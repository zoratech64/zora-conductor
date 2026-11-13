import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { checkIdentity, gitLayout, overwriteText, restoreIdentity, samePath } from '../src/gitmeta.mjs';
import {
  branch,
  configList,
  dirtyState,
  head,
  noHooksDir,
  pathStates,
  pinLayout,
  rollbackPaths,
  savePartial,
  statusEntries,
  unpinLayout
} from '../src/gitx.mjs';
import { addFake, calls, git, makeHome, makeRepo, task } from './helpers.mjs';

function hasSh() {
  const r = spawnSync('sh', ['-c', 'exit 0']);
  return r.status === 0;
}

test('A1: helpers do not execute core.fsmonitor or hooks', (t) => {
  if (!hasSh()) {
    t.skip('needs sh');
    return;
  }
  makeHome();
  const { dir } = makeRepo();
  const extDir = mkdtempSync(join(tmpdir(), 'zc-a1-'));

  const fsmonMarker = join(extDir, 'fsmon.marker').replace(/\\/g, '/');
  const fsmonScript = join(extDir, 'fsmon.sh');
  writeFileSync(fsmonScript, `#!/bin/sh\necho x >> "${fsmonMarker}"\nexit 1\n`);
  chmodSync(fsmonScript, 0o755);
  git(dir, 'config', 'core.fsmonitor', fsmonScript.replace(/\\/g, '/'));

  const hookMarker = join(extDir, 'hook.marker').replace(/\\/g, '/');
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookScript = join(hooksDir, 'post-index-change');
  writeFileSync(hookScript, `#!/bin/sh\necho x >> "${hookMarker}"\nexit 0\n`);
  chmodSync(hookScript, 0o755);

  writeFileSync(join(dir, 'README.md'), 'modified\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');

  head(dir);
  branch(dir);
  const entries = statusEntries(dir);
  const ds = dirtyState(dir);
  pathStates(dir, ['README.md', 'untracked.txt']);
  const saveDir = mkdtempSync(join(tmpdir(), 'save1-'));
  savePartial(dir, saveDir, entries);
  rollbackPaths(dir, statusEntries(dir), ds);

  assert.ok(!existsSync(fsmonMarker), 'fsmonitor marker should not exist during zc helpers');
  assert.ok(!existsSync(hookMarker), 'hook marker should not exist during zc helpers');

  try {
    git(dir, 'status');
  } catch {
    // fsmonitor returns 1, so git status might print a warning or fail
  }
  assert.ok(existsSync(fsmonMarker), 'fsmonitor marker must exist after plain git status');
});

test('A2: savePartial does not execute diff.external', (t) => {
  if (!hasSh()) {
    t.skip('needs sh');
    return;
  }
  makeHome();
  const { dir } = makeRepo();

  const diffMarker = join(dir, 'diff.marker').replace(/\\/g, '/');
  const diffScript = join(dir, 'diff.sh');
  writeFileSync(diffScript, `#!/bin/sh\necho x >> "${diffMarker}"\nexit 0\n`);
  chmodSync(diffScript, 0o755);
  git(dir, 'config', 'diff.external', diffScript.replace(/\\/g, '/'));

  writeFileSync(join(dir, 'README.md'), 'changed line\n');
  const saveDir = mkdtempSync(join(tmpdir(), 'save2-'));
  savePartial(dir, saveDir, statusEntries(dir));

  assert.ok(!existsSync(diffMarker), 'diff.external marker should not exist');
  git(dir, 'apply', '--check', '--reverse', join(saveDir, 'tracked.patch'));
});

test('A3: pinLayout isolates git operations from modified pointer files', () => {
  const { dir } = makeRepo();
  const wt = mkdtempSync(join(tmpdir(), 'zc-wt3-'));
  git(dir, 'worktree', 'add', wt, '-b', 'wt');

  const decoy = mkdtempSync(join(tmpdir(), 'zc-decoy3-'));
  git(decoy, 'init', '-q', '-b', 'decoy');
  git(decoy, 'config', 'user.email', 'd@example.com');
  git(decoy, 'config', 'user.name', 'Decoy');
  git(decoy, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(decoy, 'decoy.txt'), 'decoy\n');
  git(decoy, 'add', '-A');
  git(decoy, 'commit', '-q', '-m', 'decoy init');

  const layout = gitLayout(wt);
  const origHead = head(wt);
  pinLayout(wt, layout);

  try {
    const dotGitPath = join(wt, '.git');
    const origDotGit = readFileSync(dotGitPath, 'utf8');
    overwriteText(dotGitPath, `gitdir: ${join(decoy, '.git')}\n`);

    assert.equal(branch(wt), 'wt');
    assert.equal(head(wt), origHead);

    overwriteText(dotGitPath, origDotGit);

    const commondirPath = join(layout.gitDir, 'commondir');
    const origCommondir = readFileSync(commondirPath, 'utf8');
    overwriteText(commondirPath, join(decoy, '.git'));

    assert.equal(branch(wt), 'wt');

    overwriteText(commondirPath, origCommondir);
  } finally {
    unpinLayout(wt);
  }
});

