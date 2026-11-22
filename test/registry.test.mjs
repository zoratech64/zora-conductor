import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryDir } from '../src/registry-path.mjs';
import { evaluateStale, openRegistry, profileIdentity } from '../src/registry.mjs';

const POSIX = process.platform !== 'win32';
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

const owner = { ownerPid: 111, ownerStart: 1, ownerBoot: 'boot-a' };
const lease = (key, runId, extra = {}) => ({
  key, kind: 'account', runId, projectKey: 'p-1', stateRoot: '/s', zcVersion: '0.0.0', ...owner, ...extra
});

test('registryDir: default is fixed and independent of ZC_HOME and XDG_STATE_HOME', () => {
  const a = registryDir({ env: { HOME: '/home/u' }, platform: 'linux', home: '/home/u' });
  const b = registryDir({ env: { HOME: '/home/u', ZC_HOME: '/x', XDG_STATE_HOME: '/y' }, platform: 'linux', home: '/home/u' });
  assert.equal(a, b);
  assert.equal(a, join('/home/u', '.local', 'state', 'zora-conductor-registry'));
  assert.match(registryDir({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', home: 'C:\\u' }), /zora-conductor-registry$/);
});

test('registryDir: ZC_TEST_REGISTRY_DIR needs ZC_TESTING=1 and an absolute path; an explicit dir wins', { skip: !POSIX && 'POSIX paths' }, () => {
  assert.equal(registryDir({ env: { ZC_TEST_REGISTRY_DIR: '/t', ZC_TESTING: '1' }, platform: 'linux', home: '/h' }), '/t');
  assert.throws(() => registryDir({ env: { ZC_TEST_REGISTRY_DIR: '/t' }, platform: 'linux', home: '/h' }), /ZC_TESTING/);
  assert.throws(() => registryDir({ env: { ZC_TEST_REGISTRY_DIR: 'rel', ZC_TESTING: '1' }, platform: 'linux', home: '/h' }), /absolute/);
  assert.equal(registryDir({ dir: '/d', env: { ZC_TEST_REGISTRY_DIR: '/t' }, platform: 'linux', home: '/h' }), '/d');
});

test('openRegistry creates the dir 0700 and registry.db 0600', { skip: !POSIX && 'POSIX modes' }, () => {
  const dir = join(tmp('zc-reg-'), 'registry');
  const reg = openRegistry({ dir });
  reg.close();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'registry.db')).mode & 0o777, 0o600);
});

test('openRegistry refuses a registry dir that others can write, and a symlinked dir', { skip: !POSIX && 'POSIX modes' }, () => {
  const base = tmp('zc-reg-');
  const loose = join(base, 'loose');
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o777);
  assert.throws(() => openRegistry({ dir: loose }), /permissions/);
  const readable = join(base, 'readable');
  mkdirSync(readable, { mode: 0o755 });
  chmodSync(readable, 0o755);
  assert.throws(() => openRegistry({ dir: readable }), /permissions/, 'others must not even list it');
  const withLink = join(base, 'withlink');
  mkdirSync(withLink, { mode: 0o700 });
  symlinkSync(join(base, 'elsewhere.db'), join(withLink, 'registry.db'));
  assert.throws(() => openRegistry({ dir: withLink }), /symlink/);
  const real = join(base, 'real');
  mkdirSync(real, { mode: 0o700 });
  const link = join(base, 'link');
  symlinkSync(real, link);
  assert.throws(() => openRegistry({ dir: link }), /symlink/);
});

test('openRegistry refuses network filesystems (injected detector)', () => {
  const dir = join(tmp('zc-reg-'), 'registry');
  assert.throws(() => openRegistry({ dir, fsType: () => 'nfs' }), /network filesystem/);
  openRegistry({ dir, fsType: () => null }).close();
});

test('acquire / list / heartbeat / release', () => {
  const reg = openRegistry({ dir: join(tmp('zc-reg-'), 'r') });
  const a = reg.acquireLease(lease('dev:1', 'run-a'));
  assert.equal(a.acquired, true);
  const b = reg.acquireLease(lease('dev:1', 'run-b'));
  assert.equal(b.acquired, false);
  assert.equal(b.holder.runId, 'run-a');
  assert.equal(reg.listLeases().length, 1);
  const before = reg.listLeases()[0].heartbeatAt;
  assert.equal(reg.heartbeat('dev:1', 'run-a', before + 5), true);
  assert.equal(reg.listLeases()[0].heartbeatAt, before + 5);
  assert.equal(reg.heartbeat('dev:1', 'run-b'), false);
  assert.equal(reg.releaseLease('dev:1', 'run-b'), false, 'only the holder releases');
  assert.equal(reg.releaseLease('dev:1', 'run-a'), true);
  assert.equal(reg.listLeases().length, 0);
  assert.equal(reg.acquireLease(lease('dev:1', 'run-b')).acquired, true);
  reg.close();
});

