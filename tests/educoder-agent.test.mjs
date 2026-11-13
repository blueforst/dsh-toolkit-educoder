import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentRunner, installEduCoderToolBoundary } from '../plugins/educoder/agent.js';

const sdk = {
  sessionId: value => value,
  userMessage: data => ({ ...data, role: 'user' }),
  nativeExecutor: ctx => ({ kind: 'native', ctx }),
};
const usage = { inputTokens: 30, outputTokens: 15, cacheReadTokens: 5 };

async function fixture(t, exercise, options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-edu-agent-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const runs = [];
  let withoutInitiator = false;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'code' }) },
    sessions: {
      flush: async session => { session.flushed = true; },
    },
    agents: {
      withoutInitiator(fn) {
        withoutInitiator = true;
        return fn();
      },
      async create(createOptions) {
        assert(withoutInitiator);
        const callbacks = new Map();
        const toolDefinitions = new Map();
        const record = { createOptions, toolDefinitions };
        runs.push(record);
        const session = {
          append(type, data) {
            callbacks.get('session/event')?.(session, { type, data });
          },
        };
        let idle = Promise.resolve();
        const agent = {
          session,
          followup(message) {
            record.message = message;
            idle = exercise({
              record,
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
              call(name, args = {}) {
                const exec = { name, agent, signal: createOptions.signal };
                assert.equal(record.guard(exec), undefined);
                return toolDefinitions.get(name).execute(args, exec);
              },
              signal: createOptions.signal,
              retry: () => callbacks.get('agent/request-error')({}, () => ({ kind: 'retry' })),
            });
          },
          whenIdle: () => idle,
          cancel(cause) { record.cancel = cause; },
        };
        createOptions.setup({
          on(name, callback) { callbacks.set(name, callback); },
          tools: {
            restrict(value) { record.restriction = value; },
            guard(value) { record.guard = value; record.agent = agent; },
            setExecutor(value) { record.executor = value.kind; },
            register(value) { toolDefinitions.set(value.name, value); },
          },
        }, agent);
        return { agent, dispose: async () => { record.disposed = true; } };
      },
    },
  };
  return { runs, run: createAgentRunner(ctx, { workspaceRoot, runtimeLoader: async () => sdk, ...options }) };
}

function codeTask(options = {}) {
  return {
    title: '关卡',
    instructions: '返回 42',
    paths: ['src/answer.py'],
    kind: 'code',
    accountRef: 'first',
    taskId: 'task-a',
    readFile: async () => '',
    saveFile: async () => {},
    evaluate: async () => ({ status: 'failed' }),
    ...options,
  };
}

test('每次运行创建独立 Agent，限制可见工具、调用身份和允许的文件', async t => {
  const reads = [];
  const sessions = [];
  const { runs, run } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn, call, retry }) => {
    assert.equal(await beginStep(), 'enter');
    assert.deepEqual([...record.toolDefinitions.keys()],
      ['educoder_read_file', 'educoder_save_file', 'educoder_evaluate']);
    assert.deepEqual(record.restriction, { allow: [] });
    assert.equal(record.executor, 'native');
    for (const name of ['bash', 'read', 'run_code', 'mcp__desktop']) {
      assert(record.guard({ name, agent: record.agent }));
    }
    assert(record.guard({ name: 'educoder_read_file', agent: {} }));
    assert(record.guard({ name: 'educoder_read_file', agent: record.agent, parent: {} }));
    await assert.rejects(call('educoder_read_file', { path: '../.credentials.yaml' }), /工具未完成/);
    const { content } = await call('educoder_read_file', { path: 'src/answer.py' });
    assert(!content.includes('fixture-secret'));
    assert.match(content, /脱敏/);
    assert.equal(await retry(), undefined);
    finishStep(usage);
    finishTurn();
  });
  const makeTask = accountRef => codeTask({
    accountRef,
    instructions: 'Cookie: fake-instructions-token',
    readFile: async path => { reads.push([accountRef, path]); return 'Cookie: fixture-secret'; },
    onSession: sessionId => { sessions.push(sessionId); },
  });
  const results = await Promise.all([run(makeTask('first')), run(makeTask('second')), run(makeTask('first'))]);
  assert.deepEqual(results.map(result => result.status), ['finished', 'finished', 'finished']);
  assert.deepEqual(results.map(result => result.tokens), [50, 50, 50]);
  assert.equal(new Set(sessions).size, 3);
  assert.equal(new Set(runs.map(record => record.createOptions.meta.cwd)).size, 3);
  assert.equal(reads.filter(([account]) => account === 'first').length, 2);
  assert.equal(reads.filter(([account]) => account === 'second').length, 1);
  assert(runs.every(record => !JSON.stringify(record.message).includes('fake-instructions-token')));
  assert(runs.every(record => record.agent.session.flushed && record.disposed));
});

