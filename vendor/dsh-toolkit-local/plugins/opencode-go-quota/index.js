import { isIPv4 } from 'node:net';

export const name = 'opencode-go-quota';
export const inject = ['webServer', 'connection'];

const keyRef = 'OPENCODE_GO_API_KEY';
const relayRef = 'DSH_OPENCODE_GO_USAGE_URL';
const usageUrl = 'https://opencode.ai/inference/go/v1/usage';

function relayUrl(value) {
  const url = new URL(value);
  const [first, second] = url.hostname.split('.').map(Number);
  const privateHost = url.hostname === '[::1]' || (isIPv4(url.hostname) &&
    (first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)));
  if (!privateHost || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) throw new Error('额度代理地址无效');
  return url.href;
}

function sendUnavailable(req, res, body) {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

export function apply(ctx) {
  function admitted(req, res) {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return true;
    res.writeHead(rejection, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: '需要通过 DSH 登录访问' }));
    return false;
  }
  let quotaCache;
  let quotaPending;
  let nextQuotaAttempt = 0;
  async function readQuota() {
    if (quotaCache && Date.now() - quotaCache.timestamp < 60000) return quotaCache;
    if (quotaPending) return quotaPending;
    if (Date.now() < nextQuotaAttempt) throw new Error('额度暂不可用');
    quotaPending = (async () => {
      try {
        const headers = { Accept: 'application/json', 'User-Agent': 'DSH-Toolkit-Go-Quota/1.0' };
        const relay = process.env[relayRef]?.trim();
        let endpoint = usageUrl;
        if (relay) {
          endpoint = relayUrl(relay);
        } else {
          const credentials = ctx.get?.('credentials');
          const key = (credentials ? (await credentials.resolve(keyRef))?.value : process.env[keyRef])?.trim();
          if (!key) return null;
          headers.Authorization = `Bearer ${key}`;
        }
        const response = await fetch(endpoint, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('额度请求失败');
        const monthly = (await response.json()).usage?.monthly;
        if (!monthly || !Number.isFinite(monthly.percent) || monthly.percent < 0 || monthly.percent > 100 ||
          !['ok', 'rate-limited'].includes(monthly.status) || !Number.isFinite(Date.parse(monthly.resetsAt))) {
          throw new Error('额度数据格式无效');
        }
        quotaCache = {
          scope: 'opencode-go-monthly', timestamp: Date.now(),
          monthly: { percent: monthly.percent, status: monthly.status, resetsAt: monthly.resetsAt },
        };
        return quotaCache;
      } catch {
        nextQuotaAttempt = Date.now() + 10000;
        throw new Error('OpenCode Go 月额度暂不可用');
      }
    })().finally(() => { quotaPending = undefined; });
    return quotaPending;
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/opencode-go-quota',
    async handler(req, res) {
      if (!admitted(req, res)) return;
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      try {
        const sample = await readQuota();
        if (sample === null) {
          sendUnavailable(req, res, { error: '未配置 OpenCode Go API Key', code: 'missing-credential' });
          return;
        }
        const body = JSON.stringify(sample);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        sendUnavailable(req, res, { error: 'OpenCode Go 月额度暂不可用' });
      }
    },
  }), 'opencode-go-quota: HTTP');
}
