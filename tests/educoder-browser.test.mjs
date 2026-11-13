import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { createBrowserInspector } from '../plugins/educoder/browser.js';

const web = 'https://www.educoder.net';
const api = 'https://data.educoder.net';
const binding = { courseId: 'course-a', homeworkId: '42', taskId: 'game-a', remoteUserId: '11' };
const session = { remoteUserId: '11', session: 'fixture-session', autologin: 'fixture-auto', zzud: 'fixture-zzud' };
const target = `${web}/tasks/course-a/42/game-a`;
const detail = `${api}/api/tasks/game-a.json?homework_common_id=42`;

test('隔离浏览器只读取已绑定关卡，不做请求拦截，核对账号并清理会话', async () => {
  let closeCount = 0;
  let privateHome;
  let responsePredicate;
  let settled = 0;
  let installedRoute = false;
  let installedWsRoute = false;
  let cookies;
  const page = {
    waitForResponse(predicate) {
      responsePredicate = predicate;
      return Promise.resolve({
        json: async () => ({ user: { user_id: 11 }, homework_common_id: 42, game: { identifier: 'game-a' } }),
      });
    },
    async goto(url) {
      assert.equal(url, target);
      assert.ok(responsePredicate({ ok: () => true, url: () => detail }));
      return { ok: () => true };
    },
    async waitForLoadState(state) {
      assert.equal(state, 'networkidle');
      settled++;
    },
    url: () => `${target}?tab=1`,
    locator: () => ({ evaluate: async () => '可见的题面 fixture-session fixture-auto fixture-zzud' }),
  };
  const launch = async options => {
    privateHome = options.env.HOME;
    assert.ok(privateHome.startsWith('/'));
    assert.equal(options.proxy.server, 'http://192.0.2.1:8080');
    assert.equal(options.headless, true);
    return {
      newContext: async contextOptions => {
        assert.equal(contextOptions.acceptDownloads, false);
        return {
          addCookies: async list => {
            cookies = list;
            assert.ok(list.every(item => item.httpOnly && item.secure && [web, api].includes(item.url)));
          },
          route: async () => { installedRoute = true; },
          routeWebSocket: async () => { installedWsRoute = true; },
          newPage: async () => page,
          close: async () => { closeCount++; },
        };
      },
      close: async () => { closeCount++; },
    };
  };
  const inspect = createBrowserInspector({ launch, proxy: 'http://192.0.2.1:8080' });
  await assert.rejects(inspect({ binding, session: { ...session, remoteUserId: '22' } }), { code: 'browser_scope_unverified' });
  assert.deepEqual(await inspect({ binding, session }), { text: '可见的题面 [已脱敏] [已脱敏] [已脱敏]' });
  assert.equal(cookies.length, 4);
  assert.equal(settled, 1);
  assert.equal(installedRoute, false);
  assert.equal(installedWsRoute, false);
  assert.equal(closeCount, 2);
  await assert.rejects(access(privateHome), { code: 'ENOENT' });
});

test('跳转离开绑定关卡或响应体所属范围不符时返回 scope 错误', async () => {
  const inspectRedirected = createBrowserInspector({
    launch: async () => ({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => ({
          waitForResponse: () => Promise.resolve({ json: async () => ({ user: { user_id: 11 }, homework_common_id: 42, game: { identifier: 'game-a' } }) }),
          goto: async () => ({ ok: () => true }),
          url: () => `${web}/login`,
        }),
        close: async () => {},
      }),
      close: async () => {},
    }),
  });
  await assert.rejects(inspectRedirected({ binding, session }), { code: 'browser_scope_unverified' });

  const inspectMismatchedDetail = createBrowserInspector({
    launch: async () => ({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => ({
          waitForResponse: () => Promise.resolve({ json: async () => ({ user: { user_id: 99 }, homework_common_id: 42, game: { identifier: 'game-a' } }) }),
          goto: async () => ({ ok: () => true }),
          url: () => target,
        }),
        close: async () => {},
      }),
      close: async () => {},
    }),
  });
  await assert.rejects(inspectMismatchedDetail({ binding, session }), { code: 'browser_scope_unverified' });
});

test('浏览器启动失败或已取消时只返回固定原因', async () => {
  const inspect = createBrowserInspector({ launch: async () => { throw new Error('不应显示的底层启动错误'); } });
  await assert.rejects(inspect({ binding, session }), { code: 'browser_unavailable', message: '头歌浏览器暂时无法启动。' });
  await assert.rejects(inspect({ binding, session, signal: AbortSignal.abort() }), { code: 'browser_cancelled' });
});
