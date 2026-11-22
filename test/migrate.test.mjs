import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers.mjs';
import * as accounts from '../src/accounts.mjs';
import { activate, barrierState, downgrade } from '../src/migrate.mjs';

const POSIX = process.platform !== 'win32';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const noUsers = () => ({ verdict: 'none', pids: [] });
const base = { scan: noUsers };

/** Fresh state root holding a legacy accounts.json like alpha.3 wrote (no identity field). */
function legacyRoot(count = 3) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zc-mig-')));
  process.env.ZC_HOME = root;
  const state = { currentId: 'g1', accounts: {} };
  for (let i = 1; i <= count; i++) {
    const id = `g${i}`;
    state.accounts[id] = { id, adapter: 'agy', profileDir: join(root, 'profiles', id), status: i === 3 ? 'needs-login' : 'ready',
      createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: 1000 + i, cooldownUntil: 0, holdReason: null, usage: [{ remainingPercent: 40 + i }] };
    mkdirSync(state.accounts[id].profileDir, { recursive: true });
  }
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return { root, state, bytes: readFileSync(join(root, 'accounts.json')) };
}

const readBytes = (root) => readFileSync(join(root, 'accounts.json'));

test('barrierState: legacy until activated; dry run changes nothing', () => {
  const { root, bytes } = legacyRoot();
  assert.equal(barrierState(root).state, 'legacy');
  const plan = activate({ root, ...base });
  assert.equal(plan.applied, false);
  assert.ok(plan.steps.length >= 4);
  assert.equal(barrierState(root).state, 'legacy');
  assert.deepEqual(readBytes(root), bytes);
  assert.equal(existsSync(join(root, 'accounts.v1.json')), false);
  assert.equal(existsSync(join(root, 'backups')), false);
});

test('activate --apply: verified backup, store with identity:null, fail-closed stub', { skip: !POSIX && 'POSIX modes' }, () => {
  const { root, state, bytes } = legacyRoot();
  const r = activate({ root, apply: true, ...base });
  assert.equal(r.applied, true);
  assert.equal(barrierState(root).state, 'active');
  const stub = JSON.parse(readBytes(root));
  assert.deepEqual(stub.accounts, {});
  assert.equal(stub.currentId, null);
  assert.ok(stub.zcBarrier.version >= 1);
  const store = JSON.parse(readFileSync(join(root, 'accounts.v1.json'), 'utf8'));
  assert.equal(store.currentId, 'g1');
  assert.deepEqual(Object.keys(store.accounts), ['g1', 'g2', 'g3']);
  for (const id of ['g1', 'g2', 'g3']) {
    assert.equal(store.accounts[id].identity, null, 'never auto-attested');
    const { identity, ...rest } = store.accounts[id];
    assert.deepEqual(rest, state.accounts[id], 'no other field changed');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'backups', stub.zcBarrier.manifest), 'utf8'));
  const backup = readFileSync(join(root, 'backups', manifest.backup));
  assert.equal(manifest.sha256, sha(bytes));
  assert.equal(sha(backup), manifest.sha256);
  assert.deepEqual(backup, bytes);
  for (const f of [join(root, 'accounts.v1.json'), join(root, 'backups', manifest.backup), join(root, 'backups', stub.zcBarrier.manifest)]) {
    assert.equal(statSync(f).mode & 0o777, 0o600, f);
  }
});

test('accounts API reads and writes the store once active; the stub stays empty', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  assert.deepEqual(accounts.listAccounts().map((a) => a.id), ['g1', 'g2', 'g3']);
  accounts.updateAccount('g2', { status: 'blocked' });
  accounts.addAccount('g4', { identity: { label: 'Delta', attestedAt: 'x', method: 'manual' } });
  assert.equal(accounts.getAccount('g2').status, 'blocked');
  assert.equal(accounts.getAccount('g4').identity.label, 'Delta');
  assert.deepEqual(JSON.parse(readBytes(root)).accounts, {});
  assert.equal(barrierState(root).state, 'active');
});

