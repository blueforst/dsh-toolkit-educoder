import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

const eduApiOrigin = 'https://data.educoder.net';

function createProxyRequest(proxyUrl) {
  const requireFromDsh = createRequire(realpathSync(process.argv[1]));
  const { fetch, ProxyAgent } = requireFromDsh('undici');
  const dispatcher = new ProxyAgent(proxyUrl);
  return {
    fetch: (url, options) => fetch(url, { ...options, dispatcher }),
    close: () => dispatcher.close(),
  };
}

export function createEduCoderProxy(proxyUrl, {
  fetch: request = globalThis.fetch,
  proxyFactory = createProxyRequest,
} = {}) {
  if (!proxyUrl) return { fetch: request, async close() {} };
  let proxy;
  try { proxy = new URL(proxyUrl); } catch { throw new TypeError('头歌 HTTPS 代理地址无效。'); }
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password ||
      proxy.pathname !== '/' || proxy.search || proxy.hash) throw new TypeError('头歌 HTTPS 代理地址无效。');
  const scoped = proxyFactory(proxy.href);
  return {
    fetch(url, options) {
      return new URL(url).origin === eduApiOrigin
        ? scoped.fetch(url, options)
        : request(url, options);
    },
    close: () => scoped.close(),
  };
}
