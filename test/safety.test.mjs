import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { acceptRun, dispatch, rejectRun } from '../src/dispatch.mjs';
import { acquireLock } from '../src/fsx.mjs';
import { dirtyState, rollbackPaths, statusEntries } from '../src/gitx.mjs';
import { parseMinutes } from '../src/limits.mjs';
import { lockFile } from '../src/paths.mjs';
import { restoreZc, snapshotZc } from '../src/snapshot.mjs';
import { parseTask } from '../src/task.mjs';
import { FAIL, addFake, calls, git, makeHome, makeRepo, task } from './helpers.mjs';

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

test('the .zc root itself is protected: empty root deleted, absent root created, root swapped for a file', () => {
  const emptied = () => { const { dir } = makeRepo(); rmSync(join(dir, '.zc/config.json')); return dir; };
  const run = (dir, mutate) => {
    const snap = snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-')));
    mutate(dir);
    return restoreZc(dir, snap, { saveDir: mkdtempSync(join(tmpdir(), 'zc-ev-')) });
  };
  // 1. empty .zc deleted
  const a = emptied();
  assert.deepEqual(run(a, (d) => rmSync(join(d, '.zc'), { recursive: true })).map((v) => [v.path, v.kind, v.change, v.restored]), [['.zc', 'root', 'removed', true]]);
  assert.ok(existsSync(join(a, '.zc')));
  // 2. absent .zc created (empty)
  const b = emptied();
  rmSync(join(b, '.zc'), { recursive: true });
  assert.deepEqual(run(b, (d) => mkdirSync(join(d, '.zc'))).map((v) => [v.path, v.kind, v.change, v.restored]), [['.zc', 'root', 'added', true]]);
  assert.ok(!existsSync(join(b, '.zc')));
  // 3. .zc replaced by a file
  const c = emptied();
  const v3 = run(c, (d) => { rmSync(join(d, '.zc'), { recursive: true }); writeFileSync(join(d, '.zc'), 'not a folder'); });
  assert.deepEqual(v3.map((v) => [v.path, v.kind, v.change, v.restored]), [['.zc', 'root', 'replaced', true]]);
  assert.ok(statSync(join(c, '.zc')).isDirectory(), 'a real folder is back');
  // 4. untouched root: no violations
  assert.deepEqual(run(emptied(), () => {}), []);
});

test('a .zc that is a symlink or a file cannot be protected, so it is reported before any worker starts', () => {
  const { dir } = makeRepo();
  const snap = snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-link-')));
  assert.deepEqual(snap.uncopied, []);
  rmSync(join(dir, '.zc'), { recursive: true });
  writeFileSync(join(dir, '.zc'), 'x');
  assert.match(snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-file-'))).uncopied.join(), /\.zc \(a file/);
});

test('a .zc that is a real symlink blocks the run: no worker starts', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'zc-elsewhere-'));
  writeFileSync(join(elsewhere, 'config.json'), '{}');
  rmSync(join(dir, '.zc'), { recursive: true });
  symlinkSync(elsewhere, join(dir, '.zc'), 'dir');
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /\.zc \(a link, not a folder\)/);
  assert.equal(existsSync(join(g1.profileDir, 'calls.log')), false, 'the worker never ran');
});

test('a worker that swaps .zc/ for a symlink is undone without touching the link target', () => {
  const { dir } = makeRepo();
  const target = mkdtempSync(join(tmpdir(), 'zc-target-'));
  writeFileSync(join(target, 'keep.txt'), 'keep');
  const snap = snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-')));
  rmSync(join(dir, '.zc'), { recursive: true });
  symlinkSync(target, join(dir, '.zc'), 'dir');
  const v = restoreZc(dir, snap, { saveDir: mkdtempSync(join(tmpdir(), 'zc-ev-')) });
  assert.ok(v.some((x) => x.kind === 'root' && x.change === 'replaced' && x.restored));
  assert.ok(statSync(join(dir, '.zc')).isDirectory());
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep', 'the symlink target was not deleted');
  assert.equal(readFileSync(join(dir, '.zc/config.json'), 'utf8').length > 0, true, 'original files are back');
});

