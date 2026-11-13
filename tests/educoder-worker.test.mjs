import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createScheduler } from '../plugins/educoder/scheduler.js';
import { createWorkers } from '../plugins/educoder/worker.js';

const account = {
  a: { remoteUserId: '1001', session: 'private-session-alice' },
  b: { remoteUserId: '1002', session: 'private-session-bob' },
};
const scopes = {
  a: { accountId: 'a', courseId: 'course-a', homeworkId: '51' },
  b: { accountId: 'b', courseId: 'course-b', homeworkId: '52' },
};

function exercise(accountId, index, options = {}) {
  const { courseId, homeworkId } = scopes[accountId];
  const remoteUserId = account[accountId].remoteUserId;
  const kind = options.kind ?? 'code';
  return {
    binding: {
      courseId, homeworkId, taskId: 'game-' + accountId + index,
      remoteUserId, practiceId: 'practice-' + accountId,
      gameId: remoteUserId + index, challengeId: String(500 + index),
    },
    state: options.state ?? 'pending',
    evaluating: false,
    kind,
    terminalAvailable: kind === 'terminal' || options.terminalUnavailable === true,
    terminalUnavailable: options.terminalUnavailable === true,
    title: 'Fixture ' + accountId + '/' + index,
    instructions: 'Fixture only ' + account[accountId].session,
    paths: options.paths ?? (kind === 'code' ? ['src/main.py'] : []),
    marker: options.marker ?? '0',
    nextTaskId: options.nextTaskId,
    imagesUnavailable: options.imagesUnavailable ?? false,
    loseResponse: options.loseResponse ?? false,
    failFirst: options.failFirst ?? false,
    afterAccepted: options.afterAccepted,
    publicTests: options.publicTests,
    files: new Map(),
    reads: 0,
    builds: 0,
  };
}

