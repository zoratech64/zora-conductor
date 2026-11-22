import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch, rejectRun, acceptRun } from '../src/dispatch.mjs';
import { acquireProjectLease } from '../src/lease-project.mjs';
import { lockFile, projectKey } from '../src/paths.mjs';
import { openRegistry } from '../src/registry.mjs';
import { parseTask } from '../src/task.mjs';
import { addFake, makeHome, makeRepo, mkTmp } from './helpers.mjs';

const scoped = () => parseTask('---\nid: T-1\nallowed:\n  - src/\n---\nDo it.');
const leases = () => { const r = openRegistry(); try { return r.listLeases(); } finally { r.close(); } };
const projectLeases = () => leases().filter((l) => l.kind === 'project');
const putLock = (root, content) => {
  const file = lockFile(root);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('project lease is exclusive per project, independent across projects, and releasable', () => {
  makeHome();
  const a = mkTmp('proj-a-');
  const b = mkTmp('proj-b-');
  const releaseA = acquireProjectLease({ root: a, runId: 'r1' });
  assert.throws(() => acquireProjectLease({ root: a, runId: 'r2' }), /already running \(pid \d+/);
  const releaseB = acquireProjectLease({ root: b, runId: 'r3' });
  assert.equal(projectLeases().length, 2);
  assert.equal(projectLeases()[0].key, `project:${projectKey(a)}`);
  releaseA();
  releaseA(); // releasing twice is harmless
  releaseB();
  assert.equal(projectLeases().length, 0);
  acquireProjectLease({ root: a, runId: 'r4' })();
});

test('project lease: a lease whose owner is dead is refused, never taken over', () => {
  makeHome();
  const root = mkTmp('proj-');
  const reg = openRegistry();
  reg.acquireLease({ key: `project:${projectKey(root)}`, kind: 'project', runId: 'gone', projectKey: projectKey(root), ownerPid: 999999999, ownerStart: 1, ownerBoot: 'old' });
  reg.close();
  for (let i = 0; i < 20; i++) assert.throws(() => acquireProjectLease({ root, runId: `r${i}` }), /is gone|not taken over/);
  assert.equal(projectLeases()[0].runId, 'gone');
});

test('legacy dispatch.lock: a live one blocks, a dead one is ignored and never deleted or rewritten', () => {
  makeHome();
  const root = mkTmp('proj-');
  const file = putLock(root, { pid: process.ppid, startedAt: 1, runId: 'legacy-run' });
  assert.throws(() => acquireProjectLease({ root, runId: 'r1' }), /older zc|legacy/);
  assert.equal(projectLeases().length, 0, 'a refused attempt leaves no lease behind');
  // equivalent copies of the two real orphan locks (dead pids)
  for (const content of [
    { pid: 999999998, startedAt: 1794996245959, runId: '20261118100405-odvn' },
    { pid: 999999997, startedAt: 1794820057662, runId: '20261116090737-s8j3' }
  ]) {
    writeFileSync(file, JSON.stringify(content));
    const before = readFileSync(file);
    const release = acquireProjectLease({ root, runId: 'r2' });
    assert.deepEqual(readFileSync(file), before, 'dead lock untouched while we hold the project');
    release();
    assert.deepEqual(readFileSync(file), before, 'and after release');
  }
});

test('legacy dispatch.lock: unreadable content fails closed', () => {
  makeHome();
  const root = mkTmp('proj-');
  putLock(root, '{"pid": 12');
  assert.throws(() => acquireProjectLease({ root, runId: 'r1' }), /unreadable/);
});

test('dispatch takes the project lease for the whole run and writes no dispatch.lock', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.notEqual(r.status, 'NEEDS_HUMAN');
  assert.equal(leases().length, 0, 'account and project leases both released');
  assert.equal(existsSync(lockFile(dir)), false, 'new code does not create dispatch.lock');
});

test('dispatch refuses while another run holds the project, with the tree untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  const release = acquireProjectLease({ root: dir, runId: 'other' });
  const r = await dispatch({ root: dir, task: scoped(), config });
  release();
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /already running/);
  assert.equal(existsSync(join(dir, 'src', 'a.txt')), false);
});

