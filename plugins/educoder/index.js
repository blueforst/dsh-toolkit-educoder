import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentRunner, createSaveEvidenceReader, installEduCoderToolBoundary } from './agent.js';
import { createTransport } from './transport.js';
import { createService } from './service.js';
import { createExperience } from './experience.js';
import { createTerminalRunner } from './terminal-runner.js';
import { createBrowserInspector } from './browser.js';
import { createEduCoderProxy } from './proxy.js';

export const name = 'dsh-educoder';
export const inject = ['webServer', 'connection', 'credentials', 'tools', 'agents', 'sessions', 'agentDefaultModel', 'llm', 'attachments', 'workspaceRegistry'];

const errors = {
  invalid_input: [400, '请求参数无效。'],
  invalid_scope: [403, '无法确认所选账号与作业范围。'],
  auth_required: [409, 'EduCoder 登录已失效，请重新登录。'],
  invalid_credentials: [409, 'EduCoder 拒绝了账号或密码。'],
  manual_required: [409, '当前账号或任务需要人工处理。'],
  signature_error: [503, 'EduCoder 请求签名不可用。'],
  unavailable: [503, 'EduCoder 暂时不可用。'],
  uncertain: [409, '远端操作结果未确认，请先核验。'],
  not_found: [404, '记录不存在。'],
  busy: [409, '当前账号正在处理另一项操作。'],
  already_exists: [409, '该 EduCoder 账号已经绑定。'],
  invalid_state: [409, '当前状态不允许该操作。'],
  retry_limit: [409, '已达到重试上限。'],
  live_disabled: [403, '当前部署仅开放隔离测试。'],
  tasks_disabled: [403, '当前实例开放账号登录和课程查看，作业执行尚未启用。'],
  course_limit: [409, '该课程作业超过一键通关的 1000 项上限。'],
};

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function reject(res, status, code, message, headers) {
  json(res, status, { ok: false, error: { code, message } }, headers);
}

async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 32768) throw Object.assign(new Error('请求过大。'), { code: 'invalid_input' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求格式无效。'), { code: 'invalid_input' });
  }
}

export function registerApi(ctx, service) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-educoder/api',
    async handler(req, res) {
      const denied = ctx.connection.requestRejection(req);
      if (denied !== undefined) {
        reject(res, denied, 'invalid_scope', '需要通过已认证的 DSH Web 页面访问。');
        return;
      }
      if (req.method !== 'POST') {
        reject(res, 405, 'invalid_input', '请使用 POST。', { Allow: 'POST' });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '') ||
          Number(req.headers['content-length']) > 32768) {
        reject(res, 400, 'invalid_input', '需要 JSON 请求。');
        return;
      }
      try {
        const result = await service.execute(await body(req));
        json(res, 200, { ok: true, data: result });
      } catch (error) {
        const value = Object.hasOwn(errors, error?.code) ? errors[error.code] : undefined;
        const [status, message] = value ?? [500, 'EduCoder 操作未完成。'];
        reject(res, status, value ? error.code : 'agent_failed', message);
      }
    },
  });
}

export function apply(ctx) {
  const baseUrl = process.env.DSH_EDUCODER_API_URL;
  const dedicated = process.env.DSH_EDUCODER_DEDICATED === '1';
  const publicAdmin = process.env.DSH_EDUCODER_PUBLIC_ADMIN === '1';
  const scopedProxy = process.env.DSH_EDUCODER_HTTPS_PROXY;
  const httpsProxy = scopedProxy || process.env.HTTPS_PROXY || process.env.https_proxy;
  const terminalRunner = process.env.DSH_EDUCODER_TERMINAL_ENABLED === '1' ? createTerminalRunner({ proxyUrl: httpsProxy }) : undefined;
  const inspectBrowser = process.env.DSH_EDUCODER_BROWSER_INSPECTION === '1' ? createBrowserInspector({
    proxy: httpsProxy,
  }) : undefined;
  const fixture = Boolean(baseUrl) && new URL(baseUrl).protocol === 'http:';
  const live = process.env.DSH_EDUCODER_LIVE_ACCOUNTS === '1';
  const provider = process.env.DSH_EDUCODER_PROVIDER;
  const model = process.env.DSH_EDUCODER_MODEL;
  const allowTasks = process.env.DSH_EDUCODER_READONLY_TASKS !== '1' && (fixture || (
    live && process.env.DSH_EDUCODER_LIVE_TASKS === '1' && Boolean(provider && model)
  ));
  const root = resolve(process.env.DSH_EDUCODER_STATE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'educoder'));
  ctx.effect(() => {
    const boundary = dedicated && !publicAdmin ? installEduCoderToolBoundary(ctx) : undefined;
    let proxy;
    let service;
    let unregister;
    try {
      proxy = createEduCoderProxy(scopedProxy);
      const transport = createTransport({ baseUrl, terminalRunner, fetch: proxy.fetch });
      const sharedWorkspaceRoot = process.env.DSH_EDUCODER_WORKSPACE_DIR || join(root, 'workspace');
      const experience = dedicated && (live || process.env.DSH_EDUCODER_WORKSPACE_DIR) ? createExperience({
        root: sharedWorkspaceRoot, workspaceRegistry: ctx.workspaceRegistry,
      }).catch(() => {
        ctx.logger.warn('EduCoder 工作区初始化失败。');
        return undefined;
      }) : undefined;
      const runAgent = createAgentRunner(ctx, {
        workspaceRoot: join(root, 'workspaces'),
        sharedWorkspaceRoot,
        provider,
        model,
        experience,
        extended: publicAdmin,
        nativeTools: true,
        toolBoundary: boundary,
        apiUrl: baseUrl,
        proxyUrl: httpsProxy,
        signingAccessKey: process.env.EDUCODER_SIGNING_ACCESS_KEY,
        signingSecretKey: process.env.EDUCODER_SIGNING_SECRET_KEY,
        terminalEnabled: process.env.DSH_EDUCODER_TERMINAL_ENABLED === '1',
        browserInspection: process.env.DSH_EDUCODER_BROWSER_INSPECTION === '1',
        readOnly: process.env.DSH_EDUCODER_READONLY_TASKS === '1',
      });
      service = createService({
        root,
        credentials: ctx.credentials,
        transport,
        runAgent,
        experience,
        inspectBrowser,
        extended: publicAdmin,
        nativeTools: true,
        readSaveEvidence: createSaveEvidenceReader(ctx, {
          sharedWorkspaceRoot,
          workspaceRoot: join(root, 'workspaces'),
        }),
        allowAccounts: () => dedicated && (fixture || (
          live && (publicAdmin || ctx.get('educoderCredentialBoundary', false)?.() === true)
        )),
        allowTasks,
        mode: fixture ? 'fixture' : live ? 'live' : 'disabled',
      });
      unregister = registerApi(ctx, service);
    } catch (error) {
      boundary?.dispose();
      void service?.close();
      void proxy?.close();
      throw error;
    }
    return async () => {
      unregister();
      try { await service.close(); } finally {
        boundary?.dispose();
        await proxy.close();
      }
    };
  }, 'EduCoder 控制面与调度器');
}