function fixture(t, exercises, runAgent, { nativeTools = false, extended = false, readSaveEvidence, maxStages, inspectBrowser, pollAttempts = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-educoder-worker-'));
  const path = join(dir, 'queue.sqlite');
  const byGame = new Map(exercises.map(stage => [stage.binding.taskId, stage]));
  const actions = [];
  let queue;
  t.after(async () => {
    await queue?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accounts = {
    async withSession(id, callback, options) {
      assert.equal(options.worker, true);
      assert.ok(Object.hasOwn(account, id));
      return callback(account[id]);
    },
  };

  function getStage(session, scope) {
    const stage = scope.binding
      ? byGame.get(scope.binding.taskId)
      : exercises.find(({ binding }) => binding.courseId === scope.courseId && binding.homeworkId === scope.homeworkId);
    assert.ok(stage);
    assert.equal(stage.binding.remoteUserId, session.remoteUserId);
    if (scope.binding) assert.deepEqual(stage.binding, scope.binding);
    return stage;
  }

  const transport = {
    async inspect(session, scope, { signal }) {
      signal.throwIfAborted();
      let stage = getStage(session, scope);
      if (scope.advanceTo) {
        assert.equal(stage.state, 'passed');
        assert.equal(stage.nextTaskId, scope.advanceTo);
        actions.push(['advance', stage.binding.taskId, scope.advanceTo]);
        stage = getStage(session, { binding: byGame.get(scope.advanceTo).binding });
      }
      stage.reads++;
      await stage.onInspect?.(stage);
      const { binding, state, evaluating, marker, nextTaskId, kind, title, instructions, paths, terminalAvailable, failedVerdict, imagesUnavailable } = stage;
      return structuredClone({
        binding, state, evaluating, marker, nextTaskId: state === 'passed' ? nextTaskId : undefined, failedVerdict,
        kind, title, instructions, paths, terminalAvailable, imagesUnavailable,
        feedback: { compiler: session.session, publicTests: stage.publicTests },
      });
    },
    async readFile(session, scope, file) {
      const stage = getStage(session, scope);
      assert.ok(stage.paths.includes(file));
      return stage.files.get(file) ?? '# fixture ' + session.session;
    },
    async saveFile(session, scope, file, content, { signal }) {
      signal.throwIfAborted();
      const stage = getStage(session, scope);
      assert.ok(stage.paths.includes(file));
      assert.equal(stage.kind, 'code');
      actions.push(['save', stage.binding.taskId, file]);
      stage.files.set(file, content);
      if (stage.loseSave) throw Object.assign(new Error('response lost'), { code: 'uncertain' });
      return { taskId: stage.binding.taskId, remoteUserId: session.remoteUserId, file };
    },
    async recoverCodeWrite(session, scope, { path: file, content, marker }, { readCurrent }) {
      const stage = getStage(session, scope);
      assert.equal(marker, stage.marker);
      if (!stage.canRecover) throw Object.assign(new Error('not yet readable'), { code: 'uncertain' });
      actions.push(['readback', stage.binding.taskId, file]);
      if (readCurrent && stage.files.get(file) !== content) return undefined;
      assert.equal(stage.files.get(file), content);
      return { taskId: stage.binding.taskId, remoteUserId: session.remoteUserId, file };
    },
    async runTerminal(session, scope, command, { signal }) {
      signal.throwIfAborted();
      const stage = getStage(session, scope);
      assert.equal(stage.terminalAvailable, true);
      assert.equal(command, 'printf fixture');
      actions.push(['terminal', stage.binding.taskId]);
      if (stage.failTerminal) throw Object.assign(new Error('ws dropped'), { code: 'uncertain' });
      if (stage.terminalUnavailable) return { exitCode: 125, output: '没有发出命令', notAvailable: true };
      return {
        exitCode: 0, output: 'fixture output ' + session.session,
        proof: { taskId: stage.binding.taskId, remoteUserId: session.remoteUserId, terminal: true },
      };
    },
    async evaluate(session, scope, proof, { signal }) {
      signal.throwIfAborted();
      const stage = getStage(session, scope);
      assert.equal(proof.remoteUserId, session.remoteUserId);
      assert.equal(proof.taskId, stage.binding.taskId);
      if (stage.kind === 'terminal') assert.equal(proof.terminal, true);
      else {
        assert.equal(proof.file, stage.paths.at(-1));
        assert.deepEqual([...stage.files.keys()], stage.paths);
      }
      actions.push(['evaluate', stage.binding.taskId]);
      stage.builds++;
      if (stage.loseResponse) {
        throw Object.assign(new Error('private evaluation response lost'), { code: 'uncertain' });
      }
      stage.state = stage.evaluatePendingStale ? 'pending' : stage.failFirst && stage.builds === 1 ? 'failed' : 'passed';
      stage.marker = String(stage.builds);
      await stage.afterAccepted?.(signal);
    },
  };

  return {
    actions,
    open() {
      queue = createScheduler({
        file: path, concurrency: 2, retryDelayMs: 0, automaticRetries: Boolean(extended || nativeTools),
        ...createWorkers({ transport, accounts, runAgent, inspectBrowser, extended: Boolean(extended || nativeTools), readSaveEvidence, maxStages, pollMs: 1, pollAttempts }),
      });
      return queue;
    },
  };
}

test('保存结果不明时从旧会话读回证据，评测一次且自动续关', async t => {
  const first = exercise('a', 1, { nextTaskId: 'game-a2' });
  const second = exercise('a', 2, { failFirst: true });
  first.loseSave = true;
  const content = 'print(42)';
  let runs = 0;
  const { open, actions } = fixture(t, [first, second], async run => {
    await run.onSession('native-' + ++runs);
    assert.equal(run.sessionResume?.sessionId ?? null, runs === 3 ? 'native-2' : null);
    assert.equal(run.resumeFromPreviousStage, false);
    try {
      await run.saveFile('src/main.py', content, run.signal);
      await run.evaluate(run.signal);
    } catch (error) {
      assert.equal(error.code, 'uncertain');
      first.canRecover = true;
    }
    return { status: 'finished', sessionResume: {
      sessionId: 'native-' + runs, key: 'a'.repeat(64), scopeKey: 'b'.repeat(64),
      lastRequestAt: Date.now(), requestCount: 2,
    } };
  }, { nativeTools: true, readSaveEvidence: async id => {
    assert.equal(id, 'native-1');
    return { path: 'src/main.py', content };
  } });
  const queue = open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'passed');
  assert.equal(runs, 3);
  assert.deepEqual(actions, [
    ['save', 'game-a1', 'src/main.py'], ['readback', 'game-a1', 'src/main.py'], ['evaluate', 'game-a1'],
    ['advance', 'game-a1', 'game-a2'], ['save', 'game-a2', 'src/main.py'], ['evaluate', 'game-a2'],
    ['save', 'game-a2', 'src/main.py'], ['evaluate', 'game-a2'],
  ]);
});

test('平台当前代码与待核验保存不同，自动重新读取后继续且不提交旧版本', async t => {
  const stage = exercise('a', 1);
  stage.loseSave = true;
  let runs = 0;
  const { open, actions } = fixture(t, [stage], async run => {
    await run.onSession('native-' + ++runs);
    if (runs === 1) {
      await assert.rejects(run.saveFile('src/main.py', 'old attempt', run.signal), { code: 'uncertain' });
      stage.files.set('src/main.py', 'current upstream');
      stage.loseSave = false;
      stage.canRecover = true;
    } else {
      assert.equal(await run.readFile('src/main.py', run.signal), 'current upstream');
      await run.saveFile('src/main.py', 'new attempt', run.signal);
      assert.equal((await run.evaluate(run.signal)).status, 'passed');
    }
    return { status: 'finished' };
  }, { nativeTools: true, readSaveEvidence: async () => ({ path: 'src/main.py', content: 'old attempt' }) });
  const queue = open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'passed');
  assert.equal(runs, 2);
  assert.deepEqual(actions.map(([kind]) => kind), ['save', 'readback', 'save', 'evaluate']);
});

async function expectState(queue, id, status) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const task = queue.get(id);
    if (task.status === status) return task;
    assert.ok(Date.now() < deadline, `expected ${status}, reached ${task.status}/${task.code}`);
    await wait(5);
  }
}