test('reject and accept take the project lease and always release it, even when they throw', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'w' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  const release = acquireProjectLease({ root: dir, runId: 'other' });
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /already running/);
  assert.throws(() => acceptRun({ root: dir, runId: r.runId }), /already running/);
  release();
  writeFileSync(join(dir, 'src/a.txt'), 'edited');
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /not exactly/);
  assert.equal(projectLeases().length, 0, 'a failing reject did not leak the lease');
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(projectLeases().length, 0);
});

test('two projects dispatch in parallel on different accounts without touching each other', async () => {
  makeHome();
  const a = makeRepo();
  const b = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs: 400 });
  addFake('g2', { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs: 400 });
  const [ra, rb] = await Promise.all([
    dispatch({ root: a.dir, task: scoped(), config: a.config }),
    dispatch({ root: b.dir, task: scoped(), config: b.config })
  ]);
  assert.notEqual(ra.status, 'NEEDS_HUMAN', ra.nextAction);
  assert.notEqual(rb.status, 'NEEDS_HUMAN', rb.nextAction);
  assert.notEqual(ra.account, rb.account);
});

test('a worker that cannot be proven gone keeps the project lease as well as the account lease', { skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' }, orphan: true });
  const r = await dispatch({ root: dir, task: scoped(), config });
  const rows = leases();
  try {
    assert.equal(r.status, 'NEEDS_HUMAN');
    assert.deepEqual(rows.map((l) => l.kind).sort(), ['account', 'project']);
    await assert.rejects(Promise.resolve().then(() => acquireProjectLease({ root: dir, runId: 'next' })), /already running/, 'a second dispatch in this project cannot start');
  } finally {
    const { scanProfileUsers } = await import('../src/procid.mjs');
    for (const pid of scanProfileUsers(g1.profileDir).pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    const reg = openRegistry();
    for (const l of rows) reg.releaseLease(l.key, l.runId);
    reg.close();
  }
});

test('a project left leased by a dead zc is refused with the "not taken over" text, not "already running"', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  const reg = openRegistry();
  reg.acquireLease({ key: `project:${projectKey(dir)}`, kind: 'project', runId: 'crashed', projectKey: projectKey(dir), ownerPid: 999999999, ownerStart: 1, ownerBoot: 'old' });
  reg.close();
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /whose zc \(pid 999999999\) is gone/);
  assert.doesNotMatch(r.nextAction, /already running/);
  assert.equal(projectLeases()[0].runId, 'crashed', 'kept, not reaped');
});

test('a failing release is reported but never masks the result of the operation', async () => {
  makeHome();
  const root = mkTmp('proj-');
  const release = acquireProjectLease({ root, runId: 'r1' });
  const { rmSync } = await import('node:fs');
  const dir = process.env.ZC_TEST_REGISTRY_DIR;
  const realWarn = console.error;
  const warnings = [];
  console.error = (m) => warnings.push(m);
  try {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory'); // the registry can no longer be opened
    assert.equal(release(), false, 'returns instead of throwing');
  } finally {
    console.error = realWarn;
    rmSync(dir, { force: true });
  }
  assert.match(warnings.join(' '), /could not release the project lease/);
});

test('a lock file that is not a regular file, or names a non-positive pid, cannot hang or bypass the check', { skip: process.platform === 'win32' && 'POSIX nodes' }, async () => {
  const { spawnSync } = await import('node:child_process');
  makeHome();
  const root = mkTmp('proj-');
  const file = lockFile(root);
  mkdirSync(join(file, '..'), { recursive: true });
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
  assert.throws(() => acquireProjectLease({ root, runId: 'r1' }), /not a regular file/, 'a FIFO fails closed instead of blocking');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(file);
  writeFileSync(file, JSON.stringify({ pid: -1, startedAt: 1 }));
  assert.doesNotThrow(() => acquireProjectLease({ root, runId: 'r2' })(), 'pid -1 is not a live dispatcher (kill(-1,0) would say alive)');
});