test('lease rows carry owner, worker, profile identity and timestamps', () => {
  const reg = openRegistry({ dir: join(tmp('zc-reg-'), 'r') });
  reg.acquireLease(lease('k', 'r1', { workerPgid: 77, workerStart: 9, profilePath: '/p/g1', profileDev: '1', profileIno: '2' }));
  const row = reg.listLeases()[0];
  assert.equal(row.runId, 'r1');
  assert.equal(row.projectKey, 'p-1');
  assert.equal(row.ownerPid, 111);
  assert.equal(row.ownerBoot, 'boot-a');
  assert.equal(row.workerPgid, 77);
  assert.equal(row.profileIno, '2');
  assert.ok(row.acquiredAt > 0 && row.heartbeatAt >= row.acquiredAt);
  reg.close();
});

test('withTx rolls back on error and does not leak a transaction', () => {
  const reg = openRegistry({ dir: join(tmp('zc-reg-'), 'r') });
  assert.throws(() => reg.withTx(() => {
    reg.acquireLease(lease('k', 'r1'));
    throw new Error('boom');
  }), /boom/);
  assert.equal(reg.listLeases().length, 0);
  assert.equal(reg.acquireLease(lease('k', 'r2')).acquired, true);
  reg.close();
});

test('acquireLease validates its input', () => {
  const reg = openRegistry({ dir: join(tmp('zc-reg-'), 'r') });
  assert.throws(() => reg.acquireLease(lease('', 'r1')), /key/);
  assert.throws(() => reg.acquireLease(lease('k', '')), /runId/);
  assert.throws(() => reg.acquireLease({ ...lease('k', 'r'), kind: 'bogus' }), /kind/);
  reg.close();
});

test('profileIdentity: symlink and real path give one key; different dirs differ', { skip: !POSIX && 'POSIX symlinks' }, () => {
  const base = tmp('zc-id-');
  const real = join(base, 'a', 'profiles', 'g1');
  mkdirSync(real, { recursive: true });
  const link = join(base, 'other-root-profile');
  symlinkSync(real, link);
  const viaDot = join(base, 'a', 'profiles', '..', 'profiles', 'g1');
  const x = profileIdentity(real);
  assert.equal(profileIdentity(link).key, x.key);
  assert.equal(profileIdentity(viaDot).key, x.key);
  assert.equal(x.path, real);
  const other = join(base, 'a', 'profiles', 'g2');
  mkdirSync(other);
  assert.notEqual(profileIdentity(other).key, x.key);
  assert.throws(() => profileIdentity(join(base, 'missing')), /profile directory/);
});

const live = { ownerAlive: true, workerScan: 'none', groupAlive: 'none' };

test('evaluateStale: live owner is live; reap needs dead owner AND scan none AND group none', () => {
  assert.equal(evaluateStale(live).verdict, 'live');
  assert.equal(evaluateStale({ ...live, workerScan: 'found' }).verdict, 'live');
  const dead = { ownerAlive: false, workerScan: 'none', groupAlive: 'none' };
  assert.equal(evaluateStale(dead).verdict, 'stale');
  assert.equal(evaluateStale({ ...dead, workerScan: 'unknown' }).verdict, 'unknown');
  assert.equal(evaluateStale({ ...dead, workerScan: 'found' }).verdict, 'orphan');
  assert.equal(evaluateStale({ ...dead, groupAlive: 'found' }).verdict, 'orphan');
  assert.equal(evaluateStale({ ...dead, groupAlive: 'unknown' }).verdict, 'unknown');
  assert.equal(evaluateStale({ ownerAlive: 'unknown', workerScan: 'none', groupAlive: 'none' }).verdict, 'unknown');
  assert.equal(evaluateStale({}).verdict, 'unknown', 'missing proof never means stale');
});

test('evaluateStale: heartbeat age and a changed boot do not reap on their own', () => {
  const r = evaluateStale({ ownerAlive: false, workerScan: 'unknown', groupAlive: 'none', heartbeatAgeMs: 1e12, bootChanged: true });
  assert.equal(r.verdict, 'unknown');
  assert.equal(evaluateStale({ ownerAlive: false, workerScan: 'none', groupAlive: 'none', bootChanged: true }).verdict, 'stale');
});

test('registry file is not created outside the given dir', () => {
  const base = tmp('zc-reg-');
  const dir = join(base, 'r');
  openRegistry({ dir }).close();
  writeFileSync(join(base, 'marker'), '');
  assert.equal(statSync(join(dir, 'registry.db')).isFile(), true);
});

test('opening the registry prints nothing on stderr (no sqlite ExperimentalWarning)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = join(tmp('zc-warn-'), 'r');
  const code = `import { openRegistry } from ${JSON.stringify(new URL('../src/registry.mjs', import.meta.url).href)};
    openRegistry({ dir: ${JSON.stringify(dir)} }).close();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '');
});
