import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const MAX_BATCH = 1000;
const MAX_COURSE_HOMEWORKS = 10_000;
const MAX_STAGE_CONTINUATIONS = 1000;
const MAX_EVENTS = 500;
const MAX_RECONCILES = 20;
const MAX_CONCURRENCY = 32;
const ID = /^[\w.:-]{1,160}$/u;
const MARKER = /^[\w.:/+@-]{0,160}$/u;
const BINDING_KEYS = ['courseId', 'homeworkId', 'taskId', 'practiceId', 'remoteUserId', 'gameId', 'challengeId'];
const WORKER_RESULTS = new Set(['passed', 'failed', 'manual', 'paused']);
const TERMINAL = new Set(['passed', 'cancelled']);
const USER_ACTION = new Set(['paused', 'manual', 'failed']);
const MANUAL_CODES = new Set([
  'auth_required', 'invalid_credentials', 'signature_error', 'invalid_scope', 'manual_required',
  'terminal_unavailable', 'verification_pending', 'uncertain', 'write_unverified', 'stale_scope',
  'live_disabled', 'image_unavailable', 'image_model_unsupported',
  'choice_closed',
]);
const SAFE_CODES = new Set([
  ...MANUAL_CODES, 'unavailable', 'invalid_input', 'verification_failed', 'budget',
  'timeout', 'cancelled', 'agent_failed', 'busy', 'already_exists', 'not_found',
  'invalid_state', 'retry_limit', 'recovery_required', 'next_stage', 'stage_limit',
  'resume_after_readback',
]);

export class SchedulerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

function fail(code) {
  throw new SchedulerError(code);
}

function requireId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('invalid_input');
  return value;
}

function requireMarker(value) {
  if (typeof value !== 'string' || !MARKER.test(value)) fail('invalid_input');
  return value;
}

function numberBetween(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_input');
  return value;
}

function requireBatch(batch, limit = MAX_BATCH) {
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > limit) fail('invalid_input');
  return batch;
}

function normalizeTarget(target) {
  const title = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 250) || null
    : null;
  return {
    accountId: requireId(target?.accountId),
    courseId: requireId(target?.courseId),
    homeworkId: requireId(target?.homeworkId),
    courseTitle: title(target?.courseTitle),
    homeworkTitle: title(target?.homeworkTitle),
  };
}

function targetKey({ accountId, courseId, homeworkId }) {
  return JSON.stringify([accountId, courseId, homeworkId]);
}

function normalizeBinding(value, task) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_scope');
  const binding = {};
  for (const key of BINDING_KEYS) binding[key] = requireId(value[key]);
  if (binding.courseId !== task.courseId || binding.homeworkId !== task.homeworkId) {
    fail('invalid_scope');
  }
  return binding;
}

function sameBinding(a, b) {
  return Boolean(a && b && BINDING_KEYS.every(key => a[key] === b[key]));
}

function safeCode(value, fallback = 'agent_failed') {
  return SAFE_CODES.has(value) ? value : fallback;
}

function publicTask(task, detail = false) {
  const {
    id, accountId, courseId, homeworkId, courseTitle, homeworkTitle, status, code, sessionId, createdAt,
    updatedAt, startedAt, finishedAt, verifiedAt, attempts, retryAt,
  } = task;
  const result = {
    id, accountId, courseId, homeworkId, courseTitle, homeworkTitle, status, code, sessionId, createdAt,
    updatedAt, startedAt, finishedAt, verifiedAt, attempts, retryAt,
  };
  if (detail) result.events = structuredClone(task.events);
  return result;
}

function isLocked(error) {
  return error?.errcode === 5 || error?.errcode === 6 || /database is locked/i.test(error?.message ?? '');
}

