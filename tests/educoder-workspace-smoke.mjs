// 在隔离 DSH Web 中验证原生工作区归属和模型跨会话复用经验。
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

function loopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/');
  assert.ok(!url.username && !url.password && !url.hash);
  return url;
}

function nativeWorkspace(origin, cookie) {
  const url = new URL('/api/remote.mux', origin);
  url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers: { origin, cookie } });
  const streamId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('工作区服务未返回快照。')), 8_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } }));
    });
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      if (frame.streamId !== streamId) return;
      if (frame.type === 'item' && frame.value?.type === 'baseline') finish(null, frame.value.value.items);
      if (frame.type === 'error') finish(new Error('工作区服务拒绝快照请求。'));
    });
    socket.addEventListener('error', () => finish(new Error('无法连接工作区服务。')), { once: true });
  });
}

async function run() {
  const bootstrap = loopback(process.env.DSH_EDUCODER_SMOKE_URL);
  assert.ok(bootstrap.searchParams.get('token'), '需要隔离 DSH 的启动凭据');
  const fixture = loopback(process.env.DSH_EDUCODER_FIXTURE_URL || 'http://127.0.0.1:9299/');
  const directory = await realpath(process.env.DSH_EDUCODER_WORKSPACE_DIR);
  const group = 'workspace-' + randomBytes(5).toString('hex');
  const fetchLocal = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });

  const evidenceURL = new URL('/fixture/evidence?group=' + group, fixture);
  async function evidence() {
    const response = await fetchLocal(evidenceURL);
    assert.equal(response.status, 200, '需要支持工作区验收的 EduCoder 替身');
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

  const settings = await api('settings');
  assert.equal(settings.mode, 'fixture', '工作区验收只能在隔离模式运行');
  assert.equal(settings.tasksEnabled, true);
  const completed = [];
  for (const name of ['alice', 'bob']) {
    const login = `educoder-${group}-${name}`;
    const { id: accountId } = await api('addAccount', { login, password: 'fake-password-' + login });
    const [{ id: courseId }] = await api('courses', { accountId });
    const [{ id: homeworkId }] = await api('homeworks', { accountId, courseId });
    const [{ id: taskId }] = await api('allocate', { targets: [{ accountId, courseId, homeworkId }], start: true });
    const deadline = Date.now() + 30_000;
    let task;
    do {
      task = await api('task', { taskId });
      if (task.status === 'passed') break;
      assert.ok(!['failed', 'manual', 'cancelled', 'paused'].includes(task.status), `任务提前结束（${task.status} / ${task.code}）`);
      await wait(250);
    } while (Date.now() < deadline);
    assert.equal(task.status, 'passed');
    assert.ok(task.sessionId && task.verifiedAt, '没有创建并核验原生会话');
    completed.push(task.sessionId);
  }

  const snapshots = await nativeWorkspace(bootstrap.origin, cookie);
  const groups = snapshots.filter(workspace => workspace.path === directory);
  assert.equal(groups.length, 1, '应注册一个 EduCoder 专属工作区');
  assert.equal(groups[0].title, 'EduCoder');
  assert.ok(completed.every(id => groups[0].sessionIds.includes(id)), '两个会话应归属于同一原生工作区');
  const notes = await readFile(join(directory, '解题经验.md'), 'utf8');
  assert.match(notes, /公开样例/);
  assert.ok(!notes.includes('通过前尝试写入'));
  assert.equal(notes.split(`修改程序后用公开样例确认输出格式。验收标记 ${group.slice(-10)}。`).length, 2, '相同经验只应保存一次');
  const result = await evidence();
  assert.equal(result.rejectedScope, before.rejectedScope, '替身拒绝了不符合预期的请求');
  assert.equal(result.accounts.length, 2);
  for (const account of result.accounts) {
    assert.equal(account.experienceVerified, true, '模型应遵守通过后记录并在新会话中收到旧经验');
    assert.equal(account.builds, 1);
    assert.equal(account.passed, true);
  }
  console.log(JSON.stringify({ nativeWorkspace: true, groupedSessions: completed.length, recordedAfterPass: true,
    reusedInNextSession: true, duplicateSkipped: true }));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : '隔离工作区验收未能完成。');
  process.exitCode = 1;
}
