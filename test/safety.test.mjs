import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch, rejectRun } from '../src/dispatch.mjs';
import { acquireLock } from '../src/fsx.mjs';
import { dirtyState, rollbackPaths, statusEntries } from '../src/gitx.mjs';
import { parseMinutes } from '../src/limits.mjs';
import { lockFile } from '../src/paths.mjs';
import { restoreZc, snapshotZc } from '../src/snapshot.mjs';
import { parseTask } from '../src/task.mjs';
import { FAIL, addFake, git, makeHome, makeRepo, task } from './helpers.mjs';

const scoped = (extra = '') => task(`id: T-1\nallowed:\n  - src/\n${extra}`);

test('worker edits under .zc/ are caught, undone, and saved as evidence', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const original = readFileSync(join(dir, '.zc/config.json'), 'utf8');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', '.zc/config.json': '{"hacked":true}', '.zc/tasks/new.md': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(r.forbidden.includes('.zc/config.json'));
  assert.ok(r.forbidden.includes('.zc/tasks/new.md'));
  assert.equal(readFileSync(join(dir, '.zc/config.json'), 'utf8'), original);
  assert.ok(!existsSync(join(dir, '.zc/tasks/new.md')));
  assert.ok(existsSync(join(r.runDir, 'zc-violations-1', '.zc', 'config.json')));
});

test('a worker that only touches .zc/ is a scope violation, not NO_CHANGES', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { '.zc/notes.md': 'sneaky' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(!existsSync(join(dir, '.zc/notes.md')));
});

test("rolling back a failed attempt never deletes the manager's .zc/ files", async () => {
  makeHome();
  const { dir, config } = makeRepo();
  mkdirSync(join(dir, '.zc/tasks'), { recursive: true });
  writeFileSync(join(dir, '.zc/tasks/T-9.md'), 'manager task');
  addFake('g1', { mode: 'quota', partial: true, write: { 'src/p.txt': 'half' } });
  addFake('g2', { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(readFileSync(join(dir, '.zc/tasks/T-9.md'), 'utf8'), 'manager task');
});

test('snapshotZc/restoreZc put back modified, deleted and added files', () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, '.zc/a.md'), 'A');
  writeFileSync(join(dir, '.zc/b.md'), 'B');
  const snap = snapshotZc(dir, join(dir, '.zc-copy-outside'));
  writeFileSync(join(dir, '.zc/a.md'), 'changed');
  writeFileSync(join(dir, '.zc/new.md'), 'new');
  const v = restoreZc(dir, snap, { saveDir: join(dir, '.zc-evidence-outside') });
  assert.deepEqual(v.map((x) => [x.path, x.change, x.restored]).sort(), [['.zc/a.md', 'modified', true], ['.zc/new.md', 'added', true]]);
  assert.equal(readFileSync(join(dir, '.zc/a.md'), 'utf8'), 'A');
  assert.ok(!existsSync(join(dir, '.zc/new.md')));
});

test('rollbackPaths restores only paths whose content still matches; others are conflicts', () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'src/a.txt'), 'worker a');
  writeFileSync(join(dir, 'src/b.txt'), 'worker b');
  writeFileSync(join(dir, 'README.md'), 'worker readme');
  const expected = dirtyState(dir);
  writeFileSync(join(dir, 'src/b.txt'), 'USER EDIT after the worker'); // same path, different bytes
  const rb = rollbackPaths(dir, statusEntries(dir), expected);
  assert.deepEqual(rb.restored.sort(), ['README.md', 'src/a.txt']);
  assert.deepEqual(rb.conflicts.map((c) => c.path), ['src/b.txt']);
  assert.equal(readFileSync(join(dir, 'src/b.txt'), 'utf8'), 'USER EDIT after the worker');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'hello\n');
});

test('reject refuses when a worker-touched file was edited again by hand, unless forced (then a copy is kept)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  writeFileSync(join(dir, 'src/a.txt'), 'my careful edit on top');
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /not exactly run/);
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'my careful edit on top');
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(statusEntries(dir).length, 0);
  assert.equal(readFileSync(join(r.runDir, 'rejected-manual', 'untracked', 'src', 'a.txt'), 'utf8'), 'my careful edit on top');
});

test('reject refuses a run that has no recorded file contents unless forced', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'w' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  const file = join(r.runDir, 'result.json');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  delete old.workerState;
  writeFileSync(file, JSON.stringify(old));
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /no recorded file contents/);
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(statusEntries(dir).length, 0);
});

test('reject takes the project lock, and always releases it', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'w' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  const release = acquireLock(lockFile(dir), { runId: 'other' });
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /already running/);
  assert.ok(existsSync(join(dir, 'src/a.txt')), 'nothing was touched while locked');
  release();
  writeFileSync(join(dir, 'src/a.txt'), 'edited'); // makes reject throw inside the lock
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /not exactly/);
  const again = acquireLock(lockFile(dir), {}); // would throw if the failed reject leaked the lock
  again();
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.ok(!existsSync(lockFile(dir)));
});

