import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acceptRun, dispatch } from '../src/dispatch.mjs';
import { toplevel } from '../src/gitx.mjs';
import { FAIL, addFake, git, makeHome, makeRepo, setScenario, task } from './helpers.mjs';

test('OK run: accepts and stages only recorded paths, leaving unrelated untracked files alone', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-1\nallowed:\n  - src/\n  - README.md');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'new content\n', 'README.md': 'updated readme\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'notes.txt'), 'unrelated notes\n');

  const res = acceptRun({ root: dir, runId: run.runId, config });
  assert.equal(res.runId, run.runId);
  assert.deepEqual(res.staged, ['README.md', 'src/a.txt']);
  assert.deepEqual(res.leftAlone, ['notes.txt']);

  const cached = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
  assert.deepEqual(cached, ['README.md', 'src/a.txt']);

  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /\?\? notes\.txt/);
});

test('pre-existing staged change is refused, leaving index unchanged and unstaged modification unstaged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-2\nallowed:\n  - src/a.txt');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker output\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  // Pre-existing staged change made after the run to unrelated tracked file
  writeFileSync(join(dir, 'README.md'), 'manager staged change\n');
  git(dir, 'add', 'README.md');
  const before = git(dir, 'diff', '--cached', '--name-only');
  const cachedBefore = git(dir, 'diff', '--cached', '--', 'README.md');

  // Unrelated unstaged modification
  writeFileSync(join(dir, 'src', 'keep.txt'), 'manager unstaged change\n');

  assert.throws(
    () => acceptRun({ root: dir, runId: run.runId, config }),
    /unrelated paths are already staged.*README\.md/
  );

  assert.equal(git(dir, 'diff', '--cached', '--name-only'), before);
  const cachedAfter = git(dir, 'diff', '--cached', '--', 'README.md');
  assert.equal(cachedAfter, cachedBefore);

  const unstagedKeep = git(dir, 'diff', '--name-only', '--', 'src/keep.txt').trim();
  assert.equal(unstagedKeep, 'src/keep.txt');
  const cachedKeep = git(dir, 'diff', '--cached', '--name-only', '--', 'src/keep.txt').trim();
  assert.equal(cachedKeep, '');
});

test('deletion: a run that deletes a tracked file results in that deletion staged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-3\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', delete: ['src/keep.txt'], write: { 'src/new.txt': 'new file\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  const res = acceptRun({ root: dir, runId: run.runId, config });
  assert.deepEqual(res.staged, ['src/keep.txt', 'src/new.txt']);

  const cachedNames = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
  assert.deepEqual(cachedNames, ['src/keep.txt', 'src/new.txt']);

  const cachedStatus = git(dir, 'diff', '--cached', '--name-status');
  assert.match(cachedStatus, /D\t+src\/keep\.txt/);
  assert.match(cachedStatus, /A\t+src\/new\.txt/);
});

