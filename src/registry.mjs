import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { networkFsType, registryDir } from './registry-path.mjs';

/**
 * Machine-wide lease registry (SQLite, one file per user). A lease key is the
 * canonical profile directory identity (dev:ino of the real path), never an
 * account id or a state root, so any path to the same directory meets in one row.
 * Transactions are short (BEGIN IMMEDIATE) and a killed holder releases its
 * database lock automatically; leases themselves are only ever freed by an
 * explicit, proven decision (see evaluateStale).
 */

const POSIX = process.platform !== 'win32';
const KINDS = new Set(['account', 'project']);
const BUSY_MS = 5000;
const BEGIN_RETRY_MS = 30000;

let sqliteModule;
function sqlite() {
  if (sqliteModule) return sqliteModule;
  // node:sqlite prints an ExperimentalWarning on Node 22; keep stderr contracts clean.
  // Relies on Node calling process.emitWarning at load time (true for Node >= 22.13).
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/sqlite/i.test(text)) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    sqliteModule = process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

function ensureDir(dir) {
  let info = null;
  try { info = lstatSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (POSIX) chmodSync(dir, 0o700);
    return;
  }
  if (info.isSymbolicLink()) throw new Error(`registry directory ${dir} is a symlink; refusing`);
  if (!info.isDirectory()) throw new Error(`registry path ${dir} is not a directory`);
  if (POSIX && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) {
    throw new Error(`registry directory ${dir} has unsafe permissions or owner (needs mode 0700, owned by you)`);
  }
}

