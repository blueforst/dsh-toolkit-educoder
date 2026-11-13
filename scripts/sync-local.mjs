// Maintainer-only snapshot builder. Reads a clean local Git checkout; never downloads
// dependencies and never changes the source checkout or DSH's running configuration.
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'blueforst/dsh-toolkit-local';
const packageName = '@forst/dsh-toolkit-local';
const defaultRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const rootFiles = new Set(['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'LICENSE', 'NOTICE.md']);
const pluginFilePattern = /^plugins\/(?:opencode-go-quota|session-billing)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|json)$/;
const allowedDirectories = new Set(['plugins', 'plugins/opencode-go-quota', 'plugins/session-billing']);
const requiredFiles = [
  ...[...rootFiles].filter(path => path !== 'client.js'),
  'plugins/opencode-go-quota/index.js', 'plugins/opencode-go-quota/client.js', 'plugins/opencode-go-quota/package.json',
  'plugins/session-billing/index.js', 'plugins/session-billing/client.js', 'plugins/session-billing/package.json',
  'plugins/session-billing/projection.js', 'plugins/session-billing/runtime.js',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = path => typeof path === 'string' && (rootFiles.has(path) || pluginFilePattern.test(path));

function fail(message) { throw new Error(message); }
function stat(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Check every existing path component. lstat (not stat) means neither a symlinked
// vendor directory nor a symlinked parent can redirect a write outside the repo.
function assertNoSymlink(path) {
  const absolute = resolve(path);
  const base = parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = stat(current);
    if (info?.isSymbolicLink()) fail('Refusing symlink in source or snapshot path. Use its real checkout path.');
  }
}

function paths(root) {
  const project = resolve(root);
  assertNoSymlink(project);
  if (!stat(project)?.isDirectory() || project === parse(project).root) fail('Invalid project directory.');
  const vendorParent = join(project, 'vendor');
  const target = join(vendorParent, 'dsh-toolkit-local');
  const manifest = join(vendorParent, 'dsh-toolkit-local.source.json');
  for (const path of [vendorParent, target, manifest]) assertNoSymlink(path);
  for (const path of [vendorParent, target]) {
    if (stat(path) && !stat(path).isDirectory()) fail('Snapshot parent must be a real directory.');
  }
  if (stat(manifest) && !stat(manifest).isFile()) fail('Snapshot manifest must be a regular file.');
  return { project, vendorParent, target, manifest };
}

function regularBytes(path) {
  assertNoSymlink(path);
  if (!stat(path)?.isFile()) fail('Missing or non-regular snapshot file.');
  return readFileSync(path);
}

function parseJson(bytes, kind) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`Invalid ${kind} JSON.`); }
}

function assertKeys(value, expected, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail(`Invalid ${kind} fields.`);
}

function validatePackage(bytes, expectedVersion) {
  const pkg = parseJson(bytes, 'package');
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.name !== packageName ||
      typeof pkg.version !== 'string' || !versionPattern.test(pkg.version)) {
    fail('Source package name/version does not identify the local toolkit.');
  }
  if (expectedVersion !== undefined && pkg.version !== expectedVersion) fail('Manifest/package version mismatch.');
  return pkg.version;
}

function validateFileList(files) {
  if (!Array.isArray(files)) fail('Manifest files must be an array.');
  const seen = new Set();
  for (const entry of files) {
    assertKeys(entry, ['path', 'sha256'], 'file entry');
    if (!allowed(entry.path)) fail('File path is outside the runtime whitelist.');
    if (seen.has(entry.path)) fail('Duplicate manifest file path.');
    if (typeof entry.sha256 !== 'string' || !digestPattern.test(entry.sha256)) fail('Invalid SHA256 digest.');
    seen.add(entry.path);
  }
  for (const path of requiredFiles) if (!seen.has(path)) fail(`Required runtime file missing from manifest: ${path}`);
  const actual = files.map(entry => entry.path);
  if (actual.join('\n') !== [...actual].sort().join('\n')) fail('Manifest file list must be sorted.');
}