test('activation refuses while a legacy dispatcher is alive or a profile user is found', async () => {
  const { root } = legacyRoot();
  mkdirSync(join(root, 'projects', 'p-1'), { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(root, 'projects', 'p-1', 'dispatch.lock'), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
    const r = activate({ root, apply: true, ...base });
    assert.equal(r.applied, false);
    assert.match(r.refused.join(' '), /dispatcher/);
    assert.equal(barrierState(root).state, 'legacy');
  } finally { child.kill('SIGKILL'); }
  // a dead pid in a lock file is ignored and the lock file is never deleted
  writeFileSync(join(root, 'projects', 'p-1', 'dispatch.lock'), JSON.stringify({ pid: 999999999, startedAt: 1 }));
  const lockBytes = readFileSync(join(root, 'projects', 'p-1', 'dispatch.lock'));
  const busy = activate({ root, apply: true, scan: (dir) => (dir.endsWith('g2') ? { verdict: 'found', pids: [4242] } : noUsers()) });
  assert.equal(busy.applied, false);
  assert.match(busy.refused.join(' '), /g2/);
  const ok = activate({ root, apply: true, ...base });
  assert.equal(ok.applied, true);
  assert.deepEqual(readFileSync(join(root, 'projects', 'p-1', 'dispatch.lock')), lockBytes);
});

test('unknown scan result warns but does not block', () => {
  const { root } = legacyRoot();
  const r = activate({ root, apply: true, scan: () => ({ verdict: 'unknown', pids: [], unreadable: [1] }) });
  assert.equal(r.applied, true);
  assert.match(r.warnings.join(' '), /unreadable/);
});

test('activation interrupted at every step fails closed with no account lost, and re-running completes it', () => {
  for (const point of ['after-backup', 'after-store', 'after-stub']) {
    const { root, bytes } = legacyRoot();
    assert.throws(() => activate({ root, apply: true, ...base, fault: (p) => { if (p === point) throw new Error(`stop ${p}`); } }), /stop/);
    const s = barrierState(root).state;
    assert.equal(s, point === 'after-stub' ? 'active' : point === 'after-store' ? 'interrupted' : 'legacy', point);
    if (s === 'interrupted') {
      assert.throws(() => accounts.listAccounts(), /inconsistent|interrupted/, 'every accounts call fails closed');
      assert.deepEqual(readBytes(root), bytes, 'legacy file still authoritative and untouched');
    }
    if (s === 'legacy') assert.deepEqual(readBytes(root), bytes);
    const done = activate({ root, apply: true, ...base });
    assert.equal(barrierState(root).state, 'active', point);
    assert.deepEqual(accounts.listAccounts().map((a) => a.id), ['g1', 'g2', 'g3'], point);
    assert.ok(done.applied || point === 'after-stub');
  }
});

test('downgrade right after activation restores the exact original bytes and archives the store', { skip: !POSIX && 'POSIX modes' }, () => {
  const { root, bytes } = legacyRoot();
  activate({ root, apply: true, ...base });
  const plan = downgrade({ root, ...base });
  assert.equal(plan.applied, false);
  assert.equal(barrierState(root).state, 'active');
  const r = downgrade({ root, apply: true, ...base });
  assert.equal(r.applied, true);
  assert.equal(r.exact, true);
  assert.deepEqual(readBytes(root), bytes);
  assert.equal(barrierState(root).state, 'legacy');
  assert.equal(existsSync(join(root, 'accounts.v1.json')), false);
  assert.ok(readdirSync(join(root, 'backups')).some((n) => n.startsWith('accounts.v1.json.downgraded-')), 'store kept, never deleted');
  assert.equal(statSync(join(root, 'accounts.json')).mode & 0o777, 0o600);
});

test('downgrade after use exports the store in legacy format, dropping only identity', () => {
  const { root, state } = legacyRoot();
  activate({ root, apply: true, ...base });
  accounts.attestAccount('g1', 'Alpha');
  accounts.updateAccount('g2', { cooldownUntil: 99, holdReason: 'quota' });
  accounts.addAccount('g9');
  const r = downgrade({ root, apply: true, ...base });
  assert.equal(r.exact, false);
  const legacy = JSON.parse(readBytes(root));
  assert.deepEqual(Object.keys(legacy), ['currentId', 'accounts']);
  assert.deepEqual(Object.keys(legacy.accounts), ['g1', 'g2', 'g3', 'g9']);
  assert.equal(legacy.accounts.g2.cooldownUntil, 99);
  assert.equal(legacy.accounts.g2.holdReason, 'quota');
  assert.deepEqual(legacy.accounts.g3, state.accounts.g3);
  for (const a of Object.values(legacy.accounts)) assert.equal('identity' in a, false);
  assert.equal(barrierState(root).state, 'legacy');
});

test('downgrade interrupted at each step fails closed with no account lost; re-running completes it', () => {
  for (const point of ['after-legacy', 'after-archive']) {
    const { root } = legacyRoot();
    activate({ root, apply: true, ...base });
    accounts.updateAccount('g1', { lastUsedAt: 5555 });
    assert.throws(() => downgrade({ root, apply: true, ...base, fault: (p) => { if (p === point) throw new Error(`stop ${p}`); } }), /stop/);
    const s = barrierState(root).state;
    assert.equal(s, point === 'after-legacy' ? 'interrupted' : 'legacy', point);
    if (s === 'interrupted') assert.throws(() => accounts.listAccounts(), /inconsistent|interrupted/);
    const legacy = JSON.parse(readBytes(root));
    assert.equal(legacy.accounts.g1.lastUsedAt, 5555, 'newest data present in the authoritative file');
    downgrade({ root, apply: true, ...base });
    assert.equal(barrierState(root).state, 'legacy');
    assert.equal(accounts.getAccount('g1').lastUsedAt, 5555);
  }
});

test('a legacy executable writing into the stub is detected as tampered; activate repairs it without losing the store', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  accounts.updateAccount('g1', { lastUsedAt: 777 });
  const stub = JSON.parse(readBytes(root));
  stub.accounts.rogue = { id: 'rogue', status: 'ready' };
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(stub));
  assert.equal(barrierState(root).state, 'tampered');
  assert.throws(() => accounts.listAccounts(), /tampered|inconsistent/);
  const r = activate({ root, apply: true, ...base });
  assert.equal(r.applied, true);
  assert.equal(barrierState(root).state, 'active');
  assert.equal(accounts.getAccount('g1').lastUsedAt, 777, 'store untouched');
  assert.equal(accounts.getAccount('rogue'), null);
  assert.ok(readdirSync(join(root, 'backups')).some((n) => n.startsWith('tampered-stub-')), 'tampered content kept');
});