test('replacing .zc/ with an identical copy is not a change; a copy with different content is caught file by file', () => {
  const { dir } = makeRepo();
  const original = readFileSync(join(dir, '.zc/config.json'), 'utf8');
  const snap = snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-')));
  rmSync(join(dir, '.zc'), { recursive: true });
  mkdirSync(join(dir, '.zc'));
  writeFileSync(join(dir, '.zc/config.json'), original);
  assert.deepEqual(restoreZc(dir, snap, { saveDir: mkdtempSync(join(tmpdir(), 'ev-same-')) }), [], 'same state, nothing to report');
  rmSync(join(dir, '.zc'), { recursive: true });
  mkdirSync(join(dir, '.zc'));
  writeFileSync(join(dir, '.zc/config.json'), '{"swapped":true}');
  const v = restoreZc(dir, snap, { saveDir: mkdtempSync(join(tmpdir(), 'ev-diff-')) });
  assert.deepEqual(v.map((x) => [x.path, x.change, x.restored]), [['.zc/config.json', 'modified', true]]);
  assert.equal(readFileSync(join(dir, '.zc/config.json'), 'utf8'), original);
});

const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

test('an unreadable .zc/ folder stops the run before any worker starts (fail closed)', { skip: !canTestPermissions && 'needs a non-root POSIX user' }, async () => {
  makeHome();
  const { dir, config } = makeRepo();
  mkdirSync(join(dir, '.zc/private'));
  writeFileSync(join(dir, '.zc/private/notes.md'), 'n');
  chmodSync(join(dir, '.zc/private'), 0o000);
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  try {
    const r = await dispatch({ root: dir, task: scoped(), config });
    assert.equal(r.status, 'NEEDS_HUMAN');
    assert.match(r.nextAction, /could not be fully read.*EACCES/);
    assert.equal(existsSync(join(g1.profileDir, 'calls.log')), false, 'the worker never ran');
  } finally {
    chmodSync(join(dir, '.zc/private'), 0o755);
  }
});

test('snapshot errors other than "missing" are thrown, not treated as an empty .zc/', { skip: !canTestPermissions && 'needs a non-root POSIX user' }, () => {
  const { dir } = makeRepo();
  chmodSync(join(dir, '.zc'), 0o000);
  try {
    assert.throws(() => snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-perm-'))), /EACCES/);
  } finally {
    chmodSync(join(dir, '.zc'), 0o755);
  }
  rmSync(join(dir, '.zc'), { recursive: true });
  assert.equal(snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-missing-'))).rootKind, 'missing', 'a truly absent .zc is still fine');
});

test('restoreZc throws (does not report a clean .zc/) when a folder became unreadable', { skip: !canTestPermissions && 'needs a non-root POSIX user' }, () => {
  const { dir } = makeRepo();
  mkdirSync(join(dir, '.zc/sub'));
  const snap = snapshotZc(dir, mkdtempSync(join(tmpdir(), 'zc-copy-later-')));
  chmodSync(join(dir, '.zc/sub'), 0o000);
  try {
    assert.throws(() => restoreZc(dir, snap, { saveDir: mkdtempSync(join(tmpdir(), 'zc-ev-later-')) }), /EACCES/);
  } finally {
    chmodSync(join(dir, '.zc/sub'), 0o755);
  }
});

test('dispatch: a worker that makes .zc/ unreadable ends as NEEDS_HUMAN, its work is not verified, and the pre-run copy is kept', { skip: !canTestPermissions && 'needs a non-root POSIX user' }, async () => {
  makeHome();
  const { dir, config } = makeRepo();
  mkdirSync(join(dir, '.zc/sub'));
  writeFileSync(join(dir, '.zc/sub/notes.md'), 'manager notes');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'worker' }, chmod: { '.zc/sub': '000' } });
  try {
    const r = await dispatch({ root: dir, task: scoped(), config });
    assert.equal(r.status, 'NEEDS_HUMAN');
    assert.equal(r.exitCode, 3);
    assert.match(r.nextAction, /could not be read to check it.*EACCES/);
    assert.deepEqual(r.verify, [], 'the verify gate never ran, so nothing is reported as verified');
    assert.equal(r.attempts[0].outcome, 'zc-not-checked');
    assert.equal(readFileSync(join(r.runDir, 'zc-snapshot-1', '.zc', 'sub', 'notes.md'), 'utf8'), 'manager notes', 'the pre-run copy is kept');
    assert.ok(existsSync(join(dir, 'src/a.txt')), 'nothing was rolled back automatically');
  } finally {
    chmodSync(join(dir, '.zc/sub'), 0o755);
  }
});

