import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentRunner, installEduCoderToolBoundary } from '../plugins/educoder/agent.js';

class SessionNotFound extends Error {}
const sdk = {
  sessionId: value => value,
  sessionNotFound: SessionNotFound,
  userMessage: data => ({ ...data, role: 'user' }),
  nativeExecutor: ctx => ({ kind: 'native', ctx }),
  installModelSelection() {},
};
const usage = { inputTokens: 30, outputTokens: 15, cacheReadTokens: 5 };

async function fixture(t, exercise, options = {}, context = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-edu-agent-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const runs = [];
  const stored = new Map();
  const resumeAttempts = [];
  let withoutInitiator = false;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'code' }) },
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
      async resume(options) {
        resumeAttempts.push(options.resumeSessionId);
        const previous = stored.get(options.resumeSessionId);
        if (!previous) throw new SessionNotFound();
        return this.create({ ...options, meta: previous.header, sessionId: options.resumeSessionId }, previous);
      },
      async create(createOptions, previous) {
        assert(withoutInitiator);
        const callbacks = new Map();
        const toolDefinitions = new Map();
        const record = { createOptions, toolDefinitions, previous };
        runs.push(record);
        const session = {
          header: createOptions.meta,
          deriveMessages: () => previous?.messages ?? [],
          append(type, data) {
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
        await createOptions.setup({
          on(name, callback) { callbacks.set(name, callback); },
          tools: {
            restrict(value) { record.restriction = value; },
            guard(value) { record.guard = value; record.agent = agent; },
            setExecutor(value) { record.executor = value.kind; },
            register(value) { toolDefinitions.set(value.name, value); },
          },
        }, agent);
        return { agent, dispose: async () => {
          record.disposed = true;
          if (session.flushed && record.message) stored.set(createOptions.sessionId, {
            header: session.header, messages: [...session.deriveMessages(), record.message],
          });
        } };
      },
    },
  };
  return { runs, stored, resumeAttempts,
    run: createAgentRunner(ctx, { workspaceRoot, runtimeLoader: async () => sdk, ...options }) };
}

