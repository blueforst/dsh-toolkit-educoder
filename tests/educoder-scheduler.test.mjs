import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduler } from '../plugins/educoder/scheduler.js';

const target = (accountId, homeworkId = '42') => ({ accountId, courseId: '7', homeworkId });
const bind = (task, taskId = 'game1') => ({
  courseId: task.courseId, homeworkId: task.homeworkId, taskId, practiceId: 'p1',
  remoteUserId: task.accountId === 'a' ? '11' : '22',
  gameId: taskId === 'game1' ? '101' : '102',
  challengeId: taskId === 'game1' ? '201' : '202',
});
const pause = () => ({ status: 'paused' });
const verify = task => ({ status: 'passed', marker: 'verified', binding: task.binding });

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-educoder-queue-'));
  const file = join(dir, 'queue.sqlite');
  let instance;
  t.after(async () => {
    await instance?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    file,
    open(opts) {
      instance = createScheduler({ file, worker: pause, reconcile: pause, retryDelayMs: 0, ...opts });
      return instance;
    },
  };
}

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, 'scheduler did not reach expected state');
    await delay(5);
  }
}

const until = (queue, id, status) => waitFor(() => {
  const value = queue.get(id);
  return value.status === status && value;
});

test('批量入队与启停原子化，重复点击沿用同一任务，跨账号轮换', { timeout: 8000 }, async t => {
  const ran = [];
  const queue = setup(t).open({
    concurrency: 1,
    worker(task) {
      ran.push(task.accountId + ':' + task.homeworkId);
      return pause();
    },
  });
  assert.throws(() => queue.enqueueBatch([target('a'), target('')], { start: true }), { code: 'invalid_input' });
  const release = queue.blockAccount('b');
  assert.throws(() => queue.enqueueBatch([target('a'), target('b')], { start: true }), { code: 'busy' });
  assert.deepEqual(queue.list(), []);
  release();
  const [a1, a2, b1, duplicate] = queue.enqueueBatch([target('a'), target('a', '43'), target('b'), target('a')]);
  assert.equal(duplicate.id, a1.id);
  assert.throws(() => queue.startBatch([a1.id, 'missing']), { code: 'not_found' });
  assert.equal(queue.get(a1.id).status, 'waiting');
  queue.startBatch([a1.id, a2.id, b1.id]);
  assert.equal(queue.start(a1.id).status, 'queued');
  await until(queue, a2.id, 'paused');
  assert.deepEqual(ran, ['a:42', 'b:42', 'a:43']);
  assert.equal(queue.enqueue(target('a'), { start: true }).status, 'paused');
  queue.cancel(a1.id);
  assert.equal(queue.enqueue(target('a'), { start: true }).status, 'cancelled');
  assert.equal(queue.list({ accountId: 'a' }).length, 2);
});

test('跨账号并发，同账号须等已暂停的执行真正退出', { timeout: 8000 }, async t => {
  const pending = new Map();
  const worker = (task, context) => {
    const gate = Promise.withResolvers();
    pending.set(task.id, { ...context, ...gate });
    return gate.promise;
  };
  const queue = setup(t).open({ worker });
  const [a1, a2, b1] = queue.enqueueBatch([target('a'), target('a', '43'), target('b')], { start: true });
  t.after(() => {
    for (const gate of pending.values()) gate.resolve(pause());
  });
  // Ensure gates also resolve before setup's async close hook on assertion failure.
  const bailout = setTimeout(() => {
    for (const gate of pending.values()) gate.resolve(pause());
  }, 3500);
  t.after(() => clearTimeout(bailout));
  await waitFor(() => pending.has(a1.id) && pending.has(b1.id));
  assert.equal(pending.has(a2.id), false);
  const release = queue.blockAccount('a');
  queue.pauseAccount('a');
  assert.equal(pending.get(a1.id).signal.aborted, true);
  assert.throws(() => pending.get(a1.id).checkpoint({ marker: 'late' }), { code: 'cancelled' });
  assert.equal(queue.get(a2.id).status, 'paused');
  assert.throws(() => queue.resume(a2.id), { code: 'busy' });
  let idle = false;
  const waitIdle = queue.waitForAccountIdle('a').then(() => { idle = true; });
  await delay(10);
  assert.equal(idle, false);
  pending.get(a1.id).resolve(pause());
  await waitIdle;
  release();
  queue.resume(a2.id);
  await waitFor(() => pending.has(a2.id));
  assert.equal(queue.get(b1.id).status, 'running');
  pending.get(b1.id).resolve(pause());
  pending.get(a2.id).resolve(pause());
  await until(queue, a2.id, 'paused');
});