test('repair demands the same file contents, not just the same paths', async () => {
  makeHome();
  const { dir, config } = makeRepo({ verify: [FAIL] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker' } });
  const r1 = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r1.status, 'VERIFY_FAILED');
  writeFileSync(join(dir, 'src/a.txt'), 'hand edit, same path');
  const r2 = await dispatch({ root: dir, task: scoped(), config, repairOf: r1.runId });
  assert.equal(r2.status, 'NEEDS_HUMAN');
  assert.match(r2.nextAction, /no longer matches/);
  writeFileSync(join(dir, 'src/a.txt'), 'worker'); // restored exactly
  const r3 = await dispatch({ root: dir, task: scoped(), config, repairOf: r1.runId });
  assert.notEqual(r3.status, 'NEEDS_HUMAN');
});

test('durations: only finite positive numbers up to 8 hours are accepted', () => {
  for (const ok of [1, 0.5, '30', '1.5', 480]) assert.ok(parseMinutes(ok) > 0);
  for (const bad of [0, -1, NaN, Infinity, '', ' ', 'abc', '10m', '1e3', '0', null, undefined, {}, 481, 1e9, '-5']) {
    assert.throws(() => parseMinutes(bad), /minutes/, String(bad));
  }
});

test('durations are validated in task files, config, and again at dispatch', async () => {
  assert.throws(() => parseTask('---\nid: x\nminutes: abc\n---\nbody'), /minutes/);
  assert.throws(() => parseTask('---\nid: x\nminutes: 0\n---\nbody'), /minutes/);
  assert.throws(() => parseTask('---\nid: x\nminutes: Infinity\n---\nbody'), /minutes/);
  makeHome();
  assert.throws(() => makeRepo({ defaults: { minutes: -3 } }), /defaults.minutes/);
  assert.throws(() => makeRepo({ defaults: { cooldownMinutes: 'soon' } }), /cooldownMinutes/);
  const ok = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  const t = scoped();
  t.meta.minutes = Infinity; // a caller that bypasses the parser
  const r = await dispatch({ root: ok.dir, task: t, config: ok.config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /minutes/);
});

test('a .zc/ file too big to snapshot stops the run before any worker starts', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  writeFileSync(join(dir, '.zc/big.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /too large.*big\.bin/);
  assert.equal(existsSync(join(g1.profileDir, 'calls.log')), false, 'the worker never ran');
});

test('a .zc/ change that cannot be restored is reported as not restored, never as success', () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, '.zc/a.md'), 'A');
  const snap = snapshotZc(dir, join(dir, '.zc-copy-x'));
  snap.copied = []; // pretend no copy was kept
  writeFileSync(join(dir, '.zc/a.md'), 'changed');
  const v = restoreZc(dir, snap, { saveDir: join(dir, '.zc-evidence-x') });
  assert.deepEqual(v.map((x) => [x.path, x.restored]), [['.zc/a.md', false]]);
});

test('staging a worker file counts as a change: reject and rollback refuse to discard it', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  git(dir, 'add', 'src/a.txt'); // file content is unchanged, but you staged it
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /not exactly run/);
  assert.match(git(dir, 'status', '--porcelain'), /^A  src\/a\.txt/m, 'still staged');
  const expected = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8')).workerState;
  const rb = rollbackPaths(dir, statusEntries(dir), expected);
  assert.deepEqual(rb.conflicts.map((c) => c.path), ['src/a.txt']);
  assert.match(git(dir, 'status', '--porcelain'), /^A  src\/a\.txt/m);
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(statusEntries(dir).length, 0);
});

test('repair also refuses when you staged the worker result', async () => {
  makeHome();
  const { dir, config } = makeRepo({ verify: [FAIL] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker' } });
  const r1 = await dispatch({ root: dir, task: scoped(), config });
  git(dir, 'add', 'src/a.txt');
  const r2 = await dispatch({ root: dir, task: scoped(), config, repairOf: r1.runId });
  assert.equal(r2.status, 'NEEDS_HUMAN');
});

test('empty .zc/ folders are protected too: deleted ones come back, new ones are removed and reported', () => {
  const { dir } = makeRepo();
  mkdirSync(join(dir, '.zc/keepdir'), { recursive: true });
  writeFileSync(join(dir, '.zc/a.md'), 'A');
  const snap = snapshotZc(dir, join(dir, '.zc-copy-d'));
  rmSync(join(dir, '.zc/keepdir'), { recursive: true });
  mkdirSync(join(dir, '.zc/sneaky'));
  const v = restoreZc(dir, snap, { saveDir: join(dir, '.zc-evidence-d') });
  assert.deepEqual(v.map((x) => [x.path, x.change, x.kind, x.restored]).sort(),
    [['.zc/keepdir', 'removed', 'dir', true], ['.zc/sneaky', 'added', 'dir', true]]);
  assert.ok(existsSync(join(dir, '.zc/keepdir')));
  assert.ok(!existsSync(join(dir, '.zc/sneaky')));
});