function readManifest(path) {
  const data = parseJson(regularBytes(path), 'manifest');
  assertKeys(data, ['repository', 'commit', 'version', 'files'], 'manifest');
  if (data.repository !== repository) fail('Unexpected source repository in manifest.');
  if (typeof data.commit !== 'string' || !commitPattern.test(data.commit)) fail('Manifest commit must be a full 40-character SHA.');
  if (typeof data.version !== 'string' || !versionPattern.test(data.version)) fail('Invalid manifest version.');
  validateFileList(data.files);
  return data;
}

function snapshotFiles(target) {
  if (!stat(target)) return [];
  assertNoSymlink(target);
  if (!stat(target).isDirectory()) fail('Snapshot target must be a real directory.');
  const result = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('Refusing symlink inside snapshot.');
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(path)) fail('Unexpected directory inside snapshot.');
        visit(join(directory, entry.name), path);
      } else {
        if (!entry.isFile() || !allowed(path)) fail('Unexpected file outside snapshot runtime whitelist.');
        result.push(path);
      }
    }
  }
  visit(target);
  return result.sort();
}

function git(source, args) {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', source, ...args], {
      encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { fail(`Git ${args[0]} failed. A readable non-bare source checkout is required.`); }
}

function isWithin(path, parent) {
  const tail = relative(parent, path);
  return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail));
}

function cleanHead(source) {
  if (git(source, ['status', '--porcelain=v1', '--untracked-files=all']).length !== 0) fail('Source checkout is dirty; commit or clean its changes first.');
  const head = git(source, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  if (!commitPattern.test(head)) fail('Source HEAD must be a full 40-character commit SHA.');
  return head;
}

function readSource(sourceArgument, projectPaths) {
  if (!sourceArgument || typeof sourceArgument !== 'string') fail('--source requires a local checkout path.');
  const candidate = resolve(sourceArgument);
  assertNoSymlink(candidate);
  if (!stat(candidate)?.isDirectory() || candidate === parse(candidate).root) fail('Invalid source checkout path.');
  const source = realpathSync(candidate);
  if (isWithin(projectPaths.project, source) || isWithin(source, projectPaths.target)) fail('Source cannot be the project, a project ancestor, or the snapshot itself.');
  const top = git(source, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (realpathSync(top) !== source) fail('--source must name the Git checkout root, not a subdirectory.');
  const origin = git(source, ['remote', 'get-url', 'origin']).toString('utf8').trim();
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)blueforst\/dsh-toolkit-local(?:\.git)?\/?$/.test(origin)) {
    fail('Source origin must point to blueforst/dsh-toolkit-local.');
  }
  const commit = cleanHead(source);
  const tree = git(source, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean);
  const bytes = new Map();
  for (const row of tree) {
    const tab = row.indexOf('\t');
    const path = row.slice(tab + 1);
    if (!allowed(path)) continue;
    const [mode, type] = row.slice(0, tab).split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) fail('Source runtime must contain regular Git blobs, never symlinks.');
    bytes.set(path, git(source, ['show', `${commit}:${path}`]));
  }
  for (const path of requiredFiles) if (!bytes.has(path)) fail(`Required source runtime file missing: ${path}`);
  const version = validatePackage(bytes.get('package.json'));
  if (cleanHead(source) !== commit) fail('Source HEAD changed while reading; retry from a stable checkout.');
  return { repository, commit, version, bytes };
}

function verifyFiles(projectPaths, manifest) {
  const actual = snapshotFiles(projectPaths.target);
  const recorded = manifest.files.map(entry => entry.path);
  if (actual.join('\n') !== recorded.join('\n')) fail('Snapshot has missing or extra files.');
  for (const entry of manifest.files) {
    if (sha256(regularBytes(join(projectPaths.target, entry.path))) !== entry.sha256) fail(`Snapshot SHA256 mismatch: ${entry.path}`);
  }
  validatePackage(regularBytes(join(projectPaths.target, 'package.json')), manifest.version);
}

