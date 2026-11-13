// 通过独立 DSH Web 和 Pi 验收头歌题面附件读取。
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
  const group = 'vision-' + randomBytes(5).toString('hex');
  const fetchLocal = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });

  const evidenceURL = new URL('/fixture/evidence?group=' + group, fixture);
  async function evidence() {
    const response = await fetchLocal(evidenceURL);
    assert.equal(response.status, 200, '需要支持题面图片的 EduCoder 替身');
    return response.json();
  }
  const initial = await evidence();
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

  const settings = await api('settings');
  assert.equal(settings.mode, 'fixture', '读图验收只能在隔离模式运行');
  assert.equal(settings.tasksEnabled, true, '隔离实例必须允许作业执行');
  const targets = await Promise.all(['alice', 'bob', 'missing'].map(async name => {
    const login = `educoder-${group}-${name}`;
    const { id: accountId } = await api('addAccount', { login, password: 'fake-password-' + login });
    const [{ id: courseId }] = await api('courses', { accountId });
    const [{ id: homeworkId }] = await api('homeworks', { accountId, courseId });
    return { accountId, courseId, homeworkId };
  }));
  assert.notEqual(targets[0].homeworkId, targets[1].homeworkId);
  const batch = await api('allocate', { targets, start: true });
  const taskIds = new Set(batch.map(item => item.id));
  const missing = targets[2].homeworkId;
  const expected = task => task.homeworkId === missing ? 'manual' : 'passed';
  const deadline = Date.now() + 30_000;
  let tasks;
  do {
    tasks = (await api('tasks')).filter(task => taskIds.has(task.id));
    if (tasks.length === 3 && tasks.every(task => task.status === expected(task))) break;
    const failed = tasks.find(task => task.status !== expected(task)
      && ['passed', 'failed', 'manual', 'cancelled', 'paused'].includes(task.status));
    assert.ok(!failed, `DSH 读图任务提前结束（${failed?.status} / ${failed?.code}）`);
    await wait(250);
  } while (Date.now() < deadline);
  assert.equal(tasks.length, 3);
  assert.ok(tasks.filter(task => task.homeworkId !== missing).every(task => task.status === 'passed' && task.verifiedAt),
    '未获得两个平台通过结果');
  const missingTask = tasks.find(task => task.homeworkId === missing);
  assert.equal(missingTask.status, 'manual');
  assert.equal(missingTask.code, 'image_unavailable');

  const result = await evidence();
  assert.equal(result.rejectedScope, initial.rejectedScope, '替身拒绝了越界或不符合预期的请求');
  assert.equal(result.accounts.length, 3);
  const checked = result.accounts.filter(account => account.homework !== missing);
  for (const account of checked) {
    assert.ok(account.imageDownloads >= 1, '头歌附件未被下载');
    assert.ok(account.imageRequests >= 3, 'Pi 未收到与该题完全一致的 PNG 图像数据');
    assert.equal(account.imageRequests, account.modelCalls);
    assert.equal(account.builds, 1);
    assert.equal(account.passed, true);
    assert.ok(account.readback >= 1, 'DSH 未读回头歌评测结果');
  }
  const missingImage = result.accounts.find(account => account.homework === missing);
  assert.ok(missingImage.imageDownloads >= 1);
  assert.equal(missingImage.modelCalls, 0);
  assert.equal(missingImage.saves, 0);
  assert.equal(missingImage.builds, 0);
  console.log(JSON.stringify({ passed: checked.length, verifiedInlineImages: checked.length,
    modelRequestsWithImages: checked.map(account => account.imageRequests),
    submittedPerAccount: checked.map(account => account.builds), missingImageSkipped: true }));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : '隔离读图验收未能完成。');
  process.exitCode = 1;
}
