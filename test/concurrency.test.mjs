import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import './helpers.mjs';
import { openRegistry } from '../src/registry.mjs';

const WORKER = resolve(import.meta.dirname, 'registry-worker.mjs');
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolveRun(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

test('8 processes x 200 acquire/release cycles never hold a key twice', { timeout: 300000 }, async () => {
  const base = tmp('zc-conc-');
  const dir = join(base, 'registry');
  openRegistry({ dir }).close(); // create once so workers only open
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    run([WORKER, dir, join(base, 'held'), '200', '3', String(i)])));
  assert.deepEqual(results.map((r) => r.done), Array(8).fill(200));
  assert.deepEqual(results.map((r) => r.duplicates), Array(8).fill(0));
  const reg = openRegistry({ dir });
  assert.equal(reg.listLeases().length, 0, 'every lease released');
  reg.close();
});

test('a holder killed with SIGKILL inside a transaction never blocks the registry', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const base = tmp('zc-kill-');
  const dir = join(base, 'registry');
  openRegistry({ dir }).close();
  const code = `
    import { openRegistry } from ${JSON.stringify(new URL('../src/registry.mjs', import.meta.url).href)};
    const reg = openRegistry({ dir: ${JSON.stringify(dir)} });
    reg.db.exec('BEGIN IMMEDIATE');
    console.log('locked');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const reg = openRegistry({ dir });
  const t0 = Date.now();
  assert.equal(reg.acquireLease({ key: 'k', kind: 'account', runId: 'r', projectKey: 'p', stateRoot: '/s', zcVersion: 'x', ownerPid: 1, ownerStart: 1, ownerBoot: 'b' }).acquired, true);
  assert.ok(Date.now() - t0 < 4000);
  reg.close();
});

test('8 processes opening a brand-new registry at the same moment all succeed', { timeout: 120000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const base = tmp('zc-fresh-');
    const dir = join(base, 'registry');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      run([WORKER, dir, join(base, 'held'), '5', '3', String(i)])));
    assert.deepEqual(results.map((r) => r.done), Array(8).fill(5));
    assert.deepEqual(results.map((r) => r.duplicates), Array(8).fill(0));
  }
});

const MUTATOR = resolve(import.meta.dirname, 'accounts-mutator.mjs');

async function mutateInParallel(root, registry, mode) {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((done, fail) => {
    const env = { ...process.env, ZC_HOME: root, ZC_TESTING: '1', ZC_TEST_REGISTRY_DIR: registry };
    const child = spawn(process.execPath, [MUTATOR, String(i), '40', mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`mutator ${i} exit ${code}: ${err}`))));
  })));
  return results.length;
}

for (const mode of ['legacy', 'active']) {
  test(`test 2 (${mode} store): 6 processes x 40 account mutations lose no update`, { timeout: 300000 }, async () => {
    const root = tmp('zc-acc-');
    const registry = join(tmp('zc-accreg-'), 'registry');
    if (mode === 'active') {
      const { activate } = await import('../src/migrate.mjs');
      process.env.ZC_HOME = root;
      process.env.ZC_TESTING = '1';
      process.env.ZC_TEST_REGISTRY_DIR = registry;
      activate({ root, apply: true, scan: () => ({ verdict: 'none', pids: [] }) });
    }
    await mutateInParallel(root, registry, mode);
    process.env.ZC_HOME = root;
    process.env.ZC_TESTING = '1';
    process.env.ZC_TEST_REGISTRY_DIR = registry;
    const accountsApi = await import('../src/accounts.mjs');
    const list = accountsApi.listAccounts();
    assert.equal(list.length, 240, 'every added account is present');
    for (let p = 0; p < 6; p++) {
      assert.equal(list.filter((a) => a.id.startsWith(`p${p}-`)).length, 40);
      assert.equal(accountsApi.getAccount(`p${p}-0`).lastUsedAt, 40 - 1 + 1000, 'last update of the shared counter field is kept');
    }
  });
}

const DRIVER = resolve(import.meta.dirname, 'dispatch-driver.mjs');

function drive(root, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [DRIVER, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`driver exit ${code}: ${err}`))));
  });
}

async function dispatchWorld({ projects, accountIds, holdMs, maxLiveProjects }) {
  const helpers = await import('./helpers.mjs');
  const home = helpers.makeHome();
  const trace = join(home, 'trace.log');
  for (const id of accountIds) helpers.addFake(id, { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs, trace });
  const repos = Array.from({ length: projects }, () => helpers.makeRepo({ defaults: { maxLiveProjects } }).dir);
  const env = { ...process.env };
  const results = await Promise.all(repos.map((root) => drive(root, env)));
  const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '));
  return { repos, results, events, helpers };
}

function overlaps(events) {
  const byDir = new Map();
  let live = 0;
  let max = 0;
  let sameAccountOverlap = false;
  for (const [kind, dir, at] of events.sort((a, b) => Number(a[2]) - Number(b[2]) || (a[0] === 'end' ? -1 : 1))) {
    const open = byDir.get(dir) ?? 0;
    if (kind === 'start') { byDir.set(dir, open + 1); live++; if (open + 1 > 1) sameAccountOverlap = true; } else { byDir.set(dir, open - 1); live--; }
    max = Math.max(max, live);
    void at;
  }
  return { max, sameAccountOverlap };
}

test('test 8: 8 dispatches over 3 accounts run at most 3 at a time and never share an account', { timeout: 300000 }, async () => {
  const world = await dispatchWorld({ projects: 8, accountIds: ['g1', 'g2', 'g3'], holdMs: 2000, maxLiveProjects: 8 });
  assert.equal(world.results.length, 8);
  for (const r of world.results) assert.notEqual(r.status, 'NEEDS_HUMAN', JSON.stringify(r));
  assert.equal(world.events.filter((e) => e[0] === 'start').length, 8, 'every dispatch ran a worker exactly once');
  const { max, sameAccountOverlap } = overlaps(world.events);
  assert.ok(max <= 3, `at most 3 workers at once, saw ${max}`);
  assert.ok(max >= 2, 'workers did overlap, so the test exercised contention');
  assert.equal(sameAccountOverlap, false, 'no account ever ran two workers at once');
});

test('test 9: two projects at once get different accounts and independent git indexes', { timeout: 300000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const helpers = await import('./helpers.mjs');
  const index = (dir) => spawnSync('git', ['ls-files', '-s'], { cwd: dir, encoding: 'utf8' }).stdout;
  const world = await (async () => {
    const home = helpers.makeHome();
    const trace = join(home, 'trace.log');
    for (const id of ['g1', 'g2']) helpers.addFake(id, { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs: 600, trace });
    const repos = [helpers.makeRepo().dir, helpers.makeRepo().dir];
    const before = repos.map(index);
    const results = await Promise.all(repos.map((root) => drive(root, { ...process.env })));
    return { repos, before, results, trace };
  })();
  assert.notEqual(world.results[0].account, world.results[1].account);
  assert.deepEqual(world.results.map((r) => r.busy), [0, 0], 'neither had to wait: two accounts, two projects');
  assert.deepEqual(world.repos.map(index), world.before, 'indexes untouched by the other project');
});

// ---- section 7 tests that live here beyond tests 1, 2, 8 and 9 ----

test('test 3: 8 processes racing for a proven-stale project lease give exactly one winner, 30 rounds', { skip: process.platform !== 'linux' && 'needs /proc', timeout: 300000 }, async () => {
  const helpers = await import('./helpers.mjs');
  const { projectKey } = await import('../src/paths.mjs');
  const LEASE_WORKER = resolve(import.meta.dirname, 'lease-race-worker.mjs');
  helpers.makeHome();
  const { dir } = helpers.makeRepo();
  for (let round = 0; round < 30; round++) {
    const reg = openRegistry();
    reg.acquireLease({ key: `project:${projectKey(dir)}`, kind: 'project', runId: `dead-${round}`, projectKey: projectKey(dir), ownerPid: 999999999, ownerStart: 1, ownerBoot: 'old-boot' });
    reg.close();
    const children = Array.from({ length: 8 }, (_, i) => {
      const child = spawn(process.execPath, [LEASE_WORKER, dir, `r${round}-${i}`], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
      const said = new Promise((done) => { child.stdout.once('data', (d) => done(String(d).trim())); });
      const exited = new Promise((done) => child.on('exit', done));
      return { child, said, exited };
    });
    const verdicts = await Promise.all(children.map((c) => c.said));
    for (const c of children) c.child.stdin.end();
    await Promise.all(children.map((c) => c.exited));
    assert.equal(verdicts.filter((v) => v === 'won').length, 1, `round ${round}: ${verdicts.join(',')}`);
  }
});

test('test 4: a dispatcher killed with SIGKILL keeps its leases while the worker lives, they are reaped after it exits, and zc recover then works', { skip: process.platform === 'win32' && 'POSIX signals', timeout: 120000 }, async () => {
  const helpers = await import('./helpers.mjs');
  const { reserve } = await import('../src/reserve.mjs');
  const { recoverRun } = await import('../src/recover.mjs');
  const { listRuns } = await import('../src/dispatch.mjs');
  const { runsDir } = await import('../src/paths.mjs');
  const { existsSync, readdirSync } = await import('node:fs');
  const home = helpers.makeHome();
  const trace = join(home, 'trace.log');
  const { dir } = helpers.makeRepo();
  const g1 = helpers.addFake('g1', { mode: 'slow', partial: true, write: { 'src/part.txt': 'half' }, trace });
  const driver = resolve(import.meta.dirname, 'dispatch-driver.mjs');
  const child = spawn(process.execPath, [driver, dir], { env: process.env, stdio: 'ignore' });
  const exited = new Promise((done) => child.on('exit', done));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (check, what) => { const end = Date.now() + 20000; for (;;) { const v = check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(25); } };
  const record = () => { const names = existsSync(runsDir(dir)) ? readdirSync(runsDir(dir)) : []; return names.length ? listRuns(dir, 1)[0] : null; };
  const live = await waitFor(() => { const r = record(); return r?.worker?.pgid && existsSync(trace) && /^ready /m.test(readFileSync(trace, 'utf8')) ? r : null; }, 'the worker to be ready');
  child.kill('SIGKILL');
  await exited;
  const deps = { platform: 'linux', isolation: 'dbus' };
  const kept = reserve({ root: dir, runId: 'next', deps });
  assert.equal(kept.ok, false, 'the worker is alive: the account is not given away');
  assert.equal(openRegistry().listLeases().length, 2, 'account and project lease still held');
  process.kill(-live.worker.pgid, 'SIGKILL');
  await waitFor(() => record().status === 'INTERRUPTED', 'INTERRUPTED once the worker is gone');
  const proof = recoverRun({ root: dir, runId: live.runId, deps });
  assert.equal(proof.proof.verdict, 'stale');
  const done = recoverRun({ root: dir, runId: live.runId, yes: true, deps });
  assert.equal(done.recovered, true);
  assert.equal(existsSync(join(dir, 'src', 'part.txt')), true, 'the tree was preserved');
  assert.deepEqual(openRegistry().listLeases(), []);
  void g1;
});

test('test 5: a worker that crashes mid-write is handed on with its partial work and the final gates pass', async () => {
  const helpers = await import('./helpers.mjs');
  const { dispatch } = await import('../src/dispatch.mjs');
  helpers.makeHome();
  const { dir, config } = helpers.makeRepo({ defaults: { onLimit: 'handoff' } });
  helpers.addFake('g1', { mode: 'crash', partial: true, write: { 'src/a.txt': 'A' } });
  helpers.addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'B' } });
  const r = await dispatch({ root: dir, task: helpers.task('id: T-5\nallowed:\n  - src/'), config });
  assert.equal(r.status, 'OK', r.nextAction);
  assert.deepEqual(r.attempts.map((a) => a.account), ['g1', 'g1', 'g2'], 'one rerun on the crashed account, then the next');
  assert.deepEqual(r.changed.sort(), ['src/a.txt', 'src/b.txt']);
  assert.ok(r.attempts.some((a) => a.handoff === 1));
});

test('B4: two ZC_HOME roots that point at the same profile directory still cannot both lease it', async () => {
  const helpers = await import('./helpers.mjs');
  const accounts = await import('../src/accounts.mjs');
  const { reserve } = await import('../src/reserve.mjs');
  const { mkdtempSync: mk } = await import('node:fs');
  helpers.makeHome();
  const a = helpers.addFake('g1', { mode: 'ok' });
  const { dir: rootA } = helpers.makeRepo();
  const first = reserve({ root: rootA, runId: 'a' });
  assert.equal(first.ok, true);
  process.env.ZC_HOME = mk(join(tmpdir(), 'zc-home-'));
  accounts.addAccount('gx', { dir: a.profileDir, identity: { label: 'label-gx', attestedAt: new Date().toISOString(), method: 'manual' } });
  accounts.updateAccount('gx', { status: 'ready' });
  const { dir: rootB } = helpers.makeRepo();
  const second = reserve({ root: rootB, runId: 'b' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'all-reserved');
});
