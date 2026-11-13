import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as accounts from '../src/accounts.mjs';
import { dispatch, rejectRun } from '../src/dispatch.mjs';
import { statusEntries } from '../src/gitx.mjs';
import { FAIL, addFake, fakeEcc, calls, git, lastPrompt, makeHome, makeRepo, setScenario, task } from './helpers.mjs';

const scoped = (extra = '') => task(`id: T-1\nallowed:\n  - src/\n${extra}`);
const clean = (dir) => statusEntries(dir).length === 0;

test('success: worker edits are left in the tree, verified, scoped', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'hi' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.changed, ['src/a.txt']);
  assert.equal(r.verify.length, 1);
  assert.ok(r.verify[0].ok);
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'hi');
});

test('quota on one account: partial work saved and rolled back, next account finishes', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'quota', partial: true, write: { 'src/partial.txt': 'half' } });
  const g2 = addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.attempts.map((a) => [a.account, a.kind ?? 'ok']), [['g1', 'quota'], ['g2', 'ok']]);
  assert.deepEqual(r.changed, ['src/b.txt']); // g1's half-done file did not leak into g2's result
  assert.ok(r.attempts[0].metrics?.promptBytes > 0);
  assert.ok(existsSync(join(r.runDir, 'partial-1', 'untracked', 'src', 'partial.txt')));
  const held = accounts.getAccount('g1');
  assert.ok(held.cooldownUntil > Date.now() + 20 * 60_000, 'cooldown honours the 30 minute hint');
  assert.equal(accounts.currentId(), 'g2');
  assert.equal(calls(g1), 1);
  assert.equal(calls(g2), 1);
});

test('stays on the same account until it is exhausted (sticky)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': '1' } });
  addFake('g2', { mode: 'ok', write: { 'src/a.txt': '1' } });
  await dispatch({ root: dir, task: scoped(), config });
  rejectRun({ root: dir });
  const second = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(second.account, 'g1');
  assert.equal(calls(g1), 2);
});

test('all accounts cooling: exit 2 with a retry time, tree untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'quota' });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NO_CAPACITY');
  assert.equal(r.exitCode, 2);
  assert.ok(Date.parse(r.retryAfter) > Date.now());
  assert.ok(clean(dir));
});

test('no accounts configured: needs a human', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.exitCode, 3);
  assert.match(r.nextAction, /zc account add/);
});

test('scope violation: out-of-scope and forbidden files are rejected and rolled back', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok', 'other/x.txt': 'nope', '.env': 'SECRET=1' } });
  const r = await dispatch({ root: dir, task: task('id: T-2\nallowed:\n  - src/\n  - .env'), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.deepEqual(r.outOfScope, ['other/x.txt']);
  assert.deepEqual(r.forbidden, ['.env']); // forbidden even though the task listed it
  assert.ok(r.rolledBack);
  assert.ok(clean(dir));
  assert.ok(existsSync(join(r.runDir, 'rejected', 'tracked.patch')));
});

test('verify failure keeps the work; dirty tree needs --repair; repair sees prior work', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'v1' } });
  const failing = task('id: T-3\nallowed:\n  - src/', 'Make it work.');
  failing.meta.verify = [FAIL];
  const first = await dispatch({ root: dir, task: failing, config });
  assert.equal(first.status, 'VERIFY_FAILED');
  assert.match(first.verify[0].tail, /boom/);
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'v1');

  const blocked = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(blocked.status, 'NEEDS_HUMAN');
  assert.match(blocked.nextAction, /--repair/);

  setScenario(g1, { mode: 'ok', write: { 'src/a.txt': 'v2' } });
  const fixed = await dispatch({ root: dir, task: scoped(), config, repairOf: first.runId });
  assert.equal(fixed.status, 'OK');
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'v2');
  assert.match(lastPrompt(g1), /earlier, uncommitted work/);
});