test('评测结果未知时，Agent 无法在本次运行重放提交或保存', async t => {
  let evaluations = 0;
  let writes = 0;
  const { run } = await fixture(t, async ({ beginStep, finishStep, finishTurn, call }) => {
    assert.equal(await beginStep(), 'enter');
    await assert.rejects(call('educoder_evaluate'), error => {
      assert(!error.message.includes('fake-session-token'));
      return true;
    });
    await assert.rejects(call('educoder_evaluate'));
    await assert.rejects(call('educoder_save_file', { path: 'src/answer.py', content: 'print(42)' }));
    finishStep(usage);
    finishTurn();
  });
  const result = await run(codeTask({
    evaluate: async () => { evaluations++; throw new Error('Cookie: fake-session-token'); },
    saveFile: async () => { writes++; },
  }));
  assert.equal(result.status, 'finished');
  assert.equal(evaluations, 1);
  assert.equal(writes, 0);
});

test('只在已确认评测失败后允许修复，待核验时关停写入', async t => {
  let evaluations = 0;
  let writes = 0;
  const { run } = await fixture(t, async ({ beginStep, finishStep, finishTurn, call }) => {
    assert.equal(await beginStep(), 'enter');
    assert.deepEqual(await call('educoder_evaluate'), { status: 'failed', feedback: '编译失败' });
    assert.deepEqual(await call('educoder_save_file', { path: 'src/answer.py', content: 'print(42)' }), { saved: true });
    assert.deepEqual(await call('educoder_evaluate'), { status: 'pending', feedback: '' });
    await assert.rejects(call('educoder_evaluate'));
    finishStep(usage);
    finishTurn();
  });
  await run(codeTask({
    evaluate: async () => ++evaluations === 1 ? { status: 'failed', feedback: '编译失败' } : { status: 'pending' },
    saveFile: async () => { writes++; },
  }));
  assert.equal(evaluations, 2);
  assert.equal(writes, 1);
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

test('专用实例的全局工具边界仅临时授权正在运行的 Agent 对象', async t => {
  let globalGuard;
  const toolBoundary = installEduCoderToolBoundary({
    tools: { guard(guard) { globalGuard = guard; return () => { globalGuard = undefined; }; } },
  });
  t.after(toolBoundary.dispose);
  const { runs, run } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    const exec = { name: 'educoder_evaluate', agent: record.agent };
    assert.equal(globalGuard(exec), undefined);
    assert(globalGuard({ ...exec, agent: {} }));
    assert(globalGuard({ ...exec, parent: {} }));
    assert(globalGuard({ ...exec, name: 'bash' }));
    assert(globalGuard({ name: 'educoder_evaluate' }));
    assert.equal(await beginStep(), 'enter');
    finishStep(usage);
    finishTurn();
  }, { toolBoundary });
  assert.equal((await run(codeTask())).status, 'finished');
  assert(globalGuard({ name: 'educoder_evaluate', agent: runs[0].agent }));
});
