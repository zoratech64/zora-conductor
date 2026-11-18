import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptRun, ackRun, dispatch, rejectRun } from '../src/dispatch.mjs';
import { runsDir } from '../src/paths.mjs';
import { addFake, git, makeHome, makeRepo, mkTmp, setScenario, task } from './helpers.mjs';

const hasSh = () => spawnSync('sh', ['-c', 'exit 0']).status === 0;
const scoped = () => task('id: T-1\nallowed:\n  - src/');
const verifyJs = (t, script) => {
  t.meta.verify = [[process.execPath, '-e', `const {execFileSync}=require('child_process');const fs=require('fs');${script}`]];
  return t;
};
const readJson = (r) => JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8'));
const markerScript = (marker, rest = 'exit 0') => `#!/bin/sh\necho x >> "${marker.replace(/\\/g, '/')}"\n${rest}\n`;

test('D1: verify plants a hook and a config alias: SCOPE_VIOLATION in verify, both repaired', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const t = verifyJs(scoped(), "fs.writeFileSync('.git/hooks/pre-commit','#!/bin/sh\\nexit 0\\n',{mode:0o755});execFileSync('git',['config','alias.pwn','status']);");
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.equal(r.phase, 'verify');
  assert.ok(r.gitMeta.length >= 2 && r.gitMeta.every((e) => e.restored));
  assert.ok(!existsSync(join(dir, '.git/hooks/pre-commit')));
  assert.equal(spawnSync('git', ['config', '--get', 'alias.pwn'], { cwd: dir }).status, 1);
  assert.ok(r.forbidden.includes('.git/hooks/pre-commit'));
});

test('D2: a worker writing a hook is a SCOPE_VIOLATION, and a metadata-only run is not NO_CHANGES', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { '.git/hooks/pre-commit': '#!/bin/sh\nexit 0\n' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.equal(r.phase, 'worker');
  assert.ok(!existsSync(join(dir, '.git/hooks/pre-commit')));
  assert.ok(existsSync(join(r.runDir, 'git-meta-violations-1')));
});

test('D3 (no execution): verify sets core.fsmonitor to a marker script, which never runs and is restored', async (t) => {
  if (!hasSh()) return t.skip('needs sh');
  makeHome();
  const { dir, config } = makeRepo();
  const extra = mkTmp('zc-d3-');
  const marker = join(extra, 'm');
  const script = join(extra, 'fsmon.sh');
  writeFileSync(script, markerScript(marker, 'exit 1'));
  chmodSync(script, 0o755);
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const tk = verifyJs(scoped(), `execFileSync('git',['config','core.fsmonitor',${JSON.stringify(script.replace(/\\/g, '/'))}]);`);
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(!existsSync(marker), 'fsmonitor marker must be absent');
  assert.equal(spawnSync('git', ['config', '--get', 'core.fsmonitor'], { cwd: dir }).status, 1);
});

test('D4 (no execution): verify defines clean/smudge filters via info/attributes while a rollback is forced', async (t) => {
  if (!hasSh()) return t.skip('needs sh');
  makeHome();
  const { dir, config } = makeRepo();
  const extra = mkTmp('zc-d4-');
  const marker = join(extra, 'm');
  const filter = join(extra, 'f.sh');
  writeFileSync(filter, markerScript(marker, 'cat'));
  chmodSync(filter, 0o755);
  const f = JSON.stringify(filter.replace(/\\/g, '/'));
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'other/x.txt': 'x' } });
  const tk = verifyJs(scoped(), `execFileSync('git',['config','filter.x.clean',${f}]);execFileSync('git',['config','filter.x.smudge',${f}]);fs.appendFileSync('.git/info/attributes','* filter=x\\n');`);
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(!existsSync(marker), 'filter marker must be absent');
  assert.equal(spawnSync('git', ['config', '--get', 'filter.x.clean'], { cwd: dir }).status, 1);
  const attrs = join(dir, '.git/info/attributes');
  assert.ok(!existsSync(attrs) || !readFileSync(attrs, 'utf8').includes('filter=x'));
});

