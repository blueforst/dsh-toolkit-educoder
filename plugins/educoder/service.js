import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAccounts, AccountError } from './accounts.js';
import { createScheduler } from './scheduler.js';
import { createWorkers } from './worker.js';

const scopeId = /^[a-zA-Z0-9_-]{1,120}$/u;
const homeworkId = /^[1-9][0-9]{0,14}$/u;
const controls = { start: 'startBatch', pause: 'pauseBatch', resume: 'resumeBatch', cancel: 'cancelBatch' };

function fail(code) {
  throw new AccountError(code);
}

export function privateDirectory(root) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || realpathSync(root) !== resolve(root)) fail('invalid_state');
}

export function createService({ root, credentials, transport, runAgent, pollMs, pollAttempts, allowAccounts }) {
  privateDirectory(root);
  const allowed = typeof allowAccounts === 'function' ? allowAccounts : () => allowAccounts === true;
  function requireAccounts() {
    if (!allowed()) fail('live_disabled');
  }
  let accounts;
  const workers = createWorkers({
    transport,
    runAgent,
    pollMs,
    pollAttempts,
    accounts: {
      withSession: (...args) => {
        requireAccounts();
        return accounts.withSession(...args);
      },
    },
  });
  const queue = createScheduler({
    file: join(root, 'queue.sqlite'),
    ...workers,
  });
  try {
    accounts = createAccounts({ file: join(root, 'accounts.sqlite'), credentials, transport, queue });
  } catch (error) {
    void queue.close();
    throw error;
  }

  async function catalog(action, id, courseId) {
    return accounts.withSession(id, async session => {
      const result = action === 'courses'
        ? await transport.courses(session)
        : await transport.homeworks(session, courseId);
      return result.map(({ id, title, taskCount, passedCount }) => ({
        id, title,
        ...(Number.isSafeInteger(taskCount) && taskCount >= 0 ? { taskCount } : {}),
        ...(Number.isSafeInteger(passedCount) && passedCount >= 0 ? { passedCount } : {}),
      }));
    });
  }

  async function allocate(targets, start) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 100 || typeof start !== 'boolean') {
      fail('invalid_input');
    }
    const validated = [];
    const catalogs = new Map();
    for (const target of targets) {
      if (!scopeId.test(target?.courseId) || !homeworkId.test(target?.homeworkId) ||
          typeof target?.courseId !== 'string' || typeof target?.homeworkId !== 'string') fail('invalid_input');
      const { accountId, courseId, homeworkId: selected } = target;
      const id = JSON.stringify([accountId, courseId]);
      if (!catalogs.has(id)) {
        catalogs.set(id, await accounts.withSession(accountId, async session => {
          const course = (await transport.courses(session)).find(item => item.id === courseId);
          if (!course) fail('invalid_scope');
          return { course, homeworks: await transport.homeworks(session, courseId) };
        }));
      }
      const { course, homeworks } = catalogs.get(id);
      const homework = homeworks.find(item => item.id === selected);
      if (!homework) fail('invalid_scope');
      validated.push({ accountId, courseId, homeworkId: selected, courseTitle: course.title, homeworkTitle: homework.title });
    }
    const ready = new Set(accounts.list().filter(account => ['ready', 'unverified'].includes(account.status)).map(account => account.id));
    if (validated.some(target => !ready.has(target.accountId))) fail('auth_required');
    return queue.enqueueBatch(validated, { start });
  }

  let closed = false;
  const requests = new Set();
  async function dispatch(input) {
    if (closed || !input || Array.isArray(input) || typeof input.action !== 'string') fail('invalid_input');
    switch (input.action) {
      case 'accounts': return accounts.list();
      case 'addAccount':
        requireAccounts();
        return accounts.add(input.login, input.password);
      case 'relogin':
        requireAccounts();
        return accounts.relogin(input.accountId, input.login, input.password);
      case 'checkAccount':
        requireAccounts();
        return accounts.check(input.accountId);
      case 'removeAccount': return accounts.remove(input.accountId);
      case 'courses':
      case 'homeworks':
        requireAccounts();
        return catalog(input.action, input.accountId, input.courseId);
      case 'tasks': return queue.list();
      case 'task': {
        const task = queue.get(input.taskId);
        if (!task) fail('not_found');
        return task;
      }
      case 'allocate':
        requireAccounts();
        return allocate(input.targets, input.start ?? false);
      case 'control':
        if (!Object.hasOwn(controls, input.command)) fail('invalid_input');
        if (['start', 'resume'].includes(input.command)) requireAccounts();
        return queue[controls[input.command]](input.taskIds);
      case 'settings':
        return { concurrency: input.concurrency === undefined ? queue.getConcurrency() : queue.setConcurrency(input.concurrency) };
      default: fail('invalid_input');
    }
  }

  return {
    execute(input) {
      const request = dispatch(input);
      requests.add(request);
      const done = () => requests.delete(request);
      request.then(done, done);
      return request;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...requests]);
      await queue.close();
      accounts.close();
    },
  };
}