test('已核验失败可跨重启继续同一会话，提交仍需本轮证明且下一关新建会话', async t => {
  const first = exercise('a', 1, { failFirst: true, nextTaskId: 'game-a2' });
  const second = exercise('a', 2);
  const resume = {
    sessionId: 'first-session', key: 'a'.repeat(64), requestCount: 3, lastRequestAt: Date.now(),
  };
  let attempts = 0;
  const { open, actions } = fixture(t, [first, second], async agent => {
    attempts++;
    const sameStage = attempts <= 2;
    assert.deepEqual(agent.sessionResume, attempts === 2 ? resume : null);
    await agent.onSession(sameStage ? resume.sessionId : 'second-session');
    assert.equal((await agent.evaluate(agent.signal)).status, 'not_ready');
    await agent.saveFile('src/main.py', 'print(42)', agent.signal);
    assert.equal((await agent.evaluate(agent.signal)).status, attempts === 1 ? 'failed' : 'passed');
    return { status: 'finished', sessionResume: sameStage ? resume : undefined };
  });
  let queue = open();
  const [task] = queue.enqueueBatch([scopes.a], { start: true });
  const failure = await expectState(queue, task.id, 'failed');
  assert.equal(failure.code, 'verification_failed');
  assert.equal(failure.sessionId, resume.sessionId);
  assert.equal(failure.sessionResume, undefined);
  await queue.close();
  queue = open();
  queue.resume(task.id);
  const passed = await expectState(queue, task.id, 'passed');
  assert.equal(passed.sessionId, 'second-session');
  assert.equal(attempts, 3);
  assert.deepEqual(actions.filter(([name]) => name === 'evaluate'), [
    ['evaluate', 'game-a1'], ['evaluate', 'game-a1'], ['evaluate', 'game-a2'],
  ]);
});

for (const maxStages of [1, 8]) {
  test(`原生作业在单轮最多 ${maxStages} 关时，继承已通过关卡的会话并刷新当前关卡的重试状态`, async t => {
    const first = exercise('a', 1, { nextTaskId: 'game-a2' });
    const second = exercise('a', 2, { failFirst: true });
    const sessionId = 'native-shared-session';
    const scopeKey = 'b'.repeat(64);
    const stages = [];
    let candidate = null;
    const { open, actions } = fixture(t, [first, second], async agent => {
      const call = stages.length;
      stages.push([agent.stageId, agent.resumeFromPreviousStage]);
      assert.deepEqual(agent.sessionResume, candidate);
      await agent.onSession(sessionId);
      assert.equal((await agent.evaluate(agent.signal)).status, 'not_ready');
      await agent.saveFile('src/main.py', 'print(42)', agent.signal);
      assert.equal((await agent.evaluate(agent.signal)).status, call === 1 ? 'failed' : 'passed');
      candidate = {
        sessionId, scopeKey, key: (call === 0 ? 'a' : 'c').repeat(64), lastRequestAt: Date.now(),
        requestCount: 2 * (call + 1),
      };
      return { status: 'finished', sessionResume: candidate };
    }, { nativeTools: true, maxStages });
    const queue = open();
    const task = queue.enqueue(scopes.a, { start: true });
    assert.equal((await expectState(queue, task.id, 'passed')).sessionId, sessionId);
    assert.deepEqual(stages, [['game-a1', false], ['game-a2', true], ['game-a2', false]]);
    assert.deepEqual(actions.filter(([name]) => name === 'evaluate'), [
      ['evaluate', 'game-a1'], ['evaluate', 'game-a2'], ['evaluate', 'game-a2'],
    ]);
  });
}