test('A4: gitLayout on normal repo, linked worktree, and separate-git-dir', () => {
  const { dir: normalDir } = makeRepo();
  const normalLayout = gitLayout(normalDir);
  assert.equal(normalLayout.linked, false);
  assert.equal(normalLayout.dotGit.kind, 'dir');
  assert.equal(normalLayout.dotGit.text, null);
  assert.ok(samePath(normalLayout.gitDir, git(normalDir, 'rev-parse', '--absolute-git-dir').trim()));
  assert.ok(samePath(normalLayout.commonDir, resolve(normalDir, git(normalDir, 'rev-parse', '--git-common-dir').trim())));

  const wtDir = mkdtempSync(join(tmpdir(), 'zc-wt4-'));
  git(normalDir, 'worktree', 'add', wtDir, '-b', 'wt4');
  const wtLayout = gitLayout(wtDir);
  assert.equal(wtLayout.linked, true);
  assert.equal(wtLayout.dotGit.kind, 'file');
  assert.ok(wtLayout.dotGit.text.startsWith('gitdir:'));
  assert.notEqual(wtLayout.worktreeFiles.commondir, null);
  assert.ok(samePath(wtLayout.gitDir, git(wtDir, 'rev-parse', '--absolute-git-dir').trim()));
  assert.ok(samePath(wtLayout.commonDir, resolve(wtDir, git(wtDir, 'rev-parse', '--git-common-dir').trim())));

  const sepGit = mkdtempSync(join(tmpdir(), 'sep-git4-'));
  const sepWt = mkdtempSync(join(tmpdir(), 'sep-wt4-'));
  git(sepWt, 'init', '-q', '-b', 'main', '--separate-git-dir', sepGit);
  git(sepWt, 'config', 'user.email', 't@example.com');
  git(sepWt, 'config', 'user.name', 'Test');
  git(sepWt, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(sepWt, 'file.txt'), 'hello\n');
  git(sepWt, 'add', '-A');
  git(sepWt, 'commit', '-q', '-m', 'init');

  const sepLayout = gitLayout(sepWt);
  assert.equal(sepLayout.linked, false);
  assert.equal(sepLayout.dotGit.kind, 'file');
  assert.ok(samePath(sepLayout.gitDir, git(sepWt, 'rev-parse', '--absolute-git-dir').trim()));
  assert.ok(samePath(sepLayout.commonDir, resolve(sepWt, git(sepWt, 'rev-parse', '--git-common-dir').trim())));
});

test('A5: dispatch fails closed before worker starts on bare repo or symlinked .git', async (t) => {
  // (a) Bare repository root
  makeHome();
  const bareDir = mkdtempSync(join(tmpdir(), 'zc-bare5-'));
  git(bareDir, 'init', '--bare', '-q');
  mkdirSync(join(bareDir, '.zc'), { recursive: true });
  writeFileSync(join(bareDir, '.zc', 'config.json'), JSON.stringify({
    version: 1,
    verify: [[process.execPath, '-e', 'process.exit(0)']]
  }));
  const bareConfig = loadConfig(bareDir);
  const accA = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'bare' } });
  const rBare = await dispatch({
    root: bareDir,
    task: task('id: T-bare\nallowed:\n  - src/'),
    config: bareConfig
  });
  assert.equal(rBare.status, 'NEEDS_HUMAN');
  assert.match(rBare.nextAction, /git directory/);
  assert.equal(calls(accA), 0);

  // (b) Symlink to .git directory
  makeHome();
  const { dir: symRepoDir, config: symConfig } = makeRepo();
  const realGit = mkdtempSync(join(tmpdir(), 'zc-realgit5-'));
  rmdirSync(realGit);
  renameSync(join(symRepoDir, '.git'), realGit);
  try {
    symlinkSync(realGit, join(symRepoDir, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`symlink creation failed: ${err.message}`);
    return;
  }
  const accB = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'sym' } });
  const rSym = await dispatch({
    root: symRepoDir,
    task: task('id: T-sym\nallowed:\n  - src/'),
    config: symConfig
  });
  assert.equal(rSym.status, 'NEEDS_HUMAN');
  assert.match(rSym.nextAction, /git directory/);
  assert.equal(calls(accB), 0);
});

test('A6: inherited GIT_* environment variables do not affect zc git calls', () => {
  const { dir: dir1 } = makeRepo();
  const { dir: dir2 } = makeRepo();
  writeFileSync(join(dir1, 'README.md'), 'changed\n');
  const expectedHead = git(dir1, 'rev-parse', 'HEAD').trim();

  const prevGitDir = process.env.GIT_DIR;
  const prevGitIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = join(dir2, '.git');
  process.env.GIT_INDEX_FILE = join(tmpdir(), 'bogus-index');

  try {
    assert.equal(head(dir1), expectedHead);
    const entries = statusEntries(dir1);
    assert.ok(entries.some((e) => e.path === 'README.md'));
  } finally {
    if (prevGitDir !== undefined) process.env.GIT_DIR = prevGitDir;
    else delete process.env.GIT_DIR;
    if (prevGitIndex !== undefined) process.env.GIT_INDEX_FILE = prevGitIndex;
    else delete process.env.GIT_INDEX_FILE;
  }
});