function openStore(file, concurrency) {
  if (typeof file !== 'string' || !file) fail('invalid_input');
  const location = resolve(file);
  mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(location, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = lstatSync(location);
    if (!info.isFile() || (info.mode & 0o077)) fail('invalid_input');
  }
  const database = new DatabaseSync(location);
  try {
    // A live scheduler owns the database across transactions. The OS releases
    // this lock after a crash, unlike a separate pid or lock file.
    database.exec(`PRAGMA busy_timeout=0;
      PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      BEGIN EXCLUSIVE;`);
    const { user_version: version } = database.prepare('PRAGMA user_version').get();
    if (version === 0) {
      database.exec(`CREATE TABLE scheduler_state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);
        PRAGMA user_version=${VERSION};`);
      database.prepare('INSERT INTO scheduler_state VALUES (1, ?)').run(JSON.stringify({
        concurrency, sequence: 0, lastAccountId: null, tasks: {},
      }));
    } else if (version !== VERSION) {
      fail('invalid_state');
    }
    const { data } = database.prepare('SELECT data FROM scheduler_state WHERE id=1').get();
    const state = JSON.parse(data);
    database.exec('COMMIT;');
    const update = database.prepare('UPDATE scheduler_state SET data=? WHERE id=1');
    return {
      state,
      write: next => update.run(JSON.stringify(next)),
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    if (isLocked(error)) fail('busy');
    throw error;
  }
}

function logEvent(task, at) {
  task.events.push({
    at, status: task.status, code: task.code, sessionId: task.sessionId, attempt: task.attempts,
  });
  if (task.events.length > MAX_EVENTS) task.events.shift();
}

function transition(task, status, at, code = null, reconcile = false) {
  task.status = status;
  task.code = code;
  task.updatedAt = at;
  if (status === 'running') {
    if (!reconcile || !task.startedAt) task.startedAt = at;
    task.finishedAt = null;
  } else if (status === 'queued') {
    task.finishedAt = null;
  } else if (USER_ACTION.has(status) || TERMINAL.has(status)) {
    task.finishedAt = at;
  }
  logEvent(task, at);
}

function clearVerification(task) {
  task.mutation = null;
  task.needsReconcile = false;
  task.reconcileAttempts = 0;
}

function hasVerifiedSuccessor(task, status, code) {
  return status === 'paused' && (code === 'stage_limit' || code === 'next_stage') &&
    !task.mutation && !task.needsReconcile && Boolean(task.binding && task.nextTaskId);
}

function clearSessionResume(task) {
  task.sessionResume = null;
  task.sessionResumeTransfer = null;
}

function applyCheckpoint(task, changes) {
  if (Object.hasOwn(changes, 'binding')) {
    const binding = normalizeBinding(changes.binding, task);
    if (task.binding && !sameBinding(task.binding, binding)) {
      if (task.binding.taskId === binding.taskId ||
          task.binding.remoteUserId !== binding.remoteUserId ||
          task.binding.practiceId !== binding.practiceId ||
          task.nextTaskId !== binding.taskId ||
          (task.mutation && changes.mutation !== null)) fail('invalid_scope');
      const transfer = task.sessionResumeTransfer;
      const keepSession = !task.mutation && !task.needsReconcile &&
        transfer?.fromTaskId === task.binding.taskId && transfer.toTaskId === binding.taskId;
      task.marker = null;
      task.nextTaskId = null;
      if (!keepSession) clearSessionResume(task);
      task.stageRetries = 0;
    }
    task.binding = binding;
  }
  if (Object.hasOwn(changes, 'marker')) task.marker = requireMarker(changes.marker);
  if (Object.hasOwn(changes, 'mutation')) {
    const mutation = changes.mutation;
    if (mutation === null) {
      clearVerification(task);
    } else {
      if (!task.binding || !['write', 'evaluate', 'terminal'].includes(mutation?.phase)) fail('invalid_scope');
      task.mutation = { phase: mutation.phase, marker: requireMarker(mutation.marker) };
      task.needsReconcile = true;
    }
  }
  if (Object.hasOwn(changes, 'nextTaskId')) {
    const next = changes.nextTaskId;
    if (next === task.binding?.taskId) fail('invalid_scope');
    task.nextTaskId = next === null ? null : requireId(next);
  }
  if (Object.hasOwn(changes, 'sessionId')) {
    task.sessionId = requireId(changes.sessionId);
    clearSessionResume(task);
  }
  if (Object.hasOwn(changes, 'sessionResumeSuccessor') && !Object.hasOwn(changes, 'sessionResume')) fail('invalid_scope');
  if (Object.hasOwn(changes, 'sessionResume')) {
    const { sessionId, key, scopeKey, lastRequestAt, requestCount } = changes.sessionResume ?? {};
    if (!task.binding || task.mutation || task.needsReconcile || !task.sessionId || task.sessionId !== sessionId ||
        typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key) ||
        (scopeKey !== undefined && (typeof scopeKey !== 'string' || !/^[a-f0-9]{64}$/u.test(scopeKey))) ||
        !Number.isSafeInteger(lastRequestAt) || lastRequestAt <= 0 ||
        !Number.isSafeInteger(requestCount) || requestCount <= 0) fail('invalid_scope');
    const successor = changes.sessionResumeSuccessor;
    if (successor !== undefined && (!scopeKey || successor !== task.nextTaskId || !successor)) fail('invalid_scope');
    task.sessionResume = { sessionId, key, ...(scopeKey === undefined ? {} : { scopeKey }), lastRequestAt, requestCount };
    task.sessionResumeTransfer = successor ? { fromTaskId: task.binding.taskId, toTaskId: successor } : null;
  }
}

