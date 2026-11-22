import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as accounts from '../src/accounts.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { stateRoot } from '../src/paths.mjs';
import { profileIdentity, openRegistry } from '../src/registry.mjs';
import { processIdentity } from '../src/procid.mjs';
import { proveWorkerGone, reserve, withShortLease } from '../src/reserve.mjs';
import { parseTask } from '../src/task.mjs';
import { addFake, calls, makeHome, makeRepo, mkTmp } from './helpers.mjs';

const scoped = () => parseTask('---\nid: T-1\nallowed:\n  - src/\n---\nDo it.');
const ready = (id) => accounts.updateAccount(id, { status: 'ready' });
const registry = () => openRegistry();
const leases = () => { const r = registry(); try { return r.listLeases(); } finally { r.close(); } };

test('reserve: picks the sticky account, then LRU, and records a lease with owner identity', () => {
  makeHome();
  addFake('g1', {});
  addFake('g2', {});
  const a = reserve({ root: mkTmp('p-'), runId: 'r1' });
  assert.equal(a.ok, true);
  assert.equal(a.account.id, 'g1');
  const b = reserve({ root: mkTmp('p-'), runId: 'r2' });
  assert.equal(b.account.id, 'g2', 'g1 is reserved, so the next account is used');
  const rows = leases();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ownerPid, process.pid);
  assert.equal(rows[0].profilePath, profileIdentity(rows[0].profilePath).path);
  assert.ok(rows[0].zcVersion);
});

test('reserve: every eligible account reserved gives all-reserved, and never touches them', () => {
  makeHome();
  addFake('g1', {});
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r1' }).ok, true);
  const second = reserve({ root: mkTmp('p-'), runId: 'r2' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'all-reserved');
  assert.equal(leases().length, 1);
});

test('reserve: unattested, duplicate-label and attested paths (account-unattested fails closed)', () => {
  makeHome();
  addFake('g1', {}, { attested: false });
  const none = reserve({ root: mkTmp('p-'), runId: 'r1' });
  assert.deepEqual([none.ok, none.reason], [false, 'account-unattested']);
  assert.deepEqual(none.ids, ['g1']);
  addFake('g2', {});
  accounts.attestAccount('g1', 'Dup');
  accounts.updateAccount('g2', { identity: { label: ' dup', attestedAt: 'x', method: 'manual' } });
  const dup = reserve({ root: mkTmp('p-'), runId: 'r2' });
  assert.equal(dup.reason, 'account-unattested', 'both carry the same label: neither may be used');
  accounts.updateAccount('g2', { identity: { label: 'Other', attestedAt: 'x', method: 'manual' } });
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r3' }).ok, true);
  assert.equal(leases().length, 1, 'only one lease, a failed reserve leaves none behind');
});

test('reserve: two accounts that share one profile directory share one lease key', () => {
  makeHome();
  const g1 = addFake('g1', {});
  accounts.addAccount('g2', { dir: g1.profileDir, identity: { label: 'other', attestedAt: 'x', method: 'manual' } });
  ready('g2');
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r1' }).account.id, 'g1');
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r2' }).reason, 'all-reserved', 'same directory, same lease');
});

test('reserve: cooling and not-ready are reported as before', () => {
  makeHome();
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r0' }).reason, 'no-accounts');
  addFake('g1', {});
  accounts.cooldown('g1', Date.now() + 60_000, 'quota');
  const cool = reserve({ root: mkTmp('p-'), runId: 'r1' });
  assert.deepEqual([cool.reason, cool.retryAfter > Date.now()], ['cooling', true]);
  accounts.resetAccount('g1');
  accounts.setStatus('g1', 'blocked', 'license');
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r2' }).reason, 'not-ready');
});

test('reserve: live project cap, counted over live lease owners', () => {
  makeHome();
  for (const id of ['g1', 'g2', 'g3']) addFake(id, {});
  const roots = [mkTmp('pa-'), mkTmp('pb-'), mkTmp('pc-')];
  assert.equal(reserve({ root: roots[0], runId: 'r1', maxProjects: 2 }).ok, true);
  assert.equal(reserve({ root: roots[1], runId: 'r2', maxProjects: 2 }).ok, true);
  const third = reserve({ root: roots[2], runId: 'r3', maxProjects: 2 });
  assert.deepEqual([third.ok, third.reason], [false, 'max-projects']);
  assert.equal(reserve({ root: roots[0], runId: 'r4', maxProjects: 2 }).ok, true, 'a project already running may take another account');
});

test('reserve: a live legacy dispatch.lock refuses, a dead one is ignored and never deleted, a new-style lock is fine', () => {
  const home = makeHome();
  addFake('g1', {});
  const lockDir = join(home, 'projects', 'other-1');
  mkdirSync(lockDir, { recursive: true });
  const lock = join(lockDir, 'dispatch.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 1 }));
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r1' }).reason, 'legacy-dispatcher');
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 1, registry: true }));
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r2' }).ok, true, 'a new-style dispatcher is a peer, not a legacy writer');
  writeFileSync(lock, JSON.stringify({ pid: 999999999, startedAt: 1 }));
  const before = readFileSync(lock);
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r3' }).reason, 'all-reserved', 'dead legacy lock ignored (g1 is reserved by r2)');
  assert.deepEqual(readFileSync(lock), before, 'never deleted or rewritten');
});

