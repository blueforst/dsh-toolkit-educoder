// 使用配置了 cacheRetention: long 的隔离模型替身验收原生 DSH 会话续跑。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

function loopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/');
  assert.ok(!url.username && !url.password && !url.hash);
  return url;
}

async function run() {
  const bootstrap = loopback(process.env.DSH_EDUCODER_SMOKE_URL);
  assert.ok(bootstrap.searchParams.get('token'), '需要隔离 DSH 的启动凭据');
  const fixture = loopback(process.env.DSH_EDUCODER_FIXTURE_URL || 'http://127.0.0.1:9299/');
  const group = 'resume-' + randomBytes(5).toString('hex');
  const fetchLocal = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });
  async function evidence() {
    const response = await fetchLocal(new URL('/fixture/evidence?group=' + group, fixture));
    assert.equal(response.status, 200, '需要支持会话续跑验收的 EduCoder 替身');
    return response.json();
  }
  const before = await evidence();
  const auth = await fetchLocal(bootstrap, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  await auth.body?.cancel();
  assert.ok(cookie, '启动凭据未换到本地 DSH 会话');
  async function api(action, fields = {}) {
    const response = await fetchLocal(new URL('/dsh-educoder/api', bootstrap), {
      method: 'POST', headers: { origin: bootstrap.origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
    });
    const result = await response.json();
    assert.ok(response.ok && result.ok, `操作 ${action} 未成功（HTTP ${response.status}）`);
    return result.data;
  }
  async function settled(taskId) {
    const deadline = Date.now() + 30_000;
    do {
      const task = await api('task', { taskId });
      if (['failed', 'passed', 'manual', 'paused', 'cancelled'].includes(task.status)) return task;
      await wait(200);
    } while (Date.now() < deadline);
    throw new Error('等待作业结算超时。');
  }
  const settings = await api('settings');
  assert.equal(settings.mode, 'fixture', '会话验收只能在隔离模式运行');
  assert.equal(settings.tasksEnabled, true);
  const identities = [];
  for (const name of ['alice', 'bob']) {
    const login = `educoder-${group}-${name}`;
    const { id: accountId } = await api('addAccount', { login, password: 'fake-password-' + login });
    const [{ id: courseId }] = await api('courses', { accountId });
    const [{ id: homeworkId }] = await api('homeworks', { accountId, courseId });
    const [{ id: taskId }] = await api('allocate', { targets: [{ accountId, courseId, homeworkId }], start: true });
    const failed = await settled(taskId);
    assert.equal(failed.status, 'failed', `初次评测结算为 ${failed.status} / ${failed.code}`);
    assert.equal(failed.code, 'verification_failed');
    assert.equal(failed.attempts, 1);
    assert.match(failed.sessionId, /^[a-z0-9-]{36}$/i);
    await api('control', { taskIds: [taskId], command: 'resume' });
    const passed = await settled(taskId);
    assert.equal(passed.status, 'passed', `续跑评测结算为 ${passed.status} / ${passed.code}`);
    assert.ok(passed.verifiedAt);
    assert.equal(passed.attempts, 2);
    assert.equal(passed.sessionId, failed.sessionId);
    identities.push({ homeworkId, sessionId: passed.sessionId });
  }

  assert.notEqual(identities[0].sessionId, identities[1].sessionId);
  const after = await evidence();
  assert.equal(after.rejectedScope, before.rejectedScope, '替身拒绝了不符合预期的请求');
  assert.equal(after.accounts.length, identities.length);
  for (const { homeworkId, sessionId } of identities) {
    const account = after.accounts.find(value => value.homework === homeworkId);
    assert.ok(account);
    assert.equal(account.affinity, sessionId);
    assert.equal(account.resumeSteps, 9);
    assert.equal(account.saves, 2);
    assert.equal(account.builds, 2);
    assert.equal(account.passed, true);
  }
  console.log(JSON.stringify({ reusedSessions: identities.length, retainedToolHistory: true,
    stableProviderAffinity: true, refusedEvaluationWithoutFreshProof: true, verified: identities.length }));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : '隔离会话续跑验收未能完成。');
  process.exitCode = 1;
}
