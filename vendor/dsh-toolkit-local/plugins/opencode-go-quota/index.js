export const name = 'opencode-go-quota';
export const inject = ['webServer', 'connection'];

const keyRef = 'OPENCODE_GO_API_KEY';

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
        const credentials = ctx.get('credentials');
        const key = credentials ? (await credentials.resolve(keyRef))?.value : process.env[keyRef];
        if (!key?.trim()) return null;
        const response = await fetch('https://opencode.ai/inference/go/v1/usage', {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'opencode/2.1.2' },
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
