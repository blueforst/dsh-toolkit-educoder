import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  installEduCoderToolBoundary,
} from '../plugins/educoder/agent.js';
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
  ['缺失 token 用量', {}, undefined],
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

test('专用实例的全局工具边界仅临时授权正在运行的 Agent 执行原生编码工具', async t => {
  let globalGuard;
  const toolBoundary = installEduCoderToolBoundary({
    tools: { guard(guard) { globalGuard = guard; return () => { globalGuard = undefined; }; } },
  });
  t.after(toolBoundary.dispose);
  const { runs, run } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    const exec = { name: 'bash', agent: record.agent };
    assert.equal(globalGuard(exec), undefined);
    assert.equal(globalGuard({ ...exec, name: 'read' }), undefined);
    assert(globalGuard({ ...exec, agent: {} }));
    assert(globalGuard({ ...exec, parent: {} }));
    assert(globalGuard({ ...exec, name: 'educoder_evaluate' }));
    assert(globalGuard({ ...exec, name: 'web_search' }));
    assert(globalGuard({ name: 'bash' }));
    assert.equal(await beginStep(), 'enter');
    finishStep(usage);
    finishTurn();
  }, { toolBoundary });
  assert.equal((await run(codeTask())).status, 'finished');
  assert(globalGuard({ name: 'bash', agent: runs[0].agent }));
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

async function resolveTestDshEntrypoint() {
  if (process.env.DSH_ENTRYPOINT) return process.env.DSH_ENTRYPOINT;
  try {
    const resolved = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch {}
  return undefined;
}

test('真实 DSH Cordis 运行时仅挂载原生编码工具并通过 bash 子进程注入作用域 CLI 环境', async t => {
  const entrypoint = await resolveTestDshEntrypoint();
  if (!entrypoint) {
    t.skip('未发现 DSH 可执行入口，跳过真实 Cordis 集成测试。');
    return;
  }
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

  await Promise.all(forks.map(fork => fork.await?.()));

  // 注册一个全局无关工具，验证 mountNativeCodingTools + restrict + guard 会将其彻底屏蔽
  ctx.tools.register({
    name: 'web_search',
    description: 'Dummy forbidden tool',
    parameters: { q: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    async execute() { throw new Error('forbidden global tool must not execute'); },
  });

  const capturedRequests = [];
  let modelTurn = 0;
  class FixtureAdapter extends llmMod.LlmAdapter {
    async *stream(options) {
      capturedRequests.push(options);
      modelTurn++;
      if (modelTurn === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: 'call_real_doctor',
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

  const boundary = installEduCoderToolBoundary(ctx);
  t.after(boundary.dispose);

  const sharedWorkspace = join(root, 'shared-workspace');
  const runner = createAgentRunner(ctx, {
    toolBoundary: boundary,
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
  assert.equal(result.steps, 2);
  assert.equal(capturedRequests.length, 2);

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
  for (const forbidden of ['educoder_read_file', 'educoder_save_file', 'educoder_evaluate', 'exit_plan_mode', 'web_search', 'todo_write', sessionSecret]) {
    assert.ok(!systemText.includes(forbidden), `system prompt leaked ${forbidden}`);
  }

  // 验证 bash 工具真正在隔离环境里执行了 node "$DSH_EDUCODER_CLI" doctor 且 session secret 未进 stdout 或父进程 env
  assert.equal(process.env.DSH_EDUCODER_SESSION, undefined);
  const secondTranscript = JSON.stringify(capturedRequests[1].messages ?? []);
  assert.ok(secondTranscript.includes('"ok": true') || secondTranscript.includes('cliRoot'), 'doctor output missing from tool result');
  assert.ok(secondTranscript.includes('HAS_SCOPED_ENV=yes'));
  assert.ok(!secondTranscript.includes(sessionSecret), 'session secret must never appear in model transcript');
});
