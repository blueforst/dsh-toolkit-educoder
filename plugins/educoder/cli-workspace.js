import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_CLI_ROOT = fileURLToPath(new URL('./cli/', import.meta.url));
const MANIFEST_NAME = '.manifest.json';

function ensureInside(root, target) {
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`工作区路径越界：${target}`);
  }
}

async function listSourceFiles(rootDir) {
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.baseline' || entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(relative(rootDir, full).split(sep).join('/'));
    }
  }
  await walk(rootDir);
  return files.sort((a, b) => a.localeCompare(b));
}

async function ensureRealDirectory(dirPath, rootReal) {
  await mkdir(dirPath, { recursive: true });
  const stats = await lstat(dirPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`工作区目录不能是符号链接：${dirPath}`);
  }
  const canonical = await realpath(dirPath);
  if (rootReal) ensureInside(rootReal, canonical);
  return canonical;
}

async function writeSafeFile(dest, content, mode = 0o644) {
  await mkdir(dirname(dest), { recursive: true });
  const existing = await lstat(dest).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error(`拒绝覆盖符号链接文件：${dest}`);
  const handle = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close().catch(() => {});
  }
  await chmod(dest, mode);
}

async function readManifestHashes(manifestPath) {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.files && typeof parsed.files === 'object' ? parsed.files : {};
  } catch {
    return {};
  }
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Seed or upgrade the shared editable CLI workspace under `<workspaceRoot>/cli`,
 * keeping `.baseline/` in sync while preserving model/operator edits to live files.
 */
export async function syncCliWorkspace(workspaceRoot, {
  sourceRoot = SOURCE_CLI_ROOT,
  reset = process.env.DSH_EDUCODER_CLI_RESET === '1',
} = {}) {
  const rootCanonical = await realpath(resolve(workspaceRoot));
  const cliRoot = await ensureRealDirectory(join(rootCanonical, 'cli'), rootCanonical);
  const baselineRoot = await ensureRealDirectory(join(cliRoot, '.baseline'), cliRoot);
  const tasksRoot = await ensureRealDirectory(join(rootCanonical, 'tasks'), rootCanonical);

  const manifestPath = join(baselineRoot, MANIFEST_NAME);
  const prevHashes = await readManifestHashes(manifestPath);
  const relFiles = await listSourceFiles(sourceRoot);
  const nextHashes = {};
  const preserved = [];
  const updated = [];

  for (const rel of relFiles) {
    const srcPath = join(sourceRoot, rel);
    const livePath = join(cliRoot, rel);
    const basePath = join(baselineRoot, rel);
    const data = await readFile(srcPath);
    const hash = sha256Buffer(data);
    nextHashes[rel] = hash;
    const mode = rel === 'bin/educoder' || rel === 'educoder.mjs' ? 0o755 : 0o644;

    await writeSafeFile(basePath, data, mode);

    const liveExisting = await lstat(livePath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (liveExisting?.isSymbolicLink()) {
      await rm(livePath, { force: true });
    }
    if (!liveExisting || liveExisting.isSymbolicLink() || reset) {
      await writeSafeFile(livePath, data, mode);
      updated.push(rel);
      continue;
    }
    const liveData = await readFile(livePath);
    const liveHash = sha256Buffer(liveData);
    const prevBaseHash = prevHashes[rel];
    if (liveHash === hash) continue;
    // Upgrade untouched live files automatically when the package changes; preserve DS fixes.
    if (prevBaseHash && liveHash === prevBaseHash) {
      await writeSafeFile(livePath, data, mode);
      updated.push(rel);
    } else {
      preserved.push(rel);
    }
  }

  await writeSafeFile(manifestPath, JSON.stringify({ files: nextHashes }, null, 2) + '\n', 0o644);
  return {
    cliRoot,
    baselineRoot,
    tasksRoot,
    entrypoint: join(cliRoot, 'educoder.mjs'),
    binPath: join(cliRoot, 'bin', 'educoder'),
    preserved,
    updated,
  };
}

/** Create or open a per-task scratch directory inside `<workspaceRoot>/tasks/`. */
export async function ensureTaskWorkdir(workspaceRoot, taskKey) {
  const rootCanonical = await realpath(resolve(workspaceRoot));
  const tasksRoot = await ensureRealDirectory(join(rootCanonical, 'tasks'), rootCanonical);
  const slug = String(taskKey || 'default')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96) || 'task';
  return ensureRealDirectory(join(tasksRoot, slug), tasksRoot);
}