test('reserve: a lease whose owner is dead is refused, never reaped, however often we ask', () => {
  makeHome();
  const g1 = addFake('g1', {});
  const reg = registry();
  const id = profileIdentity(g1.profileDir);
  reg.acquireLease({ key: id.key, kind: 'account', runId: 'dead-run', projectKey: 'p', ownerPid: 999999999, ownerStart: 1, ownerBoot: 'old-boot' });
  reg.close();
  for (let i = 0; i < 100; i++) {
    const r = reserve({ root: mkTmp('p-'), runId: `r${i}` });
    assert.deepEqual([r.ok, r.reason], [false, 'stale-lease']);
  }
  assert.equal(leases()[0].runId, 'dead-run');
});

test('proveWorkerGone: group and profile scan must both be clear (Linux)', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  const home = makeHome();
  const account = addFake('g1', {});
  assert.equal(proveWorkerGone({ profileDir: account.profileDir, pgid: null, worker: null }).gone, true, 'nothing was ever spawned');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: join(account.profileDir, 'home') } });
  await new Promise((r) => setTimeout(r, 200));
  const worker = processIdentity(child.pid);
  const alive = proveWorkerGone({ profileDir: account.profileDir, pgid: child.pid, worker, delays: [10] });
  assert.equal(alive.gone, false);
  process.kill(-child.pid, 'SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(proveWorkerGone({ profileDir: account.profileDir, pgid: child.pid, worker }).gone, true);
  assert.ok(home);
});

test('withShortLease: check/login style lease refuses an account that is in use and releases afterwards', async () => {
  makeHome();
  const g1 = addFake('g1', {});
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'busy' }).ok, true);
  await assert.rejects(withShortLease(g1, 'check', async () => 'x'), /in use by run busy/);
  const reg = registry();
  reg.releaseLease(profileIdentity(g1.profileDir).key, 'busy');
  reg.close();
  assert.equal(await withShortLease(g1, 'check', async () => 'ran'), 'ran');
  assert.equal(leases().length, 0, 'short lease released');
  await assert.rejects(withShortLease(g1, 'check', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(leases().length, 0, 'released even when the work throws');
});

test('dispatch: refuses an unattested account with NEEDS_HUMAN and a hint, and starts no worker', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } }, { attested: false });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /zc account attest g1/);
  assert.equal(calls(g1), 0);
});

test('dispatch: releases the lease when the run ends, success or not', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.notEqual(r.status, 'NEEDS_HUMAN');
  assert.equal(leases().length, 0);
});

test('dispatch: all accounts reserved by another run is NO_CAPACITY (all-reserved) with the tree untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'other' }).ok, true);
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.deepEqual([r.status, r.reason], ['NO_CAPACITY', 'all-reserved']);
  assert.equal(r.exitCode, 2);
  assert.equal(existsSync(join(dir, 'src', 'a.txt')), false);
});

test('dispatch: a worker that leaves a descendant using the profile keeps the lease and stops for a human', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' }, orphan: true });
  const r = await dispatch({ root: dir, task: scoped(), config });
  const rows = leases();
  try {
    assert.equal(r.status, 'NEEDS_HUMAN');
    assert.match(r.nextAction, /could not be proven gone/);
    const account = rows.filter((l) => l.kind === 'account');
    assert.equal(account.length, 1, 'the account lease is kept');
    assert.equal(account[0].runId, r.runId);
  } finally {
    const { scanProfileUsers } = await import('../src/procid.mjs');
    for (const pid of scanProfileUsers(g1.profileDir).pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    const reg = registry();
    for (const l of rows) reg.releaseLease(l.key, l.runId);
    reg.close();
  }
  assert.ok(stateRoot());
});

