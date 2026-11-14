import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../plugins/educoder/service.js';

const people = [
  { login: 'fixture-first-person', password: 'never-store-password-a', remoteId: '101', courseId: 'course-a', homeworkId: '11' },
  { login: 'fixture-second-person', password: 'never-store-password-b', remoteId: '202', courseId: 'course-b', homeworkId: '22' },
];

function setup(t, { allowAccounts = true, allowTasks = true, mode = 'disabled', assignments, inspectTask, runAgent, extended = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-educoder-service-')));
  const stored = new Map();
  const state = new Map();
  const authAttempts = [];
  const inspected = [];
  const transport = {
    async login(login, password) {
      authAttempts.push(login);
      const person = people.find(person => person.login === login && person.password === password);
      if (!person) throw Object.assign(new Error('不可公开的模拟失败'), { code: 'invalid_credentials' });
      const suffix = person.remoteId;
      state.set(suffix, 'ready');
      return { remoteUserId: suffix, label: 'fi***' + suffix.at(-1), session: {
        zzud: person.login, autologin: 'private-auto-' + suffix, session: 'private-session-' + suffix,
        remoteUserId: suffix,
      } };
    },
    async status(session) {
      const current = state.get(session.remoteUserId);
      if (current === 'expired') throw Object.assign(new Error('过期'), { code: 'auth_required' });
      return { remoteUserId: session.remoteUserId, label: 'fi***' + session.remoteUserId.at(-1), verified: current === 'ready' };
    },
    async courses(session) {
      await this.status(session);
      const person = people.find(item => item.remoteId === session.remoteUserId);
      return [{ id: person.courseId, title: '课程 ' + person.courseId, private: session.session }];
    },
    async homeworks(session, id) {
      await this.status(session);
      const person = people.find(item => item.remoteId === session.remoteUserId);
      assert.equal(id, person.courseId);
      return assignments?.get(id) ?? [{ id: person.homeworkId, title: '作业 ' + person.homeworkId, private: session.session }];
    },
    async inspect(session, targetScope) {
      const { courseId, homeworkId } = targetScope.binding ?? targetScope;
      const person = people.find(item => item.remoteId === session.remoteUserId);
      assert.equal(courseId, person.courseId);
      inspected.push({ courseId, homeworkId });
      const extra = inspectTask ? await inspectTask({ courseId, homeworkId, targetScope }) : {};
      return { binding: {
        courseId, homeworkId, remoteUserId: session.remoteUserId,
        taskId: 'task-' + homeworkId, practiceId: 'practice-' + homeworkId,
        gameId: homeworkId, challengeId: homeworkId,
      }, kind: 'manual', state: 'pending', title: '题目 ' + homeworkId, instructions: '题面 ' + homeworkId, ...extra };
    },
  };
  const credentials = {
    async modifyRecord(id, update) {
      stored.set(id, structuredClone(await update(stored.get(id))));
    },
    async readRecord(id) { return structuredClone(stored.get(id)); },
    async deleteRecord(id) { stored.delete(id); },
  };
  let service;
  const open = () => createService({
    root, credentials, transport, allowAccounts, allowTasks, mode, extended,
    runAgent: runAgent ?? (async () => assert.fail('此用例不应启动 Agent')),
  });
  service = open();
  t.after(async () => {
    await service.close();
    rmSync(root, { force: true, recursive: true });
  });
  return {
    root, stored, state, authAttempts, inspected,
    api: (action, fields = {}) => service.execute({ action, ...fields }),
    async reopen() {
      await service.close();
      service = open();
    },
  };
}

function bind(api, person) {
  return api('addAccount', { login: person.login, password: person.password });
}

function target(account, person) {
  return { accountId: account.id, courseId: person.courseId, homeworkId: person.homeworkId };
}

test('账号凭据分区、过期和重新登录，账号元数据与队列重开后无原始秘密', async t => {
  const { api, root, stored, state, reopen } = setup(t);
  const [first, second] = await Promise.all(people.map(person => bind(api, person)));
  assert.notEqual(first.id, second.id);
  assert.deepEqual(Object.keys(first).sort(), ['id', 'label', 'status', 'updatedAt']);
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  assert.equal(stored.get('dsh-educoder/account-' + first.id).payload.remoteUserId, people[0].remoteId);
  assert.equal(stored.get('dsh-educoder/account-' + second.id).payload.remoteUserId, people[1].remoteId);
  assert.ok([...stored.values()].every(record => !JSON.stringify(record).includes('never-store-password')));
  await assert.rejects(bind(api, people[0]), { code: 'already_exists' });
  await assert.rejects(api('relogin', {
    accountId: first.id, login: people[1].login, password: people[1].password,
  }), { code: 'invalid_scope' });
  assert.equal(stored.get('dsh-educoder/account-' + first.id).payload.remoteUserId, people[0].remoteId);

  state.set(people[0].remoteId, 'expired');
  await assert.rejects(api('checkAccount', { accountId: first.id }), { code: 'auth_required' });
  assert.equal((await api('accounts')).find(account => account.id === first.id).status, 'auth_required');
  assert.equal((await api('checkAccount', { accountId: second.id })).status, 'ready');
  const relogin = await api('relogin', { accountId: first.id, login: people[0].login, password: people[0].password });
  assert.equal(relogin.status, 'ready');
  await reopen();

  const accountFile = join(root, 'accounts.sqlite');
  const queueFile = join(root, 'queue.sqlite');
  for (const file of [accountFile, queueFile]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const bytes = readFileSync(file);
    for (const secret of [...people.flatMap(person => [person.login, person.password]), 'private-auto-', 'private-session-']) {
      assert.equal(bytes.includes(secret), false);
    }
  }
  const courses = await api('courses', { accountId: first.id });
  assert.deepEqual(courses, [{ id: people[0].courseId, title: '课程 course-a' }]);
});

test('拒绝跨账号作业批次且不落盘，删除账号只取消该账号队列并移除凭据', async t => {
  const { api, stored, reopen } = setup(t);
  const [first, second] = await Promise.all(people.map(person => bind(api, person)));
  await assert.rejects(api('allocate', {
    targets: [target(first, people[0]), target(second, people[0])], start: false,
  }), { code: 'invalid_scope' });
  assert.deepEqual(await api('tasks'), []);

  const targets = [target(first, people[0]), target(second, people[1])];
  const queued = await api('allocate', { targets, start: false });
  assert.deepEqual((await api('allocate', { targets, start: false })).map(task => task.id), queued.map(task => task.id));
  assert.deepEqual(await api('removeAccount', { accountId: first.id }), { id: first.id });
  await reopen();

  assert.equal(stored.has('dsh-educoder/account-' + first.id), false);
  assert.equal(stored.has('dsh-educoder/account-' + second.id), true);
  assert.deepEqual((await api('accounts')).map(account => account.id), [second.id]);
  const tasks = new Map((await api('tasks')).map(task => [task.accountId, task]));
  assert.equal(tasks.get(first.id).status, 'cancelled');
  assert.equal(tasks.get(second.id).status, 'waiting');
  await assert.rejects(api('courses', { accountId: first.id }), { code: 'not_found' });
});

test('禁用真实账号时认证和运行请求在访问平台之前被拒绝', async t => {
  const { api, authAttempts, stored } = setup(t, { allowAccounts: false });
  for (const action of ['addAccount', 'relogin', 'checkAccount', 'courses', 'homeworks', 'allocate', 'startCourse']) {
    await assert.rejects(api(action, { login: people[0].login, password: people[0].password }), { code: 'live_disabled' });
  }
  for (const command of ['start', 'resume']) {
    await assert.rejects(api('control', { command }), { code: 'live_disabled' });
  }
  assert.deepEqual(authAttempts, []);
  assert.equal(stored.size, 0);
  assert.deepEqual(await api('accounts'), []);
  assert.deepEqual(await api('tasks'), []);
});

test('真实账号的只读实例允许登录和目录读取，拒绝分配和启动作业', async t => {
  const { api } = setup(t, { allowTasks: false, mode: 'live' });
  const person = people[0];
  const account = await bind(api, person);
  assert.equal((await api('courses', { accountId: account.id })).length, 1);
  assert.equal((await api('homeworks', { accountId: account.id, courseId: person.courseId })).length, 1);
  assert.deepEqual(await api('settings'), { concurrency: 2, mode: 'live', tasksEnabled: false });
  await assert.rejects(api('allocate', { targets: [target(account, person)], start: true }), { code: 'tasks_disabled' });
  await assert.rejects(api('startCourse', { accountId: account.id, courseId: person.courseId }), { code: 'tasks_disabled' });
  await assert.rejects(api('control', { command: 'resume', taskIds: [] }), { code: 'tasks_disabled' });
  assert.deepEqual(await api('tasks'), []);
});

test('课程通关只启动当前账号课程的未完成作业，重复点击不重试已处理任务', async t => {
  const [owner, other] = people;
  const completed = { id: '12', title: '已通过', taskCount: 2, passedCount: 2 };
  const partial = { id: '13', title: '进行中', taskCount: 4, passedCount: 1 };
  const waiting = { id: '14', title: '待启动', taskCount: 0, passedCount: 0 };
  const { api, inspected } = setup(t, { assignments: new Map([[owner.courseId, [completed, partial, waiting]]]) });
  const [first, second] = await Promise.all(people.map(person => bind(api, person)));
  const selected = { accountId: first.id, courseId: owner.courseId };
  await assert.rejects(api('startCourse', { ...selected, courseId: other.courseId }), { code: 'invalid_scope' });
  assert.deepEqual(await api('tasks'), []);

  const [waitingTask, otherTask] = await api('allocate', {
    targets: [{ ...selected, homeworkId: waiting.id }, target(second, other)],
  });
  const result = await api('startCourse', { ...selected, targets: [target(second, other)] });
  assert.deepEqual({ ...result, tasks: result.tasks.map(task => task.homeworkId) }, {
    started: 2, skippedCompleted: 1, skippedExisting: 0, tasks: [partial.id, waiting.id],
  });
  assert.equal(result.tasks[1].id, waitingTask.id);
  assert.ok(result.tasks.every(task => task.status === 'queued' && task.courseId === owner.courseId));

  const repeated = await api('startCourse', selected);
  assert.deepEqual(repeated, { tasks: [], started: 0, skippedCompleted: 1, skippedExisting: 2 });
  assert.equal((await api('task', { taskId: otherTask.id })).status, 'waiting');
  assert.ok(inspected.every(task => task.courseId === owner.courseId && task.homeworkId !== completed.id));
});

test('课程通关支持超过一百份作业，并在全部校验成功后才启动', async t => {
  const owner = people[0];
  const homeworks = Array.from({ length: 101 }, (_, index) => ({ id: String(101 + index), title: `作业 ${index + 1}` }));
  const assignments = new Map([[owner.courseId, [...homeworks, { id: 'bad' }]]]);
  const { api } = setup(t, { assignments });
  const account = await bind(api, owner);
  const selected = { accountId: account.id, courseId: owner.courseId };
  await assert.rejects(api('startCourse', selected), { code: 'invalid_scope' });
  assert.deepEqual(await api('tasks'), []);

  assignments.set(owner.courseId, homeworks);
  const result = await api('startCourse', selected);
  assert.equal(result.started, 101);
  assert.equal(result.tasks.length, 101);
  assert.deepEqual(result.tasks.map(task => task.homeworkId), homeworks.map(task => task.id));
});

test('tasks 接口默认按更新时间倒序返回队列任务', async t => {
  const owner = people[0];
  const homeworks = [
    { id: '11', title: '作业 11' },
    { id: '12', title: '作业 12' },
    { id: '13', title: '作业 13' },
  ];
  const { api } = setup(t, { assignments: new Map([[owner.courseId, homeworks]]) });
  const account = await bind(api, owner);
  const [first] = await api('allocate', {
    targets: [{ accountId: account.id, courseId: owner.courseId, homeworkId: '11' }],
    start: false,
  });
  await delay(5);
  const [second] = await api('allocate', {
    targets: [{ accountId: account.id, courseId: owner.courseId, homeworkId: '12' }],
    start: false,
  });
  await delay(5);
  const [third] = await api('allocate', {
    targets: [{ accountId: account.id, courseId: owner.courseId, homeworkId: '13' }],
    start: false,
  });
  assert.deepEqual((await api('tasks')).map(task => task.id), [third.id, second.id, first.id]);

  await delay(5);
  await api('control', { taskIds: [first.id], command: 'start' });
  assert.deepEqual((await api('tasks')).map(task => task.id), [first.id, third.id, second.id]);
});

test('一键通关会重启队列中已暂停的任务，将待评审任务计入已完成跳过，并保留人工处理任务', async t => {
  const owner = people[0];
  const homeworks = [
    { id: '11', title: '暂停作业' },
    { id: '12', title: '待评审客观题' },
    { id: '13', title: '人工作业' },
  ];
  const markers = new Map([['11', '0'], ['12', '8']]);
  let holdPaused;
  let passedPaused = false;
  let reviewRuns = 0;
  const { api } = setup(t, {
    extended: true,
    assignments: new Map([[owner.courseId, homeworks]]),
    inspectTask: ({ homeworkId }) => {
      if (homeworkId === '11') {
        return passedPaused
          ? { kind: 'code', state: 'passed', marker: markers.get('11'), paths: ['main.py'] }
          : { kind: 'code', state: 'pending', marker: markers.get('11'), paths: ['main.py'] };
      }
      if (homeworkId === '12') {
        return {
          kind: 'choice',
          state: 'pending',
          choiceResultHidden: true,
          marker: markers.get('12'),
          questions: [{ type: 'single', prompt: 'q1', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }] }],
        };
      }
      return { kind: 'manual', state: 'pending' };
    },
    runAgent: async run => {
      await run.onSession('sess-' + run.homeworkId);
      if (run.homeworkId === '11') {
        if (!holdPaused) {
          if (run.signal.aborted) throw run.signal.reason;
          return new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true }));
        }
        markers.set('11', '1');
        passedPaused = true;
        return { status: 'finished' };
      }
      if (run.homeworkId === '12') {
        reviewRuns++;
        markers.set('12', '9');
        return { status: 'finished' };
      }
      return { status: 'finished' };
    },
  });

  const account = await bind(api, owner);
  const selected = { accountId: account.id, courseId: owner.courseId };
  const initial = await api('allocate', {
    targets: [
      { ...selected, homeworkId: '11' },
      { ...selected, homeworkId: '12' },
      { ...selected, homeworkId: '13' },
    ],
    start: true,
  });
  const waitStatus = async (id, expected) => {
    let last;
    for (let i = 0; i < 80; i++) {
      last = await api('task', { taskId: id });
      if (last.status === expected) return last;
      await delay(10);
    }
    assert.fail(`等待任务 ${id} 变为 ${expected} 超时，当前为 ${JSON.stringify({ status: last?.status, code: last?.code, events: last?.events })}`);
  };

  await waitStatus(initial[0].id, 'running');
  await api('control', { taskIds: [initial[0].id], command: 'pause' });
  await waitStatus(initial[0].id, 'paused');
  await waitStatus(initial[1].id, 'pending_review');
  await waitStatus(initial[2].id, 'manual');

  holdPaused = true;
  const restarted = await api('startCourse', selected);
  assert.deepEqual({ ...restarted, tasks: restarted.tasks.map(task => task.homeworkId) }, {
    started: 1, skippedCompleted: 1, skippedExisting: 1, tasks: ['11'],
  });
  await waitStatus(initial[0].id, 'passed');
  assert.equal((await api('task', { taskId: initial[1].id })).status, 'pending_review');
  assert.equal((await api('task', { taskId: initial[2].id })).status, 'manual');
  assert.equal(reviewRuns, 1);

  const afterPass = await api('startCourse', selected);
  assert.deepEqual(afterPass, { tasks: [], started: 0, skippedCompleted: 2, skippedExisting: 1 });
});
