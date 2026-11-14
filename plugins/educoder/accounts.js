import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const accountId = /^[a-z0-9-]{36}$/u;
const remoteId = /^[1-9][0-9]{0,14}$/u;

export class AccountError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AccountError(code);
}

function projection(row) {
  return { id: row.id, label: row.label, status: row.status, updatedAt: row.updatedAt };
}

function statusFor(error) {
  if (error?.code === 'auth_required' || error?.code === 'invalid_credentials') return 'auth_required';
  if (error?.code === 'manual_required') return 'manual';
  return null;
}

function redactLabel(label) {
  const input = typeof label === 'string' ? label.trim() : '';
  return /^[\p{L}\p{N}.+_-]{1,2}\*{3}[\p{L}\p{N}.+_-]{1,2}$/u.test(input) ? input : '***';
}

export function createAccounts({ file, credentials, transport, queue }) {
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) fail('invalid_state');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 1000');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        remoteId TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','unverified','auth_required','manual','removed')),
        updatedAt TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    else if (version !== 1) fail('invalid_state');
  } catch (error) {
    db.close();
    throw error;
  }
  const byId = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const byRemote = db.prepare('SELECT * FROM accounts WHERE remoteId = ?');
  const set = db.prepare('UPDATE accounts SET status = ?, label = ?, updatedAt = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)');
  const list = db.prepare("SELECT * FROM accounts WHERE status <> 'removed' ORDER BY updatedAt DESC, id");
  // DSH 的凭据记录段必须以字母开头，UUID 本身可以以数字开头。
  const key = id => 'dsh-educoder/account-' + id;
  const authenticating = new Set();
  const exclusive = new Set();
  let closed = false;
  let currentSnapshot = [];
  let snapshotQueue = Promise.resolve();

  async function buildSnapshot() {
    if (closed) return currentSnapshot;
    const rows = list.all();
    const next = [];
    for (const row of rows) {
      if (closed) return currentSnapshot;
      const record = await credentials.readRecord(key(row.id));
      const grant = record?.kind === 'grant' && record.payload?.remoteUserId === row.remoteId ? record.payload : null;
      next.push({
        id: row.id,
        remoteUserId: row.remoteId,
        label: row.label,
        status: row.status,
        updatedAt: row.updatedAt,
        ...(grant ? { session: { ...grant } } : {}),
      });
    }
    if (!closed) currentSnapshot = next;
    return currentSnapshot;
  }

  function syncSnapshot() {
    const next = snapshotQueue.then(() => buildSnapshot());
    snapshotQueue = next.catch(() => currentSnapshot);
    return next;
  }

  const ready = syncSnapshot().catch(() => []);

  function find(id) {
    if (typeof id !== 'string' || !accountId.test(id)) fail('invalid_input');
    const row = byId.get(id);
    if (!row || row.status === 'removed') fail('not_found');
    return row;
  }

  function update(row, status, label = row.label) {
    const updatedAt = new Date().toISOString();
    set.run(status, label, updatedAt, row.id);
    void syncSnapshot();
    return projection({ ...row, status, label, updatedAt });
  }

  async function rotate(id, callback) {
    if (exclusive.has(id)) fail('busy');
    exclusive.add(id);
    let release;
    try {
      release = queue.blockAccount(id);
      return await callback();
    } finally {
      release?.();
      exclusive.delete(id);
    }
  }

  async function authenticate(login, password) {
    if (typeof login !== 'string' || !login.trim() || login.length > 254 ||
        typeof password !== 'string' || !password || password.length > 1024) fail('invalid_input');
    const attempt = login.trim();
    if (authenticating.has(attempt) || authenticating.size >= 4) fail('busy');
    authenticating.add(attempt);
    try {
      const result = await transport.login(attempt, password);
      if (!remoteId.test(result?.remoteUserId) || result.session?.remoteUserId !== result.remoteUserId) {
        fail('invalid_scope');
      }
      return result;
    } finally {
      authenticating.delete(attempt);
    }
  }

  async function save(row, authenticated) {
    await credentials.modifyRecord(key(row.id), async () => ({ kind: 'grant', payload: authenticated.session }));
    const projected = update(row, 'ready', redactLabel(authenticated.label));
    await syncSnapshot();
    return projected;
  }

  async function withSession(id, callback, { check = false, worker = false } = {}) {
    const row = find(id);
    if (!worker && exclusive.has(id)) fail('busy');
    if (!check && !['ready', 'unverified'].includes(row.status)) fail(row.status === 'manual' ? 'manual_required' : 'auth_required');
    const record = await credentials.readRecord(key(id));
    if (record?.kind !== 'grant' || record.payload?.remoteUserId !== row.remoteId) {
      const latest = byId.get(id);
      if (!exclusive.has(id) && latest && latest.status !== 'removed') {
        update(latest, 'auth_required');
        await syncSnapshot().catch(() => {});
      }
      fail('auth_required');
    }
    try {
      return await callback(record.payload, row);
    } catch (error) {
      const state = statusFor(error);
      // Unsupported assignments need a task-level pause, not an account-level login lock.
      const latest = byId.get(id);
      if (state && (state !== 'manual' || check) && !exclusive.has(id) && latest?.status !== 'removed' &&
          (await credentials.readRecord(key(id)))?.payload?.session === record.payload.session &&
          !exclusive.has(id) && byId.get(id)?.status !== 'removed') {
        update(byId.get(id), state);
        await syncSnapshot().catch(() => {});
      }
      throw error;
    }
  }

  return {
    list: () => list.all().map(projection),
    snapshot: () => currentSnapshot.map(entry => ({
      ...entry,
      ...(entry.session ? { session: { ...entry.session } } : {}),
    })),
    ready,
    waitSnapshot: () => snapshotQueue.then(() => currentSnapshot),
    withSession,
    async add(login, password) {
      const result = await authenticate(login, password);
      const existing = byRemote.get(result.remoteUserId);
      if (existing && existing.status !== 'removed') fail('already_exists');
      const row = existing ?? { id: randomUUID(), remoteId: result.remoteUserId, label: '***' };
      return rotate(row.id, async () => {
        if (!existing) insert.run(row.id, row.remoteId, row.label, 'auth_required', new Date().toISOString());
        return save(row, result);
      });
    },
    async relogin(id, login, password) {
      const row = find(id);
      return rotate(id, async () => {
        queue.pauseAccount(id);
        await queue.waitForAccountIdle(id);
        const result = await authenticate(login, password);
        if (result.remoteUserId !== row.remoteId) fail('invalid_scope');
        return save(row, result);
      });
    },
    async check(id) {
      const state = await withSession(id, async (session, row) => {
        const result = await transport.status(session);
        if (result.remoteUserId !== row.remoteId) fail('invalid_scope');
        if (exclusive.has(id) || byId.get(id)?.status === 'removed' ||
            (await credentials.readRecord(key(id)))?.payload?.session !== session.session ||
            exclusive.has(id) || byId.get(id)?.status === 'removed') fail('busy');
        return update(byId.get(id), result.verified === true ? 'ready' : 'unverified', redactLabel(result.label));
      }, { check: true });
      await syncSnapshot();
      return state;
    },
    async remove(id) {
      const row = find(id);
      return rotate(id, async () => {
        queue.cancelAccount(id);
        await queue.waitForAccountIdle(id);
        await credentials.deleteRecord(key(id));
        update(row, 'removed', '***');
        await syncSnapshot();
        return { id };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await snapshotQueue.catch(() => {});
      db.close();
    },
  };
}
