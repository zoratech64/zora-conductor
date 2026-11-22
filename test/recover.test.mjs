import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptRun, getRun, listRuns, rejectRun } from '../src/dispatch.mjs';
import * as G from '../src/gitx.mjs';
import { gitLayout } from '../src/gitmeta.mjs';
import { projectKey, runsDir } from '../src/paths.mjs';
import { openRegistry, profileIdentity } from '../src/registry.mjs';
import { recoverRun, releaseConfirmation } from '../src/recover.mjs';
import { addFake, makeHome, makeRepo } from './helpers.mjs';

const gone = { verdict: 'none', pids: [] };
const proven = { platform: 'linux', isolation: 'dbus', scan: () => gone, groupAlive: () => gone };
const DEAD = { pid: 999999999, identity: 'pid-only' };

/** A project with a dead dispatcher's RUNNING record and a worker's uncommitted file. */
function world({ status = 'RUNNING', extra = {} } = {}) {
  makeHome();
  const acct = addFake('g1', {});
  const { dir } = makeRepo();
  const runId = 'dead-run';
  const runDir = join(runsDir(dir), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    runId, runDir, taskId: 'T-1', status, owner: DEAD, worker: null, account: 'g1', head: G.head(dir), gitLayout: gitLayout(dir), ...extra
  }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.txt'), 'worker output\n');
  return { dir, runId, acct };
}
const tree = (dir) => ({ state: G.dirtyState(dir), a: readFileSync(join(dir, 'src', 'a.txt'), 'utf8') });
const plantLeases = (dir, acct, runId) => {
  const id = profileIdentity(acct.profileDir);
  const reg = openRegistry();
  const base = { runId, projectKey: projectKey(dir), ownerPid: DEAD.pid, ownerStart: null, ownerBoot: null };
  reg.acquireLease({ ...base, key: id.key, kind: 'account', profilePath: id.path });
  reg.acquireLease({ ...base, key: `project:${projectKey(dir)}`, kind: 'project' });
  reg.close();
};
const leaseKeys = () => { const r = openRegistry(); try { return r.listLeases().map((l) => l.key); } finally { r.close(); } };

test('without --yes it only shows the proof and the changed paths', () => {
  const { dir, runId } = world();
  const before = tree(dir);
  const out = recoverRun({ root: dir, runId, deps: proven });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.paths, ['src/a.txt']);
  assert.equal(getRun(dir, runId).status, 'RUNNING');
  assert.deepEqual(tree(dir), before);
});

test('with --yes and a proven-gone worker the run becomes RECOVERED and no file changes', () => {
  const { dir, runId } = world();
  const before = tree(dir);
  const out = recoverRun({ root: dir, runId, yes: true, deps: proven });
  assert.equal(out.recovered, true);
  const record = getRun(dir, runId);
  assert.equal(record.status, 'RECOVERED');
  assert.equal(record.storedStatus, 'RUNNING');
  assert.deepEqual(record.workerState, before.state);
  assert.deepEqual(tree(dir), before, 'fingerprints equal before and after');
  assert.equal(listRuns(dir, 1)[0].status, 'RECOVERED');
  assert.deepEqual(leaseKeys(), []);
});

test('a recovered run cannot be accepted, and reject discards exactly its files', () => {
  const { dir, runId } = world();
  recoverRun({ root: dir, runId, yes: true, deps: proven });
  assert.throws(() => acceptRun({ root: dir, runId }), /status is RECOVERED/);
  const out = rejectRun({ root: dir, runId });
  assert.equal(out.rolledBack, true);
  assert.deepEqual(out.restored, ['src/a.txt']);
});