function ensureFile(path) {
  let fd;
  try {
    // O_NOFOLLOW closes the gap between checking and opening: a symlink makes open fail.
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`registry file ${path} is a symlink; refusing`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (POSIX && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) {
      throw new Error(`registry file ${path} has unsafe permissions or owner (needs 0600, owned by you)`);
    }
  } finally { closeSync(fd); }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS leases (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    run_id TEXT NOT NULL,
    project_key TEXT,
    state_root TEXT,
    owner_pid INTEGER, owner_start INTEGER, owner_boot TEXT,
    worker_pid INTEGER, worker_pgid INTEGER, worker_start INTEGER,
    profile_path TEXT, profile_dev TEXT, profile_ino TEXT,
    zc_version TEXT,
    acquired_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    lease_key TEXT, run_id TEXT, kind TEXT, reason TEXT, detail TEXT
  );
  INSERT OR IGNORE INTO meta (name, value) VALUES ('schema_version', '1');`;

const toLease = (row) => row && ({
  key: row.key, kind: row.kind, runId: row.run_id, projectKey: row.project_key, stateRoot: row.state_root,
  ownerPid: row.owner_pid, ownerStart: row.owner_start, ownerBoot: row.owner_boot,
  workerPid: row.worker_pid, workerPgid: row.worker_pgid, workerStart: row.worker_start,
  profilePath: row.profile_path, profileDev: row.profile_dev, profileIno: row.profile_ino,
  zcVersion: row.zc_version, acquiredAt: row.acquired_at, heartbeatAt: row.heartbeat_at
});

function validate(lease) {
  if (!lease?.key || typeof lease.key !== 'string') throw new Error('lease key is required');
  if (!lease.runId || typeof lease.runId !== 'string') throw new Error('lease runId is required');
  if (!KINDS.has(lease.kind)) throw new Error(`lease kind must be one of ${[...KINDS].join(', ')}`);
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Many processes may open a fresh registry at once; retry while SQLite reports it busy or locked. */
function initialize(db) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  for (let attempt = 0; ; attempt++) {
    try {
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      const ready = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'leases'").get();
      if (!ready) db.exec(SCHEMA);
      return;
    } catch (error) {
      if (attempt >= 100 || !/locked|busy/i.test(String(error.message))) throw error;
      pause(50);
    }
  }
}

/** Open (and if needed create) the registry. Throws on unsafe location or permissions. */
export function openRegistry({ dir, fsType = networkFsType, now = () => Date.now() } = {}) {
  const base = registryDir({ dir });
  ensureDir(base);
  const network = fsType(base);
  if (network) {
    throw new Error(`registry directory ${base} is on a network filesystem (${network}); SQLite locking is unreliable there`);
  }
  const path = join(base, 'registry.db');
  ensureFile(path);
  const db = new (sqlite().DatabaseSync)(path);
  try {
    initialize(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let inTx = false;

  /** BEGIN IMMEDIATE, retried (jittered, bounded) when other processes hold the write lock. */
  function begin() {
    const deadline = Date.now() + BEGIN_RETRY_MS;
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); return; } catch (error) {
        if (!/locked|busy/i.test(String(error.message)) || Date.now() > deadline) throw error;
        pause(5 + Math.random() * 20);
      }
    }
  }

  function withTx(fn) {
    if (inTx) return fn();
    begin();
    inTx = true;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* connection already rolled back */ }
      throw error;
    } finally {
      inTx = false;
    }
  }

  const selectOne = db.prepare('SELECT * FROM leases WHERE key = ?');
  const listAll = db.prepare('SELECT * FROM leases ORDER BY acquired_at, key');
  const remove = db.prepare('DELETE FROM leases WHERE key = ? AND run_id = ?');
  const addEvent = db.prepare('INSERT INTO events (at, action, lease_key, run_id, kind, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const recent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');
  const setWorker = db.prepare('UPDATE leases SET worker_pid = ?, worker_pgid = ?, worker_start = ? WHERE key = ? AND run_id = ?');
  const beat = db.prepare('UPDATE leases SET heartbeat_at = ? WHERE key = ? AND run_id = ?');
  const insert = db.prepare(`INSERT INTO leases (key, kind, run_id, project_key, state_root, owner_pid, owner_start, owner_boot,
    worker_pid, worker_pgid, worker_start, profile_path, profile_dev, profile_ino, zc_version, acquired_at, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    path,
    db,
    withTx,
    close: () => db.close(),
    getLease: (key) => toLease(selectOne.get(key)),
    listLeases: () => listAll.all().map(toLease),
    acquireLease(lease) {
      validate(lease);
      return withTx(() => {
        const holder = selectOne.get(lease.key);
        if (holder) return { acquired: false, holder: toLease(holder) };
        const t = now();
        insert.run(lease.key, lease.kind, lease.runId, lease.projectKey ?? null, lease.stateRoot ?? null,
          lease.ownerPid ?? null, lease.ownerStart ?? null, lease.ownerBoot ?? null,
          lease.workerPid ?? null, lease.workerPgid ?? null, lease.workerStart ?? null,
          lease.profilePath ?? null, lease.profileDev ?? null, lease.profileIno ?? null,
          lease.zcVersion ?? null, t, t);
        return { acquired: true, lease: toLease(selectOne.get(lease.key)) };
      });
    },
    /** Only the run that holds the lease can release it. */
    releaseLease: (key, runId) => withTx(() =>
      Number(remove.run(key, runId).changes) > 0),
    /** Audit trail of automatic decisions (a lease reaped). */
    recordEvent: ({ key, runId, kind, reason, detail }) => withTx(() => {
      addEvent.run(now(), 'reaped', key, runId, kind, reason, JSON.stringify(detail ?? {}));
    }),
    listEvents: (limit = 20) => recent.all(limit).map((e) => ({ at: e.at, action: e.action, key: e.lease_key, runId: e.run_id, kind: e.kind, reason: e.reason, detail: JSON.parse(e.detail || '{}') })),
    /** Record the worker process once it exists (pid, process group, start time). */
    updateWorker: (key, runId, { pid, pgid, start }) => withTx(() =>
      Number(setWorker.run(pid ?? null, pgid ?? null, start ?? null, key, runId).changes) > 0),
    heartbeat: (key, runId, at = now()) => withTx(() =>
      Number(beat.run(at, key, runId).changes) > 0)
  };
}

/** Canonical identity of a profile directory: real path plus dev:ino. */
export function profileIdentity(dir) {
  let real;
  let info;
  try {
    real = realpathSync.native(dir);
    info = statSync(real, { bigint: true });
  } catch (error) {
    throw new Error(`profile directory ${dir} is not readable: ${error.code ?? error.message}`);
  }
  return { path: real, dev: String(info.dev), ino: String(info.ino), key: `${info.dev}:${info.ino}` };
}

/**
 * Pure verdict on one lease from already-gathered proof. Stale needs ALL of:
 * owner proven dead, no process using the profile, worker group gone. Anything
 * unproven is `unknown`; heartbeat age and a reboot never decide on their own.
 */
export function evaluateStale({ ownerAlive, workerScan, groupAlive } = {}) {
  if (ownerAlive === true) return { verdict: 'live', reason: 'owner-alive' };
  if (ownerAlive !== false) return { verdict: 'unknown', reason: 'owner-liveness-unproven' };
  if (workerScan === 'found' || groupAlive === 'found') return { verdict: 'orphan', reason: 'worker-alive' };
  if (workerScan === 'none' && groupAlive === 'none') return { verdict: 'stale', reason: 'owner-dead-worker-gone' };
  return { verdict: 'unknown', reason: 'worker-state-unproven' };
}
