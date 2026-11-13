import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createScheduler } from '../plugins/educoder/scheduler.js';
import { createWorkers } from '../plugins/educoder/worker.js';

const { values } = parseArgs({
  options: {
    'duration-ms': { type: 'string', default: '120000' },
    accounts: { type: 'string', default: '8' },
    concurrency: { type: 'string' },
    'restart-every-ms': { type: 'string' },
  },
});

function boundedInteger(name, min, max, fallback) {
  const value = Number(values[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const durationMs = boundedInteger('duration-ms', 2000, 600_000);
const accountsCount = boundedInteger('accounts', 2, 24);
const concurrency = boundedInteger('concurrency', 2, Math.min(accountsCount, 8), Math.min(accountsCount, 3));
const restartEveryMs = boundedInteger('restart-every-ms', 500, Math.min(60_000, durationMs - 500),
  Math.min(60_000, Math.floor(durationMs / 4)));
if (durationMs < accountsCount * 200) throw new Error('increase --duration-ms for the selected account count');
const dir = mkdtempSync(join(tmpdir(), 'dsh-educoder-soak-'));
const file = join(dir, 'queue.sqlite');
const slots = Array.from({ length: accountsCount }, (_, index) => ({
  accountId: 'account-' + (index + 1),
  courseId: 'course-' + (index % 3 + 1),
  remoteUserId: String(index + 1),
}));
const slotById = new Map(slots.map(slot => [slot.accountId, slot]));
const stages = new Map();
const active = new Set();
const byAccount = Object.fromEntries(slots.map(slot => [slot.accountId, 0]));
const metrics = {
  tasks: 0, agentRuns: 0, writes: 0, submissions: 0, duplicateSubmissions: 0, lostResponses: 0,
  acceptedAfterRestart: 0, restarts: 0, inFlightRestarts: 0, verified: 0,
  readbacks: 0, peakConcurrency: 0, peakRss: 0, peakHeapUsed: 0,
};
const sourcePath = 'src/main.py';
let queue;
let interruptedEvaluations = 0;
let stopping = false;

function addTask(slot) {
  const sequence = ++metrics.tasks;
  const homeworkId = String(sequence);
  const { accountId, courseId, remoteUserId } = slot;
  stages.set(homeworkId, {
    accountId,
    sequence,
    binding: {
      courseId, homeworkId, remoteUserId, taskId: 'task-' + sequence,
      practiceId: 'practice-' + sequence, gameId: homeworkId, challengeId: homeworkId,
    },
    contents: '# fixture\n',
    readyAt: Infinity,
    accepted: false,
  });
  return queue.enqueue({ accountId, courseId, homeworkId }, { start: true }).id;
}

function stageFor(session, scope) {
  const expected = scope.binding ?? scope;
  const stage = stages.get(expected.homeworkId);
  assert.ok(stage);
  assert.equal(expected.courseId, stage.binding.courseId);
  assert.equal(session.remoteUserId, stage.binding.remoteUserId);
  if (scope.binding) assert.deepEqual(scope.binding, stage.binding);
  return stage;
}

const transport = {
  async inspect(session, scope, { signal }) {
    signal.throwIfAborted();
    const stage = stageFor(session, scope);
    const passed = performance.now() >= stage.readyAt;
    if (passed) metrics.readbacks++;
    return {
      binding: stage.binding, state: passed ? 'passed' : 'pending', evaluating: !passed && stage.accepted,
      kind: 'code', title: '模拟关卡', instructions: 'Fixture ' + stage.sequence,
      paths: [sourcePath], marker: passed ? '1' : '0', feedback: {},
    };
  },
  async readFile(session, scope, path, { signal }) {
    signal.throwIfAborted();
    assert.equal(path, sourcePath);
    return stageFor(session, scope).contents;
  },
  async saveFile(session, scope, path, contents, { signal }) {
    signal.throwIfAborted();
    const stage = stageFor(session, scope);
    assert.equal(path, sourcePath);
    assert.equal(contents, 'print(' + stage.sequence + ')\n');
    assert.equal(stage.accepted, false);
    stage.contents = contents;
    metrics.writes++;
    return stage.binding;
  },
  async evaluate(session, scope, proof, { signal }) {
    signal.throwIfAborted();
    const stage = stageFor(session, scope);
    assert.deepEqual(proof, stage.binding);
    assert.equal(stage.contents, 'print(' + stage.sequence + ')\n');
    if (stage.accepted) {
      metrics.duplicateSubmissions++;
      throw new Error('duplicate fixture submit');
    }
    stage.accepted = true;
    stage.readyAt = performance.now() + (stage.sequence % 5 === 0 ? 400 : 80);
    metrics.submissions++;
    interruptedEvaluations++;
    try {
      await delay(stage.sequence % 3 === 0 ? 420 : 175, undefined, { signal });
      if (stage.sequence % 5 === 0) {
        metrics.lostResponses++;
        throw Object.assign(new Error('simulated response loss'), { code: 'uncertain' });
      }
    } finally {
      interruptedEvaluations--;
    }
  },
};

const workers = createWorkers({
  transport,
  accounts: {
    withSession(id, callback) {
      const { remoteUserId } = slotById.get(id);
      return callback({ remoteUserId, session: 'fixture-session-' + id });
    },
  },
  async runAgent(run) {
    await run.onSession('soak-session-' + ++metrics.agentRuns);
    const sequence = Number(run.instructions.split(' ').at(-1));
    assert.equal(await run.readFile(sourcePath, run.signal), '# fixture\n');
    await run.saveFile(sourcePath, 'print(' + sequence + ')\n', run.signal);
    try {
      await run.evaluate(run.signal);
    } catch (error) {
      if (error.code !== 'uncertain') throw error;
    }
    return { status: 'finished' };
  },
  pollMs: 20,
  pollAttempts: 6,
});

function open() {
  return createScheduler({
    file, concurrency, timeoutMs: 3000, retryDelayMs: 40, reconcile: workers.reconcile,
    async worker(task, context) {
      assert.ok(!active.has(task.accountId), 'overlapping runs for the same account');
      active.add(task.accountId);
      metrics.peakConcurrency = Math.max(metrics.peakConcurrency, active.size);
      assert.ok(active.size <= concurrency);
      try {
        return await workers.worker(task, context);
      } finally {
        active.delete(task.accountId);
      }
    },
  });
}

function sample() {
  const { rss, heapUsed } = process.memoryUsage();
  metrics.peakRss = Math.max(metrics.peakRss, rss);
  metrics.peakHeapUsed = Math.max(metrics.peakHeapUsed, heapUsed);
  return { rss, heapUsed };
}

function inspectQueue(pending) {
  for (const [id, slot] of pending) {
    const task = queue.get(id);
    const stage = stages.get(task.homeworkId);
    if (task.status === 'passed') {
      assert.ok(task.verifiedAt);
      assert.ok(stage.accepted && performance.now() >= stage.readyAt);
      assert.equal(task.attempts, 1);
      assert.equal(stage.accountId, slot.accountId);
      if (task.events.some(event => event.code === 'recovery_required')) metrics.acceptedAfterRestart++;
      metrics.verified++;
      byAccount[slot.accountId]++;
      pending.delete(id);
      stages.delete(task.homeworkId);
    } else if (task.status === 'manual') {
      assert.equal(task.code, 'verification_pending');
      queue.resume(id);
    } else {
      assert.ok(['queued', 'running'].includes(task.status), task.status + ':' + task.code);
    }
  }
}

const loop = monitorEventLoopDelay({ resolution: 25 });
const started = performance.now();
const initialMemory = sample();
const initialCpu = process.cpuUsage();
const pending = new Map();
const maxQueued = accountsCount;
let nextSlot = 0;
let nextTask = started;
let nextRestart = started + restartEveryMs;

try {
  loop.enable();
  queue = open();
  while (performance.now() - started < durationMs || pending.size > 0) {
    const now = performance.now();
    stopping ||= now - started >= durationMs;
    if (now - started > durationMs + 8000) throw new Error('soak did not drain');
    if (!stopping && pending.size < maxQueued && now >= nextTask) {
      const slot = slots[nextSlot++ % slots.length];
      pending.set(addTask(slot), slot);
      nextTask = now + 125;
    }
    if (!stopping && now >= nextRestart && interruptedEvaluations > 0 && interruptedEvaluations === active.size) {
      metrics.inFlightRestarts++;
      await queue.close();
      assert.equal(active.size, 0);
      queue = open();
      metrics.restarts++;
      nextRestart = now + restartEveryMs;
    }
    inspectQueue(pending);
    sample();
    await delay(45);
  }
  await queue.close();
  const finalMemory = sample();
  const cpu = process.cpuUsage(initialCpu);
  assert.equal(active.size, 0);
  assert.equal(metrics.duplicateSubmissions, 0);
  assert.equal(metrics.tasks, metrics.verified);
  assert.equal(metrics.tasks, metrics.submissions);
  assert.equal(metrics.tasks, metrics.agentRuns);
  assert.ok(metrics.lostResponses > 0);
  assert.ok(metrics.peakConcurrency >= 2);
  assert.ok(metrics.inFlightRestarts > 0);
  assert.ok(metrics.acceptedAfterRestart > 0);
  assert.ok(Object.values(byAccount).every(count => count > 0));
  console.log(JSON.stringify({
    durationMs: Math.round(performance.now() - started), accounts: accountsCount, concurrency, byAccount,
    ...metrics, initialMemory, finalMemory, cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    eventLoopP95Ms: Math.round(loop.percentile(95) / 1e6), databaseBytes: statSync(file).size,
  }, null, 2));
} finally {
  loop.disable();
  await queue?.close();
  rmSync(dir, { recursive: true, force: true });
}
