import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from '../vendor/dsh-toolkit-local/plugins/session-billing/runtime.js';
import { createProjection } from '../vendor/dsh-toolkit-local/plugins/session-billing/projection.js';

const entrypoint = process.env.DSH_ENTRYPOINT;
const close = (a, b) => assert(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
test('复用安装的 Pi：分项、重试、去重、压缩和未知价格', { skip: !entrypoint && '请设置 DSH_ENTRYPOINT 指向已安装 DSH 的 lib/bin.js' }, async () => {
  const runtime = await loadRuntime(entrypoint);
  const projection = createProjection(runtime);
  const route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000, reasoningTokens: 100 };
  const message = (step, value = usage, source = route) => ({ type: 'assistant/message', data: { turn: 1, step, usage: value, message: { source: { kind: 'model', ...source } } } });
  let state = projection.apply(projection.init(), message(1));
  close(state.totals.inputUsd, .00015);
  close(state.totals.outputUsd, .00012);
  close(state.totals.cacheReadUsd, .00003);
  close(state.totals.cacheWriteUsd, 0);
  assert.equal(projection.apply(state, message(1)), state);
  state = projection.apply(state, message(1, { ...usage, outputTokens: 300 }));
  close(state.totals.usd, .00036);
  assert.equal(state.totals.pricedCalls, 1);
  state = projection.apply(state, { type: 'llm/retry-started', data: { turn: 1, step: 1 } });
  state = projection.apply(state, message(1));
  close(state.totals.usd, .00066);
  assert.equal(state.totals.pricedCalls, 2);
  state = projection.apply(state, { type: 'compaction/summary', data: { ...route, usage } });
  close(state.totals.usd, .00096);
  state = projection.apply(state, message(2, usage, { provider: 'unknown', model: 'unknown' }));
  assert.equal(state.totals.unpricedCalls, 1);
  projection.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  const model = runtime.getBuiltinModels('anthropic').find(item => item.cost.cacheWrite > 0);
  assert(model, '已安装 Pi 应包含有缓存写费用的模型');
  const withWrite = projection.apply(projection.init(), message(1, { ...usage, cacheWriteTokens: 5000 }, { provider: 'anthropic', model: model.id }));
  assert.equal(withWrite.totals.cacheWriteUsd > 0, true);
  close(withWrite.totals.usd, withWrite.totals.inputUsd + withWrite.totals.outputUsd + withWrite.totals.cacheReadUsd + withWrite.totals.cacheWriteUsd);

  const [major, minor, patch] = runtime.version.split('.').map(part => Number.parseInt(part, 10) || 0);
  assert.equal(projection.stateVersion, 4_000_000 + major * 10000 + minor * 100 + patch);

  const nativeRelay = projection.apply(projection.init(), message(1, usage, { provider: 'opencode-go-native', model: 'deepseek-v4.1-flash' }));
  close(nativeRelay.totals.usd, .0003);
  assert.equal(nativeRelay.totals.pricedCalls, 1);
  assert.equal(nativeRelay.totals.unpricedCalls, 0);

  const unknownGateway = projection.apply(projection.init(), message(1, usage, { provider: 'custom-gateway', model: 'deepseek-v4.1-flash' }));
  assert.equal(unknownGateway.totals.usd, 0);
  assert.equal(unknownGateway.totals.unpricedCalls, 1);

  const vertex = projection.apply(projection.init(), message(1, usage, { provider: 'google-vertex', model: 'gemini-4-hydrogen' }));
  close(vertex.totals.inputUsd, .0015);
  close(vertex.totals.outputUsd, .0015);
  close(vertex.totals.cacheReadUsd, .00075);
  close(vertex.totals.usd, .00375);
  assert.equal(vertex.totals.pricedCalls, 1);
});

test('统一后端注册两条原生 HTTP 路由及费用投影', { skip: !entrypoint && '请设置 DSH_ENTRYPOINT' }, async () => {
  const { apply } = await import('../index.js');
  const routes = [], projections = [];
  const previous = process.argv[1];
  process.argv[1] = entrypoint;
  const previousURL = process.env.DSH_METRICS_URL;
  process.env.DSH_METRICS_URL = 'http://127.0.0.1:9191/metrics';
  try {
    await apply({ effect: callback => callback(), connection: { requestRejection: () => undefined }, webServer: { register: route => { routes.push(route); return () => {}; } }, sessionProjections: { register: projection => projections.push(projection) } });
  } finally {
    process.argv[1] = previous;
    if (previousURL === undefined) delete process.env.DSH_METRICS_URL; else process.env.DSH_METRICS_URL = previousURL;
  }
  assert.deepEqual(routes.map(route => route.path).sort(), ['/opencode-go-quota', '/server-metrics']);
  assert.equal(projections.length, 1);
  assert.equal(projections[0].key, 'forstSessionCost');
});
