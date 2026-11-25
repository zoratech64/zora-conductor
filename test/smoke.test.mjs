import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatSmoke, smokeAll } from '../src/smoke.mjs';
import { addFake, makeHome, mkTmp } from './helpers.mjs';

const bin = join(import.meta.dirname, '..', 'bin', 'zc.mjs');
const zc = (...args) => spawnSync(process.execPath, [bin, ...args], { env: process.env, encoding: 'utf8', cwd: mkTmp('cwd-') });

test('smoke: all workers respond, exit 0, summary counts', () => {
  makeHome();
  addFake('a1', {});
  addFake('a2', {});
  const r = zc('smoke');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK\s+a1/);
  assert.match(r.stdout, /OK\s+a2/);
  assert.match(r.stdout, /smoke: total 2, passed 2, failed 0/);
});

test('smoke: a signed-out worker fails, the rest still run, exit 1', () => {
  makeHome();
  addFake('a1', { signedOut: true });
  addFake('a2', {});
  const r = zc('smoke');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL a1 .* not signed in/);
  assert.match(r.stdout, /OK\s+a2/);
  assert.match(r.stdout, /total 2, passed 1, failed 1/);
});

test('smoke: a hung worker times out without blocking the others', () => {
  makeHome();
  addFake('a1', { usageHoldMs: 30_000 });
  addFake('a2', {});
  const r = zc('smoke', '--timeout', '1');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL a1 .* timed out after 1s/);
  assert.match(r.stdout, /OK\s+a2/);
});

test('smoke: a busy worker fails and is reported, not skipped', async () => {
  const report = await smokeAll({
    accounts: [{ id: 'busy' }, { id: 'fine' }],
    timeoutMs: 1000,
    lease: async (account, _label, work) => { if (account.id === 'busy') throw new Error('account busy is in use'); return work(); },
    check: async () => ({ ok: true, limits: [{}] })
  });
  assert.deepEqual([report.total, report.passed, report.failed], [2, 1, 1]);
  assert.match(report.results[0].error, /in use/);
});

test('smoke: --json prints the report; no workers is a failure', () => {
  makeHome();
  const none = zc('smoke');
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no workers registered/);
  addFake('a1', {});
  const r = zc('smoke', '--json');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).passed, 1);
});

test('smoke: bad --timeout is refused', () => {
  makeHome();
  assert.equal(zc('smoke', '--timeout', '0').status, 3);
});

test('smoke: formatSmoke lists failures with reason', () => {
  const out = formatSmoke({ total: 1, passed: 0, failed: 1, results: [{ id: 'x', ok: false, ms: 5, error: 'boom' }] });
  assert.match(out, /FAIL x \(5ms\) - boom/);
});
