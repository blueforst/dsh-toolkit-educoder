// 在 DSH 容器内执行。只接受带启动令牌的回环 DSH，以及内置的模拟账号。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';

const bootstrap = new URL(process.env.DSH_EDUCODER_SMOKE_URL || 'http://127.0.0.1:3080/');
const fixture = new URL('http://127.0.0.1:9299/');
const token = bootstrap.searchParams.get('token');
if (bootstrap.origin !== 'http://127.0.0.1:3080' || bootstrap.pathname !== '/' || !token) {
  throw new Error('请设置隔离实例的回环启动 URL。');
}
const base = bootstrap.origin;
const group = 'smoke-' + randomBytes(5).toString('hex');
const testAccounts = ['alice', 'bob'].map(name => {
  const login = 'educoder-' + group + '-' + name;
  return { login, password: 'fake-password-' + login };
});
const wrongPassword = 'fixture-incorrect-password';
const credentials = [wrongPassword, ...testAccounts.flatMap(item => [item.login, item.password])];
const denied = ['private-auto-', 'private-session-', 'private-proof-', 'never-project-private-test'];
let stage = 'fixture_health';
let cookie;

function noSecrets(value) {
  if ([token, ...credentials, ...denied].some(secret => value.includes(secret))) {
    throw new Error('隔离验收检测到敏感字段。');
  }
}

