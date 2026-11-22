import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from './atomicfile.mjs';
import { pidAlive } from './fsx.mjs';
import { stateRoot } from './paths.mjs';
import { scanProfileUsers } from './procid.mjs';
import { openRegistry } from './registry.mjs';

/**
 * Account store and the migration barrier.
 *
 * Legacy: accounts live in <root>/accounts.json (alpha.1-3 read and write it).
 * Active: accounts live in <root>/accounts.v1.json, and accounts.json is a
 * fail-closed stub (no accounts, a zcBarrier marker) so any older executable
 * sees "no accounts" instead of a second copy of the truth.
 *
 * States: legacy | active | interrupted (store exists but accounts.json is a
 * real file: a half-done activation or downgrade) | tampered (an old executable
 * wrote accounts into the stub) | corrupt. Everything except legacy and active
 * makes every accounts call fail; only `zc registry activate|downgrade` act.
 * Nothing in here ever deletes a backup, a store or a lock file.
 */

const STORE_NAME = 'accounts.v1.json';
const LEGACY_NAME = 'accounts.json';
const SCHEMA = 1;
const EMPTY = () => ({ currentId: null, accounts: {} });

const legacyFile = (root) => join(root, LEGACY_NAME);
const storeFile = (root) => join(root, STORE_NAME);
const backupsDir = (root) => join(root, 'backups');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Unique per run: a name collision must never overwrite an earlier backup.
const stamp = (date) => `${date.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
const BACKUP_NAME = /^accounts\.json\.[\w-]+\.bak$/;
const MANIFEST_NAME = /^MANIFEST\.[\w-]+\.json$/;
const safeName = (name, pattern) => typeof name === 'string' && pattern.test(name);
const POSIX = process.platform !== 'win32';

/** backups/ must be a real directory of ours; created 0700, tightened if it already exists. */
function ensureBackups(root) {
  const dir = backupsDir(root);
  let info = null;
  try { info = lstatSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error(`${dir} is not a plain directory; refusing`);
  if (!info) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX && info && info.uid === process.getuid() && (info.mode & 0o077)) chmodSync(dir, 0o700);
  return dir;
}

function readMaybe(path) {
  let bytes;
  try { bytes = readFileSync(path); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
  try { return { exists: true, bytes, json: JSON.parse(bytes.toString('utf8')) }; } catch (error) {
    return { exists: true, bytes, error: error.message };
  }
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validAccount = (a) => plain(a) && (a.profileDir === undefined || typeof a.profileDir === 'string');
const validStore = (s) => s.exists && !s.error && s.json?.schema === SCHEMA && plain(s.json.accounts)
  && Object.values(s.json.accounts).every(validAccount);

/** Which of the five states the root is in, plus a human-readable detail. */
export function barrierState(root = stateRoot()) {
  const legacy = readMaybe(legacyFile(root));
  const store = readMaybe(storeFile(root));
  if (legacy.error) return { state: 'corrupt', detail: `accounts.json is not valid JSON (${legacy.error})` };
  const marker = legacy.json?.zcBarrier;
  if (!marker) {
    return store.exists ? { state: 'interrupted', detail: `${STORE_NAME} exists but accounts.json is not the barrier stub`, legacy, store }
      : { state: 'legacy', detail: 'accounts.json holds the accounts', legacy, store };
  }
  const snapshot = { marker, legacy, store };
  if (!validStore(store)) return { state: 'corrupt', detail: `${STORE_NAME} is missing or invalid behind the stub; not repairing automatically`, ...snapshot };
  if (Object.keys(legacy.json.accounts ?? {}).length) {
    return { state: 'tampered', detail: 'accounts were written into the barrier stub (an older zc ran); content is kept', ...snapshot };
  }
  return { state: 'active', detail: `${STORE_NAME} holds the accounts`, ...snapshot };
}

/** Current accounts as {kind, data}. Throws unless the state is legacy or active. */
export function readAccountsState(root = stateRoot()) {
  let seen = barrierState(root);
  // An unlocked read can straddle an activation or downgrade; look once more before failing closed.
  if (seen.state !== 'legacy' && seen.state !== 'active') seen = barrierState(root);
  const { state, detail, legacy, store } = seen;
  if (state === 'legacy') return { kind: 'legacy', data: legacy.json ?? EMPTY() };
  if (state === 'active') return { kind: 'store', data: store.json };
  throw new Error(`accounts store is in an inconsistent state (${state}): ${detail}. Run \`zc registry status\`.`);
}

export function writeAccountsState(kind, data, root = stateRoot()) {
  writeJsonAtomic(kind === 'store' ? storeFile(root) : legacyFile(root), data, { mode: 0o600 });
}

/** Serialize every accounts mutation machine-wide (one short registry transaction). */
export function withAccountsLock(fn) {
  const registry = openRegistry();
  try { return registry.withTx(fn); } finally { registry.close(); }
}