test('提交超时只做远端核验，人工恢复也不重复提交', { timeout: 8000 }, async t => {
  let submits = 0;
  let reads = 0;
  let remotePassed = false;
  const queue = setup(t).open({
    timeoutMs: 40,
    worker(task, { signal, checkpoint, current }) {
      checkpoint({ binding: bind(task), marker: '0', sessionId: 'session-a' });
      checkpoint({ mutation: { phase: 'evaluate', marker: '0', cookie: 'private-secret' } });
      assert.equal(current().mutation.phase, 'evaluate');
      submits++;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    reconcile(task, { checkpoint }) {
      reads++;
      assert.equal(task.mutation.phase, 'evaluate');
      assert.throws(() => checkpoint({ mutation: { phase: 'evaluate', marker: '1' } }), { code: 'invalid_scope' });
      return remotePassed ? verify(task) : { status: 'manual', code: 'verification_pending' };
    },
  });
  const task = queue.enqueue(target('a'), { start: true });
  const manual = await until(queue, task.id, 'manual');
  assert.equal(manual.sessionId, 'session-a');
  assert.equal(manual.code, 'verification_pending');
  assert.equal(manual.attempts, 1);
  for (const excluded of ['binding', 'mutation', 'marker', 'private-secret']) {
    assert.ok(!JSON.stringify(manual).includes(excluded));
  }
  queue.resume(task.id);
  await until(queue, task.id, 'manual');
  assert.equal(reads, 2);
  remotePassed = true;
  queue.resume(task.id);
  const passed = await until(queue, task.id, 'passed');
  assert.equal(submits, 1);
  assert.equal(reads, 3);
  assert.ok(passed.verifiedAt);
  assert.equal(passed.events.at(-1).status, 'passed');
});

test('进程崩溃后恢复写入意图，只读核验并保留持久配置', { timeout: 8000 }, async t => {
  const { file, open } = setup(t);
  const moduleURL = new URL('../plugins/educoder/scheduler.js', import.meta.url);
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createScheduler } from ${JSON.stringify(moduleURL)};
    const queue = createScheduler({
      file: process.argv[1],
      worker(task, { checkpoint }) {
        checkpoint({ binding: { courseId: '7', homeworkId: '42', taskId: 'game1',
          practiceId: 'p1', remoteUserId: '11', gameId: '101', challengeId: '201' },
          mutation: { phase: 'evaluate', marker: '0' } });
        process.send(task.id);
        return new Promise(() => {});
      },
      reconcile() {},
    });
    queue.setConcurrency(3);
    queue.enqueue({ accountId: 'a', courseId: '7', homeworkId: '42' }, { start: true });
  `, file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const [id] = await once(child, 'message', { signal: AbortSignal.timeout(4000) });
  assert.throws(() => open(), { code: 'busy' });
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;

  let writes = 0;
  let reads = 0;
  const queue = open({
    worker() { writes++; return pause(); },
    reconcile(task) {
      reads++;
      assert.equal(task.mutation.phase, 'evaluate');
      return verify(task);
    },
  });
  const passed = await until(queue, id, 'passed');
  assert.equal(queue.getConcurrency(), 3);
  assert.equal(passed.attempts, 1);
  assert.equal(writes, 0);
  assert.equal(reads, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(passed.events.some(event => event.code === 'recovery_required'));
});

test('远端证据约束账号与关卡，已验证关卡后可推进下一关', { timeout: 8000 }, async t => {
  const queue = setup(t).open({
    worker(task, { checkpoint }) {
      checkpoint({ binding: bind(task), marker: '0' });
      assert.throws(() => checkpoint({ binding: bind(task, 'game2') }), { code: 'invalid_scope' });
      checkpoint({ nextTaskId: 'game2' });
      assert.throws(() => checkpoint({ binding: { ...bind(task, 'game2'), remoteUserId: '88' } }), { code: 'invalid_scope' });
      checkpoint({ binding: bind(task, 'game2'), marker: '0', mutation: null });
      return { status: 'passed', marker: 'agent-claim', binding: bind(task, 'game2') };
    },
    reconcile(task) {
      assert.equal(task.binding.taskId, 'game2');
      return { ...verify(task), binding: { ...task.binding, remoteUserId: '88' } };
    },
  });
  const task = queue.enqueue(target('a'), { start: true });
  const held = await until(queue, task.id, 'manual');
  assert.equal(held.code, 'invalid_scope');
  assert.equal(held.verifiedAt, null);
});

test('单独和课程批量启动的作业均可自动续关，保留同一次尝试', { timeout: 8000 }, async t => {
  const queue = setup(t).open({
    maxAttempts: 1,
    worker(task, { checkpoint }) {
      if (!task.binding) {
        const binding = bind(task);
        checkpoint({ binding, marker: '1', nextTaskId: 'game2', sessionId: 'session-first' });
        return { status: 'paused', code: 'stage_limit', binding, marker: '1', nextTaskId: 'game2' };
      }
      assert.equal(task.attempts, 1);
      assert.equal(task.sessionId, 'session-first');
      assert.equal(task.nextTaskId, 'game2');
      const binding = bind(task, 'game2');
      checkpoint({ binding, marker: '1', nextTaskId: null, sessionId: 'session-second' });
      return { status: 'passed', binding, marker: '1', nextTaskId: null };
    },
    reconcile: verify,
  });
  const [courseTask] = queue.enqueueCourse([target('a')]);
  const passed = await until(queue, courseTask.id, 'passed');
  assert.equal(passed.attempts, 1);
  assert.equal(passed.sessionId, 'session-second');
  assert.equal(passed.startedAt, passed.events.find(event => event.status === 'running').at);

  const manualTask = queue.enqueue(target('a', '43'), { start: true });
  assert.equal((await until(queue, manualTask.id, 'passed')).attempts, 1);
});

test('旧版已暂停的续关任务可在重试次数用尽时继续', { timeout: 8000 }, async t => {
  const { file, open } = setup(t);
  let queue = open();
  const task = queue.enqueue(target('a'));
  await queue.close();
  const startedAt = '2026-11-13T00:00:00.000Z';
  const db = new DatabaseSync(file);
  try {
    const state = JSON.parse(db.prepare('SELECT data FROM scheduler_state WHERE id=1').get().data);
    Object.assign(state.tasks[task.id], {
      status: 'paused', code: 'next_stage', startedAt, attempts: 1,
      binding: bind(task), marker: '1', nextTaskId: 'game2', sessionId: 'session-first',
    });
    db.prepare('UPDATE scheduler_state SET data=? WHERE id=1').run(JSON.stringify(state));
  } finally {
    db.close();
  }

  queue = open({
    maxAttempts: 1,
    worker(current, { checkpoint }) {
      assert.equal(current.binding.taskId, 'game1');
      assert.equal(current.nextTaskId, 'game2');
      const binding = bind(current, 'game2');
      checkpoint({ binding, nextTaskId: null, sessionId: 'session-second' });
      return { status: 'passed', binding, marker: '1', nextTaskId: null };
    },
    reconcile: verify,
  });
  assert.equal(queue.resume(task.id).status, 'queued');
  const completed = await until(queue, task.id, 'passed');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.startedAt, startedAt);
  assert.equal(completed.sessionId, 'session-second');
});

test('失败错误脱敏，显式重试受次数与退避限制', { timeout: 8000 }, async t => {
  const queue = setup(t).open({
    maxAttempts: 2,
    retryDelayMs: 50,
    worker() { throw Object.assign(new Error('secret example cookie'), { code: 'private-code' }); },
  });
  const task = queue.enqueue(target('a'), { start: true });
  const failed = await until(queue, task.id, 'failed');
  assert.equal(failed.code, 'agent_failed');
  assert.ok(!JSON.stringify(failed).includes('secret'));
  const retry = queue.resume(task.id);
  assert.equal(retry.status, 'queued');
  assert.ok(retry.retryAt);
  assert.equal(queue.resume(task.id).retryAt, retry.retryAt);
  await until(queue, task.id, 'failed');
  assert.throws(() => queue.resume(task.id), { code: 'retry_limit' });
  assert.equal(queue.get(task.id).attempts, 2);
});

test('原生任务达到历史尝试上限后，手动暂停和继续仍沿用本轮', async t => {
  let runs = 0;
  const queue = setup(t).open({
    maxAttempts: 1,
    automaticRetries: true,
    async worker(task, { signal }) {
      assert.equal(task.attempts, 1);
      runs++;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 'failed', code: 'cancelled' };
    },
  });
  const task = queue.enqueue(target('a'), { start: true });
  await waitFor(() => runs === 1);
  const paused = queue.pause(task.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.code, null);
  await delay(15);
  assert.equal(runs, 1);
  assert.equal(queue.resume(task.id).status, 'queued');
  await waitFor(() => runs === 2);
  const running = queue.get(task.id);
  assert.equal(running.attempts, 1);
  assert.equal(running.startedAt, paused.startedAt);
  assert.equal(queue.pause(task.id).status, 'paused');
});

test('默认允许超过 3 次自动重试，且调度异常时记录脱敏日志', { timeout: 8000 }, async t => {
  const warnings = [];
  let attempts = 0;
  const queue = setup(t).open({
    automaticRetries: true,
    logger: { warn: (...args) => warnings.push(args) },
    worker(task, { checkpoint }) {
      attempts++;
      if (attempts <= 4) {
        throw Object.assign(new Error('secret failure details'), { code: 'ECONNRESET' });
      }
      const binding = bind(task);
      checkpoint({ binding, marker: '1' });
      return { status: 'passed', binding, marker: '1' };
    },
    reconcile: verify,
  });
  const task = queue.enqueue(target('a'), { start: true });
  const passed = await until(queue, task.id, 'passed');
  assert.equal(passed.attempts, 5);
  assert.equal(warnings.length, 4);
  const serialized = JSON.stringify(warnings);
  assert.match(serialized, /ECONNRESET/);
  assert.ok(!serialized.includes('secret'));
});
