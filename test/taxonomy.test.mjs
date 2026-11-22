import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as accounts from '../src/accounts.mjs';
import { classify } from '../src/classify.mjs';
import { loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { statusEntries } from '../src/gitx.mjs';
import { openRegistry } from '../src/registry.mjs';
import { addFake, calls, makeHome, makeRepo, task } from './helpers.mjs';

const scoped = () => task('id: T-1\nallowed:\n  - src/\n');
const FAST = { capacityWaitSeconds: [0.05, 0.05], networkWaitSeconds: [0.05, 0.05] };
const leases = () => { const r = openRegistry(); try { return r.listLeases(); } finally { r.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the real gita stderr line is capacity, network errors are network, a plain 5xx stays server', () => {
  assert.equal(classify('API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server'), 'capacity');
  for (const text of ['getaddrinfo ENOTFOUND x.googleapis.com', 'EAI_AGAIN', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'TypeError: fetch failed']) {
    assert.equal(classify(text), 'network', text);
  }
  assert.equal(classify('Internal error encountered'), 'server');
  assert.equal(classify('503 service UNAVAILABLE'), 'server');
  assert.equal(classify('RESOURCE_EXHAUSTED: quota exceeded'), 'quota');
});

test('capacity once: waits, retries the same account, no cooldown, no rotation, maxAttempts untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: { ...FAST, maxAttempts: 1 } });
  const g1 = addFake('g1', { mode: 'capacity', failTimes: 1, write: { 'src/a.txt': 'a' } });
  const g2 = addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.attempts.map((a) => [a.account, a.kind ?? null]), [['g1', 'capacity'], ['g1', null]]);
  assert.equal(calls(g1), 2);
  assert.equal(calls(g2), 0);
  const a = accounts.getAccount('g1');
  assert.equal(a.status, 'ready');
  assert.ok(!a.cooldownUntil, 'no cooldown was written');
});

test('capacity every time: two waits, then NO_CAPACITY (model-capacity), exit 2, tree clean, account untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: FAST });
  const g1 = addFake('g1', { mode: 'capacity', partial: true, write: { 'src/p.txt': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NO_CAPACITY');
  assert.equal(r.reason, 'model-capacity');
  assert.equal(r.exitCode, 2);
  assert.equal(calls(g1), 3, 'one try plus two waits');
  assert.equal(statusEntries(dir).length, 0);
  assert.ok(!accounts.getAccount('g1').cooldownUntil);
  assert.deepEqual(leases(), []);
});

test('network every time: NETWORK, exit 2, no account change', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: FAST });
  addFake('g1', { mode: 'network' });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NETWORK');
  assert.equal(r.reason, 'network');
  assert.equal(r.exitCode, 2);
  assert.equal(accounts.getAccount('g1').status, 'ready');
});

test('during a wait only the project lease is held', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: { capacityWaitSeconds: [0.8, 0.8], networkWaitSeconds: [0.8, 0.8] } });
  addFake('g1', { mode: 'capacity', failTimes: 1, write: { 'src/a.txt': 'a' } });
  const seen = new Set();
  let running = true;
  const poll = (async () => { while (running) { seen.add(leases().map((l) => l.kind).sort().join('+')); await sleep(30); } })();
  const r = await dispatch({ root: dir, task: scoped(), config });
  running = false;
  await poll;
  assert.equal(r.status, 'OK');
  assert.ok(seen.has('project'), `a moment with only the project lease (saw ${[...seen].join(' | ')})`);
});

test('a signal during the wait ends the run INTERRUPTED (130) promptly and releases everything', { skip: process.platform === 'win32' && 'POSIX signals', timeout: 60000 }, async () => {
  const home = makeHome();
  const trace = join(home, 'trace.log');
  const { dir } = makeRepo({ defaults: { capacityWaitSeconds: [60, 60], networkWaitSeconds: [60, 60] } });
  addFake('g1', { mode: 'capacity', trace });
  const driver = resolve(import.meta.dirname, 'dispatch-driver.mjs');
  const child = spawn(process.execPath, [driver, dir, '--exit-code'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  const end = Date.now() + 20000;
  while (!(existsSync(trace) && /^end /m.test(readFileSync(trace, 'utf8')))) {
    if (Date.now() > end) throw new Error('worker never finished');
    await sleep(25);
  }
  await sleep(300); // now inside the 60 s wait
  const sent = Date.now();
  child.kill('SIGINT');
  assert.equal(await exited, 130);
  assert.ok(Date.now() - sent < 10000, 'did not sit out the wait');
  assert.equal(JSON.parse(out).status, 'INTERRUPTED');
  assert.deepEqual(leases(), []);
});

test('config: waits are one or two numbers of seconds', () => {
  assert.throws(() => makeRepo({ defaults: { capacityWaitSeconds: [1, 2, 3] } }), /capacityWaitSeconds/);
  assert.throws(() => makeRepo({ defaults: { networkWaitSeconds: [-1] } }), /networkWaitSeconds/);
  const ok = makeRepo();
  assert.deepEqual(loadConfig(ok.dir).defaults.networkWaitSeconds, [30, 120]);
});
