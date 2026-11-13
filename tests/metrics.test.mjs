import test from 'node:test';
import assert from 'node:assert/strict';
import { apply as applyMetrics } from '../plugins/server-metrics/index.js';
import { apply as applyQuota } from '../vendor/dsh-toolkit-local/plugins/opencode-go-quota/index.js';

function response() {
  return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}
test('Go 月额度共享一分钟缓存，合并并发请求并支持 HEAD', async () => {
  const original = { fetch: globalThis.fetch, now: Date.now, key: process.env.OPENCODE_GO_API_KEY, url: process.env.DSH_METRICS_URL };
  let now = 100000, calls = 0;
  const routes = new Map();
  process.env.OPENCODE_GO_API_KEY = 'test-credential';
  process.env.DSH_METRICS_URL = 'http://127.0.0.1:9191/metrics';
  Date.now = () => now;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://opencode.ai/inference/go/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer test-credential');
    await Promise.resolve();
    return { ok: true, json: async () => ({ usage: { monthly: { percent: 8, status: 'ok', resetsAt: '2026-12-01T00:00:00.000Z' } } }) };
  };
  try {
    const ctx = { get: () => undefined, effect: callback => callback(), connection: { requestRejection: request => request.rejection }, webServer: { register: route => {
      assert(!routes.has(route.path), `路由重复注册：${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } };
    applyMetrics(ctx);
    applyQuota(ctx);
    assert.deepEqual([...routes.keys()].sort(), ['/opencode-go-quota', '/server-metrics']);
    for (const route of routes.values()) {
      for (const rejection of [401, 403]) {
        const denied = response(); await route.handler({ method: 'GET', rejection }, denied);
        assert.equal(denied.status, rejection);
      }
    }
    assert.equal(calls, 0, '认证拒绝前不应调用官方接口');
    const get = async method => { const res = response(); await routes.get('/opencode-go-quota').handler({ method }, res); return res; };
    const [a, b] = await Promise.all([get('GET'), get('GET')]);
    assert.equal(calls, 1);
    assert.equal(a.body, b.body);
    assert.equal(JSON.parse(a.body).monthly.percent, 8);
    assert(!a.body.includes('test-credential'));
    now += 59000; await get('GET'); assert.equal(calls, 1);
    now += 1000; await get('GET'); assert.equal(calls, 2);
    const head = await get('HEAD'); assert.equal(head.status, 200); assert.equal(head.body, undefined);
    const invalid = await get('POST'); assert.equal(invalid.status, 405);
  } finally {
    globalThis.fetch = original.fetch; Date.now = original.now;
    for (const [name, value] of [['OPENCODE_GO_API_KEY', original.key], ['DSH_METRICS_URL', original.url]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('服务器资源独立于 Go 额度，保留认证、方法检查和卸载', async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.DSH_METRICS_URL, key: process.env.OPENCODE_GO_API_KEY };
  const routes = new Map(), cleanups = [];
  const endpoint = 'http://127.0.0.1:9191/metrics';
  const sample = { scope: 'host', timestamp: Date.now(), cpu: { percent: 5, cores: 2 }, memory: { used: 1024, total: 4096, percent: 25 }, disk: { used: 2048, total: 8192, percent: 25 } };
  let calls = 0;
  process.env.DSH_METRICS_URL = endpoint;
  delete process.env.OPENCODE_GO_API_KEY;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, endpoint);
    assert(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => sample };
  };
  try {
    applyMetrics({
      effect: callback => cleanups.push(callback()),
      connection: { requestRejection: req => req.rejection },
      webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
    });
    assert.deepEqual([...routes.keys()], ['/server-metrics'], '资源模块不再附带额度路由');
    const get = async (method, rejection) => { const res = response(); await routes.get('/server-metrics').handler({ method, rejection }, res); return res; };
    for (const rejection of [401, 403]) {
      assert.equal((await get('GET', rejection)).status, rejection);
      const deniedHead = await get('HEAD', rejection);
      assert.equal(deniedHead.status, rejection);
      assert.equal(deniedHead.body, undefined);
    }
    assert.equal((await get('POST')).status, 405);
    assert.equal(calls, 0, '未认证和不支持的方法不应采样');
    const result = await get('GET');
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), sample);
    assert.equal(result.headers['Content-Length'], Buffer.byteLength(result.body));
    assert.equal(result.headers['Cache-Control'], 'no-store');
    const head = await get('HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    assert.equal(calls, 2);
    for (const dispose of cleanups) dispose();
    assert.equal(routes.size, 0);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [['DSH_METRICS_URL', previous.url], ['OPENCODE_GO_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('资源采样失败或格式错误时保留明确不可用状态，不泄露上游错误', async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.DSH_METRICS_URL };
  process.env.DSH_METRICS_URL = 'http://127.0.0.1:9191/metrics';
  let handler;
  try {
    applyMetrics({ effect: callback => callback(), connection: { requestRejection: () => undefined }, webServer: { register: route => { handler = route.handler; return () => {}; } } });
    for (const upstream of [
      async () => { throw new Error('private-upstream-detail'); },
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({ scope: 'container', timestamp: Date.now() }) }),
      async () => ({ ok: true, json: async () => ({ scope: 'host', timestamp: null }) }),
      async () => ({ ok: true, json: async () => { throw new Error('private-json-detail'); } }),
    ]) {
      globalThis.fetch = upstream;
      const get = response(); await handler({ method: 'GET' }, get);
      assert.equal(get.status, 503);
      assert.deepEqual(JSON.parse(get.body), { error: '服务器资源采样暂不可用' });
      const head = response(); await handler({ method: 'HEAD' }, head);
      assert.equal(head.status, 503);
      assert.equal(head.body, undefined);
    }
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.DSH_METRICS_URL; else process.env.DSH_METRICS_URL = previous.url;
  }
});