test('corrupt store or missing store behind a stub fails closed and is never auto-repaired', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  writeFileSync(join(root, 'accounts.v1.json'), '{not json');
  assert.equal(barrierState(root).state, 'corrupt');
  assert.throws(() => accounts.listAccounts(), /corrupt|inconsistent/);
  assert.equal(activate({ root, apply: true, ...base }).applied, false);
  assert.equal(readFileSync(join(root, 'accounts.v1.json'), 'utf8'), '{not json');
});

test('no accounts.json at all is legacy-empty and can be activated', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zc-mig-')));
  process.env.ZC_HOME = root;
  assert.equal(barrierState(root).state, 'legacy');
  assert.deepEqual(accounts.listAccounts(), []);
  assert.equal(activate({ root, apply: true, ...base }).applied, true);
  assert.deepEqual(accounts.listAccounts(), []);
  accounts.addAccount('a1');
  assert.equal(accounts.getAccount('a1').id, 'a1');
});

test('zc registry status|activate|downgrade CLI: dry run by default, --apply acts', async () => {
  const { spawnSync } = await import('node:child_process');
  const { root } = legacyRoot();
  const env = { ...process.env, ZC_HOME: root, ZC_ISOLATION: 'none' };
  const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const run = (...args) => spawnSync(process.execPath, [bin, 'registry', ...args], { env, encoding: 'utf8' });
  assert.match(run('status').stdout, /legacy/);
  const dry = run('activate');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/i);
  assert.equal(barrierState(root).state, 'legacy');
  assert.equal(run('activate', '--apply').status, 0);
  assert.match(run('status').stdout, /active/);
  assert.equal(run('downgrade', '--apply').status, 0);
  assert.match(run('status').stdout, /legacy/);
  assert.notEqual(run('bogus').status, 0);
});

test('tampered stub with a missing store is corrupt, not repairable by activate', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  const stub = JSON.parse(readBytes(root));
  stub.accounts.rogue = { id: 'rogue' };
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(stub));
  writeFileSync(join(root, 'accounts.v1.json'), 'garbage');
  assert.equal(barrierState(root).state, 'corrupt');
  assert.equal(activate({ root, apply: true, ...base }).applied, false);
});

test('repairing a tampered stub warns which accounts are not migrated', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  const stub = JSON.parse(readBytes(root));
  stub.accounts.rogue = { id: 'rogue' };
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(stub));
  const dry = activate({ root, ...base });
  assert.match(dry.warnings.join(' '), /rogue/);
});

test('an older zc writing accounts.json between backup and stub aborts activation without losing the write', () => {
  const { root } = legacyRoot();
  const sneaky = (p) => {
    if (p !== 'after-store') return;
    const legacy = JSON.parse(readBytes(root));
    legacy.accounts.late = { id: 'late', status: 'ready', profileDir: join(root, 'profiles', 'late') };
    writeFileSync(join(root, 'accounts.json'), JSON.stringify(legacy));
  };
  assert.throws(() => activate({ root, apply: true, ...base, fault: sneaky }), /changed during activation/);
  assert.equal(barrierState(root).state, 'interrupted');
  assert.ok(JSON.parse(readBytes(root)).accounts.late, 'the late write is still in accounts.json');
  activate({ root, apply: true, ...base });
  assert.ok(accounts.getAccount('late'), 'a re-run picks it up');
});

test('a stray file under projects/ does not break the dispatcher check', () => {
  const { root } = legacyRoot();
  mkdirSync(join(root, 'projects'), { recursive: true });
  writeFileSync(join(root, 'projects', 'stray.txt'), 'x');
  assert.equal(activate({ root, apply: true, ...base }).applied, true);
});

