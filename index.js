import { apply as metrics } from './plugins/server-metrics/index.js';
import { apply as quota } from './vendor/dsh-toolkit-local/plugins/opencode-go-quota/index.js';
import { apply as billing } from './vendor/dsh-toolkit-local/plugins/session-billing/index.js';

export const name = 'dsh-toolkit';
export const inject = ['webServer', 'sessionProjections', 'connection'];

export async function apply(ctx) {
  metrics(ctx);
  quota(ctx);
  await billing(ctx);
}
