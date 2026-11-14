import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  NATIVE_CODING_TOOLS,
  createAgentRunner,
  createSaveEvidenceReader,
  registerWorkspaceShellEnv,
} from '../plugins/educoder/agent.js';
import { createExperience } from '../plugins/educoder/experience.js';
import { apply as applyEduCoderPlugin } from '../plugins/educoder/index.js';
import { writeCliState } from '../plugins/educoder/cli/lib/state.mjs';

class SessionNotFound extends Error {}
const sdk = {
  sessionId: value => value,
  sessionNotFound: SessionNotFound,
  userMessage: data => ({ ...data, role: 'user' }),
  nativeExecutor: ctx => ({ kind: 'native', ctx }),
  installModelSelection() {},
  setSandboxMode: (session, mode) => session.append('sandbox/mode', { mode }),
  setApprovalPolicy: (session, policy) => session.append('approval/policy', { policy }),
};
const usage = { inputTokens: 30, outputTokens: 15, cacheReadTokens: 5 };

function createMockShellEnv() {
  const contributors = new Map();
  return {
    contributors,
    register(contributor) {
      assert.ok(contributor.name);
      for (const [key, spec] of Object.entries(contributor.variables)) {
        assert.match(key, /^DSH_[A-Z][A-Z0-9_]*$/);
        assert.ok(typeof spec.description === 'string' && spec.description.trim().length > 0);
      }
      if (contributors.has(contributor.name)) {
        throw new Error(`bash env contributor "${contributor.name}" is already registered`);
      }
      contributors.set(contributor.name, contributor);
      return () => contributors.delete(contributor.name);
    },
    resolveForAgent(agent) {
      const merged = {};
      for (const contributor of contributors.values()) {
        const res = contributor.resolve({ agent });
        for (const [k, v] of Object.entries(res)) {
          assert.equal(typeof v, 'string', `shellEnv key ${k} must be a string`);
          merged[k] = v;
        }
      }
      return merged;
    },
  };
}

async function fixture(t, exercise, options = {}, context = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-edu-agent-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const runs = [];
  const stored = new Map();
  const resumeAttempts = [];
  let withoutInitiator = false;
  const shellEnv = createMockShellEnv();
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'code' }) },
    shellEnv,
    ...context,
    sessions: {
      flush: async session => { session.flushed = true; },
    },
    agents: {
      get() {},
      withoutInitiator(fn) {
        withoutInitiator = true;
        return fn();
      },
      async resume(resumeOptions) {
        resumeAttempts.push(resumeOptions.resumeSessionId);
        const previous = stored.get(resumeOptions.resumeSessionId);
        if (!previous) throw new SessionNotFound();
        return this.create({ ...resumeOptions, meta: previous.header, sessionId: resumeOptions.resumeSessionId }, previous);
      },
      async create(createOptions, previous) {
        assert(withoutInitiator);
        const callbacks = new Map();
        const events = [];
        const toolDefinitions = new Map();
        const record = { createOptions, toolDefinitions, previous, events };
        runs.push(record);
        const session = {
          header: createOptions.meta,
          deriveMessages: () => previous?.messages ?? [],
          append(type, data) {
            events.push({ type, data });
            callbacks.get('session/event')?.(session, { type, data });
          },
        };
        let idle = Promise.resolve();
        const agent = {
          session,
          model: { current: () => createOptions.agentOptions },
          inbox: { nextTurn: [], nextStep: [] },
          followup(message) {
            record.message = message;
            idle = exercise({
              record,
              shellEnv,
              async beginStep() {
                const decision = await callbacks.get('agent/pre-step')({}, async () => ({ kind: 'enter' }));
                if (decision.kind === 'enter') session.append('step/start', {});
                return decision.kind;
              },
              finishStep(metrics) {
                session.append('assistant/message', { usage: metrics });
                session.append('step/end', {});
              },
              finishTurn(kind = 'completed') { session.append('turn/end', { reason: { kind } }); },
              signal: createOptions.signal,
              retry: () => callbacks.get('agent/request-error')({}, () => ({ kind: 'retry' })),
            });
          },
          whenIdle: () => idle,
          cancel(cause) { record.cancel = cause; },
        };
        await createOptions.setup({
          on(name, callback) { callbacks.set(name, callback); },
          tools: {
            list: () => [...toolDefinitions.values()],
            restrict(value) { record.restriction = value; },
            guard(value) { record.guard = value; record.agent = agent; },
            setExecutor(value) { record.executor = value.kind; },
            register(value) { toolDefinitions.set(value.name, value); },
          },
        }, agent);
        return {
          agent,
          dispose: async () => {
            record.disposed = true;
            if (session.flushed && record.message) stored.set(createOptions.sessionId, {
              header: session.header, messages: [...session.deriveMessages(), record.message],
            });
          },
        };
      },
    },
  };
  return {
    workspaceRoot,
    runs,
    stored,
    resumeAttempts,
    shellEnv,
    run: createAgentRunner(ctx, { workspaceRoot, runtimeLoader: async () => sdk, ...options }),
  };
}

function codeTask(options = {}) {
  return {
    title: '关卡',
    instructions: '返回 42',
    paths: ['src/answer.py'],
    kind: 'code',
    accountRef: 'first',
    taskId: 'task-a',
    courseId: 'course-1',
    homeworkId: '202',
    session: {
      remoteUserId: '7001',
      session: `sess-${options.accountRef || 'first'}`,
      autologin: `auto-${options.accountRef || 'first'}`,
      zzud: 'zzud-1',
    },
    binding: {
      courseId: 'course-1',
      homeworkId: '202',
      taskId: options.stageId || options.taskId || 'task-a',
      practiceId: 'p-1',
      remoteUserId: '7001',
      gameId: '404',
      challengeId: '505',
    },
    ...options,
  };
}

