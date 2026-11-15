import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acceptRun, dispatch } from '../src/dispatch.mjs';
import { FAIL, addFake, git, makeHome, makeRepo, task } from './helpers.mjs';

test('OK run: accepts and stages only recorded paths, leaving unrelated untracked files alone', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-1\nallowed:\n  - src/\n  - README.md');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'new content\n', 'README.md': 'updated readme\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'notes.txt'), 'unrelated notes\n');

  const res = acceptRun({ root: dir, runId: run.runId });
  assert.equal(res.runId, run.runId);
  assert.deepEqual(res.staged, ['README.md', 'src/a.txt']);
  assert.deepEqual(res.leftAlone, ['notes.txt']);

  const cached = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
  assert.deepEqual(cached, ['README.md', 'src/a.txt']);

  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /\?\? notes\.txt/);
});

test('pre-existing staged change stays staged with same content and unstaged modification stays unstaged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-2\nallowed:\n  - src/a.txt');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker output\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  // Pre-existing staged change made after the run to unrelated tracked file
  writeFileSync(join(dir, 'README.md'), 'manager staged change\n');
  git(dir, 'add', 'README.md');
  const cachedBefore = git(dir, 'diff', '--cached', '--', 'README.md');

  // Unrelated unstaged modification
  writeFileSync(join(dir, 'src', 'keep.txt'), 'manager unstaged change\n');

  const res = acceptRun({ root: dir, runId: run.runId });
  assert.deepEqual(res.staged, ['src/a.txt']);
  assert.deepEqual(res.leftAlone, ['README.md', 'src/keep.txt']);

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

  const res = acceptRun({ root: dir, runId: run.runId });
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

  assert.throws(() => acceptRun({ root: dir, runId: run.runId }), /only OK runs/);
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

  assert.throws(() => acceptRun({ root: dir, runId: run.runId }), /ambiguous ownership/);
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

  assert.throws(() => acceptRun({ root: dir, runId: run.runId }), /HEAD moved/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('fails closed and stages nothing when run id is unknown', async () => {
  makeHome();
  const { dir } = makeRepo();
  assert.throws(() => acceptRun({ root: dir, runId: 'no-such-run' }), /no run to accept/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('accept without runId accepts the latest run', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-8\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'latest run\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  const res = acceptRun({ root: dir });
  assert.equal(res.runId, run.runId);
  assert.deepEqual(res.staged, ['src/a.txt']);
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'src/a.txt');
});

test('CLI smoke: node bin/zc.mjs accept <runId> in temp repo exits 0 and prints staged', async () => {
  const home = makeHome();
  const { dir, config } = makeRepo();
  const t = task('id: T-7\nallowed:\n  - src/');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'smoke test\n' } });
  const run = await dispatch({ root: dir, task: t, config });
  assert.equal(run.status, 'OK');

  writeFileSync(join(dir, 'extra.txt'), 'extra\n');

  const binZc = resolve(import.meta.dirname, '..', 'bin', 'zc.mjs');
  const r = spawnSync(process.execPath, [binZc, 'accept', run.runId], {
    cwd: dir,
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