test('cli: status lists leases and the registry path; account check refuses an account in use', async () => {
  const { spawnSync } = await import('node:child_process');
  makeHome();
  addFake('g1', {});
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'busy-run' }).ok, true);
  const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const zc = (...args) => spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: 'utf8', cwd: mkTmp('cwd-') });
  const status = zc('status');
  assert.match(status.stdout, /registry: /);
  assert.match(status.stdout, /lease .*run busy-run/);
  const check = zc('account', 'check', 'g1');
  assert.notEqual(check.status, 0);
  assert.match(check.stdout, /in use by run busy-run/);
});

test('acquireLock leaves no temp files and is exclusive', async () => {
  const { acquireLock } = await import('../src/fsx.mjs');
  const { readdirSync } = await import('node:fs');
  const dir = mkTmp('lock-');
  const path = join(dir, 'dispatch.lock');
  const release = acquireLock(path, { runId: 'a', registry: true });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).registry, true);
  assert.throws(() => acquireLock(path, {}), /already running/);
  assert.deepEqual(readdirSync(dir), ['dispatch.lock']);
  release();
  assert.deepEqual(readdirSync(dir), []);
});

test('withShortLease keeps the lease and reports when a process still uses the profile', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  makeHome();
  const g1 = addFake('g1', {});
  let stray;
  await assert.rejects(withShortLease(g1, 'login', async () => {
    stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: join(g1.profileDir, 'home') } });
    await new Promise((r) => setTimeout(r, 200));
  }), /still use its profile/);
  try {
    assert.equal(leases().length, 1, 'lease kept');
  } finally {
    process.kill(-stray.pid, 'SIGKILL');
    const reg = registry();
    for (const l of reg.listLeases()) reg.releaseLease(l.key, l.runId);
    reg.close();
  }
});

test('short leases do not count toward the live-project cap', () => {
  makeHome();
  addFake('g1', {});
  addFake('g2', {});
  return withShortLease(accounts.getAccount('g1'), 'login', async () => {
    const r = reserve({ root: mkTmp('p-'), runId: 'real', maxProjects: 1 });
    assert.equal(r.ok, true, 'a login in progress did not use up the only project slot');
    assert.equal(r.account.id, 'g2');
  });
});

test('cli: account check continues past a busy account and still fails overall', async () => {
  const { spawnSync } = await import('node:child_process');
  makeHome();
  addFake('g1', {});
  addFake('g2', {});
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'busy-run' }).account.id, 'g1');
  const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const r = spawnSync(process.execPath, [bin, 'account', 'check'], { env: process.env, encoding: 'utf8', cwd: mkTmp('cwd-') });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /g1: account g1 is in use by run busy-run/);
  assert.match(r.stdout, /g2 OK/, 'g2 was still checked');
  assert.match(r.stderr, /not checked: g1/);
});

test('reserve: a profile directory that is nested in or around a leased one is refused, and relative or missing dirs are never used', async () => {
  const { mkdirSync: mk } = await import('node:fs');
  makeHome();
  const g1 = addFake('g1', {});
  const inner = join(g1.profileDir, 'inner');
  mk(inner, { recursive: true });
  accounts.addAccount('g2', { dir: inner, identity: { label: 'inner', attestedAt: 'x', method: 'manual' } });
  ready('g2');
  accounts.addAccount('g3', { dir: 'relative/path', identity: { label: 'rel', attestedAt: 'x', method: 'manual' } });
  ready('g3');
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r1' }).account.id, 'g1');
  const next = reserve({ root: mkTmp('p-'), runId: 'r2' });
  assert.equal(next.reason, 'all-reserved', 'g2 sits inside g1 (leased) and g3 has a relative dir');
});

test('reserve: the same directory recreated under a new inode is still blocked while its old lease lives', async () => {
  const { rmSync: rm, mkdirSync: mk } = await import('node:fs');
  makeHome();
  const g1 = addFake('g1', {});
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r1' }).ok, true);
  rm(g1.profileDir, { recursive: true, force: true });
  mk(g1.profileDir, { recursive: true });
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r2' }).reason, 'all-reserved');
});

test('reserve: a process that uses a profile without holding a lease blocks it (profile-in-use)', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  makeHome();
  const g1 = addFake('g1', {});
  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: join(g1.profileDir, 'home') } });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const r = reserve({ root: mkTmp('p-'), runId: 'r1' });
    assert.deepEqual([r.ok, r.reason], [false, 'profile-in-use']);
    assert.ok(r.pids.includes(stray.pid));
    assert.equal(leases().length, 0, 'the tentative lease was given back');
  } finally {
    const exited = new Promise((resolve) => stray.once('exit', resolve));
    process.kill(-stray.pid, 'SIGKILL');
    await exited; // the process must really be gone before the scan runs again
  }
  assert.equal(reserve({ root: mkTmp('p-'), runId: 'r2' }).ok, true, 'free again once the stray is gone');
});