test('首次解题仅收到公开输入和期望输出，评测后继续提供实际输出', async t => {
  const stage = exercise('a', 1, {
    publicTests: [{ input: '3\n', expected: '6\n', actual: 'stale output' }, { actual: 'without sample' }],
  });
  const context = fixture(t, [stage], async run => {
    assert.deepEqual(run.examples, [{ input: '3\n', expected: '6\n' }]);
    await run.saveFile('src/main.py', 'print(int(input())*2)', run.signal);
    stage.publicTests = [{ input: '3\n', expected: '6\n', actual: '6\n' }];
    const result = await run.evaluate(run.signal);
    assert.equal(result.status, 'passed');
    assert.deepEqual(JSON.parse(result.feedback), { compiler: '[已脱敏]', tests: stage.publicTests });
    return { status: 'finished' };
  });
  const queue = context.open();
  const task = queue.enqueue(scopes.a, { start: true });
  assert.ok((await expectState(queue, task.id, 'passed')).verifiedAt);
});

test('丢失提交响应后重启仅核验，旧失败证据不可重放，远端确认才可推进', { timeout: 8000 }, async t => {
  const first = exercise('a', 1, { nextTaskId: 'game-a2', state: 'failed', marker: '7', loseResponse: true });
  const second = exercise('a', 2);
  let agentRuns = 0;
  const context = fixture(t, [first, second], async run => {
    await run.onSession('test-session-' + ++agentRuns);
    assert.ok(!run.instructions.includes(account.a.session));
    await run.saveFile('src/main.py', 'print("fixture")', run.signal);
    try {
      await run.evaluate(run.signal);
    } catch (error) {
      assert.equal(error.code, 'uncertain');
    }
    return { status: 'finished' };
  });
  let queue = context.open();
  const task = queue.enqueue(scopes.a, { start: true });
  const ambiguous = await expectState(queue, task.id, 'manual');
  assert.equal(ambiguous.code, 'verification_pending');
  assert.equal(ambiguous.sessionId, 'test-session-1');
  assert.equal(first.builds, 1);
  assert.equal(second.reads, 0);
  const beforeRestart = first.reads;
  await queue.close();

  queue = context.open();
  assert.equal(queue.get(task.id).status, 'manual');
  queue.resume(task.id);
  const stillAmbiguous = await expectState(queue, task.id, 'manual');
  assert.equal(stillAmbiguous.code, 'verification_pending');
  assert.ok(first.reads > beforeRestart);
  assert.equal(agentRuns, 1);
  assert.equal(first.builds, 1);
  assert.equal(second.reads, 0);

  first.marker = '6';
  queue.resume(task.id);
  assert.equal((await expectState(queue, task.id, 'manual')).code, 'verification_pending');
  assert.equal(first.builds, 1);
  assert.equal(agentRuns, 1);

  first.state = 'passed';
  first.marker = '8';
  queue.resume(task.id);
  const completed = await expectState(queue, task.id, 'passed');
  assert.ok(completed.verifiedAt);
  assert.equal(completed.attempts, 1);
  assert.equal(completed.sessionId, 'test-session-2');
  assert.deepEqual(context.actions, [
    ['save', 'game-a1', 'src/main.py'], ['evaluate', 'game-a1'], ['advance', 'game-a1', 'game-a2'],
    ['save', 'game-a2', 'src/main.py'], ['evaluate', 'game-a2'],
  ]);
});