test('A7: checkIdentity detects metadata changes and restoreIdentity restores pointer files', () => {
  // 1. Untouched layout
  const { dir: normalDir } = makeRepo();
  const layout1 = gitLayout(normalDir);
  assert.deepEqual(checkIdentity(normalDir, layout1), []);

  // 2. Linked worktree with rewritten .git text
  const wt = mkdtempSync(join(tmpdir(), 'zc-wt7-'));
  git(normalDir, 'worktree', 'add', wt, '-b', 'wt7');
  const layout2 = gitLayout(wt);
  const dotGitPath = join(wt, '.git');
  const origDotGit = readFileSync(dotGitPath, 'utf8');
  overwriteText(dotGitPath, 'gitdir: /bogus/decoy\n');

  const changes2 = checkIdentity(wt, layout2);
  assert.equal(changes2.length, 1);
  assert.equal(changes2[0].change, 'modified');
  assert.equal(changes2[0].restorable, true);
  assert.equal(changes2[0].restored, false);

  const saveDir = mkdtempSync(join(tmpdir(), 'save7-'));
  const restored2 = restoreIdentity(wt, layout2, changes2, { saveDir });
  assert.equal(restored2[0].restored, true);
  assert.equal(readFileSync(dotGitPath, 'utf8'), origDotGit);
  assert.ok(existsSync(join(saveDir, '.git')));
  assert.equal(readFileSync(join(saveDir, '.git'), 'utf8'), 'gitdir: /bogus/decoy\n');

  // 3. Normal repo whose .git directory was renamed away and copied back
  const { dir: dir3 } = makeRepo();
  const layout3 = gitLayout(dir3);
  const tempGit = mkdtempSync(join(tmpdir(), 'temp-git7-'));
  rmdirSync(tempGit);
  renameSync(join(dir3, '.git'), tempGit);
  cpSync(tempGit, join(dir3, '.git'), { recursive: true });

  const changes3 = checkIdentity(dir3, layout3);
  // On platforms where lstat reports dev/ino as '0', path-only identity applies and inode changes cannot be detected
  if (layout3.identity.gitDir.dev === '0' || layout3.identity.gitDir.ino === '0') {
    assert.deepEqual(changes3, []);
  } else {
    assert.equal(changes3.length, 1);
    assert.equal(changes3[0].change, 'replaced');
    assert.equal(changes3[0].restorable, false);
  }

  // 4. Repo whose .git directory was replaced by a regular file
  const { dir: dir4 } = makeRepo();
  const layout4 = gitLayout(dir4);
  rmSync(join(dir4, '.git'), { recursive: true, force: true });
  writeFileSync(join(dir4, '.git'), 'regular file\n');
  const changes4 = checkIdentity(dir4, layout4);
  assert.equal(changes4.length, 1);
  assert.equal(changes4[0].change, 'replaced');
  assert.equal(changes4[0].restorable, false);
});

test('A8: files planted in noHooksDir are not executed and are cleaned before git calls', (t) => {
  if (!hasSh()) {
    t.skip('needs sh');
    return;
  }
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'dirty content\n');

  const hooksDir = noHooksDir();
  mkdirSync(hooksDir, { recursive: true });
  const marker = join(dir, 'hook8.marker').replace(/\\/g, '/');
  const script = join(hooksDir, 'post-index-change');
  writeFileSync(script, `#!/bin/sh\necho x >> "${marker}"\nexit 0\n`);
  chmodSync(script, 0o755);

  statusEntries(dir);
  assert.ok(!existsSync(marker), 'planted hook marker should not exist');
  assert.equal(readdirSync(noHooksDir()).length, 0, 'noHooksDir must be empty after git invocation');
});

test('A9: inert git call times out when encountering a blocking fifo', (t) => {
  if (process.platform === 'win32') {
    t.skip('no mkfifo');
    return;
  }
  const { dir } = makeRepo();
  const fifoPath = join(dir, 'fifo.cfg');
  execFileSync('mkfifo', [fifoPath]);
  git(dir, 'config', 'include.path', fifoPath);

  const prev = process.env.ZC_GIT_INERT_TIMEOUT_MS;
  process.env.ZC_GIT_INERT_TIMEOUT_MS = '500';
  try {
    assert.throws(
      () => configList(dir),
      (err) => err.code === 'ZC_GIT_TIMEOUT' && /config/.test(err.message)
    );
  } finally {
    if (prev !== undefined) process.env.ZC_GIT_INERT_TIMEOUT_MS = prev;
    else delete process.env.ZC_GIT_INERT_TIMEOUT_MS;
  }
});