test('post-verify: verify writes outside allowed paths -> SCOPE_VIOLATION', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').mkdirSync('other', { recursive: true }); require('fs').writeFileSync('other/x.txt', 'x');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.equal(r.phase, 'verify');
  assert.deepEqual(r.verifyChanged, ['other/x.txt']);
  assert.deepEqual(r.outOfScope, ['other/x.txt']);
  assert.equal(r.rolledBack, true);
  assert.ok(!existsSync(join(dir, 'other/x.txt')));
  assert.ok(existsSync(join(r.runDir, 'rejected-verify', 'untracked', 'other', 'x.txt')));
  assert.equal(statusEntries(dir).length, 0);
});

test('post-verify: verify overwrites .zc/config.json -> SCOPE_VIOLATION and restored', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const original = readFileSync(join(dir, '.zc/config.json'), 'utf8');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('.zc/config.json', '{\"hacked\":true}');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.equal(r.phase, 'verify');
  assert.ok(r.forbidden.includes('.zc/config.json'));
  assert.equal(readFileSync(join(dir, '.zc/config.json'), 'utf8'), original);
  assert.ok(existsSync(join(r.runDir, 'zc-violations-verify-1', '.zc', 'config.json')));
});

test('post-verify: verify moves HEAD -> NEEDS_HUMAN (exitCode 3)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "const { execFileSync } = require('child_process'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-q', '-m', 'v']);";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.equal(r.exitCode, 3);
  assert.match(r.nextAction, /verify/);
});

test('post-verify: verify writes in allowed paths -> OK, recorded in verifyChanged only', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('src/gen.txt', 'gen');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.verifyChanged, ['src/gen.txt']);
  assert.deepEqual(r.changed, ['src/a.txt']);
});

test('post-verify: verify overwrites .zc/config.json and exits 1 -> SCOPE_VIOLATION not VERIFY_FAILED', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const original = readFileSync(join(dir, '.zc/config.json'), 'utf8');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('.zc/config.json', '{\"hacked\":true}'); process.exit(1);";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.notEqual(r.status, 'VERIFY_FAILED');
  assert.equal(readFileSync(join(dir, '.zc/config.json'), 'utf8'), original);
});

test("post-verify: verify rewrites the worker's own in-scope file -> OK, in verifyChanged, accept refuses", async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('src/a.txt', 'verify');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.verifyChanged, ['src/a.txt']);
  assert.deepEqual(r.changed, ['src/a.txt']);
  assert.ok(Object.keys(r.preVerifyState).includes('src/a.txt'));
  assert.throws(
    () => acceptRun({ root: dir, runId: r.runId, config }),
    (err) => {
      assert.match(err.message, /not checked as the worker's change/);
      assert.match(err.message, /src\/a\.txt/);
      return true;
    }
  );
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('post-verify: verify deletes a file the worker created -> listed in verifyChanged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'src/b.txt': 'b' } });
  const t = scoped();
  const script = "require('fs').unlinkSync('src/b.txt');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.verifyChanged, ['src/b.txt']);
});

test('post-verify: result.workerState is the checked post-verify state', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('src/gen.txt', 'gen');";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.verifyChanged, ['src/gen.txt']);
  assert.deepEqual(Object.keys(r.workerState).sort(), ['src/a.txt', 'src/gen.txt']);
});

