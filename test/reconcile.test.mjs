import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireProjectLease } from '../src/lease-project.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { profileIdentity, openRegistry } from '../src/registry.mjs';
import { processIdentity, scanProfileUsers } from '../src/procid.mjs';
import { reserve } from '../src/reserve.mjs';
import { addFake, makeHome, mkTmp } from './helpers.mjs';

const none = () => ({ verdict: 'none', pids: [] });
const gone = { verdict: 'none', pids: [] };
const deps = (over = {}) => ({ platform: 'linux', isolation: 'dbus', scan: none, groupAlive: () => gone, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A lease owned by a dead dispatcher; `extra` overrides fields. */
function plant(extra = {}) {
  const reg = openRegistry();
  const lease = {
    key: 'k1', kind: 'account', runId: 'dead-run', projectKey: 'p-1', profilePath: '/p/g1', workerPgid: 4242,
    ownerPid: 999999999, ownerStart: 1, ownerBoot: 'old-boot', ...extra
  };
  reg.acquireLease(lease);
  reg.close();
  return lease;
}
const rows = () => { const r = openRegistry(); try { return r.listLeases(); } finally { r.close(); } };
const events = () => { const r = openRegistry(); try { return r.listEvents(); } finally { r.close(); } };
const sweep = (d) => { const r = openRegistry(); try { return reconcile(r, { deps: d }); } finally { r.close(); } };

test('owner dead, no process on the profile, group gone: the lease is reaped and the reaping is recorded', () => {
  makeHome();
  plant();
  const out = sweep(deps());
  assert.deepEqual(out.reaped.map((l) => l.key), ['k1']);
  assert.deepEqual(rows(), []);
  assert.equal(events()[0].reason, 'owner-dead-worker-gone');
});

test('owner alive: kept, whatever the age of its heartbeat', () => {
  makeHome();
  const me = processIdentity(process.pid);
  plant({ ownerPid: process.pid, ownerStart: me.startTicks, ownerBoot: me.bootId });
  const reg = openRegistry();
  reg.heartbeat('k1', 'dead-run', 1); // ancient
  reg.close();
  assert.deepEqual(sweep(deps()).reaped, []);
  assert.equal(rows().length, 1);
});

test('a worker still using the profile, a live group, or an unreadable process entry each keep the lease', () => {
  makeHome();
  plant();
  for (const d of [
    deps({ scan: () => ({ verdict: 'found', pids: [4242] }) }),
    deps({ scan: () => ({ verdict: 'unknown', pids: [], unreadable: [77] }) }),
    deps({ groupAlive: () => ({ verdict: 'found', pids: [4242] }) }),
    deps({ groupAlive: () => ({ verdict: 'unknown', pids: [] }) }),
    deps({ scan: () => { throw new TypeError('bad profile'); } }),
    deps({ groupAlive: () => { throw new TypeError('bad pgid'); } })
  ]) {
    const out = sweep(d);
    assert.deepEqual(out.reaped, []);
    assert.equal(rows().length, 1);
    assert.ok(out.kept.get('k1'));
  }
  assert.equal(events().length, 0);
});

test('never reaped on other platforms or without private profile isolation', () => {
  makeHome();
  plant();
  assert.deepEqual(sweep(deps({ platform: 'darwin' })).reaped, []);
  assert.deepEqual(sweep(deps({ platform: 'win32' })).reaped, []);
  assert.deepEqual(sweep(deps({ isolation: 'none' })).reaped, []);
  assert.match(sweep(deps({ isolation: 'none' })).kept.get('k1').reason, /isolation/);
  assert.equal(rows().length, 1);
});

test('after a reboot (boot id changed) a lease is reaped only if no worker survives, verified not assumed', () => {
  makeHome();
  plant({ ownerBoot: 'before-reboot' });
  assert.deepEqual(sweep(deps({ scan: () => ({ verdict: 'found', pids: [9] }) })).reaped, []);
  assert.equal(rows().length, 1);
  assert.equal(sweep(deps()).reaped.length, 1);
});

test('a project lease is reaped only together with the account lease of the same run', () => {
  makeHome();
  plant();
  plant({ key: 'project:p-1', kind: 'project', profilePath: null, workerPgid: null });
  const kept = sweep(deps({ scan: () => ({ verdict: 'found', pids: [5] }) }));
  assert.deepEqual(kept.reaped, []);
  assert.equal(rows().length, 2, 'the project stays leased while its worker may live');
  const done = sweep(deps());
  assert.deepEqual(done.reaped.map((l) => l.kind).sort(), ['account', 'project']);
  assert.deepEqual(rows(), []);
});

test('reserve reaps a proven-stale lease and takes the account; an unproven one refuses with the reason', () => {
  makeHome();
  const g1 = addFake('g1', {});
  const id = profileIdentity(g1.profileDir);
  plant({ key: id.key, profilePath: id.path });
  const unproven = reserve({ root: mkTmp('p-'), runId: 'r1', deps: deps({ scan: () => ({ verdict: 'unknown', pids: [], unreadable: [1] }) }) });
  assert.deepEqual([unproven.ok, unproven.reason], [false, 'stale-lease']);
  assert.match(unproven.why, /unreadable|unproven|not proven/i);
  const proven = reserve({ root: mkTmp('p-'), runId: 'r2', deps: deps() });
  assert.equal(proven.ok, true);
  assert.equal(rows().filter((l) => l.runId === 'r2').length, 1);
  assert.equal(events().length, 1);
});

test('a live orphan keeps its lease through 100 reserve calls (real processes, real scan)', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  makeHome();
  const g1 = addFake('g1', {});
  const id = profileIdentity(g1.profileDir);
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: join(g1.profileDir, 'home') } });
  await sleep(200);
  const w = processIdentity(orphan.pid);
  plant({ key: id.key, profilePath: id.path, workerPgid: orphan.pid, workerStart: w.startTicks, ownerBoot: w.bootId });
  try {
    for (let i = 0; i < 100; i++) {
      const r = reserve({ root: mkTmp('p-'), runId: `r${i}`, deps: { isolation: 'dbus' } });
      assert.equal(r.ok, false);
    }
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].runId, 'dead-run');
    assert.equal(events().length, 0);
  } finally { process.kill(-orphan.pid, 'SIGKILL'); }
  await new Promise((r) => orphan.once('exit', r));
});

