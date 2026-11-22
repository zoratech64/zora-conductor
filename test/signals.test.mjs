import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { installSignalGuard, interruptibleSleep, signalCaught } from '../src/signals.mjs';
import { openRegistry } from '../src/registry.mjs';
import { scanProfileUsers } from '../src/procid.mjs';
import { addFake, makeHome, makeRepo } from './helpers.mjs';

const POSIX = process.platform !== 'win32';
const DRIVER = resolve(import.meta.dirname, 'dispatch-driver.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leases = () => { const r = openRegistry(); try { return r.listLeases(); } finally { r.close(); } };

async function waitFor(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** Run a dispatch in a child process, wait until its worker has started, send `signal`, return what happened. */
async function interruptDispatch({ scenario, signal = 'SIGINT' }) {
  const home = makeHome();
  const trace = join(home, 'trace.log');
  const { dir } = makeRepo();
  const g1 = addFake('g1', { ...scenario, trace });
  const child = spawn(process.execPath, [DRIVER, dir, '--exit-code'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((done) => child.on('exit', (code, sig) => done({ code, sig })));
  await waitFor(() => existsSync(trace) && /^ready /m.test(readFileSync(trace, 'utf8')), 'the worker to be ready');
  const sentAt = Date.now();
  child.kill(signal);
  const { code, sig } = await exited;
  return { code, sig, took: Date.now() - sentAt, result: out ? JSON.parse(out) : null, dir, g1, trace };
}

const workerPid = (r) => Number(/^start \S+ \d+ (\d+)$/m.exec(readFileSync(r.trace, 'utf8'))[1]);
const isGone = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

test('SIGINT during a worker: worker stopped, partial work saved and kept, leases released, exit 130', { skip: !POSIX && 'POSIX signals', timeout: 60000 }, async () => {
  const r = await interruptDispatch({ scenario: { mode: 'slow', partial: true, write: { 'src/part.txt': 'half' } } });
  assert.equal(r.code, 130);
  assert.equal(r.result.status, 'INTERRUPTED');
  assert.equal(isGone(workerPid(r)), true, 'the worker process ended');
  assert.equal(existsSync(join(r.dir, 'src', 'part.txt')), true, 'the tree is preserved, not rolled back');
  assert.deepEqual(leases(), [], 'account and project leases released after the worker was confirmed dead');
  assert.deepEqual(scanProfileUsers(r.g1.profileDir).pids, []);
});

test('SIGTERM is handled the same way', { skip: !POSIX && 'POSIX signals', timeout: 60000 }, async () => {
  const r = await interruptDispatch({ scenario: { mode: 'slow' }, signal: 'SIGTERM' });
  assert.equal(r.code, 130);
  assert.equal(r.result.status, 'INTERRUPTED');
  assert.deepEqual(leases(), []);
});

test('a worker that ignores SIGTERM is killed after the grace period and the run still ends cleanly', { skip: !POSIX && 'POSIX signals', timeout: 60000 }, async () => {
  const r = await interruptDispatch({ scenario: { mode: 'slow', ignoreTerm: true } });
  assert.equal(r.code, 130);
  assert.equal(r.result.status, 'INTERRUPTED');
  assert.ok(r.took >= 4500, `waited for the grace period before KILL (took ${r.took} ms)`);
  assert.ok(r.took < 20000);
  assert.deepEqual(leases(), []);
});

test('a worker that leaves a descendant on the profile: leases are KEPT and the run is marked orphaned', { skip: process.platform !== 'linux' && 'needs /proc', timeout: 60000 }, async () => {
  const r = await interruptDispatch({ scenario: { mode: 'slow', orphan: true } });
  const rows = leases();
  try {
    assert.equal(r.code, 130);
    assert.equal(r.result.status, 'INTERRUPTED');
    assert.equal(r.result.orphan, true);
    assert.deepEqual(rows.map((l) => l.kind).sort(), ['account', 'project'], 'both leases kept');
  } finally {
    for (const pid of scanProfileUsers(r.g1.profileDir).pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    const reg = openRegistry();
    for (const l of rows) reg.releaseLease(l.key, l.runId);
    reg.close();
  }
});

test('guard: first signal records it and ends interruptible sleeps, a repeat is ignored, the third forces exit; uninstall restores listeners', () => {
  const before = process.listenerCount('SIGINT');
  const logs = [];
  const exits = [];
  const guard = installSignalGuard({ log: (m) => logs.push(m), exit: (c) => exits.push(c), graceMs: 10 });
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  assert.equal(guard.interrupted(), false);
  const sleeping = interruptibleSleep(60_000);
  process.emit('SIGINT', 'SIGINT');
  assert.equal(guard.interrupted(), true);
  assert.equal(guard.signal, 'SIGINT');
  return sleeping.then((completed) => {
    assert.equal(completed, false, 'the sleep was cut short');
    process.emit('SIGINT', 'SIGINT');
    assert.deepEqual(exits, [], 'a second signal does not force');
    process.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(exits, [130], 'the third signal forces exit 130');
    guard.uninstall();
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(signalCaught(), 'SIGINT');
    assert.ok(logs.length >= 2);
  });
});

test('interruptibleSleep without a guard simply sleeps', async () => {
  assert.equal(await interruptibleSleep(10), true);
});

test('deferSignals: a signal that arrives during synchronous work does not kill it; it is recorded afterwards', { skip: !POSIX && 'POSIX signals' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../src/cli.mjs', import.meta.url).href;
  const sig = new URL('../src/signals.mjs', import.meta.url).href;
  const code = `import { deferSignals } from ${JSON.stringify(cli)};
    import { signalCaught } from ${JSON.stringify(sig)};
    const out = await deferSignals(() => {
      process.kill(process.pid, 'SIGINT');
      const end = Date.now() + 200; while (Date.now() < end) { /* synchronous work in progress */ }
      return 'finished';
    });
    console.log(out, signalCaught());`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'finished SIGINT');
});

test('guard is shared by reference count: the first holder letting go keeps the handlers for the other', () => {
  const before = process.listenerCount('SIGINT');
  const a = installSignalGuard({ log: () => {}, exit: () => {} });
  const b = installSignalGuard({ log: () => {}, exit: () => {} });
  assert.notEqual(a, b, 'each caller gets its own handle');
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  a.uninstall();
  a.uninstall(); // letting go twice counts once
  assert.equal(process.listenerCount('SIGINT'), before + 1, 'still protected for the second holder');
  b.uninstall();
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('a new command in the same process does not inherit an earlier signal (main resets it)', async () => {
  const { resetSignalCaught } = await import('../src/signals.mjs');
  resetSignalCaught();
  assert.equal(signalCaught(), null);
});

test('a throwing logger cannot stop the worker from being terminated', () => {
  const guard = installSignalGuard({ log: () => { throw new Error('log broke'); }, exit: () => {}, graceMs: 10 });
  assert.doesNotThrow(() => process.emit('SIGINT', 'SIGINT'));
  assert.equal(guard.interrupted(), true);
  guard.uninstall();
});

test('runVerify starts no further command once told to stop', async () => {
  const { runVerify } = await import('../src/verify.mjs');
  const ok = [process.execPath, '-e', 'process.exit(0)'];
  let calls = 0;
  const results = await runVerify(process.cwd(), [ok, ok, ok], { timeoutMs: 10000, stop: () => ++calls > 1 });
  assert.equal(results.length, 1);
});