function liveDispatchers(root, alive) {
  const found = [];
  const projects = join(root, 'projects');
  if (!existsSync(projects)) return found;
  for (const name of readdirSync(projects)) {
    let lock;
    try { lock = readMaybe(join(projects, name, 'dispatch.lock')); } catch (error) {
      if (error.code === 'ENOTDIR' || error.code === 'ENOENT') continue; // a stray file, not a project
      throw error;
    }
    if (lock.exists && (lock.error || !plain(lock.json))) {
      found.push(`${name} (unreadable dispatch.lock; cannot prove no dispatcher)`);
      continue;
    }
    const pid = lock.json?.pid;
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) found.push(`${name} (pid ${pid})`);
  }
  return found;
}

function preflight(root, data, { scan, alive }, report) {
  for (const entry of liveDispatchers(root, alive)) report.refused.push(`live legacy dispatcher: ${entry}`);
  for (const account of Object.values(data.accounts ?? {})) {
    if (typeof account.profileDir !== 'string') { report.refused.push(`account ${account.id} has no profileDir`); continue; }
    const result = scan(account.profileDir, {});
    if (result.verdict === 'found') report.refused.push(`profile ${account.id} is in use (pids ${result.pids.join(', ')})`);
    else if (result.verdict === 'unknown') report.warnings.push(`profile ${account.id}: some processes are unreadable, so use cannot be ruled out`);
  }
}

function newReport(state) {
  return { state, steps: [], refused: [], warnings: [], applied: false };
}

const toStoreData = (legacy, migratedFrom) => ({
  schema: SCHEMA,
  migratedFrom,
  currentId: legacy.currentId ?? null,
  accounts: Object.fromEntries(Object.entries(legacy.accounts ?? {}).map(([id, a]) => [id, { ...a, identity: a.identity ?? null }]))
});

const stubFor = (ref, at) => ({
  currentId: null,
  accounts: {},
  zcBarrier: { version: 1, store: STORE_NAME, backup: ref.backup, manifest: ref.manifest, activatedAt: at, note: 'accounts moved to the versioned store; use `zc registry status`' }
});

function writeBackup(root, bytes, mode, ts) {
  ensureBackups(root);
  const backup = `accounts.json.${ts}.bak`;
  const manifest = `MANIFEST.${ts}.json`;
  writeFileAtomic(join(backupsDir(root), backup), bytes, { mode: 0o600 });
  const record = { file: LEGACY_NAME, backup, sha256: sha256(bytes), bytes: bytes.length, mode: mode.toString(8), createdAt: ts };
  writeJsonAtomic(join(backupsDir(root), manifest), record, { mode: 0o600 });
  if (sha256(readFileSync(join(backupsDir(root), backup))) !== record.sha256) throw new Error('backup verification failed');
  return { backup, manifest, record };
}

function archive(root, name, label, ts) {
  const target = join(ensureBackups(root), `${name}.${label}-${ts}`);
  if (existsSync(target)) throw new Error(`${target} already exists; refusing to overwrite`);
  renameSync(join(root, name), target);
}

function currentLegacyBytes(root) {
  return existsSync(legacyFile(root)) ? readFileSync(legacyFile(root)) : Buffer.from(`${JSON.stringify(EMPTY(), null, 2)}\n`);
}

function applyActivation(root, state, ctx) {
  const { ts, fault } = ctx;
  const at = new Date(ctx.now()).toISOString();
  let ref;
  if (state === 'tampered') {
    const marker = JSON.parse(readFileSync(legacyFile(root), 'utf8')).zcBarrier;
    if (!safeName(marker?.backup, BACKUP_NAME) || !safeName(marker?.manifest, MANIFEST_NAME)) {
      throw new Error('the stub names an invalid backup or manifest; not repairing automatically');
    }
    ensureBackups(root);
    writeFileAtomic(join(backupsDir(root), `tampered-stub-${ts}.json`), readFileSync(legacyFile(root)), { mode: 0o600 });
    ref = { backup: marker.backup, manifest: marker.manifest };
    fault('after-backup');
  } else {
    // A root that never had accounts.json is backed up as the empty file ZC would have created.
    const legacyBytes = currentLegacyBytes(root);
    const mode = statModeOf(legacyFile(root)) ?? 0o600;
    const made = writeBackup(root, legacyBytes, mode, ts);
    ref = made;
    fault('after-backup');
    if (existsSync(storeFile(root))) archive(root, STORE_NAME, 'superseded', ts);
    writeJsonAtomic(storeFile(root), toStoreData(JSON.parse(legacyBytes.toString('utf8')), { sha256: made.record.sha256, at, backup: made.backup, manifest: made.manifest }), { mode: 0o600 });
    writeJsonAtomic(join(backupsDir(root), made.manifest), { ...made.record, storeSha256: sha256(readFileSync(storeFile(root))) }, { mode: 0o600 });
    fault('after-store');
    // Compare-and-swap: an older zc may have written accounts.json since the backup was taken.
    if (sha256(currentLegacyBytes(root)) !== made.record.sha256) {
      throw new Error('accounts.json changed during activation; nothing was lost, run `zc registry activate --apply` again');
    }
  }
  writeJsonAtomic(legacyFile(root), stubFor(ref, at), { mode: 0o600 });
  fault('after-stub');
}