test('将题面图按顺序作为真实图片附件加入模型消息，且提示词不包含 educoder_* 工具名', async t => {
  const loaded = [Buffer.from('first-image'), Buffer.from('second-image')]
    .map(data => ({ data, mediaType: 'image/png' }));
  const refs = [{ attachmentId: 'first' }, { attachmentId: 'second' }];
  const { run } = await fixture(t, async ({ record, finishTurn }) => {
    const prompt = record.message.content[0].text;
    assert.match(prompt, /\[参考图 1\]/);
    assert.ok(!/educoder_[a-z_]+/.test(prompt), 'prompt must not reference removed educoder_* tools');
    assert.match(prompt, /DSH_EDUCODER_CLI/);
    assert.match(prompt, /\.\/cli\//);
    assert.deepEqual(record.message.content.slice(1), refs.map(attachment => ({ type: 'image', attachment })));
    finishTurn();
  }, {}, {
    llm: {
      async resolveModelInfo(provider, model) {
        assert.equal(provider, 'fixture');
        assert.equal(model, 'code');
        return { inputModalities: ['text', 'image'] };
      },
    },
    attachments: { async saveImages(images) { assert.deepEqual(images, loaded); return refs; } },
  });
  assert.equal((await run(codeTask({
    instructions: '根据 [参考图 1] 和 [参考图 2] 解题。',
    imageCount: 2,
    loadImages: async () => loaded,
  }))).status, 'finished');
});

test('文字模型遇到有图作业时不下载、不启动会话', async t => {
  const { runs, run } = await fixture(t, () => assert.fail('不能启动'), {}, {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
  });
  const result = await run(codeTask({ imageCount: 1, loadImages: async () => assert.fail('不能下载') }));
  assert.equal(result.code, 'image_model_unsupported');
  assert.equal(runs.length, 0);
});

test('挂载原生编码工具白名单、共享工作区 CLI、沙箱策略和审批策略', async t => {
  const attached = [];
  const root = await mkdtemp(join(tmpdir(), 'dsh-edu-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const { run, runs } = await fixture(t, async ({ record, finishTurn }) => {
    assert.match(record.message.content[0].text, /既往经验/);
    assert.deepEqual([...record.toolDefinitions.keys()], []);
    assert.deepEqual(record.restriction, { allow: NATIVE_CODING_TOOLS });
    assert.equal(record.executor, 'native');
    assert.ok(record.events.some(e => e.type === 'sandbox/mode' && e.data.mode === 'workspace-write'));
    assert.ok(record.events.some(e => e.type === 'approval/policy' && e.data.policy === 'never'));
    finishTurn();
  }, {
    experience: Promise.resolve({
      root: canonicalRoot,
      workspace: { async attachSession(id) { attached.push(id); } },
      read: async () => '阅读公开样例。',
    }),
  });
  assert.equal((await run(codeTask())).status, 'finished');
  assert.equal(runs[0].createOptions.meta.cwd, canonicalRoot);
  assert.deepEqual(attached, [runs[0].createOptions.sessionId]);
  assert.ok(existsSync(join(canonicalRoot, 'cli/educoder.mjs')));
  assert.ok(existsSync(join(canonicalRoot, 'cli/.baseline/educoder.mjs')));
});

test('首条模型消息提供公开样例并保留输入输出的空白字符', async t => {
  const { run } = await fixture(t, async ({ record, finishTurn }) => {
    const prompt = record.message.content[0].text;
    assert.match(prompt, /平台公开样例/u);
    assert.deepEqual(JSON.parse(prompt.split('\n\n').at(-1)), [
      { 输入: ' 3\n', 期望输出: '6\n' },
      { 期望输出: 'api_key=[已脱敏]' },
    ]);
    finishTurn();
  });
  assert.equal((await run(codeTask({
    examples: [
      { input: ' 3\n', expected: '6\n' },
      { expected: 'api_key=private-value' },
    ],
  }))).status, 'finished');
});

test('并发任务按 Agent 在 shellEnv 中严格隔离凭据与工作目录，结束后撤销内存环境变量', async t => {
  const envSnapshots = [];
  const { runs, run, shellEnv } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    assert.equal(await beginStep(), 'enter');
    for (const allowed of NATIVE_CODING_TOOLS) {
      assert.equal(record.guard({ name: allowed, agent: record.agent }), undefined);
    }
    for (const forbidden of ['educoder_read_file', 'educoder_save_file', 'web_search', 'subagent', 'mcp__desktop']) {
      assert(record.guard({ name: forbidden, agent: record.agent }));
    }
    assert(record.guard({ name: 'bash', agent: {} }));
    assert(record.guard({ name: 'bash', agent: record.agent, parent: {} }));
    const env = shellEnv.resolveForAgent(record.agent);
    envSnapshots.push({ agent: record.agent, env });
    assert.ok(env.DSH_EDUCODER_CLI?.endsWith('/cli/educoder.mjs'));
    assert.ok(env.DSH_EDUCODER_WORKDIR?.includes('/tasks/'));
    finishStep(usage);
    finishTurn();
  });

  const makeTask = accountRef => codeTask({
    accountRef,
    instructions: `Cookie: sess-${accountRef} token`,
  });
  const results = await Promise.all([run(makeTask('first')), run(makeTask('second')), run(makeTask('first'))]);
  assert.deepEqual(results.map(r => r.status), ['finished', 'finished', 'finished']);
  assert.deepEqual(results.map(r => r.tokens), [50, 50, 50]);

  // 共享同一 cwdCanonical（包含 ./cli/ 与 ./tasks/），同时三个运行各有独立 shellEnv 映射与脱敏提示词
  assert.equal(new Set(runs.map(r => r.createOptions.meta.cwd)).size, 1);
  const firstSession = JSON.parse(envSnapshots.find(s => s.env.DSH_EDUCODER_SESSION.includes('sess-first')).env.DSH_EDUCODER_SESSION);
  const secondSession = JSON.parse(envSnapshots.find(s => s.env.DSH_EDUCODER_SESSION.includes('sess-second')).env.DSH_EDUCODER_SESSION);
  assert.equal(firstSession.session, 'sess-first');
  assert.equal(secondSession.session, 'sess-second');

  assert(runs.every(record => {
    const text = JSON.stringify(record.message);
    return !text.includes('sess-first') && !text.includes('sess-second');
  }));
  // 运行结束后，Agent 的临时会话环境必须从内存中清除
  for (const snap of envSnapshots) {
    assert.deepEqual(shellEnv.resolveForAgent(snap.agent), {});
  }
  assert(runs.every(record => record.agent.session.flushed && record.disposed));
});

test('同一关卡短时重试恢复历史、重新授权工具并跳过归档、过期和缺失会话', async t => {
  const archivedSessionIds = [];
  let pictureLoads = 0;
  const picture = { attachmentId: 'one' };
  const { run, runs, stored, resumeAttempts } = await fixture(t, async ({
    record, beginStep, finishStep, finishTurn,
  }) => {
    assert.equal(await beginStep(), 'enter');
    if (record.previous) {
      assert.match(record.message.content[0].text, /继续当前关卡/);
      assert.equal(record.message.content.length, 1);
      assert.match(record.previous.messages[0].content[0].text, /第一张图/);
    } else {
      assert.deepEqual(record.message.content.slice(1), [{ type: 'image', attachment: picture }]);
    }
    finishStep(usage);
    finishTurn();
  }, {}, {
    workspaceRegistry: { archivedSessionIds },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: { saveImages: async () => [picture] },
  });
  const task = codeTask({
    instructions: '第一张图',
    imageCount: 1,
    loadImages: async () => { pictureLoads++; return [Buffer.from('picture')]; },
  });
  const first = await run(task);
  assert.equal(first.sessionResume.requestCount, 1);
  const second = await run({ ...task, sessionResume: first.sessionResume });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionResume.requestCount, 2);
  assert.equal(pictureLoads, 1);
  assert.notEqual(runs[0].agent, runs[1].agent);
  assert(runs[1].guard({ name: 'bash', agent: runs[0].agent }));
  archivedSessionIds.push(second.sessionId);
  const archived = await run({ ...task, sessionResume: second.sessionResume });
  assert.notEqual(archived.sessionId, second.sessionId);
  const expired = await run({ ...task, sessionResume: { ...archived.sessionResume, lastRequestAt: 1 } });
  assert.notEqual(expired.sessionId, archived.sessionId);
  const changed = await run({ ...task, sessionResume: expired.sessionResume, inspectBrowser: async () => ({ text: '' }) });
  assert.notEqual(changed.sessionId, expired.sessionId);
  stored.delete(changed.sessionId);
  const missing = await run({
    ...task, sessionResume: changed.sessionResume, inspectBrowser: async () => ({ text: '' }),
  });
  assert.notEqual(missing.sessionId, changed.sessionId);
  assert.equal(pictureLoads, 5);
  assert.deepEqual(resumeAttempts, [first.sessionId, changed.sessionId]);
});

