import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
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