test('an unreadable /proc entry keeps the lease (fake procfs)', () => {
  makeHome();
  const proc = realpathSync(mkdtempSync(join(tmpdir(), 'zc-proc-')));
  mkdirSync(join(proc, '300', 'environ'), { recursive: true }); // reading a directory fails like EACCES
  writeFileSync(join(proc, '300', 'stat'), '300 (x) S 1 300 300 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0');
  writeFileSync(join(proc, '300', 'status'), `Uid:\t${process.getuid?.() ?? 0}\t0\t0\t0\n`);
  mkdirSync(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'old-boot\n');
  plant();
  const out = sweep(deps({ scan: (dir, o) => scanProfileUsers(dir, { ...o, procRoot: proc, platform: 'linux', selfPid: 0 }) }));
  assert.deepEqual(out.reaped, []);
  assert.equal(rows().length, 1);
});

test('acquireProjectLease clears a proven-stale project lease, and keeps it while the run\'s worker is unproven', () => {
  makeHome();
  const root = mkTmp('proj-');
  const key = `project:${projectKeyOf(root)}`;
  plant({ key: 'acct-1', runId: 'crashed' });
  plant({ key, kind: 'project', runId: 'crashed', projectKey: projectKeyOf(root), profilePath: null, workerPgid: null });
  assert.throws(() => acquireProjectLease({ root, runId: 'n1', deps: deps({ scan: () => ({ verdict: 'unknown', pids: [] }) }) }), /not taken over/);
  assert.equal(rows().length, 2, 'nothing was reaped: the worker of that run is unproven');
  const release = acquireProjectLease({ root, runId: 'n2', deps: deps() });
  assert.deepEqual(rows().map((l) => l.runId), ['n2']);
  release();
});

import { projectKey as projectKeyOf } from '../src/paths.mjs';

test('zc status shows heartbeat age as information and the recent reaping events', async () => {
  const { spawnSync } = await import('node:child_process');
  makeHome();
  plant({ key: 'k-live', runId: 'live-run' });
  plant({ key: 'k-gone', runId: 'gone-run' });
  const r = openRegistry();
  r.recordEvent({ key: 'k-old', runId: 'old-run', kind: 'account', reason: 'owner-dead-worker-gone', detail: {} });
  r.close();
  const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const out = spawnSync(process.execPath, [bin, 'status'], { env: process.env, encoding: 'utf8', cwd: mkTmp('cwd-') });
  assert.match(out.stdout, /lease k-live .*last seen \d+s ago/);
  assert.match(out.stdout, /reaped .*k-old .*owner-dead-worker-gone/);
});

test('a profile reached through a symlink is scanned under both paths, so a worker using the link keeps the lease', { skip: process.platform === 'win32' && 'symlinks need privileges' }, async () => {
  const { symlinkSync } = await import('node:fs');
  makeHome();
  const real = realpathSync(mkTmp('real-'));
  const link = join(mkTmp('lnk-'), 'acct');
  symlinkSync(real, link);
  plant({ profilePath: real });
  const scanned = [];
  const d = deps({
    profileDirs: () => [link],
    scan: (dir) => { scanned.push(dir); return dir === link ? { verdict: 'found', pids: [1] } : { verdict: 'none', pids: [] }; }
  });
  const out = sweep(d);
  assert.deepEqual(out.reaped, []);
  assert.ok(scanned.includes(real) && scanned.includes(link));
  assert.equal(rows().length, 1);
});