test('两个账号通过各自工作流执行多文件和远端终端模拟题', { timeout: 8000 }, async t => {
  const files = exercise('a', 1, { paths: ['src/main.py', 'src/util.py'] });
  const terminal = exercise('b', 1, { kind: 'terminal' });
  const seen = [];
  const context = fixture(t, [files, terminal], async run => {
    seen.push(run.accountRef);
    const session = account[run.accountRef].session;
    await run.onSession('fixture-agent-' + run.accountRef);
    if (run.kind === 'terminal') {
      const result = await run.runTerminal('printf fixture', run.signal);
      assert.equal(result.exitCode, 0);
      assert.ok(!result.output.includes(session));
    } else {
      for (const path of run.paths) {
        const content = await run.readFile(path, run.signal);
        assert.ok(!content.includes(session));
        await run.saveFile(path, 'changed: ' + path, run.signal);
      }
    }
    const result = await run.evaluate(run.signal);
    assert.equal(result.status, 'passed');
    assert.ok(!result.feedback.includes(session));
    return { status: 'finished' };
  });
  const queue = context.open();
  const [one, two] = queue.enqueueBatch([scopes.a, scopes.b], { start: true });
  const outcomes = await Promise.all([expectState(queue, one.id, 'passed'), expectState(queue, two.id, 'passed')]);
  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.deepEqual(outcomes.map(task => task.sessionId), ['fixture-agent-a', 'fixture-agent-b']);
  assert.equal(files.builds, 1);
  assert.equal(terminal.builds, 1);
  assert.deepEqual([...files.files], [['src/main.py', 'changed: src/main.py'], ['src/util.py', 'changed: src/util.py']]);
  assert.deepEqual(context.actions.filter(([, target]) => target === 'game-b1'), [
    ['terminal', 'game-b1'], ['evaluate', 'game-b1'],
  ]);
  assert.ok(!JSON.stringify(outcomes).includes('private-session'));
});

test('终端命令未发出时保留同一关卡原有代码保存证明', { timeout: 8000 }, async t => {
  const stage = exercise('a', 1, { terminalUnavailable: true });
  const context = fixture(t, [stage], async run => {
    await run.onSession('test-hybrid-fallback');
    await run.saveFile('src/main.py', 'print("fixture")', run.signal);
    assert.equal((await run.runTerminal('printf fixture', run.signal)).exitCode, 125);
    assert.equal((await run.evaluate(run.signal)).status, 'passed');
    return { status: 'finished' };
  });
  const queue = context.open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'passed');
  assert.deepEqual(context.actions.map(([action]) => action), ['save', 'terminal', 'evaluate']);
});

test('混合关卡保存后再运行终端命令，默认评测保存的代码', async t => {
  const stage = exercise('a', 1);
  stage.terminalAvailable = true;
  const { open, actions } = fixture(t, [stage], async run => {
    await run.saveFile('src/main.py', 'print(42)', run.signal);
    assert.equal((await run.runTerminal('printf fixture', run.signal)).exitCode, 0);
    assert.equal((await run.evaluate(run.signal)).status, 'passed');
    return { status: 'finished' };
  }, { nativeTools: true });
  const queue = open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'passed');
  assert.deepEqual(actions.map(([action]) => action), ['save', 'terminal', 'evaluate']);
});

test('平台状态为未通过时，两次一致的新用例判定可核验失败，不重复提交', { timeout: 8000 }, async t => {
  const stage = exercise('a', 1, { loseResponse: true, marker: '1' });
  const context = fixture(t, [stage], async run => {
    await run.saveFile('src/main.py', 'print(1)', run.signal);
    await assert.rejects(run.evaluate(run.signal), { code: 'uncertain' });
    return { status: 'finished' };
  });
  const queue = context.open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'manual');
  stage.failedVerdict = 'same-platform-verdict';
  queue.resume(task.id);
  assert.equal((await expectState(queue, task.id, 'manual')).code, 'verification_pending');
  stage.marker = '2';
  const beforeReads = stage.reads;
  queue.resume(task.id);
  assert.equal((await expectState(queue, task.id, 'failed')).code, 'verification_failed');
  assert.equal(stage.reads - beforeReads, 2);
  assert.equal(stage.builds, 1);
});