function statModeOf(path) {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

const defaults = (opts) => ({
  root: opts.root ?? stateRoot(),
  apply: opts.apply === true,
  scan: opts.scan ?? scanProfileUsers,
  alive: opts.alive ?? pidAlive,
  now: opts.now ?? (() => Date.now()),
  fault: opts.fault ?? (() => {})
});

/** Dry run by default. With apply: backup, store, stub in a crash-safe order; re-running after an interruption is safe. */
export function activate(opts = {}) {
  const ctx = defaults(opts);
  const { root } = ctx;
  const { state, detail } = barrierState(root);
  const report = newReport(state);
  if (state === 'active') { report.steps.push('already active; nothing to do'); return report; }
  if (state === 'corrupt') { report.refused.push(detail); return report; }
  const source = state === 'tampered' ? readMaybe(storeFile(root)).json : (readMaybe(legacyFile(root)).json ?? EMPTY());
  if (state === 'tampered') {
    const lost = Object.keys(readMaybe(legacyFile(root)).json.accounts);
    report.warnings.push(`accounts written by an older zc (${lost.join(', ')}) are NOT migrated; they stay in backups/tampered-stub-*.json`);
  }
  report.steps.push(
    state === 'tampered' ? 'keep the tampered stub content under backups/, rewrite the stub (store untouched)'
      : 'verified backup of accounts.json (sha256 manifest, 0600) under backups/',
    ...(state === 'tampered' ? [] : ['write the versioned store accounts.v1.json (every account identity:null) and verify it', 'replace accounts.json with the fail-closed stub'])
  );
  preflight(root, source, ctx, report);
  if (report.refused.length) return report;
  if (!ctx.apply) { report.steps.push('dry run: nothing was changed; pass --apply to do it'); return report; }
  const ts = stamp(new Date(ctx.now()));
  // Note: older executables take no lock, so a write by one of them between the preflight,
  // the compare-and-swap and the stub write can still be lost; do not run old copies during activation.
  withAccountsLock(() => {
    const again = barrierState(root).state;
    if (again !== state) throw new Error(`state changed from ${state} to ${again} while waiting; run again`);
    applyActivation(root, state, { ...ctx, ts });
  });
  report.applied = true;
  return report;
}

const exportLegacy = (store) => ({
  currentId: store.currentId ?? null,
  accounts: Object.fromEntries(Object.entries(store.accounts).map(([id, { identity, ...rest }]) => [id, rest]))
});

function exactRestore(root, marker, storeBytes) {
  try {
    if (!safeName(marker?.manifest, MANIFEST_NAME)) return null;
    const manifest = JSON.parse(readFileSync(join(backupsDir(root), marker.manifest), 'utf8'));
    if (!safeName(manifest.backup, BACKUP_NAME) || !/^[0-7]{3}$/.test(String(manifest.mode))) return null;
    const backup = readFileSync(join(backupsDir(root), manifest.backup));
    if (sha256(backup) !== manifest.sha256 || sha256(storeBytes) !== manifest.storeSha256) return null;
    return { bytes: backup, mode: Number.parseInt(manifest.mode, 8) & 0o600 }; // never wider than 0600
  } catch { return null; }
}

/** Reverse of activate. The store is archived, never deleted. Exact original bytes when nothing changed since activation. */
export function downgrade(opts = {}) {
  const ctx = defaults(opts);
  const { root } = ctx;
  const { state, detail, marker } = barrierState(root);
  const report = { ...newReport(state), exact: false };
  if (state === 'legacy') { report.steps.push('already legacy; nothing to do'); return report; }
  if (state === 'corrupt' || state === 'tampered') {
    report.refused.push(state === 'tampered' ? 'stub was tampered with; run `zc registry activate --apply` to repair it first' : detail);
    return report;
  }
  const storeBytes = state === 'active' ? readFileSync(storeFile(root)) : null;
  const restore = state === 'active' ? exactRestore(root, marker, storeBytes) : null;
  if (state === 'active') report.steps.push(restore ? 'restore the exact original accounts.json bytes from the verified backup' : 'export the store to the legacy accounts.json format (identity field dropped, everything else kept)');
  report.steps.push('archive accounts.v1.json under backups/ (never deleted)');
  const data = state === 'active' ? JSON.parse(storeBytes.toString('utf8')) : (readMaybe(legacyFile(root)).json ?? EMPTY());
  preflight(root, data, ctx, report);
  if (report.refused.length) return report;
  if (!ctx.apply) { report.steps.push('dry run: nothing was changed; pass --apply to do it'); return report; }
  const ts = stamp(new Date(ctx.now()));
  withAccountsLock(() => {
    if (state === 'active') {
      if (restore) writeFileAtomic(legacyFile(root), restore.bytes, { mode: restore.mode });
      else writeJsonAtomic(legacyFile(root), exportLegacy(data), { mode: 0o600 });
      ctx.fault('after-legacy');
    }
    archive(root, STORE_NAME, 'downgraded', ts);
    ctx.fault('after-archive');
  });
  report.applied = true;
  report.exact = Boolean(restore);
  return report;
}
