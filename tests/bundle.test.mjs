import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('统一客户端只加载一个模块，注册两个侧栏区域和一个费用入口', () => {
  let definition;
  const styles = [], slots = [], cleanup = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value; } } },
    document: {
      createElement: () => ({ dataset: {}, remove() { this.removed = true; } }),
      head: { appendChild: element => styles.push(element) },
    },
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.equal(source.match(/__ModuleLoader__\.load\(/g)?.length, 1, '通用模块只在服务器入口内组合，不再单独加载');
  runInNewContext(source, sandbox);
  assert.equal(definition.id, '@forst/dsh-toolkit');
  const plugin = definition.factory(name => {
    if (name === 'react') return { createElement: (...args) => args };
    if (name === 'react-dom') return { createPortal() {} };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error('非预期依赖：' + name);
  });
  plugin.apply({
    effect: callback => cleanup.push(callback()),
    slots: { inject: (_name, callback) => callback(), register: (spec, component) => { slots.push(spec); assert.equal(typeof component, 'function'); } },
  });
  assert.deepEqual(slots.map(slot => slot.id), ['server-metrics', 'opencode-go-quota', 'session-cost']);
  assert.equal(new Set(slots.map(slot => slot.id)).size, 3);
  assert.deepEqual(slots.slice(0, 2).map(slot => slot.order), [49, 51]);
  assert.equal(slots[2].order, -1);
  assert.equal(styles.length, 1);
  cleanup.forEach(dispose => dispose?.());
  assert(styles[0].removed);
});

test('服务器入口只额外挂资源监控，额度和费用由固定通用包提供', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@forst/dsh-toolkit');
  assert.equal(manifest.version, '0.2.0');
  assert(manifest.files.includes('vendor'), '发行包必须内含固定版本的通用模块');
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, '安装不需要临时抓取本机仓库最新分支');
  const server = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert(server.includes("./vendor/dsh-toolkit-local/plugins/opencode-go-quota/index.js"));
  assert(server.includes("./vendor/dsh-toolkit-local/plugins/session-billing/index.js"));
  assert(!server.includes('web-search-tavily'));
  const metrics = readFileSync(new URL('../plugins/server-metrics/index.js', import.meta.url), 'utf8');
  assert(!metrics.includes('OPENCODE_GO_API_KEY'));
  assert(!metrics.includes('/opencode-go-quota'));
});