test('同一作业的已核验下一关复用会话并更新目标阶段环境变量', async t => {
  const seenTargets = [];
  const { run, resumeAttempts, shellEnv } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    await beginStep();
    seenTargets.push(JSON.parse(shellEnv.resolveForAgent(record.agent).DSH_EDUCODER_TARGET).taskId);
    if (seenTargets.length === 2) {
      assert.match(record.message.content[0].text, /上一关已通过/);
      assert.match(record.message.content[0].text, /第二关题面/);
      assert.deepEqual(record.message.content[1], { type: 'image', attachment: { attachmentId: 'second' } });
    }
    finishStep(usage);
    finishTurn();
  }, { nativeTools: true }, {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: { saveImages: async () => [{ attachmentId: 'second' }] },
  });
  const common = { taskId: 'homework', accountRef: 'account' };
  const first = await run(codeTask({ ...common, stageId: 'one', paths: ['first.py'] }));
  const second = await run(codeTask({
    ...common,
    stageId: 'two',
    paths: ['second.py'],
    instructions: '第二关题面',
    imageCount: 1,
    loadImages: async () => [Buffer.from('second')],
    resumeFromPreviousStage: true,
    sessionResume: first.sessionResume,
  }));
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionResume.requestCount, 2);
  assert.deepEqual(seenTargets, ['one', 'two']);
  assert.deepEqual(resumeAttempts, [first.sessionId]);
  const another = await run(codeTask({
    ...common,
    taskId: 'other-homework',
    stageId: 'three',
    resumeFromPreviousStage: true,
    sessionResume: second.sessionResume,
  }));
  assert.notEqual(another.sessionId, second.sessionId);
});

for (const [name, options, usageReport] of [
  ['模型步数', { maxSteps: 1 }, usage],
  ['累计 token', { maxTotalTokens: 50 }, usage],
]) {
  test(`${name} 超限时拒绝下一步`, async t => {
    const { run } = await fixture(t, async ({ beginStep, finishStep, finishTurn }) => {
      assert.equal(await beginStep(), 'enter');
      finishStep(usageReport);
      assert.equal(await beginStep(), 'reject');
      finishTurn('blocked');
    }, options);
    assert.equal((await run(codeTask())).status, 'budget');
  });
}

test('缺失 token 用量时不再中止执行或阻断会话续接', async t => {
  const { run } = await fixture(t, async ({ beginStep, finishStep, finishTurn }) => {
    for (let step = 0; step < 3; step++) {
      assert.equal(await beginStep(), 'enter');
      finishStep(undefined);
    }
    finishTurn();
  });
  const result = await run(codeTask());
  assert.equal(result.status, 'finished');
  assert.equal(result.steps, 3);
  assert.ok(result.sessionResume?.sessionId);
});

test('截止时取消 Agent 并等待已启动的工具收尾后再释放会话', async t => {
  const { runs, run } = await fixture(t, async ({ beginStep, signal, finishTurn }) => {
    assert.equal(await beginStep(), 'enter');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    finishTurn('cancelled');
  }, { timeoutMs: 40 });
  assert.equal((await run(codeTask())).status, 'timeout');
  assert.equal(runs[0].cancel.reason, 'agent_timeout');
  assert(runs[0].agent.session.flushed && runs[0].disposed);
});

test('默认不限制步数和单次输出 token，并在预算截断与超时时保留会话续接', async t => {
  const { runs, run } = await fixture(t, async ({ beginStep, finishStep, finishTurn }) => {
    for (let step = 0; step < 30; step++) {
      assert.equal(await beginStep(), 'enter');
      finishStep(usage);
    }
    finishTurn();
  });
  const unrestricted = await run(codeTask());
  assert.equal(unrestricted.status, 'finished');
  assert.equal(unrestricted.steps, 30);
  assert.equal(Object.hasOwn(runs[0].createOptions.agentOptions, 'maxTokens'), false);
  assert.ok(unrestricted.sessionResume?.sessionId);

  const budgeted = await fixture(t, async ({ beginStep, finishStep, finishTurn }) => {
    assert.equal(await beginStep(), 'enter');
    finishStep(usage);
    assert.equal(await beginStep(), 'reject');
    finishTurn('blocked');
  }, { maxSteps: 1 });
  const budgetResult = await budgeted.run(codeTask());
  assert.equal(budgetResult.status, 'budget');
  assert.ok(budgetResult.sessionResume?.sessionId);

  const timed = await fixture(t, async ({ beginStep, finishStep, signal, finishTurn }) => {
    assert.equal(await beginStep(), 'enter');
    finishStep(usage);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    finishTurn('cancelled');
  }, { timeoutMs: 30 });
  const timeoutResult = await timed.run(codeTask());
  assert.equal(timeoutResult.status, 'timeout');
  assert.ok(timeoutResult.sessionResume?.sessionId);
});

test('Agent 异常失败时记录脱敏日志且不泄露会话凭据', async t => {
  const warnings = [];
  const task = codeTask();
  const { run } = await fixture(t, async ({ finishTurn }) => {
    finishTurn('error');
  }, {}, {
    logger: { warn: (...args) => warnings.push(args) },
  });
  const turnFailure = await run(codeTask());
  assert.equal(turnFailure.status, 'failed');
  assert.equal(turnFailure.code, 'agent_turn_failed');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].phase, 'agent_turn_failed');
  assert.equal(warnings[0][1].turnReason, 'error');

  const failWarnings = [];
  const { run: failRun } = await fixture(t, async () => {}, {}, {
    logger: { warn: (...args) => failWarnings.push(args) },
    llm: {
      async resolveModelInfo() {
        throw Object.assign(new Error(`boom ${task.session.session} cookie: private`), { code: 'ECONNRESET' });
      },
    },
  });
  const result = await failRun(codeTask({
    ...task,
    imageCount: 1,
    loadImages: async () => [],
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'image_unavailable');
  assert.equal(failWarnings.length, 1);
  const serialized = JSON.stringify(failWarnings[0]);
  assert.match(serialized, /ECONNRESET/);
  assert.ok(!serialized.includes(task.session.session));
  assert.ok(!serialized.includes('private'));
});

test('专用实例也不向宿主挂载全局 tools.guard，仅按会话回合在 agentCtx 上临时限制工具', async t => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-no-global-guard-')));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const prevEnv = {
    DSH_EDUCODER_DEDICATED: process.env.DSH_EDUCODER_DEDICATED,
    DSH_EDUCODER_PUBLIC_ADMIN: process.env.DSH_EDUCODER_PUBLIC_ADMIN,
    DSH_EDUCODER_STATE_DIR: process.env.DSH_EDUCODER_STATE_DIR,
    DSH_EDUCODER_LIVE_ACCOUNTS: process.env.DSH_EDUCODER_LIVE_ACCOUNTS,
  };
  process.env.DSH_EDUCODER_DEDICATED = '1';
  delete process.env.DSH_EDUCODER_PUBLIC_ADMIN;
  process.env.DSH_EDUCODER_STATE_DIR = stateDir;
  delete process.env.DSH_EDUCODER_LIVE_ACCOUNTS;
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  let cleanups = [];
  let globalGuardCalls = 0;
  applyEduCoderPlugin({
    tools: { guard() { globalGuardCalls++; return () => {}; } },
    credentials: {},
    connection: { requestRejection: () => undefined },
    webServer: { register: () => () => {} },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    get: () => undefined,
  });
  for (const dispose of cleanups) await dispose();
  assert.equal(globalGuardCalls, 0);

  const { run } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    assert.equal(record.guard({ name: 'bash', agent: record.agent }), undefined);
    assert(record.guard({ name: 'web_search', agent: record.agent }));
    assert(record.guard({ name: 'bash', agent: record.agent, parent: {} }));
    assert.equal(await beginStep(), 'enter');
    finishStep(usage);
    finishTurn();
  });
  assert.equal((await run(codeTask())).status, 'finished');
});