export function createScheduler({
  file, worker, reconcile, concurrency = 2, maxAttempts = 12,
  timeoutMs = null, retryDelayMs = 1000, automaticRetries = false, logger,
} = {}) {
  if (typeof worker !== 'function' || typeof reconcile !== 'function') fail('invalid_input');
  numberBetween(concurrency, 1, MAX_CONCURRENCY);
  numberBetween(maxAttempts, 1, 1000);
  if (timeoutMs !== null) numberBetween(timeoutMs, 1, 2 ** 31 - 1);
  numberBetween(retryDelayMs, 0, 60_000);

  const store = openStore(file, concurrency);
  let state = store.state;
  const active = new Map();
  const blocked = new Map();
  let timer;
  let scheduled = false;
  let closing;

  const time = () => new Date().toISOString();
  const all = source => Object.values(source.tasks);
  const accountBlocked = accountId => blocked.has(accountId);
  function change(edit) {
    const next = structuredClone(state);
    const value = edit(next);
    store.write(next);
    state = next;
    return value;
  }

  function queue(task, next, at, code = null) {
    task.queueOrder = ++next.sequence;
    transition(task, 'queued', at, code);
  }

  function find(source, id) {
    requireId(id);
    if (!Object.hasOwn(source.tasks, id)) fail('not_found');
    return source.tasks[id];
  }

  function assertOpen() {
    if (closing) fail('invalid_state');
  }

  function schedule() {
    if (closing || scheduled) return;
    if (timer) clearTimeout(timer);
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closing) {
        try {
          pump();
        } catch {
          // Leave the last committed queue recoverable after a disk failure.
          void close();
        }
      }
    });
  }

  function pump() {
    while (active.size < state.concurrency) {
      const now = Date.now();
      const candidates = all(state).filter(task => task.status === 'queued' &&
        !active.has(task.accountId) && !accountBlocked(task.accountId));
      const ready = candidates.filter(task => !task.retryAt || Date.parse(task.retryAt) <= now);
      ready.sort((a, b) => a.queueOrder - b.queueOrder);
      const task = ready.find(item => item.accountId !== state.lastAccountId) ?? ready[0];
      if (!task) {
        const next = candidates.reduce((min, item) => item.retryAt ? Math.min(min, Date.parse(item.retryAt)) : min, Infinity);
        if (Number.isFinite(next)) {
          timer = setTimeout(schedule, Math.max(1, next - now));
        }
        return;
      }
      const mode = task.needsReconcile ? 'reconcile' : 'work';
      const continuation = task.stageContinuation === true;
      change(draft => {
        const current = draft.tasks[task.id];
        draft.lastAccountId = current.accountId;
        current.retryAt = null;
        if (mode === 'reconcile') current.reconcileAttempts++;
        else if (!continuation) current.attempts++;
        if (continuation) current.stageContinuation = false;
        // 只读核验和自动续关都属于同一轮作业。
        transition(current, 'running', time(), null, mode === 'reconcile' || continuation);
      });
      const entry = { controller: new AbortController(), taskId: task.id };
      active.set(task.accountId, entry);
      entry.done = Promise.resolve()
        .then(() => run(task, mode, entry.controller))
        .finally(() => {
          active.delete(task.accountId);
          schedule();
        });
      void entry.done.catch(() => {
        // A persistence failure cannot be recorded safely. Stop dispatch and
        // let the next process reconcile the last durable running state.
        void close();
      });
    }
  }

  async function run(task, mode, controller) {
    const current = () => structuredClone(state.tasks[task.id]);
    let contextOpen = true;
    const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
    const checkpoint = changes => {
      if (Date.now() >= deadline) controller.abort(new SchedulerError('timeout'));
      if (!contextOpen || !changes || typeof changes !== 'object' || controller.signal.aborted ||
          current().status !== 'running') fail('cancelled');
      if (mode === 'reconcile') {
        // 已读回的代码保存可以原子推进为一次待核验评测。
        const previous = current().mutation;
        const permitted = automaticRetries && previous?.phase === 'write' &&
          changes.mutation?.phase === 'evaluate' && changes.mutation.marker === previous.marker;
        if ((changes.mutation != null && !permitted) || Object.hasOwn(changes, 'sessionResume')) fail('invalid_scope');
      }
      return change(draft => {
        const latest = draft.tasks[task.id];
        const oldSession = latest.sessionId;
        applyCheckpoint(latest, changes);
        latest.updatedAt = time();
        if (oldSession !== latest.sessionId) logEvent(latest, latest.updatedAt);
        return structuredClone(latest);
      });
    };
    const timeout = timeoutMs === null ? undefined : setTimeout(() => controller.abort(new SchedulerError('timeout')), timeoutMs);
    let result;
    try {
      controller.signal.throwIfAborted();
      const execute = mode === 'work' ? worker : reconcile;
      result = await execute(current(), { signal: controller.signal, checkpoint, current });
      if (!WORKER_RESULTS.has(result?.status)) fail('agent_failed');
    } catch (error) {
      const code = safeCode(error?.code);
      if (code === 'agent_failed' && !(error instanceof SchedulerError)) {
        const rawErrCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : undefined;
        logger?.warn?.('EduCoder 调度任务异常。', {
          taskId: task.id,
          mode,
          errorName: error?.name ?? 'Error',
          ...(rawErrCode ? { errorCode: rawErrCode } : {}),
        });
      }
      result = { status: MANUAL_CODES.has(code) ? 'manual' : 'failed', code };
    } finally {
      contextOpen = false;
      clearTimeout(timeout);
    }

    const latest = current();
    if (latest.status !== 'running') return;
    if (Date.now() >= deadline) controller.abort(new SchedulerError('timeout'));
    if (closing) {
      change(draft => {
        const pending = draft.tasks[task.id];
        pending.needsReconcile = true;
        queue(pending, draft, time(), 'recovery_required');
      });
      return;
    }
    if (controller.signal.aborted) {
      result = { status: 'failed', code: safeCode(controller.signal.reason?.code, 'cancelled') };
    }
    change(draft => finish(draft.tasks[task.id], draft, mode, result));
  }

  function finish(task, draft, mode, result) {
    const at = time();
    let status = result.status;
    let code = result.code == null ? null : safeCode(result.code);
    try {
      // Validate all result fields before mutating the durable draft.
      const updated = structuredClone(task);
      if (mode === 'work' && result.mutation !== undefined && result.mutation !== null) fail('invalid_scope');
      if (mode === 'reconcile' && Object.hasOwn(result, 'sessionResume')) fail('invalid_scope');
      if (mode === 'reconcile' && result.binding && task.binding &&
          !sameBinding(task.binding, normalizeBinding(result.binding, task))) fail('invalid_scope');
      if (mode === 'reconcile' && status === 'passed') {
        if (!result.binding || !result.marker || result.nextTaskId ||
            (task.binding && !sameBinding(task.binding, normalizeBinding(result.binding, task)))) fail('verification_failed');
      }
      applyCheckpoint(updated, result);
      Object.assign(task, updated);
    } catch (error) {
      status = 'manual';
      code = safeCode(error?.code, 'invalid_scope');
    }

    if (mode === 'work' && (task.mutation || status === 'passed')) {
      task.needsReconcile = true;
      queue(task, draft, at, 'verification_pending');
      return;
    }
    if (mode === 'reconcile') {
      if (status === 'passed') {
        clearVerification(task);
        task.verifiedAt = at;
      } else if (task.mutation && result.settled === true && status === 'failed' && code === 'verification_failed') {
        clearVerification(task);
      } else if (task.mutation && automaticRetries && task.mutation.phase === 'evaluate' &&
          task.reconcileAttempts < MAX_RECONCILES && ['verification_pending', 'unavailable', 'uncertain'].includes(code)) {
        task.retryAt = new Date(Date.now() + retryDelayMs * 2 ** Math.min(Math.max(0, task.reconcileAttempts - 1), 5)).toISOString();
        queue(task, draft, at, 'verification_pending');
        return;
      } else if (task.mutation) {
        status = 'manual';
        code ??= 'uncertain';
      } else {
        task.needsReconcile = false;
      }
    }
    const canContinue = hasVerifiedSuccessor(task, status, code) &&
      (task.stageContinuations ?? 0) < MAX_STAGE_CONTINUATIONS;
    if (automaticRetries && mode === 'reconcile' && status === 'paused' &&
        ['resume_after_readback', 'recovery_required'].includes(code) && !task.mutation &&
        (task.stageRetries ?? 0) < maxAttempts - 1) {
      task.stageRetries = (task.stageRetries ?? 0) + 1;
      task.stageContinuation = true;
      queue(task, draft, at, code);
      return;
    }
    if (canContinue) {
      task.stageContinuations = (task.stageContinuations ?? 0) + 1;
      task.stageContinuation = true;
      queue(task, draft, at);
      return;
    }
    const stageRetries = task.stageRetries ?? 0;
    if (automaticRetries && status === 'failed' && !task.mutation && stageRetries < maxAttempts - 1 &&
        ['agent_failed', 'verification_failed', 'timeout', 'budget', 'unavailable', 'verification_pending'].includes(code)) {
      task.stageRetries = stageRetries + 1;
      task.retryAt = new Date(Date.now() + retryDelayMs * 2 ** Math.min(stageRetries, 5)).toISOString();
      queue(task, draft, at, code);
      return;
    }
    transition(task, status, at, code);
  }

  // Running jobs left by another process may already have sent a request.
  // Always read back on recovery, even when it died before recording a write.
  try {
    if (all(state).some(task => task.status === 'running')) {
      change(draft => {
        for (const task of all(draft).filter(item => item.status === 'running')) {
          task.needsReconcile = true;
          clearSessionResume(task);
          task.retryAt = null;
          queue(task, draft, time(), 'recovery_required');
        }
      });
    }
  } catch (error) {
    store.close();
    throw error;
  }

  function enqueueTargets(targets, start, courseRun = false) {
    assertOpen();
    if (typeof start !== 'boolean') fail('invalid_input');
    const normalized = requireBatch(targets, courseRun ? MAX_COURSE_HOMEWORKS : MAX_BATCH).map(normalizeTarget);
    const result = change(draft => {
      const tasksByTarget = new Map(all(draft).map(task => [targetKey(task), task]));
      return normalized.map(target => {
        if (accountBlocked(target.accountId)) fail('busy');
        const key = targetKey(target);
        const existing = tasksByTarget.get(key);
        if (existing) {
          if (existing.status === 'waiting' && start) queue(existing, draft, time());
          return publicTask(existing);
        }
        const at = time();
        const task = {
          ...target, id: randomUUID(), status: 'waiting', code: null,
          sessionId: null, sessionResume: null, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null,
          verifiedAt: null, attempts: 0, retryAt: null, queueOrder: null,
          needsReconcile: false, reconcileAttempts: 0, binding: null,
          marker: null, mutation: null, nextTaskId: null, events: [],
        };
        logEvent(task, at);
        draft.tasks[task.id] = task;
        tasksByTarget.set(key, task);
        if (start) queue(task, draft, at);
        return publicTask(task);
      });
    });
    if (start) schedule();
    return result;
  }

  function enqueueBatch(targets, { start = false } = {}) {
    return enqueueTargets(targets, start);
  }

  function stopTask(task, action, at) {
    if (action === 'pause' && (task.status === 'paused' || task.status === 'waiting')) return;
    if (action === 'cancel' && task.status === 'cancelled') return;
    if (action === 'pause' && !['queued', 'running'].includes(task.status)) fail('invalid_state');
    if (TERMINAL.has(task.status)) fail('invalid_state');
    if (task.mutation) task.needsReconcile = true;
    if (task.stageContinuation) task.stageContinuation = false;
    task.retryAt = null;
    transition(task, action === 'pause' ? 'paused' : 'cancelled', at, action === 'cancel' ? 'cancelled' : null);
  }

  function controlBatch(action, ids) {
    assertOpen();
    const abort = [];
    const result = change(draft => requireBatch(ids).map(id => {
      const task = find(draft, id);
      if (accountBlocked(task.accountId)) fail('busy');
      const at = time();
      if (action === 'start' || action === 'resume') {
        if (task.status === 'queued' || task.status === 'running') return publicTask(task);
        if (action === 'start' ? task.status !== 'waiting' : !USER_ACTION.has(task.status)) fail('invalid_state');
        const resumablePause = automaticRetries && task.status === 'paused' && !task.mutation && !task.needsReconcile;
        if (action === 'resume' && (resumablePause || hasVerifiedSuccessor(task, task.status, task.code))) {
          task.stageContinuation = true;
          task.stageContinuations = 0;
          if (resumablePause) task.stageRetries = 0;
          queue(task, draft, at);
          return publicTask(task);
        }
        if (task.needsReconcile && task.reconcileAttempts >= MAX_RECONCILES) fail('retry_limit');
        if (!task.needsReconcile && task.attempts >= maxAttempts) fail('retry_limit');
        const count = task.needsReconcile ? task.reconcileAttempts : task.attempts;
        if (count && task.status !== 'paused' && retryDelayMs) {
          task.retryAt = new Date(Date.now() + retryDelayMs * 2 ** Math.min(count - 1, 5)).toISOString();
        }
        queue(task, draft, at);
      } else {
        stopTask(task, action, at);
        abort.push([task.accountId, task.id]);
      }
      return publicTask(task);
    }));
    for (const [accountId, id] of abort) {
      const running = active.get(accountId);
      if (running?.taskId === id) running.controller.abort(new SchedulerError('cancelled'));
    }
    schedule();
    return result;
  }

  function stopAccount(accountId, action) {
    assertOpen();
    requireId(accountId);
    const result = change(draft => {
      const targets = all(draft).filter(task => task.accountId === accountId &&
        (action === 'cancel' ? !TERMINAL.has(task.status) : ['queued', 'running'].includes(task.status)));
      return targets.map(task => {
        stopTask(task, action, time());
        return publicTask(task);
      });
    });
    active.get(accountId)?.controller.abort(new SchedulerError('cancelled'));
    schedule();
    return result;
  }

  function blockAccount(accountId) {
    assertOpen();
    requireId(accountId);
    if (blocked.has(accountId)) fail('busy');
    const token = {};
    blocked.set(accountId, token);
    return () => {
      if (blocked.get(accountId) !== token) return;
      blocked.delete(accountId);
      schedule();
    };
  }

  function close() {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        clearTimeout(timer);
        for (const entry of active.values()) entry.controller.abort(new SchedulerError('recovery_required'));
        try {
          await Promise.allSettled([...active.values()].map(entry => entry.done));
        } finally {
          store.close();
        }
      });
    }
    return closing;
  }

  schedule();
  return {
    enqueue: (target, options) => enqueueBatch([target], options)[0],
    enqueueBatch,
    enqueueCourse: targets => enqueueTargets(targets, true, true),
    list({ accountId } = {}) {
      if (accountId !== undefined) requireId(accountId);
      return all(state).filter(task => accountId === undefined || accountId === task.accountId).map(task => publicTask(task));
    },
    get: id => Object.hasOwn(state.tasks, requireId(id)) ? publicTask(state.tasks[id], true) : null,
    start: id => controlBatch('start', [id])[0],
    startBatch: ids => controlBatch('start', ids),
    pause: id => controlBatch('pause', [id])[0],
    pauseBatch: ids => controlBatch('pause', ids),
    resume: id => controlBatch('resume', [id])[0],
    resumeBatch: ids => controlBatch('resume', ids),
    cancel: id => controlBatch('cancel', [id])[0],
    cancelBatch: ids => controlBatch('cancel', ids),
    pauseAccount: accountId => stopAccount(accountId, 'pause'),
    cancelAccount: accountId => stopAccount(accountId, 'cancel'),
    blockAccount,
    async waitForAccountIdle(accountId) {
      requireId(accountId);
      await active.get(accountId)?.done;
    },
    getConcurrency: () => state.concurrency,
    setConcurrency(value) {
      assertOpen();
      numberBetween(value, 1, MAX_CONCURRENCY);
      change(draft => { draft.concurrency = value; });
      schedule();
      return value;
    },
    close,
  };
}
