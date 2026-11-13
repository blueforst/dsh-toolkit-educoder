import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { checkSnapshot } from './sync-local.mjs';

const root = new URL('../', import.meta.url);
checkSnapshot();
const inputs = [
  { path: 'plugins/server-metrics/client.js', id: '@forst/dsh-server-metrics' },
  { path: 'vendor/dsh-toolkit-local/plugins/opencode-go-quota/client.js', id: '@forst/dsh-opencode-go-quota' },
  { path: 'vendor/dsh-toolkit-local/plugins/session-billing/client.js', id: '@forst/dsh-session-billing' },
];
const factories = inputs.map(({ path, id }) => {
  let captured;
  const source = readFileSync(new URL(path, root), 'utf8');
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { captured = value; } } } }, { timeout: 1000 });
  if (captured?.id !== id || typeof captured.factory !== 'function') throw new Error(`客户端模块格式不符：${path}`);
  return `(${captured.factory.toString()})(require)`;
});
const source = `// 由 scripts/build-client.mjs 生成；服务器模块与固定版本的本机通用模块在此组合。\nwindow.__ModuleLoader__.load({\n  id: '@forst/dsh-toolkit',\n  factory: require => {\n    const modules = [\n${factories.join(',\n')}\n    ];\n    return { inject: ['slots'], apply(ctx) { for (const module of modules) module.apply(ctx); } };\n  },\n});\n`;
writeFileSync(new URL('client.js', root), source);
console.log('已构建统一客户端模块。');
