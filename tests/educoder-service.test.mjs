import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService } from '../plugins/educoder/service.js';

const people = [
  { login: 'fixture-first-person', password: 'never-store-password-a', remoteId: '101', courseId: 'course-a', homeworkId: '11' },
  { login: 'fixture-second-person', password: 'never-store-password-b', remoteId: '202', courseId: 'course-b', homeworkId: '22' },
];

function setup(t, { allowAccounts = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-educoder-service-')));
  const stored = new Map();
  const state = new Map();
  const authAttempts = [];
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
      return [{ id: person.homeworkId, title: '作业 ' + person.homeworkId, private: session.session }];
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
    root, credentials, transport, allowAccounts,
    runAgent: async () => assert.fail('此用例不应启动 Agent'),
  });
  service = open();
  t.after(async () => {
    await service.close();
    rmSync(root, { force: true, recursive: true });
  });
  return {
    root, stored, state, authAttempts,
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
  for (const action of ['addAccount', 'relogin', 'checkAccount', 'courses', 'homeworks', 'allocate']) {
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
