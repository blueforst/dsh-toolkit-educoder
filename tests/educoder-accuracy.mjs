// 只接受回环测试实例。通过同一套 Web API 分配、启动并等待每份作业。
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
  const group = 'bench-' + randomBytes(5).toString('hex');
  const fetchLocal = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const evidenceURL = new URL('/fixture/benchmark?group=' + group, fixture);
  async function evidence() {
    const response = await fetchLocal(evidenceURL);
    assert.equal(response.status, 200, '需要启用隐藏用例的 EduCoder 替身');
    return response.json();
  }
  await evidence();
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
  assert.equal(settings.mode, 'fixture', '准确率测试只能在模拟账号模式运行');
  assert.equal(settings.tasksEnabled, true, '测试实例必须允许作业执行');
  const identities = await Promise.all(['alice', 'bob'].map(async name => {
    const login = `educoder-${group}-${name}`;
    const { id: accountId } = await api('addAccount', { login, password: 'fake-password-' + login });
    const [{ id: courseId }] = await api('courses', { accountId });
    const homeworks = await api('homeworks', { accountId, courseId });
    assert.equal(homeworks.length, 12);
    return { accountId, courseId, homeworks };
  }));
  const targets = identities.flatMap(({ accountId, courseId, homeworks }, index) =>
    homeworks.filter((_, i) => i % identities.length === index)
      .map(({ id: homeworkId }) => ({ accountId, courseId, homeworkId })));
  assert.equal(targets.length, 12);
  const started = Date.now();
  const batch = await api('allocate', { targets, start: true });
  const taskIds = new Set(batch.map(item => item.id));
  const terminal = new Set(['passed', 'failed', 'manual', 'cancelled', 'paused']);
  let tasks;
  let last = -1;
  do {
    tasks = (await api('tasks')).filter(task => taskIds.has(task.id));
    const done = tasks.filter(task => terminal.has(task.status)).length;
    if (done !== last) {
      console.error(`已完成 ${done}/${targets.length}`);
      last = done;
    }
    if (done === targets.length || Date.now() - started >= 15 * 60_000) break;
    await wait(1_000);
  } while (true);

  const graded = await evidence();
  const rows = tasks.map(task => {
    const result = graded.assignments.find(item => item.homeworkId === task.homeworkId);
    assert.ok(result, '找不到作业对应的独立判题记录');
    const evaluations = result.evaluations;
    const first = evaluations[0];
    const final = evaluations.at(-1);
    assert.equal(task.status === 'passed', final?.passed === true, 'DSH 和独立判题器结果不一致');
    if (task.status === 'passed') {
      assert.ok(task.verifiedAt && task.sessionId && result.readbacks > 0);
    }
    return {
      id: result.id, title: result.title, kind: result.kind, status: task.status, code: task.code,
      seconds: task.finishedAt && task.startedAt
        ? Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 100) / 10 : null,
      submissions: evaluations.length, firstPassed: first?.passed === true, finalPassed: final?.passed === true,
      passedTests: final?.passedTests ?? 0, totalTests: final?.totalTests ?? result.totalTests,
      initialized: result.initialized,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  console.log(JSON.stringify({
    total: targets.length, completed: rows.filter(row => terminal.has(row.status)).length,
    submitted: rows.filter(row => row.submissions > 0).length,
    firstPassed: rows.filter(row => row.firstPassed).length,
    finalPassed: rows.filter(row => row.finalPassed).length,
    submissions: rows.reduce((sum, row) => sum + row.submissions, 0),
    rejectedScope: graded.rejectedScope,
    seconds: Math.round((Date.now() - started) / 100) / 10, rows,
  }, null, 2));
  assert.equal(rows.length, targets.length);
  assert.ok(rows.every(row => terminal.has(row.status)), '部分作业在等待时限内没有完成');
}

try {
  await run();
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : '隔离准确率测试未能完成。');
  process.exitCode = 1;
}