test('repair refuses when the tree no longer matches the run', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'v1' } });
  const first = await dispatch({ root: dir, task: scoped(), config });
  writeFileSync(join(dir, 'src/manager-edit.txt'), 'x');
  const r = await dispatch({ root: dir, task: scoped(), config, repairOf: first.runId });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /no longer matches/);
});

test('location refusal stops everything: no account rotation', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'location', partial: true, write: { 'src/p.txt': 'x' } });
  const g2 = addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.equal(r.exitCode, 3);
  assert.equal(calls(g2), 0);
  assert.ok(clean(dir));
});

test('auth failure marks the account needs-login and moves on', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'auth' });
  addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(accounts.getAccount('g1').status, 'needs-login');
});

test('license refusal blocks that account permanently and moves on', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'license' });
  addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(accounts.getAccount('g1').status, 'blocked');
});

test('transient server error gets one unchanged rerun on the same account', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'server', failTimes: 1, write: { 'src/a.txt': 'a' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.attempts.map((a) => a.account), ['g1', 'g1']);
  assert.equal(calls(g1), 2);
});

test('timeout kills the worker, saves and rolls back partial work, does not rotate', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'slow', partial: true, write: { 'src/p.txt': 'x' } });
  const g2 = addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const t = task('id: T-4\nallowed:\n  - src/\nminutes: 0.02'); // ~1 second
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'TIMEOUT');
  assert.equal(r.exitCode, 1);
  assert.equal(calls(g2), 0);
  assert.ok(clean(dir));
});

test('a worker that moves HEAD is stopped and nothing is rolled back', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', commit: true, write: { 'src/a.txt': 'a' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /moved HEAD/);
});

test('permission denial is reported, not retried', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'permission' });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'DENIED');
  assert.equal(calls(g1), 1);
});

test('a task with no allowed paths fails closed', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok' });
  const r = await dispatch({ root: dir, task: task('id: T-5'), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /allowed/);
});

test('dirty tree without --repair is refused', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok' });
  writeFileSync(join(dir, 'src/mine.txt'), 'my own work');
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.deepEqual(r.changed, ['src/mine.txt']);
});

test('reject restores HEAD but will not discard edits the worker did not make', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  await dispatch({ root: dir, task: scoped(), config });
  writeFileSync(join(dir, 'src/mine.txt'), 'mine');
  assert.throws(() => rejectRun({ root: dir }), /not exactly run/);
  assert.ok(existsSync(join(dir, 'src/mine.txt')));
  rejectRun({ root: dir, force: true });
  assert.ok(clean(dir));
});

test('onLimit=continue hands partial work to the next account instead of resetting', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: { onLimit: 'continue' } });
  addFake('g1', { mode: 'quota', partial: true, write: { 'src/partial.txt': 'half' } });
  const g2 = addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.changed, ['src/b.txt', 'src/partial.txt']);
  assert.match(lastPrompt(g2), /previous worker was interrupted/);
});

test('dry run builds the prompt (with ECC rules) without touching anything', async () => {
  makeHome();
  const ecc = fakeEcc();
  const { dir, config } = makeRepo({ ecc: { path: ecc, rulePacks: ['common'] } });
  const r = await dispatch({ root: dir, task: scoped(), config, dryRun: true });
  assert.equal(r.status, 'DRY_RUN');
  assert.match(r.prompt, /ALWAYS-USE-SMALL-FILES/);
  assert.match(r.prompt, /Allowed paths/);
  assert.ok(clean(dir));
});