test('accept refuses when an accepted file changes after the run (late write)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  writeFileSync(join(dir, 'src/a.txt'), 'late');
  assert.throws(
    () => acceptRun({ root: dir, runId: r.runId, config }),
    (err) => {
      assert.match(err.message, /ambiguous ownership/);
      assert.match(err.message, /src\/a\.txt/);
      return true;
    }
  );
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
});

test('post-verify: a write after the post-verify snapshot cannot be absorbed into result.workerState', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX git wrapper');
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const bin = mkdtempSync(join(tmpdir(), 'zc-gitwrap-'));
  const marker = join(bin, 'verify-ran');
  const done = join(bin, 'late-written');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  // After verify has run, the first `git ls-files -s` (the last read of the post-verify snapshot) is
  // followed by one write to the accepted file, so the tree changes exactly after that snapshot.
  const wrapper = [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const r = require('child_process').spawnSync(process.env.ZC_T_REAL_GIT, process.argv.slice(2), { stdio: 'inherit' });",
    "const a = process.argv;",
    "if (a.includes('ls-files') && a.includes('-s') && fs.existsSync(process.env.ZC_T_MARKER) && !fs.existsSync(process.env.ZC_T_DONE)) {",
    "  fs.writeFileSync(process.env.ZC_T_DONE, '1');",
    "  fs.writeFileSync(process.env.ZC_T_LATE, 'late');",
    '}',
    'process.exit(r.status ?? 1);',
    ''
  ].join('\n');
  writeFileSync(join(bin, 'git'), wrapper);
  chmodSync(join(bin, 'git'), 0o755);
  const savedPath = process.env.PATH;
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    ZC_T_REAL_GIT: realGit, ZC_T_MARKER: marker, ZC_T_DONE: done, ZC_T_LATE: join(dir, 'src/a.txt')
  });
  try {
    const tk = scoped();
    tk.meta.verify = [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`]];
    const r = await dispatch({ root: dir, task: tk, config });
    assert.equal(r.status, 'OK');
    assert.ok(existsSync(done), 'the late write must have happened');
    assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'late');
    assert.throws(
      () => acceptRun({ root: dir, runId: r.runId, config }),
      (err) => { assert.match(err.message, /ambiguous ownership/); return true; }
    );
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
  } finally {
    process.env.PATH = savedPath;
    for (const k of ['ZC_T_REAL_GIT', 'ZC_T_MARKER', 'ZC_T_DONE', 'ZC_T_LATE']) delete process.env[k];
  }
});

test('repair refuses when the tree changed after the run (late write)', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  writeFileSync(join(dir, 'src/a.txt'), 'late');
  const feedbackTask = task('id: T-repair\nallowed:\n  - src/', 'Feedback: please fix.');
  const r2 = await dispatch({ root: dir, task: feedbackTask, config, repairOf: r.runId });
  assert.equal(r2.status, 'NEEDS_HUMAN');
  assert.match(r2.nextAction, /no longer matches/);
  assert.equal(calls(g1), 1);
});

test('reject refuses a late write without force', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  writeFileSync(join(dir, 'src/a.txt'), 'late');
  assert.throws(
    () => rejectRun({ root: dir, runId: r.runId }),
    (err) => {
      assert.match(err.message, /not exactly run/);
      assert.match(err.message, /src\/a\.txt/);
      return true;
    }
  );
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'late');
  rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(statusEntries(dir).length, 0);
  assert.ok(!existsSync(join(dir, 'src/a.txt')));
});

test('VERIFY_FAILED records the checked post-verify state', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = scoped();
  const script = "require('fs').writeFileSync('src/gen.txt', 'gen'); process.exit(1);";
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'VERIFY_FAILED');
  assert.deepEqual(r.verifyChanged, ['src/gen.txt']);
  assert.deepEqual(Object.keys(r.workerState).sort(), ['src/a.txt', 'src/gen.txt']);
});
