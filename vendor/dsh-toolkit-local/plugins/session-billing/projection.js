import vertexRates from './pi-vertex-pricing.json' with { type: 'json' };

const moneyFields = ['usd', 'inputUsd', 'outputUsd', 'cacheReadUsd', 'cacheWriteUsd'];
const emptyTotals = () => ({ usd: 0, inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, pricedCalls: 0, unpricedCalls: 0 });
const validCount = n => Number.isFinite(n) && n >= 0;

function usageOf(data) {
  if (data.usage !== undefined) return data.usage;
  for (let i = (data.stream?.length ?? 0) - 1; i >= 0; i--) {
    if (data.stream[i].type === 'chunk' && data.stream[i].chunk?.type === 'usage') return data.stream[i].chunk.usage;
  }
}

function replace(totals, previous, charge) {
  const old = previous ?? emptyTotals();
  return {
    ...Object.fromEntries(moneyFields.map(key => [key, Math.max(0, totals[key] - old[key] + charge[key])])),
    pricedCalls: totals.pricedCalls - old.pricedCalls + charge.pricedCalls,
    unpricedCalls: totals.unpricedCalls - old.unpricedCalls + charge.unpricedCalls,
  };
}

export function createProjection({ z, calculateCost, getBuiltinModels, version }) {
  const models = new Map();
  function price(usage, route) {
    const unknown = { ...emptyTotals(), unpricedCalls: 1 };
    if (!usage || !route || ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(validCount)) return unknown;
    const key = `${route.provider}\0${route.model}`;
    if (!models.has(key)) {
      let model;
      try { model = getBuiltinModels(route.provider).find(item => item.id === route.model); } catch {}
      const fallback = route.provider === 'google-vertex' && Object.hasOwn(vertexRates.models, route.model)
        ? vertexRates.models[route.model]
        : undefined;
      if (fallback && !['input', 'output', 'cacheRead', 'cacheWrite'].some(bucket => model?.cost?.[bucket] > 0)) {
        model = { ...model, cost: fallback };
      }
      models.set(key, model);
    }
    const model = models.get(key);
    if (!model) return unknown;
    const piUsage = {
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    // reasoning 已包含在 Pi 的 output 中；不再次相加。
    const cost = calculateCost(model, piUsage);
    const charge = { usd: cost.total, inputUsd: cost.input, outputUsd: cost.output, cacheReadUsd: cost.cacheRead, cacheWriteUsd: cost.cacheWrite, pricedCalls: 1, unpricedCalls: 0 };
    return moneyFields.every(key => validCount(charge[key])) ? charge : unknown;
  }
  const totalsSchema = z.object({ ...Object.fromEntries(moneyFields.map(key => [key, z.number().finite().nonnegative()])), pricedCalls: z.number().int().nonnegative(), unpricedCalls: z.number().int().nonnegative() }).strict();
  const routeSchema = z.object({ provider: z.string(), model: z.string() }).strict();
  const stateSchema = z.object({
    totals: totalsSchema,
    route: routeSchema.nullable(),
    last: z.object({ turn: z.number().int(), step: z.number().int(), charge: totalsSchema }).strict().nullable(),
  }).strict();
  const parts = version.split('.').map(Number);
  return {
    key: 'forstSessionCost',
    // 内置 Pi 或补充目录变化时，重放已缓存的会话费用。
    stateVersion: vertexRates.projectionVersion * 1_000_000 + parts[0] * 10000 + parts[1] * 100 + parts[2],
    stateSchema,
    init: () => ({ totals: emptyTotals(), route: null, last: null }),
    apply(state, event) {
      const data = event.data;
      if (event.type === 'request/context') return { ...state, route: { provider: data.provider, model: data.model } };
      if (event.type === 'llm/retry-started') return state.last?.turn === data.turn && state.last.step === data.step ? { ...state, last: null } : state;
      if (event.type === 'compaction/summary') {
        const charge = price(data.usage, data);
        return { ...state, totals: replace(state.totals, null, charge) };
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;
      const source = data.message?.source;
      const route = source?.kind === 'model' ? source : state.route;
      const charge = price(usageOf(data), route);
      const previous = state.last?.turn === data.turn && state.last.step === data.step ? state.last.charge : undefined;
      if (previous && Object.keys(charge).every(key => previous[key] === charge[key])) return state;
      return { ...state, totals: replace(state.totals, previous, charge), last: { turn: data.turn, step: data.step, charge } };
    },
    wire: { viewSchema: totalsSchema, view: state => state.totals },
  };
}
