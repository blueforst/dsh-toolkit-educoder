import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function defaultDshAnchors() {
  return [
    import.meta.url,
    process.argv[1] ? realpathSafe(process.argv[1]) : undefined,
    process.env.DSH_ENTRYPOINT ? realpathSafe(process.env.DSH_ENTRYPOINT) : undefined,
    realpathSafe(join(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/package.json')),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  ].filter(Boolean);
}

/** Resolve the file path of an optional DSH host runtime dependency. */
export function resolveDshModule(specifier, overrideEnv) {
  const override = overrideEnv ? process.env[overrideEnv] : undefined;
  if (override && existsSync(override)) return override;
  for (const anchor of defaultDshAnchors()) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch {}
  }
  throw new Error(`无法定位运行时依赖 ${specifier}，请检查 DSH 安装路径或设置 ${overrideEnv || 'DSH_ENTRYPOINT'}。`);
}

/** Load a DSH host runtime dependency with fallback across host anchors. */
export function requireDshModule(specifier, overrideEnv) {
  return createRequire(import.meta.url)(resolveDshModule(specifier, overrideEnv));
}