export function checkSnapshot({ root = defaultRoot, source } = {}) {
  const projectPaths = paths(root);
  if (!stat(projectPaths.manifest)) fail('Missing snapshot manifest; initialize from a clean, pinned local checkout.');
  const manifest = readManifest(projectPaths.manifest);
  verifyFiles(projectPaths, manifest);
  if (source !== undefined) {
    const upstream = readSource(source, projectPaths);
    if (upstream.commit !== manifest.commit) fail('Source revision does not match the snapshot commit.');
    if (upstream.version !== manifest.version) fail('Source version does not match the snapshot.');
    if ([...upstream.bytes.keys()].sort().join('\n') !== manifest.files.map(entry => entry.path).join('\n')) fail('Source/snapshot runtime file lists differ.');
    for (const entry of manifest.files) {
      if (!upstream.bytes.get(entry.path).equals(regularBytes(join(projectPaths.target, entry.path)))) fail(`Source blob differs from snapshot: ${entry.path}`);
    }
  }
  return manifest;
}

function atomicWrite(path, bytes) {
  assertNoSymlink(path);
  mkdirSync(dirname(path), { recursive: true });
  assertNoSymlink(dirname(path));
  const temporary = `${path}.sync-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    if (stat(temporary)) unlinkSync(temporary);
  }
}

export function syncSnapshot({ root = defaultRoot, source, init = false } = {}) {
  const projectPaths = paths(root);
  const upstream = readSource(source, projectPaths);
  let previous;
  if (stat(projectPaths.manifest)) {
    if (init) fail('--init is only for a snapshot without a manifest.');
    previous = readManifest(projectPaths.manifest);
    verifyFiles(projectPaths, previous);
  } else {
    const existing = snapshotFiles(projectPaths.target);
    if (existing.length && !init) fail('Unrecorded snapshot files exist; use --init only after checking they match the source.');
    for (const path of existing) {
      if (!upstream.bytes.has(path) || !upstream.bytes.get(path).equals(regularBytes(join(projectPaths.target, path)))) {
        fail(`Refusing to overwrite unrecorded snapshot content: ${path}`);
      }
    }
  }
  const manifest = {
    repository: upstream.repository, commit: upstream.commit, version: upstream.version,
    files: [...upstream.bytes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
  };
  validateFileList(manifest.files);
  // All validation happens before any mutation. Each file is atomically replaced;
  // the manifest is written last, so an interrupted synchronization fails --check.
  for (const [path, bytes] of upstream.bytes) atomicWrite(join(projectPaths.target, path), bytes);
  for (const entry of previous?.files ?? []) {
    if (upstream.bytes.has(entry.path)) continue;
    // Only old manifest-listed, whitelisted files may be removed. Never recurse.
    const path = join(projectPaths.target, entry.path);
    assertNoSymlink(path);
    if (!stat(path)?.isFile()) fail('Obsolete snapshot entry is no longer a regular file.');
    unlinkSync(path);
  }
  atomicWrite(projectPaths.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  checkSnapshot({ root });
  return manifest;
}

function main(args) {
  let check = false, init = false, source;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && !check) check = true;
    else if (args[i] === '--init' && !init) init = true;
    else if (args[i] === '--source' && source === undefined && args[i + 1] && !args[i + 1].startsWith('--')) source = args[++i];
    else fail('Usage: node scripts/sync-local.mjs --source <clean-checkout> [--init] | --check [--source <matching-checkout>]');
  }
  if (check && init) fail('--check never writes and cannot be combined with --init.');
  const manifest = check ? checkSnapshot({ source }) : syncSnapshot({ source, init });
  console.log(`${check ? 'Verified' : 'Synchronized'} ${manifest.repository}@${manifest.commit}: ${manifest.files.length} files, version ${manifest.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`Snapshot check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