test('a worker that is not proven gone is refused and nothing changes', () => {
  const { dir, runId } = world();
  const before = tree(dir);
  for (const deps of [
    { ...proven, scan: () => ({ verdict: 'found', pids: [1] }) },
    { ...proven, scan: () => ({ verdict: 'unknown', pids: [], unreadable: [2] }) },
    { ...proven, platform: 'darwin' },
    { ...proven, isolation: 'none' }
  ]) {
    assert.throws(() => recoverRun({ root: dir, runId, yes: true, deps }), /not proven gone/);
  }
  assert.equal(getRun(dir, runId).status, 'RUNNING');
  assert.deepEqual(tree(dir), before);
});

test('a finished run, an unknown run and a live dispatcher are refused', () => {
  const finished = world({ status: 'OK' });
  assert.throws(() => recoverRun({ root: finished.dir, runId: finished.runId, yes: true, deps: proven }), /only an interrupted run/);
  assert.throws(() => recoverRun({ root: finished.dir, runId: 'nope', yes: true, deps: proven }), /no run/);
  const live = world({ extra: { owner: { pid: process.pid, identity: 'pid-only' } } });
  assert.throws(() => recoverRun({ root: live.dir, runId: live.runId, yes: true, deps: proven }), /only an interrupted run/);
});

test('a lease that cannot be proven stale keeps blocking, and --release is the explicit override', () => {
  const { dir, runId, acct } = world();
  plantLeases(dir, acct, runId);
  const darwin = { ...proven, platform: 'darwin' };
  assert.throws(() => recoverRun({ root: dir, runId, yes: true, deps: darwin }), /not proven gone/);
  assert.throws(() => recoverRun({ root: dir, runId, yes: true, release: 'g1', deps: darwin }), /--confirm/);
  assert.throws(() => recoverRun({ root: dir, runId, yes: true, release: 'g2', confirm: releaseConfirmation(runId, 'g2'), deps: darwin }), /not g2/);
  assert.equal(leaseKeys().length, 2);
  const before = tree(dir);
  const out = recoverRun({ root: dir, runId, yes: true, release: 'g1', confirm: releaseConfirmation(runId, 'g1'), deps: darwin });
  assert.equal(out.recovered, true);
  assert.equal(out.released.length, 2);
  assert.equal(getRun(dir, runId).recoveredBy, 'human-release');
  assert.deepEqual(leaseKeys(), []);
  assert.deepEqual(tree(dir), before);
});

test('--release without --yes releases nothing', () => {
  const { dir, runId, acct } = world();
  plantLeases(dir, acct, runId);
  const out = recoverRun({ root: dir, runId, release: 'g1', confirm: releaseConfirmation(runId, 'g1'), deps: { ...proven, platform: 'darwin' } });
  assert.equal(out.dryRun, true);
  assert.equal(leaseKeys().length, 2);
});

test('the tree must still belong to the run: moved HEAD, a newer run, or a missing layout refuse', () => {
  const moved = world({ extra: { head: 'deadbeef' } });
  assert.throws(() => recoverRun({ root: moved.dir, runId: moved.runId, yes: true, deps: proven }), /HEAD is not the commit/);
  const bare = world({ extra: { gitLayout: undefined } });
  assert.throws(() => recoverRun({ root: bare.dir, runId: bare.runId, deps: proven }), /no git layout/);
  const newer = world();
  const runDir = join(runsDir(newer.dir), 'zz-newer');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ runId: 'zz-newer', status: 'OK', runDir }));
  assert.throws(() => recoverRun({ root: newer.dir, runId: newer.runId, yes: true, deps: proven }), /newer run \(zz-newer\)/);
  assert.equal(getRun(newer.dir, newer.runId).status, 'RUNNING');
});

test('a dry run with --release checks account and confirmation like the real one', () => {
  const { dir, runId } = world();
  const deps = { ...proven, platform: 'darwin' };
  assert.throws(() => recoverRun({ root: dir, runId, release: 'g1', deps }), /--confirm/);
  assert.throws(() => recoverRun({ root: dir, runId, release: 'g2', confirm: releaseConfirmation(runId, 'g2'), deps }), /not g2/);
});