test('D5 (no execution): verify plants a post-index-change hook; the rollback never runs it', async (t) => {
  if (!hasSh()) return t.skip('needs sh');
  makeHome();
  const { dir, config } = makeRepo();
  const extra = mkTmp('zc-d5-');
  const marker = join(extra, 'm');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'other/x.txt': 'x' } });
  const hook = JSON.stringify(markerScript(marker));
  const tk = verifyJs(scoped(), `fs.writeFileSync('.git/hooks/post-index-change',${hook},{mode:0o755});`);
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(!existsSync(marker));
  assert.ok(!existsSync(join(dir, '.git/hooks/post-index-change')));
});

test('D6: info/exclude cannot hide a worker file from the scope check', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'other/x.txt': 'x', '.git/info/exclude': 'other/\n' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(r.outOfScope.includes('other/x.txt'));
});

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`D7: verify edits README.md and sets ${flag}: out of scope, phase verify, rolled back`, async () => {
    makeHome();
    const { dir, config } = makeRepo();
    addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
    const tk = verifyJs(scoped(), `fs.writeFileSync('README.md','tampered\\n');execFileSync('git',['update-index','${flag}','README.md']);`);
    const r = await dispatch({ root: dir, task: tk, config });
    assert.equal(r.status, 'SCOPE_VIOLATION');
    assert.equal(r.phase, 'verify');
    assert.ok(r.outOfScope.includes('README.md'));
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'hello\n');
    assert.equal(r.rolledBack, true);
  });
}

test('D8: a user skip-worktree file with a local edit survives a quota rollback and a scope rollback', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'my private edit\n');
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  addFake('g1', { mode: 'quota', partial: true, write: { 'src/a.txt': 'a' } });
  await dispatch({ root: dir, task: scoped(), config });
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'my private edit\n');
  assert.ok(git(dir, 'ls-files', '-v').includes('S README.md'));
  addFake('g2', { mode: 'ok', write: { 'other/x.txt': 'x' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'my private edit\n');
  assert.ok(git(dir, 'ls-files', '-v').includes('S README.md'));
});

test('D9: verify creates a ref: NEEDS_HUMAN, unrestored, no workerState, nothing rolled back', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const tk = verifyJs(scoped(), "execFileSync('git',['branch','other']);");
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.equal(r.gitMetaUnrestored, true);
  assert.equal(r.phase, 'verify');
  assert.ok(!('workerState' in readJson(r)));
  assert.ok(existsSync(join(dir, 'src/a.txt')), 'nothing is rolled back');
  assert.match(git(dir, 'branch', '--list', 'other'), /other/);
});

test('D10: a linked worktree: shared hooks are detect-only, a rewritten .git pointer is restored', async () => {
  makeHome();
  const { dir: main, config } = makeRepo();
  const wt = mkTmp('zc-wt-d10-');
  git(main, 'worktree', 'add', wt, '-b', 'wt10');
  mkdirSync(join(wt, '.zc'), { recursive: true });
  writeFileSync(join(wt, '.zc/config.json'), readFileSync(join(main, '.zc/config.json')));
  const pointer = readFileSync(join(wt, '.git'), 'utf8');
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', '.git': 'gitdir: /nonexistent/decoy\n' } });
  const r1 = await dispatch({ root: wt, task: scoped(), config });
  assert.equal(r1.status, 'SCOPE_VIOLATION');
  assert.equal(readFileSync(join(wt, '.git'), 'utf8'), pointer);

  setScenario(g1, { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const shared = join(main, '.git', 'hooks', 'pre-commit');
  const tk = verifyJs(scoped(), `fs.writeFileSync(${JSON.stringify(shared)},'#!/bin/sh\\nexit 0\\n',{mode:0o755});`);
  const r2 = await dispatch({ root: wt, task: tk, config });
  assert.equal(r2.status, 'NEEDS_HUMAN');
  assert.equal(r2.gitMetaUnrestored, true);
});

test('D11: .gitignore inside an allowed directory is out of scope; a rolled-back one reveals what it hid', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'src/.gitignore': 'hidden.txt\n', 'src/hidden.txt': 'h' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(r.outOfScope.includes('src/.gitignore'));
  assert.equal(r.rolledBack, false);
  assert.deepEqual(r.revealedAfterRollback, ['src/hidden.txt']);
});

test('D12: normal operations still end OK', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  mkdirSync(join(dir, '.husky'), { recursive: true });
  writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git(dir, 'config', 'core.hooksPath', '.husky');
  git(dir, 'add', '-f', '.husky/pre-commit');
  git(dir, 'commit', '-q', '-m', 'husky');
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const tk = verifyJs(scoped(), "for (const a of [['status'],['diff'],['log'],['stash','list'],['pack-refs','--all']]) execFileSync('git',a);");
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.status, 'OK', JSON.stringify(r.gitMeta ?? r.nextAction));
  assert.deepEqual(readdirSync(join(dir, '.husky')), ['pre-commit']);
});

