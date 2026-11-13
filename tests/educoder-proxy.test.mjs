import assert from 'node:assert/strict';
import test from 'node:test';
import { createEduCoderProxy } from '../plugins/educoder/proxy.js';

test('仅对头歌 API 与站内附件使用专属代理，外部附件和本地替身保持直连', async () => {
  const calls = [];
  let closed = false;
  const proxy = createEduCoderProxy('http://127.0.0.1:18088', {
    proxyFactory(url) {
      assert.equal(url, 'http://127.0.0.1:18088/');
      return {
        async fetch(url, options) { calls.push({ url: String(url), options, route: 'proxy' }); },
        async close() { closed = true; },
      };
    },
    async fetch(url, options) { calls.push({ url: String(url), options, route: 'direct' }); },
  });
  const options = { method: 'GET', redirect: 'manual' };
  await proxy.fetch(new URL('https://data.educoder.net/api/courses.json'), options);
  await proxy.fetch(new URL('https://data.educoder.net/api/attachments/image'), options);
  await proxy.fetch(new URL('https://prod-attachments.oss-accelerate.aliyuncs.com/image'), options);
  await proxy.fetch(new URL('http://127.0.0.1:9299/api/courses.json'), options);
  assert.deepEqual(calls.map(call => call.route), ['proxy', 'proxy', 'direct', 'direct']);
  assert.ok(calls.every(call => call.options === options));
  await proxy.close();
  assert.equal(closed, true);
});

test('没有专属代理时保留已有请求行为，并拒绝格式异常的代理地址', async () => {
  const request = () => {};
  const proxy = createEduCoderProxy(undefined, { fetch: request });
  assert.equal(proxy.fetch, request);
  await proxy.close();
  for (const value of ['not a URL', 'file:///tmp/proxy', 'http://user:pass@localhost:8080', 'http://localhost/path']) {
    assert.throws(() => createEduCoderProxy(value), { message: '头歌 HTTPS 代理地址无效。' });
  }
});
