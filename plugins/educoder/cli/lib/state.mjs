import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const CLI_STATE_FILENAME = '.educoder-cli-state.json';
const BASELINE_DIRNAME = '.baseline';

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：${target} 不在 ${root} 目录内。`);
  }
  return rel;
}

export function cliStatePath(config) {
  if (config.workdir) return join(config.workdir, CLI_STATE_FILENAME);
  const key = [
    config.target?.courseId || 'course',
    config.target?.homeworkId || 'hw',
    config.target?.taskId || 'task',
    config.session?.remoteUserId || 'anon',
  ].join(':');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(tmpdir(), `educoder-cli-state-${hash}.json`);
}

export async function readCliState(config) {
  const path = cliStatePath(config);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    return {};
  }
}

export async function writeCliState(config, nextState) {
  const path = cliStatePath(config);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.educoder-cli-state.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(nextState, null, 2) + '\n';
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
  } finally {
    await handle.close().catch(() => {});
  }
  await rename(temp, path);
  return path;
}

/** Enumerate tracked relative paths inside a CLI directory, excluding .baseline and node_modules. */
export async function listCliRelativeFiles(rootDir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === BASELINE_DIRNAME || entry.name === '.manifest.json' ||
          entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(relative(rootDir, full).split(sep).join('/'));
      }
    }
  }
  await walk(rootDir);
  return files.sort((a, b) => a.localeCompare(b));
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function cliStatus(cliRoot) {
  const baselineRoot = join(cliRoot, BASELINE_DIRNAME);
  const baselineFiles = await listCliRelativeFiles(baselineRoot);
  const liveFiles = await listCliRelativeFiles(cliRoot);
  const all = [...new Set([...baselineFiles, ...liveFiles])].sort((a, b) => a.localeCompare(b));
  const modified = [];
  const added = [];
  const missing = [];
  const unchanged = [];

  for (const rel of all) {
    const inBase = baselineFiles.includes(rel);
    const inLive = liveFiles.includes(rel);
    if (!inBase && inLive) {
      added.push(rel);
      continue;
    }
    if (inBase && !inLive) {
      missing.push(rel);
      continue;
    }
    const [baseHash, liveHash] = await Promise.all([
      sha256File(join(baselineRoot, rel)),
      sha256File(join(cliRoot, rel)),
    ]);
    if (baseHash !== liveHash) modified.push(rel);
    else unchanged.push(rel);
  }

  return { cliRoot, baselineRoot, baselinePresent: baselineFiles.length > 0, modified, added, missing, unchanged };
}

function formatLineDiff(rel, baseText, liveText) {
  if (baseText === liveText) return '';
  const baseLines = baseText.split('\n');
  const liveLines = liveText.split('\n');
  const lines = [`--- .baseline/${rel}`, `+++ ${rel}`];
  const max = Math.max(baseLines.length, liveLines.length);
  for (let i = 0; i < max; i++) {
    const a = baseLines[i];
    const b = liveLines[i];
    if (a === b) continue;
    if (a !== undefined) lines.push(`-${i + 1}: ${a}`);
    if (b !== undefined) lines.push(`+${i + 1}: ${b}`);
  }
  return lines.join('\n');
}

export async function cliDiff(cliRoot, requestedFiles = []) {
  const status = await cliStatus(cliRoot);
  if (!status.baselinePresent) {
    throw new Error(`未找到基线备份目录：${status.baselineRoot}`);
  }
  const targets = requestedFiles.length > 0
    ? requestedFiles.map(file => {
        const clean = file.split('\\').join('/');
        assertInside(cliRoot, resolve(cliRoot, clean));
        return clean;
      })
    : [...new Set([...status.modified, ...status.missing, ...status.added])].sort((a, b) => a.localeCompare(b));

  const chunks = [];
  for (const rel of targets) {
    const basePath = join(status.baselineRoot, rel);
    const livePath = join(cliRoot, rel);
    const baseText = status.added.includes(rel) ? '' : await readFile(basePath, 'utf8').catch(() => '');
    const liveText = status.missing.includes(rel) ? '' : await readFile(livePath, 'utf8').catch(() => '');
    const diff = formatLineDiff(rel, baseText, liveText);
    if (diff) chunks.push(diff);
  }
  return chunks.join('\n\n');
}

async function copyFileNoFollow(src, dest, mode = 0o644) {
  await mkdir(dirname(dest), { recursive: true });
  const existing = await lstat(dest).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) {
    await rm(dest, { force: true });
  }
  const content = await readFile(src);
  const handle = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close().catch(() => {});
  }
  await chmod(dest, mode);
}

export async function cliRestore(cliRoot, requestedFiles = []) {
  const baselineRoot = join(cliRoot, BASELINE_DIRNAME);
  const baselineFiles = await listCliRelativeFiles(baselineRoot);
  if (baselineFiles.length === 0) {
    throw new Error(`未找到基线备份目录或备份为空：${baselineRoot}`);
  }
  const targets = requestedFiles.length > 0
    ? requestedFiles.map(file => {
        const clean = file.split('\\').join('/');
        assertInside(cliRoot, resolve(cliRoot, clean));
        if (!baselineFiles.includes(clean)) {
          throw new Error(`基线备份中不存在文件：${clean}`);
        }
        return clean;
      })
    : baselineFiles;

  for (const rel of targets) {
    const executable = rel === 'bin/educoder' || rel === 'educoder.mjs';
    await copyFileNoFollow(join(baselineRoot, rel), join(cliRoot, rel), executable ? 0o755 : 0o644);
  }
  return { restored: targets };
}
