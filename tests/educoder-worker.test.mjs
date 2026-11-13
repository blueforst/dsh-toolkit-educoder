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
    terminalAvailable: kind === 'terminal',
    title: 'Fixture ' + accountId + '/' + index,
    instructions: 'Fixture only ' + account[accountId].session,
    paths: options.paths ?? (kind === 'code' ? ['src/main.py'] : []),
    marker: options.marker ?? '0',
    nextTaskId: options.nextTaskId,
    loseResponse: options.loseResponse ?? false,
    afterAccepted: options.afterAccepted,
    files: new Map(),
    reads: 0,
    builds: 0,
  };
}

function fixture(t, exercises, runAgent) {
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
      const { binding, state, evaluating, marker, nextTaskId, kind, title, instructions, paths, terminalAvailable } = stage;
      return structuredClone({
        binding, state, evaluating, marker, nextTaskId: state === 'passed' ? nextTaskId : undefined,
        kind, title, instructions, paths, terminalAvailable, feedback: { compiler: session.session },
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
      return { taskId: stage.binding.taskId, remoteUserId: session.remoteUserId, file };
    },
    async runTerminal(session, scope, command, { signal }) {
      signal.throwIfAborted();
      const stage = getStage(session, scope);
      assert.equal(stage.kind, 'terminal');
      assert.equal(command, 'printf fixture');
      actions.push(['terminal', stage.binding.taskId]);
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
      stage.state = 'passed';
      stage.marker = String(stage.builds);
      await stage.afterAccepted?.(signal);
    },
  };

  return {
    actions,
    open() {
      queue = createScheduler({
        file: path, concurrency: 2, retryDelayMs: 0,
        ...createWorkers({ transport, accounts, runAgent, pollMs: 1, pollAttempts: 2 }),
      });
      return queue;
    },
  };
}

async function expectState(queue, id, status) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const task = queue.get(id);
    if (task.status === status) return task;
    assert.ok(Date.now() < deadline, `expected ${status}, reached ${task.status}/${task.code}`);
    await wait(5);
  }
}

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
  const verifiedFirst = await expectState(queue, task.id, 'paused');
  assert.equal(verifiedFirst.code, 'next_stage');
  assert.equal(verifiedFirst.verifiedAt, null);
  assert.equal(second.reads, 0);
  queue.resume(task.id);
  const completed = await expectState(queue, task.id, 'passed');
  assert.ok(completed.verifiedAt);
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