test('将题面图按顺序作为真实图片附件加入模型消息', async t => {
  const loaded = [Buffer.from('first-image'), Buffer.from('second-image')]
    .map(data => ({ data, mediaType: 'image/png' }));
  const refs = [{ attachmentId: 'first' }, { attachmentId: 'second' }];
  const { run } = await fixture(t, async ({ record, finishTurn }) => {
    assert.match(record.message.content[0].text, /\[参考图 1\]/);
    assert.deepEqual(record.message.content.slice(1), refs.map(attachment => ({ type: 'image', attachment })));
    finishTurn();
  }, {}, {
    llm: { async resolveModelInfo(provider, model) {
      assert.equal(provider, 'fixture');
      assert.equal(model, 'code');
      return { inputModalities: ['text', 'image'] };
    } },
    attachments: { async saveImages(images) { assert.deepEqual(images, loaded); return refs; } },
  });
  assert.equal((await run(codeTask({ instructions: '根据 [参考图 1] 和 [参考图 2] 解题。',
    imageCount: 2, loadImages: async () => loaded,
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

test('模型可自行调用关卡浏览器，并在头歌通过后才记录一次经验', async t => {
  const attached = [];
  const saved = [];
  const root = await mkdtemp(join(tmpdir(), 'dsh-edu-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { run, runs } = await fixture(t, async ({ record, call, finishTurn }) => {
    assert.match(record.message.content[0].text, /既往经验/);
    assert.deepEqual(await call('educoder_record_experience', { note: '尚未核验' }), { saved: false });
    assert.deepEqual(await call('educoder_browser'), { text: '当前关卡页面', error: '' });
    assert.equal((await call('educoder_evaluate')).status, 'passed');
    assert.deepEqual(await call('educoder_record_experience', { note: '通用解题方法' }), { saved: true });
    assert.deepEqual(await call('educoder_record_experience', { note: '重复记录' }), { saved: false });
    finishTurn();
  }, {
    experience: Promise.resolve({ root, workspace: { async attachSession(id) { attached.push(id); } },
      read: async () => '阅读公开样例。' }),
  });
  assert.equal((await run(codeTask({
    inspectBrowser: async () => ({ text: '当前关卡页面' }),
    evaluate: async () => ({ status: 'passed' }),
    recordExperience: async note => { saved.push(note); return { saved: true }; },
  }))).status, 'finished');
  assert.equal(runs[0].createOptions.meta.cwd, root);
  assert.deepEqual(attached, [runs[0].createOptions.sessionId]);
  assert.deepEqual(saved, ['通用解题方法']);
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
  assert.equal((await run(codeTask({ examples: [
    { input: ' 3\n', expected: '6\n' },
    { expected: 'api_key=private-value' },
  ] }))).status, 'finished');
});

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

test('同一关卡短时重试恢复历史、重新授权工具并跳过归档、过期和缺失会话', async t => {
  const archivedSessionIds = [];
  let pictureLoads = 0;
  const picture = { attachmentId: 'one' };
  const { run, runs, stored, resumeAttempts } = await fixture(t, async ({
    record, beginStep, finishStep, finishTurn, call,
  }) => {
    assert.equal(await beginStep(), 'enter');
    if (record.previous) {
      assert.match(record.message.content[0].text, /继续当前关卡/);
      assert.equal(record.message.content.length, 1);
      assert.match(record.previous.messages[0].content[0].text, /第一张图/);
      assert.equal((await call('educoder_read_file', { path: 'src/answer.py' })).content, 'retry');
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
  const second = await run({ ...task, sessionResume: first.sessionResume, readFile: async () => 'retry' });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionResume.requestCount, 2);
  assert.equal(pictureLoads, 1);
  assert.notEqual(runs[0].agent, runs[1].agent);
  assert(runs[1].guard({ name: 'educoder_read_file', agent: runs[0].agent }));
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

test('模型先点评测时，可根据缺少修改的提示保存代码后再提交', async t => {
  let saved = false;
  const { run } = await fixture(t, async ({ call, finishTurn }) => {
    assert.equal((await call('educoder_evaluate')).status, 'not_ready');
    assert.deepEqual(await call('educoder_save_file', { path: 'src/answer.py', content: 'print(42)' }), { saved: true });
    assert.equal((await call('educoder_evaluate')).status, 'passed');
    finishTurn();
  });
  assert.equal((await run(codeTask({
    saveFile: async () => { saved = true; },
    evaluate: async () => ({ status: saved ? 'passed' : 'not_ready' }),
  }))).status, 'finished');
});

test('同一作业的已核验下一关复用会话，加载新题图并替换关卡工具', async t => {
  const sent = [];
  const { run, resumeAttempts } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn, call }) => {
    await beginStep();
    sent.push(record.message);
    if (sent.length === 2) {
      assert.match(record.message.content[0].text, /上一关已通过/);
      assert.match(record.message.content[0].text, /第二关题面/);
      assert.deepEqual(record.message.content[1], { type: 'image', attachment: { attachmentId: 'second' } });
      await assert.rejects(call('educoder_read_file', { path: 'first.py' }));
      assert.equal((await call('educoder_read_file', { path: 'second.py' })).content, 'second');
    }
    finishStep(usage);
    finishTurn();
  }, { nativeTools: true }, {
    get(name) {
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }), mount: async () => {},
        presetForSession: session => session.header.agentPreset };
      if (name === 'permissionPresets') return { set: () => {} };
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: { saveImages: async () => [{ attachmentId: 'second' }] },
  });
  const common = { taskId: 'homework', accountRef: 'account' };
  const first = await run(codeTask({ ...common, stageId: 'one', paths: ['first.py'] }));
  const second = await run(codeTask({ ...common, stageId: 'two', paths: ['second.py'], instructions: '第二关题面',
    imageCount: 1, loadImages: async () => [Buffer.from('second')], readFile: async () => 'second',
    resumeFromPreviousStage: true, sessionResume: first.sessionResume,
  }));
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionResume.requestCount, 2);
  assert.deepEqual(resumeAttempts, [first.sessionId]);
  const another = await run(codeTask({ ...common, taskId: 'other-homework', stageId: 'three',
    resumeFromPreviousStage: true, sessionResume: second.sessionResume }));
  assert.notEqual(another.sessionId, second.sessionId);
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

test('扩展预算模式不挂载原生工具或 educoder_browser_action，仅暴露关卡工具', async t => {
  const { run } = await fixture(t, async ({ record, beginStep, finishStep, finishTurn }) => {
    assert.equal(await beginStep(), 'enter');
    assert.deepEqual(record.restriction, { allow: [] });
    assert.equal(record.executor, 'native');
    assert.deepEqual([...record.toolDefinitions.keys()],
      ['educoder_read_file', 'educoder_save_file', 'educoder_evaluate']);
    for (const forbidden of ['bash', 'read', 'write', 'browser_open', 'educoder_browser_action']) {
      assert(record.guard({ name: forbidden, agent: record.agent }));
    }
    finishStep(usage);
    finishTurn();
  }, { extended: true });
  assert.equal((await run(codeTask({ controlBrowser: async () => ({ text: '', controls: [] }) }))).status, 'finished');
});

test('超图限制仍保留前几张有效参考图并附加提示，终端失败不锁死代码保存和评测', async t => {
  const loaded = [Buffer.from('one'), Buffer.from('two')].map(data => ({ data, mediaType: 'image/png' }));
  const refs = [{ attachmentId: 'one' }, { attachmentId: 'two' }];
  const { run } = await fixture(t, async ({ record, call, finishTurn }) => {
    assert.match(record.message.content[0].text, /部分题面附图未能全部内联/);
    assert.deepEqual(record.message.content.slice(1), refs.map(attachment => ({ type: 'image', attachment })));
    await assert.rejects(call('educoder_terminal', { command: 'ls' }), /接口暂时不可用/);
    assert.deepEqual(await call('educoder_save_file', { path: 'src/answer.py', content: 'print(42)' }), { saved: true });
    assert.deepEqual(await call('educoder_evaluate'), { status: 'passed', feedback: '' });
    await assert.rejects(call('educoder_evaluate'), /请勿重复写入或提交/);
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
    runTerminal: async () => { throw Object.assign(new Error('ws fail'), { code: 'unavailable' }); },
    evaluate: async () => ({ status: 'passed' }),
  }));
  assert.equal(result.status, 'finished');
});
