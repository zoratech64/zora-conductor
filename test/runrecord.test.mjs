import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acceptRun, listRuns, rejectRun, getRun } from '../src/dispatch.mjs';
import { runsDir } from '../src/paths.mjs';
import { processIdentity } from '../src/procid.mjs';
import { deriveStatus } from '../src/runrecord.mjs';
import { addFake, makeHome, makeRepo } from './helpers.mjs';

const POSIX = process.platform !== 'win32';
const DRIVER = resolve(import.meta.dirname, 'dispatch-driver.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(25); }
}

const readRecord = (dir) => {
  const names = existsSync(runsDir(dir)) ? readdirSync(runsDir(dir)) : [];
  const file = names.length ? join(runsDir(dir), names[0], 'result.json') : null;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

const ghost = (extra = {}) => ({ runId: 'r-1', status: 'RUNNING', taskId: 'T-1', owner: { pid: 999999999, identity: 'pid-only' }, worker: null, ...extra });

test('deriveStatus: live owner stays RUNNING; dead owner and no worker is INTERRUPTED; old records keep their status', () => {
  const me = processIdentity(process.pid);
  assert.equal(deriveStatus(ghost({ owner: me })).status, 'RUNNING');
  const dead = deriveStatus(ghost());
  assert.equal(dead.status, 'INTERRUPTED');
  assert.equal(dead.storedStatus, 'RUNNING');
  assert.equal(dead.statusDerived, true);
  const legacy = { runId: 'old', status: 'RUNNING' }; // no owner: written by an older zc
  assert.equal(deriveStatus(legacy).status, 'RUNNING');
  assert.equal(deriveStatus({ runId: 'x', status: 'OK', owner: { pid: 999999999, identity: 'pid-only' } }).status, 'OK', 'only RUNNING records are re-derived');
});

test('deriveStatus: dead owner with a live worker group is ORPHAN, and INTERRUPTED once the worker is gone', { skip: !POSIX && 'POSIX groups' }, async () => {
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await sleep(150);
  const id = processIdentity(worker.pid);
  const record = ghost({ worker: { pid: worker.pid, pgid: worker.pid, startTicks: id.startTicks, bootId: id.bootId, identity: id.identity } });
  assert.equal(deriveStatus(record).status, 'ORPHAN');
  process.kill(-worker.pid, 'SIGKILL');
  await new Promise((r) => worker.once('exit', r));
  assert.equal(deriveStatus(record).status, 'INTERRUPTED');
});

test('a running dispatch records RUNNING with owner and worker identity, and the final record replaces it', { skip: !POSIX && 'POSIX', timeout: 60000 }, async () => {
  const home = makeHome();
  const trace = join(home, 'trace.log');
  const { dir } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs: 1500, trace });
  const child = spawn(process.execPath, [DRIVER, dir], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((done) => child.on('exit', done));
  const live = await waitFor(() => { const r = readRecord(dir); return r?.status === 'RUNNING' && r.worker?.pid ? r : null; }, 'a RUNNING record with a worker');
  assert.equal(live.owner.pid, child.pid);
  assert.equal(live.account, 'g1');
  assert.equal(typeof live.worker.pid, 'number');
  assert.equal(listRuns(dir, 1)[0].status, 'RUNNING', 'live owner: still RUNNING');
  await exited;
  const done = readRecord(dir);
  assert.notEqual(done.status, 'RUNNING');
  assert.equal(done.owner, undefined, 'the final record carries no running-state fields');
});

test('a dispatcher killed with SIGKILL leaves RUNNING: ORPHAN while its worker lives, INTERRUPTED after', { skip: !POSIX && 'POSIX signals', timeout: 60000 }, async () => {
  const home = makeHome();
  const trace = join(home, 'trace.log');
  const { dir } = makeRepo();
  addFake('g1', { mode: 'slow', trace });
  const child = spawn(process.execPath, [DRIVER, dir], { env: process.env, stdio: 'ignore' });
  const exited = new Promise((done) => child.on('exit', done));
  const live = await waitFor(() => { const r = readRecord(dir); return r?.status === 'RUNNING' && r.worker?.pid ? r : null; }, 'the worker to be recorded');
  child.kill('SIGKILL');
  await exited;
  const shown = listRuns(dir, 1)[0];
  assert.equal(shown.status, 'ORPHAN');
  assert.equal(shown.storedStatus, 'RUNNING');
  process.kill(-live.worker.pgid, 'SIGKILL');
  await waitFor(() => listRuns(dir, 1)[0].status === 'INTERRUPTED', 'INTERRUPTED once the worker is gone');
});