test('createSaveEvidenceReader 可读取 CLI 状态文件中的保存记录并拒绝符号链接', async t => {
  const { workspaceRoot, run } = await fixture(t, async ({ finishTurn }) => {
    finishTurn();
  });
  const sharedRoot = join(workspaceRoot, 'shared');
  const first = await run(codeTask({ accountRef: 'acc1', taskId: 'task1' }));
  const mappedWorkdir = join(sharedRoot, 'tasks', 'acc1-task1');
  await writeCliState({ workdir: mappedWorkdir }, {
    pendingSave: { path: 'src/answer.py', content: 'print(42)' },
  });

  const readEvidence = createSaveEvidenceReader({ agents: { get: () => undefined } }, { sharedWorkspaceRoot: sharedRoot });
  assert.deepEqual(await readEvidence(first.sessionId, new AbortController().signal), {
    path: 'src/answer.py',
    content: 'print(42)',
  });
  const readWhileRunning = createSaveEvidenceReader({
    agents: { get: () => ({ status: 'running' }) },
  }, { sharedWorkspaceRoot: sharedRoot });
  assert.equal(await readWhileRunning(first.sessionId, new AbortController().signal), undefined);

  // 符号链接状态文件必须被拒绝
  const evilTarget = join(workspaceRoot, 'outside.json');
  await writeFile(evilTarget, JSON.stringify({ pendingSave: { path: 'x.py', content: 'evil' } }), 'utf8');
  await rm(join(mappedWorkdir, '.educoder-cli-state.json'), { force: true });
  await symlink(evilTarget, join(mappedWorkdir, '.educoder-cli-state.json'));
  const readNoFallback = createSaveEvidenceReader({
    agents: { get: () => undefined },
    get: () => ({ open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) }),
  }, { sharedWorkspaceRoot: sharedRoot, runtimeLoader: async () => sdk });
  assert.equal(await readNoFallback(first.sessionId, new AbortController().signal), undefined);

  // 仍然兼容旧会话日志回退
  const legacyReader = createSaveEvidenceReader({
    agents: { get: () => undefined },
    get() {
      return {
        async open() {
          return {
            async read() {
              return {
                events: [
                  { type: 'turn/start', data: { turn: 1 } },
                  { type: 'user/message', data: { source: { kind: 'dsh-educoder' } } },
                  { type: 'tool/call', data: { turn: 1, name: 'educoder_save_file', arguments: { path: 'a.py', content: 'legacy' } } },
                ],
              };
            },
            async close() {},
          };
        },
      };
    },
  }, async () => ({ sessionId: v => v }));
  assert.deepEqual(await legacyReader('legacy-session', new AbortController().signal), {
    path: 'a.py',
    content: 'legacy',
  });
});

test('题面部分附图加载成功时保留已加载图片继续执行，不再整题拒跑', async t => {
  const loaded = [Buffer.from('one'), Buffer.from('two')].map(data => ({ data, mediaType: 'image/png' }));
  const refs = [{ attachmentId: 'one' }, { attachmentId: 'two' }];
  const { run } = await fixture(t, async ({ record, finishTurn }) => {
    const prompt = record.message.content[0].text;
    assert.match(prompt, /部分题面附图未能全部内联/);
    assert.deepEqual(record.message.content.slice(1), refs.map(attachment => ({ type: 'image', attachment })));
    finishTurn();
  }, {}, {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: { saveImages: async images => { assert.deepEqual(images, loaded); return refs; } },
  });
  const result = await run(codeTask({
    instructions: '参考 [参考图 1] [参考图 2] [参考图 3]',
    imageCount: 3,
    imagesUnavailable: false,
    loadImages: async () => loaded,
  }));
  assert.equal(result.status, 'finished');
});

test('超图限制仍保留前几张有效参考图并附加 CLI 图片/浏览器提示', async t => {
  const loaded = [Buffer.from('one'), Buffer.from('two')].map(data => ({ data, mediaType: 'image/png' }));
  const refs = [{ attachmentId: 'one' }, { attachmentId: 'two' }];
  const { run, shellEnv } = await fixture(t, async ({ record, finishTurn }) => {
    const prompt = record.message.content[0].text;
    assert.match(prompt, /部分题面附图未能全部内联/);
    assert.match(prompt, /images --download/);
    assert.match(prompt, /browser --screenshot/);
    const env = shellEnv.resolveForAgent(record.agent);
    assert.equal(env.DSH_EDUCODER_BROWSER_INSPECTION, '1');
    assert.deepEqual(record.message.content.slice(1), refs.map(attachment => ({ type: 'image', attachment })));
    finishTurn();
  }, {}, {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: { saveImages: async images => { assert.deepEqual(images, loaded); return refs; } },
  });
  const result = await run(codeTask({
    instructions: '参考 [参考图 1] [参考图 2] [题面图片超出数量限制]',
    imageCount: 2,
    imagesUnavailable: true,
    loadImages: async () => loaded,
    inspectBrowser: async () => ({ text: '网页' }),
  }));
  assert.equal(result.status, 'finished');
});

test('Cordis 每次 get("shellEnv") 返回新代理以及缺少/重建工作区时，多次与并发任务均可创建并上报会话', async t => {
  const cordisOriginal = Symbol.for('cordis.original');
  const effectCleanups = [];
  const rawShellEnv = createMockShellEnv();
  const makeProxy = target => new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === cordisOriginal) return obj;
      return Reflect.get(obj, prop, receiver);
    },
  });
  let proxyGets = 0;
  let attachCalls = 0;
  const attached = [];
  const { run, runs } = await fixture(t, async ({ record, finishTurn }) => {
    const env = rawShellEnv.resolveForAgent(record.agent);
    assert.ok(env.DSH_EDUCODER_CLI);
    assert.ok(env.DSH_EDUCODER_WORKDIR);
    finishTurn();
  }, {
    experience: Promise.resolve({
      workspace: undefined,
      read: async () => '',
      async attachSession(id) {
        attachCalls++;
        if (attachCalls === 2) throw new Error('workspace disappeared');
        attached.push(id);
      },
    }),
  }, {
    get(name) {
      if (name === 'shellEnv') {
        proxyGets++;
        return makeProxy(rawShellEnv);
      }
      return undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
      return cleanup;
    },
  });
  const makeRun = (taskId, accountRef) => {
    const onSessionIds = [];
    return {
      onSessionIds,
      promise: run(codeTask({
        taskId,
        stageId: `${taskId}-stage`,
        accountRef,
        onSession(id) { onSessionIds.push(id); },
      })),
    };
  };
  const first = makeRun('t-1', 'acc-1');
  const r1 = await first.promise;
  assert.equal(r1.status, 'finished', JSON.stringify(r1));
  assert.equal(first.onSessionIds.length, 1);

  // 第二次与第三次并发执行（即使 attachSession 在第 2 次抛错），均不得因重复注册 shellEnv 或 attachSession 失败而丢失会话
  const second = makeRun('t-2', 'acc-2');
  const third = makeRun('t-3', 'acc-3');
  const [r2, r3] = await Promise.all([second.promise, third.promise]);
  assert.equal(r2.status, 'finished', JSON.stringify(r2));
  assert.equal(r3.status, 'finished', JSON.stringify(r3));
  assert.equal(second.onSessionIds.length, 1);
  assert.equal(third.onSessionIds.length, 1);
  assert.equal(new Set([r1.sessionId, r2.sessionId, r3.sessionId]).size, 3);
  assert.equal(runs.length, 3);
  assert.equal(attached.length, 2);
  assert.ok(proxyGets >= 3);
  assert.equal(effectCleanups.length, 1);

  // cleanup 释放后，重新激活上下文仍能重新注册一次 shellEnv
  for (const cleanup of effectCleanups.splice(0)) cleanup();
  assert.equal(rawShellEnv.contributors.size, 0);
  const fourth = makeRun('t-4', 'acc-4');
  const r4 = await fourth.promise;
  assert.equal(r4.status, 'finished');
  assert.equal(fourth.onSessionIds.length, 1);
});