test('关机中断在途评测后，新进程自动读回已接受提交', { timeout: 8000 }, async t => {
  const submitted = Promise.withResolvers();
  const stage = exercise('a', 1, {
    afterAccepted(signal) {
      submitted.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  let agentRuns = 0;
  const context = fixture(t, [stage], async run => {
    await run.onSession('restart-session-' + ++agentRuns);
    await run.saveFile('src/main.py', 'print(1)', run.signal);
    await run.evaluate(run.signal);
    return { status: 'finished' };
  });
  let queue = context.open();
  const task = queue.enqueue(scopes.a, { start: true });
  await submitted.promise;
  assert.equal(queue.get(task.id).status, 'running');
  const readsBefore = stage.reads;
  await queue.close();
  queue = context.open();
  const verified = await expectState(queue, task.id, 'passed');
  assert.equal(stage.builds, 1);
  assert.equal(agentRuns, 1);
  assert.equal(stage.reads, readsBefore + 1);
  assert.equal(verified.sessionId, 'restart-session-1');
  assert.ok(verified.events.some(event => event.code === 'recovery_required'));
});

test('二评期间平台暂留旧 failedVerdict 且为 pending 时不误判失败，终态通过可正常检出', { timeout: 8000 }, async t => {
  const stage = exercise('a', 1, { state: 'failed', marker: '1' });
  stage.failedVerdict = 'eval-1-stale-hash';
  stage.builds = 1;
  stage.evaluatePendingStale = true;
  let pollsAfterSecondBuild = 0;
  stage.onInspect = () => {
    if (stage.builds === 2 && ++pollsAfterSecondBuild >= 3) {
      stage.state = 'passed';
      stage.failedVerdict = null;
    }
  };
  const { open } = fixture(t, [stage], async run => {
    assert.equal(run.inspectBrowser, undefined);
    await run.saveFile('src/main.py', 'v2', run.signal);
    const result = await run.evaluate(run.signal);
    assert.equal(result.status, 'passed');
    return { status: 'finished' };
  }, { pollAttempts: 6, inspectBrowser: async () => ({ text: 'unused' }) });
  const queue = open();
  const task = queue.enqueue(scopes.a, { start: true });
  await expectState(queue, task.id, 'passed');
  assert.ok(pollsAfterSecondBuild >= 3);
});

test('代码题保存成功清除 write 检查点，辅助终端断连不锁死后续保存与评测', { timeout: 8000 }, async t => {
  const stage = exercise('a', 1);
  stage.terminalAvailable = true;
  stage.failTerminal = true;
  let runs = 0;
  const { open } = fixture(t, [stage], async run => {
    runs++;
    if (runs === 1) {
      await run.saveFile('src/main.py', 'saved-without-eval', run.signal);
      return { status: 'failed' };
    }
    await assert.rejects(run.runTerminal('printf fixture', run.signal), { code: 'uncertain' });
    await run.saveFile('src/main.py', 'final-code', run.signal);
    assert.equal((await run.evaluate(run.signal)).status, 'passed');
    return { status: 'finished' };
  });
  const queue = open();
  const task = queue.enqueue(scopes.a, { start: true });
  const failed = await expectState(queue, task.id, 'failed');
  assert.equal(failed.code, 'agent_failed');
  assert.equal(failed.mutation, undefined);
  queue.resume(task.id);
  const completed = await expectState(queue, task.id, 'passed');
  assert.equal(completed.mutation, undefined);
  assert.equal(stage.files.get('src/main.py'), 'final-code');
});

test('仅在不支持接口或题面缺图时向下层 Agent 暴露 educoder_browser', { timeout: 8000 }, async t => {
  const manualStage = exercise('a', 1, { kind: 'manual' });
  const overflowImageStage = exercise('b', 1, { imagesUnavailable: true });
  let manualBrowser = false;
  let overflowBrowser = false;
  const { open } = fixture(t, [manualStage, overflowImageStage], async run => {
    if (run.taskId.startsWith('')) {
      if (run.kind === 'browser') {
        assert.equal(typeof run.inspectBrowser, 'function');
        await run.inspectBrowser(run.signal);
        manualBrowser = true;
        manualStage.state = 'passed';
      } else {
        assert.equal(typeof run.inspectBrowser, 'function');
        await run.inspectBrowser(run.signal);
        overflowBrowser = true;
        await run.saveFile('src/main.py', 'ok', run.signal);
        await run.evaluate(run.signal);
      }
    }
    return { status: 'finished' };
  }, { inspectBrowser: async () => ({ text: '网页正文' }) });
  const queue = open();
  const [t1, t2] = queue.enqueueBatch([scopes.a, scopes.b], { start: true });
  await Promise.all([expectState(queue, t1.id, 'passed'), expectState(queue, t2.id, 'passed')]);
  assert.equal(manualBrowser, true);
  assert.equal(overflowBrowser, true);
});