test('fails closed and stages nothing when run status is VERIFY_FAILED', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const failing = task('id: T-4\nallowed:\n  - src/');
  failing.meta.verify = [FAIL];
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'verify fail\n' } });
  const run = await dispatch({ root: dir, task: failing, config });
  assert.equal(run.status, 'VERIFY_FAILED');

  assert.throws(() => acceptRun({ root: dir, runId: run.runId, config }), /only OK runs/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('fails closed and stages nothing when an owned file was edited after the run', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-5\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker text\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'src', 'a.txt'), 'tampered text\n');

  assert.throws(() => acceptRun({ root: dir, runId: run.runId, config }), /ambiguous ownership/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('fails closed and stages nothing when HEAD moved after the run', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-6\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker text\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'other.txt'), 'unrelated\n');
  git(dir, 'add', 'other.txt');
  git(dir, 'commit', '-q', '-m', 'unrelated commit');

  assert.throws(() => acceptRun({ root: dir, runId: run.runId, config }), /HEAD moved/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('fails closed and stages nothing when run id is unknown', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  assert.throws(() => acceptRun({ root: dir, runId: 'no-such-run', config }), /no run to accept/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('accept without runId accepts the latest run', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-8\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'latest run\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  const res = acceptRun({ root: dir, config });
  assert.equal(res.runId, run.runId);
  assert.deepEqual(res.staged, ['src/a.txt']);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'src/a.txt');
});

test('accept refuses run where verify command wrote a file outside allowed', async () => {
  makeHome();
  const verifyCmd = [process.execPath, '-e', "require('fs').writeFileSync('dist.txt','x')"];
  const { dir, config } = makeRepo({ verify: [verifyCmd] });
  const t = task('id: T-9\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  assert.throws(
    () => acceptRun({ root: dir, runId: run.runId, config }),
    (err) => {
      assert.match(err.message, /paths outside the task scope or not checked as the worker's change/);
      assert.match(err.message, /dist\.txt/);
      return true;
    }
  );
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('accept refuses run record whose workerState contains a path missing from changed', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-10\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  const resultFile = join(run.runDir, 'result.json');
  const record = JSON.parse(readFileSync(resultFile, 'utf8'));
  record.changed = ['src/a.txt'];
  writeFileSync(resultFile, JSON.stringify(record, null, 2));

  assert.throws(
    () => acceptRun({ root: dir, runId: run.runId, config }),
    (err) => {
      assert.match(err.message, /paths outside the task scope or not checked as the worker's change/);
      assert.match(err.message, /src\/b\.txt/);
      return true;
    }
  );
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('staging uses one call: accept of a run with 150 new files stages all 150', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const write = {};
  for (let i = 0; i < 150; i++) {
    write[`src/f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
  }
  const t = task('id: T-11\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  const res = acceptRun({ root: dir, runId: run.runId, config });
  assert.equal(res.staged.length, 150);
  const cached = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  assert.equal(cached.length, 150);
});

test('accept refuses when unrelated tracked file is already staged and leaves index unchanged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-12\nallowed:\n  - src/a.txt');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker text\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'README.md'), 'user edit to readme\n');
  git(dir, 'add', 'README.md');
  const before = git(dir, 'diff', '--cached', '--name-only');
  const beforeReadme = git(dir, 'diff', '--cached', '--', 'README.md');

  assert.throws(
    () => acceptRun({ root: dir, runId: run.runId, config }),
    /unrelated paths are already staged.*README\.md/
  );

  assert.equal(git(dir, 'diff', '--cached', '--name-only'), before);
  assert.equal(git(dir, 'diff', '--cached', '--', 'README.md'), beforeReadme);
});

test('CLI smoke: node bin/zc.mjs accept <runId> in temp repo exits 0 and prints staged', async () => {
  const home = makeHome();
  const { dir, config } = makeRepo();
  const root = toplevel(dir);
  const t = task('id: T-7\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'smoke test\n' } });
  const run = await dispatch({ root, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'extra.txt'), 'extra\n');

  const binZc = resolve(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const r = spawnSync(process.execPath, [binZc, 'accept', run.runId], {
    cwd: root,
    env: { ...process.env, ZC_HOME: home },
    encoding: 'utf8'
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /zc: staged 1 file\(s\) from run/);
  assert.match(r.stdout, /src\/a\.txt/);
  assert.match(r.stdout, /left alone \(not this run's\): extra\.txt/);

  const cached = git(dir, 'diff', '--cached', '--name-only').trim();
  assert.equal(cached, 'src/a.txt');
});

test('CLI smoke: accept refuses when an unrelated file was already staged and leaves index unchanged', async () => {
  const home = makeHome();
  const { dir, config } = makeRepo();
  const root = toplevel(dir);
  const t = task('id: T-13\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'smoke test\n' } });
  const run = await dispatch({ root, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'extra.txt'), 'extra staged\n');
  git(dir, 'add', 'extra.txt');
  const before = git(dir, 'diff', '--cached', '--name-only');

  const binZc = resolve(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const r = spawnSync(process.execPath, [binZc, 'accept', run.runId], {
    cwd: root,
    env: { ...process.env, ZC_HOME: home },
    encoding: 'utf8'
  });
  assert.notEqual(r.status, 0);
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  assert.match(output, /extra\.txt/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), before);
});

test('unrelated unstaged modification and untracked file still let accept succeed and stay untouched', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-14\nallowed:\n  - src/a.txt');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker output\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'src', 'keep.txt'), 'unstaged change\n');
  writeFileSync(join(dir, 'notes.txt'), 'untracked file\n');

  const res = acceptRun({ root: dir, runId: run.runId, config });
  assert.equal(res.runId, run.runId);
  assert.deepEqual(res.staged, ['src/a.txt']);
  assert.deepEqual(res.leftAlone, ['notes.txt', 'src/keep.txt']);

  const cached = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
  assert.deepEqual(cached, ['src/a.txt']);

  const unstagedKeep = git(dir, 'diff', '--name-only', '--', 'src/keep.txt').trim();
  assert.equal(unstagedKeep, 'src/keep.txt');
  const cachedKeep = git(dir, 'diff', '--cached', '--name-only', '--', 'src/keep.txt').trim();
  assert.equal(cachedKeep, '');

  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /\?\? notes\.txt/);
});

test('accept stages inherited files of an OK repair together with its own', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'v1' } });
  const failing = task('id: T-first\nallowed:\n  - src/', 'First attempt.');
  failing.meta.verify = [FAIL];
  const first = await dispatch({ root: dir, task: failing, config });
  assert.equal(first.status, 'VERIFY_FAILED');

  setScenario(g1, { mode: 'ok', write: { 'test/b.txt': 't' } });
  const repairTask = task('id: T-repair\nallowed:\n  - test/', 'Fix tests.');
  const repair = await dispatch({ root: dir, task: repairTask, config, repairOf: first.runId });
  assert.equal(repair.status, 'OK');

  const res = acceptRun({ root: dir, runId: repair.runId, config });
  assert.deepEqual(res.staged, ['src/a.txt', 'test/b.txt']);

  const cached = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
  assert.deepEqual(cached, ['src/a.txt', 'test/b.txt']);
});

test('accept refuses an inherited path that the current config forbids', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'v1' } });
  const failing = task('id: T-first\nallowed:\n  - src/', 'First attempt.');
  failing.meta.verify = [FAIL];
  const first = await dispatch({ root: dir, task: failing, config });
  assert.equal(first.status, 'VERIFY_FAILED');

  setScenario(g1, { mode: 'ok', write: { 'test/b.txt': 't' } });
  const repairTask = task('id: T-repair\nallowed:\n  - test/', 'Fix tests.');
  const repair = await dispatch({ root: dir, task: repairTask, config, repairOf: first.runId });
  assert.equal(repair.status, 'OK');

  assert.throws(
    () => acceptRun({ root: dir, runId: repair.runId, config: { ...config, forbidden: ['src/a.txt'] } }),
    /src\/a\.txt/
  );
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});