test('accept and reject refuse a run that is still RUNNING or was interrupted without a record, with a clear message', () => {
  makeHome();
  const { dir } = makeRepo();
  const run = join(runsDir(dir), '20260101000000-abcd');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'result.json'), JSON.stringify(ghost({ runId: '20260101000000-abcd' })));
  assert.throws(() => acceptRun({ root: dir, runId: '20260101000000-abcd' }), /status is INTERRUPTED/);
  assert.throws(() => rejectRun({ root: dir, runId: '20260101000000-abcd' }), /did not finish|still running|interrupted/i);
  assert.throws(() => rejectRun({ root: dir, runId: '20260101000000-abcd', force: true }), /did not finish|still running|interrupted/i);
  assert.equal(getRun(dir, '20260101000000-abcd').status, 'RUNNING', 'getRun returns the stored record untouched');
  assert.throws(() => rejectRun({ root: dir, runId: '20260101000000-abcd' }), /recorded RUNNING, shown as INTERRUPTED/);
});

test('zc runs prints the derived status', () => {
  makeHome();
  const { dir } = makeRepo();
  const id = '20260101000000-wxyz';
  mkdirSync(join(runsDir(dir), id), { recursive: true });
  writeFileSync(join(runsDir(dir), id, 'result.json'), JSON.stringify(ghost({ runId: id })));
  const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const out = spawnSync(process.execPath, [bin, 'runs', '--project', dir], { env: process.env, encoding: 'utf8' });
  assert.match(out.stdout, /INTERRUPTED/);
});


test('a pid-only worker whose own pid is gone but whose group lives is still ORPHAN (fail closed)', { skip: !POSIX && 'POSIX groups' }, async () => {
  const leader = spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setTimeout(()=>process.exit(0),100)"], { detached: true, stdio: 'ignore' });
  await new Promise((r) => leader.once('exit', r));
  await sleep(100);
  const record = ghost({ worker: { pid: leader.pid, pgid: leader.pid, identity: 'pid-only' } });
  try {
    assert.equal(deriveStatus(record).status, 'ORPHAN', 'the leader is gone but a member of its group is not');
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('measure.mjs counts a crashed run as INTERRUPTED, like zc runs, and pendingMetaRun still works with stale RUNNING records', async () => {
  makeHome();
  const { dir } = makeRepo();
  const id = '20260101000000-meas';
  mkdirSync(join(runsDir(dir), id), { recursive: true });
  writeFileSync(join(runsDir(dir), id, 'result.json'), JSON.stringify(ghost({ runId: id })));
  const out = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'measure.mjs'), 'runs', '--project', dir], { env: process.env, encoding: 'utf8' });
  assert.match(out.stdout + out.stderr, /INTERRUPTED/);
  assert.equal(listRuns(dir, 5).length, 1);
});

test('recorder: only the first write may fail the run; later write failures warn and carry on', async () => {
  const { createRecorder } = await import('../src/runrecord.mjs');
  const { rmSync } = await import('node:fs');
  const base = join(makeHome(), 'rec');
  mkdirSync(base, { recursive: true });
  const recorder = createRecorder({ runDir: base, result: { runId: 'r' } });
  recorder.start();
  rmSync(base, { recursive: true, force: true });
  writeFileSync(base, 'a file where the run dir was'); // every further write now fails
  const warned = [];
  const real = console.error;
  console.error = (m) => warned.push(m);
  try {
    assert.doesNotThrow(() => recorder.update({ account: 'g1' }));
    assert.doesNotThrow(() => recorder.setWorker({ pid: 1 }));
  } finally { console.error = real; rmSync(base, { force: true }); }
  assert.equal(warned.length, 2);
  const failing = createRecorder({ runDir: join(base, 'nope', 'x'), result: { runId: 'r' } });
  writeFileSync(base, 'blocker');
  assert.throws(() => failing.start(), 'the first write is a hard failure');
  rmSync(base, { force: true });
});

test('deriveStatus: a worker still marked starting is ORPHAN; absurd pids never read as dead', () => {
  assert.equal(deriveStatus(ghost({ worker: { starting: true } })).status, 'ORPHAN');
  assert.equal(deriveStatus(ghost({ owner: { pid: 1e300, identity: 'pid-only' } })).status, 'RUNNING');
  assert.equal(deriveStatus(ghost({ owner: { pid: -5, identity: 'pid-only' } })).status, 'RUNNING');
  assert.equal(deriveStatus(ghost({ owner: 'nonsense' })).status, 'RUNNING');
});

test('a record whose runId differs from its directory name is not trusted', () => {
  makeHome();
  const { dir } = makeRepo();
  mkdirSync(join(runsDir(dir), '20260101000000-good'), { recursive: true });
  writeFileSync(join(runsDir(dir), '20260101000000-good', 'result.json'), JSON.stringify({ runId: '../x', status: 'OK' }));
  assert.equal(getRun(dir, '20260101000000-good'), null);
  assert.deepEqual(listRuns(dir, 5), []);
});