async function evidence() {
  const response = await fetch(new URL('/fixture/evidence?group=' + group, fixture), {
    signal: AbortSignal.timeout(4_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function request(action, fields = {}, { authenticate = true, origin = base, status = 200 } = {}) {
  const response = await fetch(base + '/dsh-educoder/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(authenticate && cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(35_000),
  });
  const text = await response.text();
  noSecrets(text);
  assert.equal(response.status, status, '操作 ' + action + ' 返回意外 HTTP 状态。');
  const parsed = JSON.parse(text);
  if (status === 200) assert.equal(parsed.ok, true, '操作 ' + action + ' 未成功。');
  return parsed;
}

async function api(action, fields) {
  return (await request(action, fields)).data;
}

async function expectDenied(path, method, status, authenticate) {
  // 使用原始路径，以免客户端先折叠需要验证的点段。
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: bootstrap.hostname, port: bootstrap.port, path, method,
      headers: { origin: base, ...(authenticate ? { cookie } : {}) },
      signal: AbortSignal.timeout(5_000),
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(result, status, '凭据边界返回意外状态 ' + method + ' ' + path);
}

try {
  const initialEvidence = await evidence();
  stage = 'authenticate_web';
  await request('accounts', {}, { authenticate: false, status: 401 });
  const auth = await fetch(bootstrap, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
  cookie = auth.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert.ok(cookie.length > 0, 'DSH 启动请求未设置浏览器认证 Cookie。');
  await auth.body?.cancel();
  await request('accounts', {}, { origin: 'https://untrusted.invalid', status: 403 });

  stage = 'credential_boundary';
  const blocked = [
    ['/api/file?path=%2Fetc%2Fhostname', 'GET'],
    ['/api/private/../file?path=%2Fetc%2Fhostname', 'GET'],
    ['/api/private/%2e%2e/file?path=%2Fetc%2Fhostname', 'GET'],
    ['/api/session/uploadFileBinary', 'POST'],
    ['/api/session/prompt', 'POST'],
    ['/api/session/create', 'POST'],
  ];
  for (const [path, method] of blocked) {
    await expectDenied(path, method, 401, false);
    await expectDenied(path, method, 403, true);
  }

  stage = 'add_accounts';
  const rejectedLogin = await request('addAccount', { login: testAccounts[0].login, password: wrongPassword }, { status: 409 });
  assert.equal(rejectedLogin.error.code, 'invalid_credentials');
  const added = [];
  for (const account of testAccounts) added.push(await api('addAccount', account));
  assert.notEqual(added[0].id, added[1].id);
  for (const account of added) {
    assert.equal(account.status, 'ready');
    assert.ok(account.label.includes('*'));
  }

  stage = 'discover_courses';
  const targets = await Promise.all(added.map(async account => {
    const courses = await api('courses', { accountId: account.id });
    assert.equal(courses.length, 1);
    const homeworks = await api('homeworks', { accountId: account.id, courseId: courses[0].id });
    assert.equal(homeworks.length, 1);
    return { accountId: account.id, courseId: courses[0].id, homeworkId: homeworks[0].id,
      courseTitle: courses[0].title, homeworkTitle: homeworks[0].title };
  }));
  assert.notEqual(targets[0].courseId, targets[1].courseId);
  assert.notEqual(targets[0].homeworkId, targets[1].homeworkId);

  stage = 'select_batch';
  assert.equal((await api('settings', { concurrency: 2 })).concurrency, 2);
  const outsideScope = await request('allocate', {
    targets: [targets[0], { ...targets[1], accountId: added[0].id }], start: false,
  }, { status: 403 });
  assert.equal(outsideScope.error.code, 'invalid_scope');
  assert.ok((await api('tasks', {})).every(task => !added.some(account => account.id === task.accountId)));
  const waiting = await api('allocate', { targets, start: false });
  assert.equal(waiting.length, 2);
  assert.ok(waiting.every(task => task.status === 'waiting'));
  const taskIds = waiting.map(task => task.id);

  stage = 'start_concurrent';
  await api('control', { taskIds, command: 'start' });
  const deadline = Date.now() + 75_000;
  let completed;
  while (Date.now() < deadline) {
    const tasks = (await api('tasks', {})).filter(task => taskIds.includes(task.id));
    if (tasks.length === 2 && tasks.every(task => task.status === 'passed')) {
      completed = tasks;
      break;
    }
    const failed = tasks.filter(task => ['failed', 'manual', 'cancelled'].includes(task.status));
    if (failed.length) {
      const statuses = failed.map(({ status, code }) => status + '/' + code);
      throw new Error('任务提前结束 ' + statuses.join(', '));
    }
    await wait(400);
  }
  assert.ok(completed, '等待真实 DSH Session 驱动两个模拟评测超时。');
  assert.notEqual(completed[0].sessionId, completed[1].sessionId);
  for (const task of completed) {
    assert.ok(/^[0-9a-f-]{36}$/i.test(task.sessionId));
    assert.ok(Number.isFinite(Date.parse(task.verifiedAt)));
    assert.equal(task.attempts, 1);
    const detail = await api('task', { taskId: task.id });
    assert.equal(detail.sessionId, task.sessionId);
    assert.ok(detail.events.some(event => event.sessionId === task.sessionId));
  }

  stage = 'verify_remote_readback_and_idempotency';
  const duplicate = await api('allocate', { targets, start: true });
  assert.deepEqual(new Set(duplicate.map(task => task.id)), new Set(taskIds));
  const checked = await evidence();
  assert.equal(checked.rejectedScope, initialEvidence.rejectedScope);
  assert.equal(checked.maxConcurrentAgents, 2);
  assert.equal(checked.accounts.length, 2);
  for (const remote of checked.accounts) {
    assert.ok(targets.some(target => target.courseId === remote.course && target.homeworkId === remote.homework));
    assert.equal(remote.saves, 1);
    assert.equal(remote.builds, 1);
    assert.equal(remote.fileReads, 1);
    assert.ok(remote.readback >= 1);
    assert.ok(remote.modelCalls >= 3);
    assert.equal(remote.passed, true);
  }
  stage = 'expire_and_relogin';
  const expired = await fetch(new URL('/fixture/expire', fixture), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: testAccounts[0].login }),
    signal: AbortSignal.timeout(4_000),
  });
  assert.equal(expired.status, 200);
  await expired.body?.cancel();
  const invalid = await request('checkAccount', { accountId: added[0].id }, { status: 409 });
  assert.equal(invalid.error.code, 'auth_required');
  const accountList = await api('accounts', {});
  assert.equal(accountList.find(account => account.id === added[0].id).status, 'auth_required');
  assert.equal(accountList.find(account => account.id === added[1].id).status, 'ready');
  assert.equal((await api('relogin', { accountId: added[0].id, ...testAccounts[0] })).status, 'ready');
  console.log(JSON.stringify({
    status: 'passed', realDshSessions: completed.map(task => task.sessionId),
    twoAccountCourseIsolation: true, peakConcurrentAgents: checked.maxConcurrentAgents,
    perAccountSaves: checked.accounts.map(item => item.saves),
    perAccountSubmissions: checked.accounts.map(item => item.builds),
    perAccountRemoteReadbacks: checked.accounts.map(item => item.readback),
    idempotentAllocation: true, authenticatedWeb: true, badOriginRejected: true,
    credentialsFiltered: true, hostFileAndUploadRoutesDenied: true, manualSessionMutationDenied: true,
    perAccountRelogin: true,
    simulatedEduCoder: true, simulatedPi: true,
  }));
} catch (error) {
  const message = String(error.message).split('\n')[0];
  console.error(JSON.stringify({
    status: 'failed', stage,
    error: [token, ...credentials, ...denied].some(secret => message.includes(secret))
      ? '错误包含敏感字段，已隐藏。' : message,
  }));
  process.exitCode = 1;
}