async function resolveTestDshEntrypoint() {
  if (process.env.DSH_ENTRYPOINT) return process.env.DSH_ENTRYPOINT;
  try {
    const resolved = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch {}
  return undefined;
}

async function bootRealCordisHost(t, { withSessionController = false, withSkills = false, onWebSearch } = {}) {
  const entrypoint = await resolveTestDshEntrypoint();
  if (!entrypoint) return undefined;
  const previousEntrypoint = process.env.DSH_ENTRYPOINT;
  process.env.DSH_ENTRYPOINT = entrypoint;
  t.after(() => {
    if (previousEntrypoint === undefined) delete process.env.DSH_ENTRYPOINT;
    else process.env.DSH_ENTRYPOINT = previousEntrypoint;
  });

  const anchor = await realpath(entrypoint);
  const hostRequire = createRequire(anchor);
  const importHost = specifier => import(pathToFileURL(hostRequire.resolve(specifier)).href);
  const unwrap = mod => mod.default ?? { ...mod };

  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-real-cordis-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { Context } = await importHost('@deepseek-ai/cordis');
  const [
    llmMod, defaultModelMod, sessionMod, persistenceMod, projectionMod,
    agentMod, agentLoopMod, systemPromptMod, toolsMod, workingDirMod,
    subprocessMod, shellEnvMod, bashLocalMod, jobsLocalMod, fsLocalMod,
    sandboxPolicyMod, approvalMod, tokenMeterMod, attachmentLocalMod,
  ] = await Promise.all([
    importHost('@deepseek-ai/dsh-llm'),
    importHost('@deepseek-ai/dsh-agent-default-model'),
    importHost('@deepseek-ai/dsh-session'),
    importHost('@deepseek-ai/dsh-session-persistence-jsonl'),
    importHost('@deepseek-ai/dsh-session-projection'),
    importHost('@deepseek-ai/dsh-agent'),
    importHost('@deepseek-ai/dsh-agent-loop'),
    importHost('@deepseek-ai/dsh-system-prompt'),
    importHost('@deepseek-ai/dsh-tools'),
    importHost('@deepseek-ai/dsh-working-directory'),
    importHost('@deepseek-ai/dsh-subprocess-local'),
    importHost('@deepseek-ai/dsh-shell-env'),
    importHost('@deepseek-ai/dsh-bash-local'),
    importHost('@deepseek-ai/dsh-jobs-local'),
    importHost('@deepseek-ai/dsh-fs-local'),
    importHost('@deepseek-ai/dsh-sandbox-policy'),
    importHost('@deepseek-ai/dsh-user-approval'),
    importHost('@deepseek-ai/dsh-token-meter'),
    importHost('@deepseek-ai/dsh-attachment-local'),
  ]);

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const warnings = [];
  if (!ctx.logger) ctx.logger = {};
  const origWarn = ctx.logger.warn?.bind(ctx.logger);
  ctx.logger.warn = (...args) => {
    warnings.push(args);
    origWarn?.(...args);
  };

  const forks = [
    ctx.plugin(unwrap(llmMod)),
    ctx.plugin(unwrap(defaultModelMod), { provider: 'fixture', model: 'code' }),
    ctx.plugin(unwrap(sessionMod)),
    ctx.plugin(unwrap(persistenceMod), { root: join(root, 'sessions') }),
    ctx.plugin(unwrap(projectionMod)),
    ctx.plugin(unwrap(agentMod)),
    ctx.plugin(unwrap(agentLoopMod)),
    ctx.plugin(unwrap(systemPromptMod), { personaPrefix: '' }),
    ctx.plugin(unwrap(toolsMod)),
    ctx.plugin(unwrap(workingDirMod)),
    ctx.plugin(unwrap(subprocessMod)),
    ctx.plugin(unwrap(shellEnvMod), { dshHome: join(root, 'dsh-home') }),
    ctx.plugin(unwrap(bashLocalMod)),
    ctx.plugin(unwrap(jobsLocalMod)),
    ctx.plugin(unwrap(fsLocalMod)),
    ctx.plugin(unwrap(sandboxPolicyMod), { mode: 'workspace-write', workspaceRoot: root }),
    ctx.plugin(unwrap(approvalMod), { policy: 'ask' }),
    ctx.plugin(unwrap(tokenMeterMod)),
    ctx.plugin(unwrap(attachmentLocalMod), { root: join(root, 'attachments') }),
  ];

  let workspace;
  if (withSessionController) {
    const sharedWorkspace = join(root, 'shared-workspace');
    await mkdir(sharedWorkspace, { recursive: true });
    workspace = {
      id: 'ws-educoder',
      path: sharedWorkspace,
      sessionIds: [],
      async attachSession(id) {
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
      },
    };
    const [sessionQueryMod, typertRegistryMod, sessionControllerMod] = await Promise.all([
      importHost('@deepseek-ai/dsh-session-query'),
      importHost('@deepseek-ai/dsh-typert-registry'),
      importHost('@deepseek-ai/dsh-api-session-controller'),
    ]);
    ctx.provide('workspaceRegistry', {
      archivedSessionIds: [],
      list: () => [workspace],
      get: id => (id === workspace.id ? workspace : undefined),
    });
    ctx.provide('remoteAccess', { allows: () => true });
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {} });
    ctx.provide('fileReferences', { list: () => [] });
    ctx.provide('typertGateway', { getPendingRemoteEvents: () => [] });
    forks.push(
      ctx.plugin(unwrap(sessionQueryMod)),
      ctx.plugin(unwrap(typertRegistryMod)),
      ctx.plugin(unwrap(sessionControllerMod), { nativeOpen: false }),
    );
  }

  if (withSkills) {
    const [skillMod, skillFsMod, toolBashMod] = await Promise.all([
      importHost('@deepseek-ai/dsh-skill'),
      importHost('@deepseek-ai/dsh-skill-filesystem'),
      importHost('@deepseek-ai/dsh-tool-bash'),
    ]);
    const bundledSkillDir = join(root, 'bundled-skills');
    await mkdir(bundledSkillDir, { recursive: true });
    forks.push(
      ctx.plugin(unwrap(skillMod)),
      ctx.plugin(unwrap(skillFsMod), {
        watch: false,
        dshHome: join(root, 'dsh-home'),
        agentsHome: join(root, 'agents-home'),
        bundledSkillDir,
      }),
      ctx.plugin(unwrap(toolBashMod)),
    );
  }

  await Promise.all(forks.map(fork => fork.await?.()));

  // 注册一个全局无关工具，验证 mountNativeCodingTools + restrict + guard 会将其彻底屏蔽
  ctx.tools.register({
    name: 'web_search',
    description: 'Dummy forbidden tool',
    parameters: { q: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    async execute(args) {
      if (onWebSearch) return onWebSearch(args);
      throw new Error('forbidden global tool must not execute');
    },
  });

  const capturedRequests = [];
  let modelTurn = 0;
  let customStreamHandler;
  class FixtureAdapter extends llmMod.LlmAdapter {
    async *stream(options) {
      capturedRequests.push(options);
      modelTurn++;
      if (customStreamHandler) {
        yield* customStreamHandler(options, modelTurn);
        return;
      }
      if (modelTurn % 2 === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: `call_real_doctor_${modelTurn}`,
          name: 'bash',
          argumentsDelta: JSON.stringify({
            description: 'Run EduCoder CLI doctor check',
            command: 'node "$DSH_EDUCODER_CLI" doctor && test -z "$DSH_EDUCODER_SESSION" && echo HAS_SCOPED_ENV=no || echo HAS_SCOPED_ENV=yes',
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
        yield { type: 'finish', reason: { kind: 'tool-use' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'CLI doctor checked.' };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());

  return {
    root,
    ctx,
    importHost,
    workspace,
    warnings,
    capturedRequests,
    setStreamHandler(handler) { customStreamHandler = handler; },
    createUserMessage(text) {
      return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
    },
  };
}

test('真实 DSH Cordis 运行时仅挂载原生编码工具并通过 bash 子进程注入作用域 CLI 环境', async t => {
  const host = await bootRealCordisHost(t);
  if (!host) {
    t.skip('未发现 DSH 可执行入口，跳过真实 Cordis 集成测试。');
    return;
  }
  const { root, ctx, capturedRequests } = host;

  const sharedWorkspace = join(root, 'shared-workspace');
  const runner = createAgentRunner(ctx, {
    workspaceRoot: root,
    sharedWorkspaceRoot: sharedWorkspace,
    apiUrl: 'http://127.0.0.1:9299',
    maxSteps: 4,
    maxTotalTokens: 10_000,
    timeoutMs: 15_000,
  });

  const sessionSecret = 'sess-cordis-top-secret-999';
  const result = await runner({
    accountRef: 'real-acc',
    courseId: 'course-1',
    homeworkId: 'hw-1',
    taskId: 'game-1',
    stageId: 'stage-1',
    title: 'Real Cordis Task',
    instructions: '请使用 $DSH_EDUCODER_CLI 完成本题。',
    paths: ['src/main.py'],
    session: { remoteUserId: 7, session: sessionSecret, autologin: 'auto-1', zzud: 'real-acc' },
  });

  assert.equal(result.status, 'finished', `unexpected outcome: ${JSON.stringify(result)}`);
  assert.ok(result.sessionId, 'first real Cordis run must report sessionId');
  assert.equal(result.steps, 2);
  assert.equal(capturedRequests.length, 2);

  // 在同一个 Cordis 运行时中继续执行第二个新任务：必须正常创建独立会话并注入该任务的隔离 CLI 环境，不能重复注册 educoder-cli-env
  const secondSecret = 'sess-cordis-top-secret-222';
  const secondSessionIds = [];
  const secondResult = await runner({
    accountRef: 'real-acc-2',
    courseId: 'course-1',
    homeworkId: 'hw-1',
    taskId: 'game-2',
    stageId: 'stage-2',
    title: 'Second Real Cordis Task',
    instructions: '请使用 $DSH_EDUCODER_CLI 完成第二题。',
    paths: ['src/main.py'],
    session: { remoteUserId: 8, session: secondSecret, autologin: 'auto-2', zzud: 'real-acc-2' },
    onSession(id) { secondSessionIds.push(id); },
  });
  assert.equal(secondResult.status, 'finished', `second real Cordis run failed: ${JSON.stringify(secondResult)}`);
  assert.ok(secondResult.sessionId, 'second real Cordis run must report sessionId');
  assert.notEqual(secondResult.sessionId, result.sessionId);
  assert.deepEqual(secondSessionIds, [secondResult.sessionId]);
  assert.equal(secondResult.steps, 2);
  assert.equal(capturedRequests.length, 4);

  // 验证模型看到的工具与提示词完全仅含原生工具，无任何 educoder_* 或 web_search/plan/subagent/goal/skill 泄漏
  const firstReq = capturedRequests[0];
  const toolNames = (firstReq.tools ?? []).map(tool => tool.name).sort();
  assert.ok(toolNames.length > 0);
  for (const name of toolNames) {
    assert.ok(NATIVE_CODING_TOOLS.includes(name), `unexpected tool exposed: ${name}`);
    assert.ok(!name.startsWith('educoder_'), `legacy educoder tool leaked: ${name}`);
  }
  assert.ok(toolNames.includes('bash'));
  assert.ok(toolNames.includes('read'));
  assert.ok(!toolNames.includes('web_search'));

  const systemText = JSON.stringify(firstReq.system ?? '');
  for (const forbidden of ['educoder_read_file', 'educoder_save_file', 'educoder_evaluate', 'exit_plan_mode', 'web_search', 'todo_write', sessionSecret, secondSecret]) {
    assert.ok(!systemText.includes(forbidden), `system prompt leaked ${forbidden}`);
  }

  // 验证 bash 工具真正在隔离环境里执行了 node "$DSH_EDUCODER_CLI" doctor 且 session secret 未进 stdout 或父进程 env
  assert.equal(process.env.DSH_EDUCODER_SESSION, undefined);
  for (const [reqIndex, forbiddenSecret] of [[1, sessionSecret], [3, secondSecret]]) {
    const transcript = JSON.stringify(capturedRequests[reqIndex].messages ?? []);
    assert.ok(transcript.includes('"ok": true') || transcript.includes('cliRoot'), 'doctor output missing from tool result');
    assert.ok(transcript.includes('HAS_SCOPED_ENV=yes'));
    assert.ok(!transcript.includes(forbiddenSecret), 'session secret must never appear in model transcript');
  }
});

test('挂载 SessionController 时走正常常驻会话流程：结束后不注销会话、可复用且清理回合隔离与凭据', async t => {
  const webSearchCalls = [];
  const host = await bootRealCordisHost(t, {
    withSessionController: true,
    onWebSearch(args) {
      webSearchCalls.push(args);
      return { ok: true, q: args.q };
    },
  });
  if (!host) {
    t.skip('未发现 DSH 可执行入口，跳过 SessionController 集成测试。');
    return;
  }

  const { ctx, workspace, capturedRequests, setStreamHandler, createUserMessage } = host;
  const disposedSessions = [];
  const removedApiSessions = [];
  const addedApiSessions = [];
  ctx.on('session/disposed', session => { disposedSessions.push(String(session.id)); });
  ctx.on('api-session/removed', sessionId => { removedApiSessions.push(String(sessionId)); });
  ctx.on('api-session/added', summary => { addedApiSessions.push(String(summary.sessionId)); });

  const sharedWorkspace = workspace.path;
  const firstSecret = 'sess-sc-secret-111';
  const secondSecret = 'sess-sc-secret-222';
  const experience = Promise.resolve({
    root: sharedWorkspace,
    workspace,
    read: async () => '',
    attachSession: id => workspace.attachSession(id),
  });

  const runner = createAgentRunner(ctx, {
    workspaceRoot: host.root,
    sharedWorkspaceRoot: sharedWorkspace,
    experience,
    apiUrl: 'http://127.0.0.1:9299',
    provider: 'fixture',
    model: 'code-custom',
    maxTokens: 1234,
    maxSteps: 4,
    maxTotalTokens: 10_000,
    timeoutMs: 15_000,
    extended: true,
  });

  const taskBase = {
    accountRef: 'sc-acc',
    courseId: 'course-1',
    homeworkId: 'hw-1',
    taskId: 'game-1',
    stageId: 'stage-1',
    title: 'SessionController Task',
    instructions: '请使用 CLI 完成第 1 关。',
    paths: ['src/main.py'],
  };

  const first = await runner({
    ...taskBase,
    session: { remoteUserId: 1, session: firstSecret, autologin: 'auto-1', zzud: 'sc-acc' },
  });

  assert.equal(first.status, 'finished', `unexpected first result: ${JSON.stringify(first)} warnings=${JSON.stringify(host.warnings)}`);
  assert.ok(first.sessionId);
  assert.ok(first.sessionResume, 'must emit sessionResume');
  assert.equal(disposedSessions.length, 0, 'session/disposed must not be emitted');
  assert.equal(removedApiSessions.length, 0, 'api-session/removed must not be emitted');
  assert.ok(addedApiSessions.includes(first.sessionId), 'api-session/added must include EduCoder session');
  assert.ok(workspace.sessionIds.includes(first.sessionId), 'session must remain attached to workspace');

  const liveAgent = ctx.agents.get(first.sessionId);
  assert.ok(liveAgent, 'agent must stay resident in ctx.agents');
  assert.equal(liveAgent.status, 'idle');

  assert.equal(capturedRequests[0].model, 'code-custom');
  assert.equal(capturedRequests[0].maxTokens, 1234);
  const firstToolNames = (capturedRequests[0].tools ?? []).map(tool => tool.name);
  assert.ok(!firstToolNames.includes('web_search'), 'web_search must be hidden during EduCoder turn');

  // 常驻 idle 会话不应阻止 createSaveEvidenceReader 读取崩溃保存证据，仅 running 时跳过
  const sessionDigest = createHash('sha256').update(String(first.sessionId)).digest('hex').slice(0, 32);
  const mappedWorkdir = JSON.parse(await readFile(
    join(sharedWorkspace, 'tasks', '.sessions', `${sessionDigest}.json`),
    'utf8',
  )).workdir;
  await writeCliState({ workdir: mappedWorkdir }, {
    pendingSave: { path: 'src/main.py', content: 'print("saved")\n' },
  });
  const readEvidence = createSaveEvidenceReader(ctx, { sharedWorkspaceRoot: sharedWorkspace });
  const recovered = await readEvidence(first.sessionId);
  assert.deepEqual(recovered, { path: 'src/main.py', content: 'print("saved")\n' });

  // 同一常驻会话进入下一关复用：不能因重复 setExecutor 报错，且注入新凭据、清理旧凭据
  const second = await runner({
    ...taskBase,
    stageId: 'stage-2',
    instructions: '请继续完成第 2 关。',
    resumeFromPreviousStage: true,
    sessionResume: first.sessionResume,
    session: { remoteUserId: 1, session: secondSecret, autologin: 'auto-2', zzud: 'sc-acc' },
  });

  assert.equal(second.status, 'finished', `unexpected second result: ${JSON.stringify(second)}`);
  assert.equal(second.sessionId, first.sessionId, 'second stage must reuse the same resident session');
  assert.equal(ctx.agents.get(first.sessionId), liveAgent);
  assert.equal(disposedSessions.length, 0);
  assert.equal(removedApiSessions.length, 0);

  const stage2Transcript = JSON.stringify(capturedRequests[3].messages ?? []);
  assert.ok(!stage2Transcript.includes(firstSecret));
  assert.ok(!stage2Transcript.includes(secondSecret));

  // 回合结束后清理了 tools.restrict/guard、shellEnv 凭据与 agent/pre-step：用户可在同一会话内正常继续对话并调用 web_search
  let userTurnStep = 0;
  setStreamHandler(async function* () {
    userTurnStep++;
    if (userTurnStep === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'call_user_bash_clean_env',
        name: 'bash',
        argumentsDelta: JSON.stringify({
          description: 'Check cleared EduCoder env after turn',
          command: 'test -z "$DSH_EDUCODER_SESSION" && test -z "$DSH_EDUCODER_TARGET" && echo CLEAN_ENV=yes',
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-use' } };
      return;
    }
    if (userTurnStep === 2) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'call_user_web_search',
        name: 'web_search',
        argumentsDelta: JSON.stringify({ q: 'hello-after-educoder' }),
      };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-use' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'User turn completed.' };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  liveAgent.followup(createUserMessage('continue after educoder'));
  await liveAgent.whenIdle();

  assert.equal(webSearchCalls.length, 1, 'user follow-up turn must be able to run previously hidden/guarded tools');
  assert.deepEqual(webSearchCalls[0], { q: 'hello-after-educoder' });
  const userReqToolNames = (capturedRequests[4].tools ?? []).map(tool => tool.name);
  assert.ok(userReqToolNames.includes('web_search'), 'web_search restriction must be cleaned up after EduCoder turn');
  const userTranscript = JSON.stringify(capturedRequests.at(-1).messages ?? []);
  assert.ok(userTranscript.includes('CLEAN_ENV=yes'), 'EduCoder shellEnv secrets must be purged after turn');
});

test('工作区技能同步与按 EduCoder 工作区隔离注入全账号 DSH_EDUCODER_ACCOUNTS', async t => {
  const host = await bootRealCordisHost(t, { withSessionController: true, withSkills: true });
  if (!host) {
    t.skip('未发现 DSH 可执行入口，跳过工作区 Skill 与账号隔离集成测试。');
    return;
  }

  const { root, ctx, importHost, workspace, capturedRequests, setStreamHandler, createUserMessage } = host;
  const [sessionMod, nativeExecMod, sandboxMod, approvalMod] = await Promise.all([
    importHost('@deepseek-ai/dsh-session'),
    importHost('@deepseek-ai/dsh-tool-executor-native'),
    importHost('@deepseek-ai/dsh-sandbox-policy'),
    importHost('@deepseek-ai/dsh-user-approval'),
  ]);
  const sdkMod = {
    sessionId: sessionMod.SessionId,
    nativeExecutor: targetCtx => new nativeExecMod.NativeToolExecutor(targetCtx, () => 1),
    setSandboxMode: sandboxMod.setSandboxMode,
    setApprovalPolicy: approvalMod.setApprovalPolicy,
  };
  const sharedWorkspace = workspace.path;
  const otherWorkspace = join(root, 'other-project');
  await mkdir(otherWorkspace, { recursive: true });

  const accounts = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      remoteUserId: '701',
      label: 'u1***01',
      status: 'ready',
      session: { remoteUserId: '701', session: 'full-secret-a', autologin: 'auto-a', zzud: 'zzud-a' },
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      remoteUserId: '802',
      label: 'u2***02',
      status: 'ready',
      session: { remoteUserId: '802', session: 'full-secret-b', autologin: 'auto-b', zzud: 'zzud-b' },
    },
  ];

  // 1. 工作区初始化应同步 .dsh/skills/educoder-cli/SKILL.md 且仅在 EduCoder 工作区被 DSH skills 服务发现
  const experienceState = await createExperience({
    root: sharedWorkspace,
    workspaceRegistry: {
      async create() {
        return workspace;
      },
    },
  });
  assert.ok(existsSync(join(sharedWorkspace, '.dsh', 'skills', 'educoder-cli', 'SKILL.md')));
  const eduSkills = await ctx.skills.list({ cwd: sharedWorkspace });
  const cliSkill = eduSkills.find(skill => skill.name === 'educoder-cli');
  assert.ok(cliSkill, 'EduCoder 工作区内应能发现 educoder-cli skill');
  const loadedSkill = await ctx.skills.get('educoder-cli', { cwd: sharedWorkspace });
  assert.match(loadedSkill?.content ?? '', /DSH_EDUCODER_ACCOUNTS/);

  const otherSkills = await ctx.skills.list({ cwd: otherWorkspace });
  assert.equal(otherSkills.some(skill => skill.name === 'educoder-cli'), false, '非 EduCoder 工作区不应发现 educoder-cli skill');

  // 2. 注册 workspace 作用域 shellEnv
  registerWorkspaceShellEnv(ctx, {
    sharedWorkspaceRoot: sharedWorkspace,
    experience: experienceState,
    getAccounts: () => accounts,
    apiUrl: 'http://127.0.0.1:9299',
  });

  // 3. 在 EduCoder 工作区创建普通用户对话：拿到 DSH_EDUCODER_ACCOUNTS + CLI 环境，但不应注入单任务 SESSION/TARGET
  const eduSessionId = sdkMod.sessionId(randomUUIDSafe());
  await ctx.sessionController.create({ sessionId: eduSessionId, cwd: sharedWorkspace });
  const eduAgent = (await ctx.sessionController.resolveAgent(eduSessionId)).agent;
  await eduAgent.whenIdle();
  eduAgent.model?.select?.({ provider: 'fixture', model: 'code' });
  eduAgent.ctx.tools.setExecutor(sdkMod.nativeExecutor(eduAgent.ctx));
  sdkMod.setSandboxMode(eduAgent.session, 'workspace-write');
  sdkMod.setApprovalPolicy(eduAgent.session, 'never');

  setStreamHandler(async function* (_opts, turn) {
    if (turn % 2 === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: `call_env_probe_${turn}`,
        name: 'bash',
        argumentsDelta: JSON.stringify({
          description: 'Inspect EduCoder env vars',
          command: 'HAS_CLI=$(test -n "$DSH_EDUCODER_CLI" && echo yes || echo no); HAS_ACC=$(test -n "$DSH_EDUCODER_ACCOUNTS" && echo yes || echo no); HAS_SESS=$(test -n "$DSH_EDUCODER_SESSION" && echo yes || echo no); ACC_OUT=$(test -n "$DSH_EDUCODER_CLI" && node "$DSH_EDUCODER_CLI" accounts --json | tr "\\n" " " || echo NONE); echo "HAS_CLI=$HAS_CLI HAS_ACC=$HAS_ACC HAS_SESS=$HAS_SESS ACC_OUT=$ACC_OUT"',
        }),
      };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-use' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Probe finished.' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });

  eduAgent.followup(createUserMessage('check accounts in workspace'));
  await eduAgent.whenIdle();
  const eduTranscript = JSON.stringify(capturedRequests.at(-1).messages ?? []);
  assert.ok(eduTranscript.includes('HAS_CLI=yes'), 'EduCoder workspace chat must have DSH_EDUCODER_CLI');
  assert.ok(eduTranscript.includes('HAS_ACC=yes'), 'EduCoder workspace chat must have DSH_EDUCODER_ACCOUNTS');
  assert.ok(eduTranscript.includes('HAS_SESS=no'), 'Normal EduCoder workspace chat must NOT lock DSH_EDUCODER_SESSION');
  assert.ok(eduTranscript.includes('u1***01') && eduTranscript.includes('u2***02'), 'accounts --json must expose all bound accounts');
  assert.ok(!eduTranscript.includes('full-secret-a') && !eduTranscript.includes('full-secret-b'), 'accounts output must never print raw session cookies');

  // 4. 普通非 EduCoder 工作区对话：shellEnv 返回 {}，完全拿不到任何 DSH_EDUCODER_* 变量
  const otherSessionId = sdkMod.sessionId(randomUUIDSafe());
  await ctx.sessionController.create({ sessionId: otherSessionId, cwd: otherWorkspace });
  const otherAgent = (await ctx.sessionController.resolveAgent(otherSessionId)).agent;
  await otherAgent.whenIdle();
  otherAgent.model?.select?.({ provider: 'fixture', model: 'code' });
  otherAgent.ctx.tools.setExecutor(sdkMod.nativeExecutor(otherAgent.ctx));
  sdkMod.setSandboxMode(otherAgent.session, 'workspace-write');
  sdkMod.setApprovalPolicy(otherAgent.session, 'never');

  otherAgent.followup(createUserMessage('check isolation outside educoder workspace'));
  await otherAgent.whenIdle();
  const otherTranscript = JSON.stringify(capturedRequests.at(-1).messages ?? []);
  assert.ok(otherTranscript.includes('HAS_CLI=no'), 'Non-EduCoder workspace must NOT receive DSH_EDUCODER_CLI');
  assert.ok(otherTranscript.includes('HAS_ACC=no'), 'Non-EduCoder workspace must NOT receive DSH_EDUCODER_ACCOUNTS');
  assert.ok(otherTranscript.includes('HAS_SESS=no'), 'Non-EduCoder workspace must NOT receive DSH_EDUCODER_SESSION');

  // 5. Worker 回合及其结束后同一空闲会话的普通追问：Worker 回合锁定 SESSION 且多账号脱敏，完成后卸掉 SESSION 但保留工作区 ACCOUNTS
  const runner = createAgentRunner(ctx, {
    workspaceRoot: root,
    sharedWorkspaceRoot: sharedWorkspace,
    experience: Promise.resolve(experienceState),
    apiUrl: 'http://127.0.0.1:9299',
    provider: 'fixture',
    model: 'code-custom',
    maxSteps: 4,
    maxTotalTokens: 10_000,
    timeoutMs: 15_000,
    extended: true,
    getAccounts: () => accounts,
  });

  const workerResult = await runner({
    accountRef: 'acc-701',
    courseId: 'course-1',
    homeworkId: 'hw-1',
    taskId: 'game-1',
    stageId: 'stage-1',
    title: 'Worker Turn',
    instructions: '检查 full-secret-b 不应出现在题面里。',
    paths: ['main.py'],
    session: accounts[0].session,
  });
  assert.equal(workerResult.status, 'finished');
  const workerReq = capturedRequests.at(-1);
  const workerTranscript = JSON.stringify(workerReq.messages ?? []);
  assert.ok(workerTranscript.includes('HAS_CLI=yes'));
  assert.ok(workerTranscript.includes('HAS_ACC=yes'));
  assert.ok(workerTranscript.includes('HAS_SESS=yes'), 'Active worker turn must receive scoped DSH_EDUCODER_SESSION');
  assert.ok(!workerTranscript.includes('full-secret-b'), 'Worker prompt must redact secrets from all accounts');

  const idleWorkerAgent = ctx.agents.get(workerResult.sessionId);
  assert.ok(idleWorkerAgent);
  idleWorkerAgent.followup(createUserMessage('follow up in idle worker session'));
  await idleWorkerAgent.whenIdle();
  const followupTranscript = JSON.stringify(capturedRequests.at(-1).messages ?? []);
  assert.ok(followupTranscript.includes('HAS_SESS=no'), 'Idle follow-up must clear task-locked DSH_EDUCODER_SESSION');
  assert.ok(followupTranscript.includes('HAS_ACC=yes'), 'Idle follow-up inside EduCoder workspace retains DSH_EDUCODER_ACCOUNTS');
});

function randomUUIDSafe() {
  return `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
}
