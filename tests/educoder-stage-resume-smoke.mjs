// 在独立 DSH Web 容器验证同一作业的连续关卡复用原生会话。
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
  const group = 'stages-' + randomBytes(5).toString('hex');
  const fetchLocal = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const evidenceUrl = new URL('/fixture/evidence?group=' + group, fixture);
  async function evidence() {
    const response = await fetchLocal(evidenceUrl);
    assert.equal(response.status, 200, '需要支持多关卡的 EduCoder 替身');
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
  assert.equal(settings.mode, 'fixture');
  assert.equal(settings.tasksEnabled, true);
  const login = `educoder-${group}-alice`;
  const { id: accountId } = await api('addAccount', { login, password: 'fake-password-' + login });
  const [{ id: courseId }] = await api('courses', { accountId });
  const [{ id: homeworkId }] = await api('homeworks', { accountId, courseId });
  const [queued] = await api('allocate', { targets: [{ accountId, courseId, homeworkId }], start: true });
  const deadline = Date.now() + 30_000;
  let task;
  do {
    task = await api('task', { taskId: queued.id });
    if (task.status === 'passed') break;
    assert.ok(!['failed', 'manual', 'cancelled', 'paused'].includes(task.status),
      `多关卡任务提前结束（${task.status} / ${task.code}）`);
    await wait(250);
  } while (Date.now() < deadline);
  assert.equal(task.status, 'passed');
  assert.ok(task.sessionId && task.verifiedAt);
  assert.deepEqual([...new Set(task.events.flatMap(event => event.sessionId ? [event.sessionId] : []))], [task.sessionId]);

  const result = await evidence();
  assert.equal(result.rejectedScope, initial.rejectedScope, '旧关卡路径不应抵达替身平台');
  const stages = result.accounts.sort((left, right) => left.index - right.index);
  assert.equal(stages.length, 2);
  for (const stage of stages) {
    assert.equal(stage.homework, homeworkId);
    assert.equal(stage.affinity, task.sessionId, '模型的缓存会话标识必须与 DSH 会话一致');
    assert.equal(stage.passed, true);
    assert.ok(stage.readback >= 1);
    assert.equal(stage.saves, 1);
    assert.equal(stage.builds, 1);
    assert.equal(stage.fileReads, 1);
    assert.equal(stage.imageDownloads, 1);
    assert.equal(stage.imageRequests, 5);
  }
  assert.equal(stages[0].nativeReadVerified, true);
  assert.equal(stages[1].oldPathRejected, true);
  assert.equal(stages[1].historyRetained, true);
  console.log(JSON.stringify({
    stagesPassed: stages.length, sameSession: true, samePromptCacheKey: true,
    nativeWorkspaceRead: true, previousStagePathRejected: true, previousImageRetained: true,
    evaluationCountPerStage: stages.map(stage => stage.builds),
  }));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : '隔离多关卡验收失败。');
  process.exitCode = 1;
}