test('a rollback never touches the manager\'s own tracked .zc/ notes', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  mkdirSync(join(dir, '.zc'), { recursive: true });
  writeFileSync(join(dir, '.zc', 'progress.md'), 'line 1\n');
  git(dir, 'add', '-f', '.zc/progress.md');
  git(dir, 'commit', '-q', '-m', 'track progress');
  writeFileSync(join(dir, '.zc', 'progress.md'), 'line 1\nline 2 (uncommitted)\n');
  addFake('g1', { mode: 'quota', partial: true, write: { 'src/partial.txt': 'half' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NO_CAPACITY');
  assert.equal(readFileSync(join(dir, '.zc', 'progress.md'), 'utf8'), 'line 1\nline 2 (uncommitted)\n');
  assert.ok(!existsSync(join(dir, 'src/partial.txt')), 'the worker\'s partial file was still rolled back');
});

test('a worker that edits files but writes no report still succeeds', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', response: '', write: { 'src/a.txt': 'a' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.match(r.workerSummary, /no report/);
  assert.equal(r.attempts.length, 1);
});

test('rollback restores tracked files the worker deleted', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'quota', partial: true, delete: ['src/keep.txt'], write: { 'src/new.txt': 'n' } });
  await dispatch({ root: dir, task: scoped(), config });
  assert.equal(readFileSync(join(dir, 'src/keep.txt'), 'utf8'), 'keep\n');
  assert.ok(!existsSync(join(dir, 'src/new.txt')));
  assert.ok(clean(dir));
});

test('git state is left sane after a rollback (no stray index entries)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'quota', partial: true, write: { 'src/new.txt': 'n', 'src/keep.txt': 'changed' } });
  await dispatch({ root: dir, task: scoped(), config });
  assert.equal(git(dir, 'status', '--porcelain').replace(/\?\? \.zc\/\n?/, '').trim(), '');
  assert.equal(readFileSync(join(dir, 'src/keep.txt'), 'utf8'), 'keep\n');
});

test('isolated launch: a full dispatch works through the private D-Bus session', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  makeHome({ isolation: 'auto' });
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/iso.txt': 'iso' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  if (r.status !== 'OK' && /dbus-run-session/.test(JSON.stringify(r))) return t.skip('dbus-run-session not available');
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.changed, ['src/iso.txt']);
});

test('ECC rules: with no ecc.path the bundled rules are used', async () => {
  makeHome();
  delete process.env.ZC_ECC_PATH;
  const { dir, config } = makeRepo({ ecc: { path: '', rulePacks: ['common', 'dart'] } });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config, dryRun: true });
  const prompt = r.prompt;
  assert.match(prompt, /Project standards \(ECC\)/);
  assert.match(prompt, /### common\//);
  assert.match(prompt, /### dart\/testing\.md/);
  assert.doesNotMatch(prompt, /truncated at/);
  assert.doesNotMatch(prompt, /### common\/hooks\.md/);
});

test('a worker whose command was refused (empty "success") is retried once with a no-commands note, then works', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'denied-empty', failTimes: 1, write: { 'src/a.txt': 'ok' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(calls(g1), 2);
  assert.match(lastPrompt(g1), /tried to run a shell command/);
  assert.equal(r.attempts[0].kind, 'permission');
});

test('a worker that keeps trying commands ends as DENIED with the refused command listed', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'denied-empty' });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'DENIED');
  assert.deepEqual(r.denied, ['run_command: ls -la']);
  assert.match(r.nextAction, /ls -la/);
  assert.ok(clean(dir));
});

test('metrics: records attempt metrics and verification duration', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'hi' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  const m = r.attempts[0].metrics;
  assert.equal(m.turns, 2);
  assert.deepEqual(m.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(m.tools.total, 1);
  assert.equal(m.fileOps.write, 1);
  assert.equal(m.fileOps.read, 0);
  const promptStat = statSync(join(r.runDir, 'attempt-1.prompt.txt'));
  assert.equal(m.promptBytes, promptStat.size);
  assert.equal(typeof r.attempts[0].durationMs, 'number');
  assert.ok(r.verify.length > 0);
  for (let i = 0; i < r.verify.length; i++) {
    assert.ok(Number.isInteger(r.verify[i].durationMs) && r.verify[i].durationMs >= 0);
  }
  assert.equal(typeof r.verifyDurationMs, 'number');

  const persisted = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8'));
  assert.deepEqual(persisted.attempts[0].metrics, m);
});