async function unrestoredRun() {
  makeHome();
  const { dir, config } = makeRepo();
  const g = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const tk = verifyJs(scoped(), "execFileSync('git',['branch','other']);");
  const r = await dispatch({ root: dir, task: tk, config });
  assert.equal(r.gitMetaUnrestored, true);
  return { dir, config, r, g };
}

test('E1: rejectRun refuses a layout mismatch, even with force', async () => {
  const { dir, r } = await unrestoredRun();
  const path = join(r.runDir, 'result.json');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  rec.gitLayout.gitDir = join(dir, 'elsewhere');
  writeFileSync(path, JSON.stringify(rec));
  assert.throws(() => rejectRun({ root: dir, runId: r.runId, force: true }), /layout/);
});

test('E1b: the unrestored result tells the user that .zc/ edits were not rolled back', async () => {
  const { r } = await unrestoredRun();
  assert.match(r.nextAction, /under \.zc\/ were not rolled back/);
});

test('E2: rejectRun refuses a gitMetaUnrestored run unless force is given', async () => {
  const { dir, r } = await unrestoredRun();
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /gitMetaUnrestored|checked by hand|zc ack/);
  const out = rejectRun({ root: dir, runId: r.runId, force: true });
  assert.equal(out.runId, r.runId);
});

test('E3 and E4: the next dispatch is blocked until zc ack, which changes only that result.json', async () => {
  const { dir, config, r, g } = await unrestoredRun();
  git(dir, 'branch', '-D', 'other');
  rejectRun({ root: dir, runId: r.runId, force: true });
  setScenario(g, { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const blocked = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(blocked.status, 'NEEDS_HUMAN');
  assert.match(blocked.nextAction, /zc ack/);
  assert.ok(!existsSync(join(dir, 'src/b.txt')), 'no worker started');

  const before = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8'));
  const stateBefore = git(dir, 'status', '--porcelain');
  ackRun({ root: dir, runId: r.runId });
  const after = JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8'));
  assert.ok(after.gitMetaAcknowledged);
  delete after.gitMetaAcknowledged;
  assert.deepEqual(after, before);
  assert.equal(git(dir, 'status', '--porcelain'), stateBefore);

  const ok = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(ok.status, 'OK');
});

test('D12b: a baseline fsmonitor and clean/smudge filter still work; rollback applies the filter', async (t) => {
  if (!hasSh()) return t.skip('needs sh');
  makeHome();
  const { dir, config } = makeRepo();
  const extra = mkTmp('zc-d12b-');
  const fsmon = join(extra, 'fsmon.sh');
  writeFileSync(fsmon, '#!/bin/sh\nexit 1\n');
  chmodSync(fsmon, 0o755);
  git(dir, 'config', 'core.fsmonitor', fsmon.replace(/\\/g, '/'));
  git(dir, 'config', 'filter.up.clean', 'tr b a');
  git(dir, 'config', 'filter.up.smudge', 'tr a b');
  writeFileSync(join(dir, '.gitattributes'), '*.flt filter=up\n');
  writeFileSync(join(dir, 'f.flt'), 'aaa\n');
  git(dir, 'add', '.gitattributes', 'f.flt');
  git(dir, 'commit', '-q', '-m', 'filter');
  git(dir, 'checkout', '--', 'f.flt');
  const g12 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a', 'f.flt': 'zzz\n' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'SCOPE_VIOLATION');
  assert.ok(r.outOfScope.includes('f.flt'));
  assert.equal(readFileSync(join(dir, 'f.flt'), 'utf8'), git(dir, 'show', 'HEAD:f.flt').replace(/a/g, 'b'));
  setScenario(g12, { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const ok = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(ok.status, 'OK', JSON.stringify(ok.gitMeta ?? ok.nextAction));
});

test('E6: a blocked dispatch records no state, stays blocked on repeat, and reject/ack find the unrestored run', async () => {
  const { dir, config, r } = await unrestoredRun();
  const b1 = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(b1.status, 'NEEDS_HUMAN');
  assert.ok(!('workerState' in readJson(b1)), 'the guard must not run git status on unrepaired metadata');
  const b2 = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(b2.status, 'NEEDS_HUMAN');
  assert.match(b2.nextAction, new RegExp(r.runId));
  assert.throws(() => rejectRun({ root: dir }), /zc ack/);
  ackRun({ root: dir });
  assert.ok(JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8')).gitMetaAcknowledged);
  git(dir, 'branch', '-D', 'other');
  assert.throws(() => rejectRun({ root: dir }), /no recorded file contents/, 'the ack refusal is lifted; only the old rule remains');
});

test('E7: early refusals (no allowed paths) record no state while an unrestored run is pending', async () => {
  const { dir, config } = await unrestoredRun();
  const r = await dispatch({ root: dir, task: task('id: T-none'), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.ok(!('workerState' in readJson(r)), 'no git status on unrepaired metadata');
});

test('E8: accept of an older OK run is refused while a newer unrestored run is unacknowledged', async () => {
  makeHome();
  const { dir, config } = makeRepo();
  const g = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const ok = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(ok.status, 'OK');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'accept by hand');
  setScenario(g, { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const bad = await dispatch({ root: dir, task: verifyJs(scoped(), "execFileSync('git',['branch','other']);"), config });
  assert.equal(bad.gitMetaUnrestored, true);
  assert.throws(() => acceptRun({ root: dir, runId: ok.runId, config }), /zc ack/);
});

test('E9: the pending run is found however many blocked runs pile up after it', async () => {
  const { dir, config } = await unrestoredRun();
  const base = runsDir(dir);
  for (let i = 0; i < 230; i++) {
    const id = `99999999999999-${String(i).padStart(4, '0')}`;
    mkdirSync(join(base, id), { recursive: true });
    writeFileSync(join(base, id, 'result.json'), JSON.stringify({ runId: id, status: 'NEEDS_HUMAN' }));
  }
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /zc ack/);
});

test('E10: reject of an older acknowledged run is refused while a newer run is unacknowledged', async () => {
  const { dir, config, r, g } = await unrestoredRun();
  ackRun({ root: dir, runId: r.runId });
  git(dir, 'branch', '-D', 'other');
  rejectRun({ root: dir, runId: r.runId, force: true });
  setScenario(g, { mode: 'ok', write: { 'src/b.txt': 'b' } });
  const r2 = await dispatch({ root: dir, task: verifyJs(scoped(), "execFileSync('git',['branch','other2']);"), config });
  assert.equal(r2.gitMetaUnrestored, true);
  assert.throws(() => rejectRun({ root: dir, runId: r.runId }), /zc ack/);
  assert.equal(ackRun({ root: dir }).runId, r2.runId, 'default ack targets the unacknowledged run');
});