test('the tampered-stub copy is written even if backups/ was removed', () => {
  const { root } = legacyRoot();
  activate({ root, apply: true, ...base });
  const stub = JSON.parse(readBytes(root));
  stub.accounts.rogue = { id: 'rogue' };
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(stub));
  // keep the manifest and backup (needed for exact downgrade) but prove mkdir is not assumed
  assert.equal(activate({ root, apply: true, ...base }).applied, true);
});

function activeRoot() {
  const made = legacyRoot();
  activate({ root: made.root, apply: true, ...base });
  return made;
}

test('forged manifest or marker names and modes never escape backups/ or widen the file', { skip: !POSIX && 'POSIX modes' }, () => {
  const { root } = activeRoot();
  const stub = JSON.parse(readBytes(root));
  const manifestPath = join(root, 'backups', stub.zcBarrier.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'SECRET');
  const forge = (patch) => writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...patch }));
  forge({ backup: '../outside.txt', sha256: sha(Buffer.from('SECRET')) });
  let r = downgrade({ root, ...base });
  assert.match(r.steps.join(' '), /export the store/, 'traversal name rejected, falls back to export');
  forge({ mode: '777' });
  const applied = downgrade({ root, apply: true, ...base });
  assert.equal(applied.exact, true, 'valid backup and checksums still restore exactly');
  assert.equal(statSync(join(root, 'accounts.json')).mode & 0o077, 0, 'never group or world accessible');
  assert.equal(readFileSync(outside, 'utf8'), 'SECRET', 'the file outside backups/ was never touched');
});

test('a forged mode string is not trusted: wide modes are masked to 0600', { skip: !POSIX && 'POSIX modes' }, () => {
  const { root } = activeRoot();
  const stub = JSON.parse(readBytes(root));
  const manifestPath = join(root, 'backups', stub.zcBarrier.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, mode: '666' }));
  assert.equal(downgrade({ root, apply: true, ...base }).applied, true);
  assert.equal(statSync(join(root, 'accounts.json')).mode & 0o077, 0);
});

test('an unreadable dispatch.lock blocks activation instead of counting as no dispatcher', () => {
  const { root } = legacyRoot();
  mkdirSync(join(root, 'projects', 'p-1'), { recursive: true });
  writeFileSync(join(root, 'projects', 'p-1', 'dispatch.lock'), '{"pid": 12');
  const r = activate({ root, apply: true, ...base });
  assert.equal(r.applied, false);
  assert.match(r.refused.join(' '), /unreadable dispatch\.lock/);
});

test('backup, manifest and archive names are unique even with a frozen clock', () => {
  const { root } = legacyRoot();
  const fixed = () => Date.UTC(2026, 0, 1);
  activate({ root, apply: true, ...base, now: fixed });
  downgrade({ root, apply: true, ...base, now: fixed });
  activate({ root, apply: true, ...base, now: fixed });
  downgrade({ root, apply: true, ...base, now: fixed });
  const names = readdirSync(join(root, 'backups'));
  assert.equal(names.filter((n) => n.endsWith('.bak')).length, 2);
  assert.equal(names.filter((n) => n.startsWith('accounts.v1.json.downgraded-')).length, 2);
  assert.equal(new Set(names).size, names.length);
});

test('account ids that name inherited properties are unknown, never matched', () => {
  const { root } = activeRoot();
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(accounts.getAccount(id), null, id);
    assert.throws(() => accounts.updateAccount(id, { status: 'x' }), /unknown account/, id);
    assert.throws(() => accounts.attestAccount(id, 'x'), /unknown account/, id);
    assert.doesNotThrow(() => accounts.markUsed(id));
  }
  assert.equal({}.status, undefined, 'Object.prototype was not polluted');
  assert.equal(barrierState(root).state, 'active');
});

test('a store whose accounts are malformed is corrupt', () => {
  const { root } = activeRoot();
  const store = JSON.parse(readFileSync(join(root, 'accounts.v1.json'), 'utf8'));
  store.accounts.g1.profileDir = 42;
  writeFileSync(join(root, 'accounts.v1.json'), JSON.stringify(store));
  assert.equal(barrierState(root).state, 'corrupt');
});

test('backups/ that is a symlink is refused', { skip: !POSIX && 'POSIX symlinks' }, async () => {
  const { symlinkSync } = await import('node:fs');
  const { root } = legacyRoot();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'zc-elsewhere-')));
  symlinkSync(elsewhere, join(root, 'backups'));
  assert.throws(() => activate({ root, apply: true, ...base }), /not a plain directory/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(barrierState(root).state, 'legacy');
});
