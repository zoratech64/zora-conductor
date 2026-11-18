import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
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
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { parseFlags } from '../src/gitmeta-flags.mjs';
import {
  checkFlags,
  checkIdentity,
  checkMetaFiles,
  checkMetaInert,
  checkOrigins,
  evidencePath,
  flagsBaseline,
  gitLayout,
  GitMetaError,
  isPrivate,
  metaBaseline,
  overwriteText,
  parseConfigList,
  refsListing,
  restoreIdentity,
  samePath
} from '../src/gitmeta.mjs';
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
import { projectState } from '../src/paths.mjs';
import { addFake, calls, git, makeHome, makeRepo, mkTmp, task } from './helpers.mjs';

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
  const extDir = mkTmp('zc-a1-');

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
  const saveDir = mkTmp('save1-');
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
  const saveDir = mkTmp('save2-');
  savePartial(dir, saveDir, statusEntries(dir));

  assert.ok(!existsSync(diffMarker), 'diff.external marker should not exist');
  git(dir, 'apply', '--check', '--reverse', join(saveDir, 'tracked.patch'));
});

test('A3: pinLayout isolates git operations from modified pointer files', () => {
  const { dir } = makeRepo();
  const wt = mkTmp('zc-wt3-');
  git(dir, 'worktree', 'add', wt, '-b', 'wt');

  const decoy = mkTmp('zc-decoy3-');
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

  const wtDir = mkTmp('zc-wt4-');
  git(normalDir, 'worktree', 'add', wtDir, '-b', 'wt4');
  const wtLayout = gitLayout(wtDir);
  assert.equal(wtLayout.linked, true);
  assert.equal(wtLayout.dotGit.kind, 'file');
  assert.ok(wtLayout.dotGit.text.startsWith('gitdir:'));
  assert.notEqual(wtLayout.worktreeFiles.commondir, null);
  assert.ok(samePath(wtLayout.gitDir, git(wtDir, 'rev-parse', '--absolute-git-dir').trim()));
  assert.ok(samePath(wtLayout.commonDir, resolve(wtDir, git(wtDir, 'rev-parse', '--git-common-dir').trim())));

  const sepGit = mkTmp('sep-git4-');
  const sepWt = mkTmp('sep-wt4-');
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
  const bareDir = mkTmp('zc-bare5-');
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
  const realGit = mkTmp('zc-realgit5-');
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
  const wt = mkTmp('zc-wt7-');
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

  const saveDir = mkTmp('save7-');
  const restored2 = restoreIdentity(wt, layout2, changes2, { saveDir });
  assert.equal(restored2[0].restored, true);
  assert.equal(readFileSync(dotGitPath, 'utf8'), origDotGit);
  assert.ok(existsSync(join(saveDir, '.git')));
  assert.equal(readFileSync(join(saveDir, '.git'), 'utf8'), 'gitdir: /bogus/decoy\n');

  // 3. Normal repo whose .git directory was renamed away and copied back
  const { dir: dir3 } = makeRepo();
  const layout3 = gitLayout(dir3);
  const tempGit = mkTmp('temp-git7-');
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

  const hooksDir = noHooksDir(dir);
  mkdirSync(hooksDir, { recursive: true });
  const marker = join(dir, 'hook8.marker').replace(/\\/g, '/');
  const script = join(hooksDir, 'post-index-change');
  writeFileSync(script, `#!/bin/sh\necho x >> "${marker}"\nexit 0\n`);
  chmodSync(script, 0o755);

  statusEntries(dir);
  assert.ok(!existsSync(marker), 'planted hook marker should not exist');
  assert.equal(readdirSync(noHooksDir(dir)).length, 0, 'noHooksDir must be empty after git invocation');
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

test('B1: hooks added, modified and removed are detected and restored with evidence', () => {
  makeHome();
  const { dir } = makeRepo();
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const preCommitPath = join(hooksDir, 'pre-commit');
  const prePushPath = join(hooksDir, 'pre-push');
  const postCheckoutPath = join(hooksDir, 'post-checkout');
  const baseContent = '#!/bin/sh\nexit 0\n';
  writeFileSync(preCommitPath, baseContent);
  writeFileSync(prePushPath, baseContent);

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    writeFileSync(preCommitPath, '#!/bin/sh\nexit 1\n');
    writeFileSync(postCheckoutPath, '#!/bin/sh\necho new\n');
    rmSync(prePushPath);

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 3);
    const mod = entries.find((e) => e.change === 'modified' && e.area === 'hooks');
    const add = entries.find((e) => e.change === 'added' && e.area === 'hooks');
    const rem = entries.find((e) => e.change === 'removed' && e.area === 'hooks');

    assert.ok(mod, 'must have modified hooks entry');
    assert.ok(add, 'must have added hooks entry');
    assert.ok(rem, 'must have removed hooks entry');

    assert.equal(mod.restored, true);
    assert.equal(add.restored, true);
    assert.equal(rem.restored, true);

    assert.equal(readFileSync(preCommitPath, 'utf8'), baseContent);
    assert.equal(readFileSync(prePushPath, 'utf8'), baseContent);
    assert.equal(existsSync(postCheckoutPath), false);

    const evPreCommit = join(saveDir, '.git', 'hooks', 'pre-commit');
    const evPostCheckout = join(saveDir, '.git', 'hooks', 'post-checkout');
    assert.ok(existsSync(evPreCommit), 'evidence must hold modified pre-commit');
    assert.ok(existsSync(evPostCheckout), 'evidence must hold added post-checkout');
    assert.equal(readFileSync(evPreCommit, 'utf8'), '#!/bin/sh\nexit 1\n');
    assert.equal(readFileSync(evPostCheckout, 'utf8'), '#!/bin/sh\necho new\n');
  } finally {
    unpinLayout(dir);
  }
});

test('B2: hook mode change is detected and restored on POSIX', (t) => {
  if (process.platform === 'win32') {
    t.skip('no exec bits on win32');
    return;
  }
  makeHome();
  const { dir } = makeRepo();
  const hooksDir = join(dir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
  chmodSync(hookPath, 0o644);

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    chmodSync(hookPath, 0o755);

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].area, 'hooks');
    assert.equal(entries[0].change, 'mode');
    assert.equal(entries[0].restorable, true);
    assert.equal(entries[0].restored, true);

    const nowMode = lstatSync(hookPath).mode & 0o777;
    assert.equal(nowMode, 0o644);
  } finally {
    unpinLayout(dir);
  }
});

test('B3: core.hooksPath pointing to ignored in-tree directory is checked and restored', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, '.gitignore'), '.hooks/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'ignore .hooks');
  git(dir, 'config', 'core.hooksPath', '.hooks');
  mkdirSync(join(dir, '.hooks'), { recursive: true });

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const expectedHooks = resolve(dir, git(dir, 'rev-parse', '--git-path', 'hooks').trim());
    assert.ok(samePath(baseline.paths.hooksDir, expectedHooks));

    const hookPath = join(dir, '.hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].area, 'hooks');
    assert.equal(entries[0].change, 'added');
    assert.equal(entries[0].restored, true);
    assert.equal(existsSync(hookPath), false);
  } finally {
    unpinLayout(dir);
  }
});

test('B4: core.hooksPath change in config is caught as config change and baseline hooks path keeps being checked', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const extDir = mkTmp('zc-b4-ext-');
    git(dir, 'config', 'core.hooksPath', extDir.replace(/\\/g, '/'));
    const plantedHook = join(dir, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(plantedHook), { recursive: true });
    writeFileSync(plantedHook, '#!/bin/sh\nexit 0\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    const cfgEntry = entries.find((e) => e.area === 'config' && e.change === 'modified');
    const hookEntry = entries.find((e) => e.area === 'hooks' && e.change === 'added');

    assert.ok(cfgEntry, 'must report config modified entry');
    assert.ok(hookEntry, 'must report hooks added entry');
    assert.equal(cfgEntry.restored, true);
    assert.equal(hookEntry.restored, true);

    const configBaseFile = baseline.files.find((f) => samePath(f.path, join(dir, '.git', 'config')));
    assert.equal(
      Buffer.compare(readFileSync(join(dir, '.git', 'config')), configBaseFile.bytes),
      0
    );
    assert.equal(existsSync(plantedHook), false);
  } finally {
    unpinLayout(dir);
  }
});

test('B5: alias appended to .git/config is restored byte for byte', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const cfgPath = join(dir, '.git', 'config');
    const origBytes = readFileSync(cfgPath);
    writeFileSync(cfgPath, Buffer.concat([origBytes, Buffer.from('[alias]\n\tst = !echo pwned\n')]));

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].area, 'config');
    assert.equal(entries[0].change, 'modified');
    assert.equal(entries[0].restored, true);

    const restoredBytes = readFileSync(cfgPath);
    assert.equal(Buffer.compare(restoredBytes, origBytes), 0);

    const inert = checkMetaInert(dir, layout, baseline);
    assert.deepEqual(inert, []);
  } finally {
    unpinLayout(dir);
  }
});

test('B6: baseline include file inside work tree hidden by gitignore is detected and restored', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, '.gitignore'), 'local.cfg\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'ignore local.cfg');

  const localCfgPath = join(dir, 'local.cfg');
  writeFileSync(localCfgPath, '[user]\n\tname = Base\n');
  git(dir, 'config', 'include.path', '../local.cfg');

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const rec = baseline.files.find((f) => samePath(f.path, localCfgPath));
    assert.ok(rec, 'baseline files must contain record for local.cfg');
    assert.equal(rec.private, true);

    writeFileSync(localCfgPath, '[user]\n\tname = Modified\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'local.cfg');
    assert.equal(entries[0].restored, true);

    const inert = checkMetaInert(dir, layout, baseline);
    assert.deepEqual(inert, []);
  } finally {
    unpinLayout(dir);
  }
});

test('B7: dangling baseline include target created outside private area is detected by checkMetaInert', () => {
  makeHome();
  const { dir } = makeRepo();
  const tmpOutside = mkTmp('zc-b7-ext-');
  const laterPath = join(tmpOutside, 'later.cfg');
  git(dir, 'config', 'include.path', laterPath.replace(/\\/g, '/'));

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    writeFileSync(laterPath, '[core]\n\tfsmonitor = x\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });
    assert.deepEqual(entries, []);

    const inert = checkMetaInert(dir, layout, baseline);
    assert.equal(inert.length, 1);
    assert.equal(inert[0].area, 'config-effective');
    assert.equal(inert[0].restorable, false);
    assert.equal(existsSync(laterPath), true);
  } finally {
    unpinLayout(dir);
  }
});

test('B8: info/exclude modified and info/attributes added are restored', () => {
  makeHome();
  const { dir } = makeRepo();
  const attrPath = join(dir, '.git', 'info', 'attributes');
  if (existsSync(attrPath)) {
    rmSync(attrPath);
  }

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const excludePath = join(dir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, Buffer.concat([readFileSync(excludePath), Buffer.from('\n# appended line\n')]));
    writeFileSync(attrPath, '* text=auto\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    const modEntry = entries.find((e) => e.path.endsWith('exclude') && e.change === 'modified');
    const addEntry = entries.find((e) => e.path.endsWith('attributes') && e.change === 'added');

    assert.ok(modEntry, 'exclude modified entry must exist');
    assert.ok(addEntry, 'attributes added entry must exist');
    assert.equal(modEntry.restored, true);
    assert.equal(addEntry.restored, true);
    assert.equal(existsSync(attrPath), false);
  } finally {
    unpinLayout(dir);
  }
});

test('B9: branch and tag creation detected as refs change and remotes/pack-refs ignored', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    git(dir, 'branch', 'b9');
    git(dir, 'tag', 't9');

    const inert = checkMetaInert(dir, layout, baseline);
    const b9Entry = inert.find((e) => e.path === 'refs/heads/b9' && e.change === 'added');
    const t9Entry = inert.find((e) => e.path === 'refs/tags/t9' && e.change === 'added');

    assert.ok(b9Entry, 'refs/heads/b9 added entry must exist');
    assert.ok(t9Entry, 'refs/tags/t9 added entry must exist');
    assert.equal(b9Entry.restorable, false);
    assert.equal(t9Entry.restorable, false);

    assert.ok(git(dir, 'rev-parse', '--verify', 'refs/heads/b9').trim());
    assert.ok(git(dir, 'rev-parse', '--verify', 'refs/tags/t9').trim());

    const baseline2 = metaBaseline(dir, layout);
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const inert2 = checkMetaInert(dir, layout, baseline2);
    assert.deepEqual(inert2, []);

    const baseline3 = metaBaseline(dir, layout);
    git(dir, 'pack-refs', '--all');
    const inert3 = checkMetaInert(dir, layout, baseline3);
    assert.deepEqual(inert3, []);
  } finally {
    unpinLayout(dir);
  }
});

test('B10: fail-closed errors at baseline and unreadable hooks dir after phase', (t) => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const hooksDir = join(dir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const bigHookPath = join(hooksDir, 'big-hook');
    writeFileSync(bigHookPath, Buffer.alloc(3 * 1024 * 1024, 0x61));
    assert.throws(
      () => metaBaseline(dir, layout),
      (err) => err.code === 'ZC_GIT_META' && /maxFileBytes/.test(err.message)
    );
    rmSync(bigHookPath, { force: true });

    const hookLink = join(hooksDir, 'link');
    let symlinkCreated = false;
    try {
      symlinkSync(join(dir, 'README.md'), hookLink);
      symlinkCreated = true;
    } catch (err) {
      t.diagnostic(`symlink creation skipped: ${err.message}`);
    }
    if (symlinkCreated) {
      assert.throws(
        () => metaBaseline(dir, layout),
        (err) => err.code === 'ZC_GIT_META' && /symlink/.test(err.message)
      );
      rmSync(hookLink, { force: true });
    }

    assert.throws(
      () => checkOrigins([{ scope: 'local', origin: 'blob:abc', key: 'a.b', value: 'c' }]),
      (err) => err.code === 'ZC_GIT_META' && /git metadata:/.test(err.message)
    );

    assert.throws(
      () => parseConfigList('a\0b\0'),
      (err) => err.code === 'ZC_GIT_META' && /git metadata:/.test(err.message)
    );

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const baseline = metaBaseline(dir, layout);
      chmodSync(hooksDir, 0);
      try {
        const saveDir = mkTmp('zc-ev-');
        const entries = checkMetaFiles(dir, layout, baseline, { saveDir });
        const unreadable = entries.find((e) => e.change === 'unreadable' && e.area === 'hooks');
        assert.ok(unreadable, 'must return an unreadable entry');
        assert.equal(unreadable.restorable, false);
      } finally {
        chmodSync(hooksDir, 0o755);
      }
    }
  } finally {
    unpinLayout(dir);
  }
});

test('B11: isPrivate with hand-built layout objects and segment/case rules', () => {
  const notLinked = {
    gitDir: resolve('/r/.git'),
    commonDir: resolve('/r/.git'),
    workTree: resolve('/r'),
    linked: false
  };
  assert.equal(isPrivate(notLinked, resolve('/r/.git')), true);
  assert.equal(isPrivate(notLinked, resolve('/r/.git/hooks/x')), true);
  assert.equal(isPrivate(notLinked, resolve('/r/src/a')), true);
  assert.equal(isPrivate(notLinked, resolve('/rr/a')), false);
  assert.equal(isPrivate(notLinked, resolve('/other')), false);

  const linked = {
    gitDir: resolve('/c/.git/worktrees/w'),
    commonDir: resolve('/c/.git'),
    workTree: resolve('/w'),
    linked: true
  };
  assert.equal(isPrivate(linked, resolve('/c/.git/worktrees/w/x')), true);
  assert.equal(isPrivate(linked, resolve('/w/a')), true);
  assert.equal(isPrivate(linked, resolve('/c/.git/hooks/x')), false);
  assert.equal(isPrivate(linked, resolve('/c/.git')), false);

  if (process.platform === 'win32') {
    const winLayout = {
      gitDir: resolve('c:/r/.git'),
      commonDir: resolve('c:/r/.git'),
      workTree: resolve('c:/r'),
      linked: false
    };
    assert.equal(isPrivate(winLayout, resolve('C:/R/a')), true);
  } else {
    const posixLayout = {
      gitDir: resolve('/r/.git'),
      commonDir: resolve('/r/.git'),
      workTree: resolve('/r'),
      linked: false
    };
    assert.equal(isPrivate(posixLayout, resolve('/R/a')), false);
  }
});

test('B12: not private hooks are detect only and evidence folder remains empty', () => {
  makeHome();
  const { dir } = makeRepo();
  const extDir = mkTmp('zc-b12-ext-');
  writeFileSync(join(extDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
  git(dir, 'config', 'core.hooksPath', extDir.replace(/\\/g, '/'));

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    assert.equal(baseline.hooks.private, false);

    writeFileSync(join(extDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(extDir, 'post-checkout'), '#!/bin/sh\necho new\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 2);
    const mod = entries.find((e) => e.change === 'modified');
    const add = entries.find((e) => e.change === 'added');
    assert.ok(mod, 'must report modified hook');
    assert.ok(add, 'must report added hook');
    assert.equal(mod.restorable, false);
    assert.equal(mod.restored, false);
    assert.equal(add.restorable, false);
    assert.equal(add.restored, false);

    assert.equal(readFileSync(join(extDir, 'pre-commit'), 'utf8'), '#!/bin/sh\nexit 1\n');
    assert.ok(existsSync(join(extDir, 'post-checkout')));
    assert.equal(readdirSync(saveDir).length, 0);
  } finally {
    unpinLayout(dir);
  }
});

test('B13: symlink where a protected config file is expected fails closed', (t) => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, '.gitignore'), 'real.cfg\nlink.cfg\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'ignore cfgs');
  writeFileSync(join(dir, 'real.cfg'), '[user]\n\tname = Base\n');
  try {
    symlinkSync('real.cfg', join(dir, 'link.cfg'));
  } catch (err) {
    t.skip(`symlink creation failed: ${err.message}`);
    return;
  }
  git(dir, 'config', 'include.path', '../link.cfg');
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    assert.throws(
      () => metaBaseline(dir, layout),
      (err) => err.code === 'ZC_GIT_META' && /git metadata:/.test(err.message)
    );
  } finally {
    unpinLayout(dir);
  }
});

test('B14: checkMetaFiles does not write or delete through symlinked hooks dir', (t) => {
  makeHome();
  const { dir } = makeRepo();
  git(dir, 'config', 'core.hooksPath', '.hooks');

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    assert.equal(baseline.hooks.exists, false);

    const victimDir = mkTmp('zc-victim14-');
    const keepPath = join(victimDir, 'keep.txt');
    writeFileSync(keepPath, 'keep content\n');

    try {
      symlinkSync(victimDir, join(dir, '.hooks'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`symlink creation failed: ${err.message}`);
      return;
    }

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].area, 'hooks');
    assert.equal(entries[0].change, 'added');
    assert.equal(entries[0].restorable, false);
    assert.equal(entries[0].restored, false);

    assert.ok(existsSync(keepPath));
    assert.equal(readFileSync(keepPath, 'utf8'), 'keep content\n');
    assert.ok(lstatSync(join(dir, '.hooks')).isSymbolicLink());
  } finally {
    unpinLayout(dir);
  }
});

test('B15: checkMetaFiles does not write through symlinked hooks subdirectory', (t) => {
  makeHome();
  const { dir } = makeRepo();
  const hooksDir = join(dir, '.git', 'hooks');
  const subDir = join(hooksDir, 'sub');
  mkdirSync(subDir, { recursive: true });
  const subX = join(subDir, 'x');
  writeFileSync(subX, 'a');

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const victimDir = mkTmp('zc-victim15-');
    writeFileSync(join(victimDir, 'victim.txt'), 'safe\n');
    const victimBefore = readdirSync(victimDir);

    rmSync(subDir, { recursive: true, force: true });
    try {
      symlinkSync(victimDir, subDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`symlink creation failed: ${err.message}`);
      return;
    }

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    const victimAfter = readdirSync(victimDir);
    assert.deepEqual(victimAfter, victimBefore);
    assert.equal(readFileSync(join(victimDir, 'victim.txt'), 'utf8'), 'safe\n');

    const entryX = entries.find((e) => e.path.endsWith('sub/x'));
    assert.ok(entryX, 'sub/x entry must exist');
    assert.equal(entryX.restorable, false);
    assert.equal(entryX.restored, false);
  } finally {
    unpinLayout(dir);
  }
});

test('B16: checkMetaFiles does not write through symlinked info directory', (t) => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const victimDir = mkTmp('zc-victim16-');
    const victimExclude = join(victimDir, 'exclude');
    writeFileSync(victimExclude, 'v');

    const infoDir = join(dir, '.git', 'info');
    rmSync(infoDir, { recursive: true, force: true });
    try {
      symlinkSync(victimDir, infoDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`symlink creation failed: ${err.message}`);
      return;
    }

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.equal(readFileSync(victimExclude, 'utf8'), 'v');

    const excludeEntry = entries.find((e) => e.path.endsWith('exclude'));
    assert.ok(excludeEntry, 'exclude entry must exist');
    assert.equal(excludeEntry.restorable, false);
    assert.equal(excludeEntry.restored, false);
  } finally {
    unpinLayout(dir);
  }
});

test('B17: added directory tree restored flag and hooks dir entry', () => {
  makeHome();
  const { dir } = makeRepo();
  git(dir, 'config', 'core.hooksPath', '.hooks2');

  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    assert.equal(baseline.hooks.exists, false);

    const hooks2Dir = join(dir, '.hooks2');
    const dDir = join(hooks2Dir, 'd');
    mkdirSync(dDir, { recursive: true });
    writeFileSync(join(dDir, 'h'), '#!/bin/sh\nexit 0\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    assert.ok(entries.length > 0, 'must have entries');
    for (const entry of entries) {
      assert.equal(entry.restored, true, `entry ${entry.path} must have restored: true`);
    }
    assert.equal(existsSync(hooks2Dir), false, '.hooks2 must no longer exist');

    const dirEntry = entries.find((e) => e.area === 'hooks' && (e.path === '.hooks2' || e.path.endsWith('.hooks2')));
    assert.ok(dirEntry, 'an entry for the hooks directory itself must exist');
    assert.equal(dirEntry.change, 'added');
  } finally {
    unpinLayout(dir);
  }
});

test('B18: checkMetaFiles never throws on corrupted baseline', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    baseline.hooks.entries = null;

    let entries;
    assert.doesNotThrow(() => {
      entries = checkMetaFiles(dir, layout, baseline);
    });

    assert.ok(Array.isArray(entries), 'must return an array');
    assert.ok(entries.length > 0, 'must have entries');
    const lastEntry = entries[entries.length - 1];
    assert.equal(lastEntry.change, 'unreadable');
    assert.equal(lastEntry.area, 'git');
    assert.equal(lastEntry.path, '.git');
  } finally {
    unpinLayout(dir);
  }
});

test('B19: non-private config/info file is detect-only', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);

    const extFolder = mkTmp('zc-b19-ext-');
    const extFile = join(extFolder, 'ext.cfg');
    writeFileSync(extFile, 'original content\n');

    const fakeRecord = {
      area: 'config',
      path: extFile,
      private: false,
      bytes: Buffer.from('original content\n')
    };
    baseline.files = [...baseline.files, fakeRecord];

    writeFileSync(extFile, 'modified content\n');

    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });

    const modEntry = entries.find((e) => samePath(e.path, extFile));
    assert.ok(modEntry, 'modified entry must exist');
    assert.equal(modEntry.change, 'modified');
    assert.equal(modEntry.restorable, false);
    assert.equal(modEntry.restored, false);
    assert.equal(readFileSync(extFile, 'utf8'), 'modified content\n');
  } finally {
    unpinLayout(dir);
  }
});

// B20-B24: ancestor-symlink escapes and fail-closed guard.
function treeSnapshot(dir, rel = '') {
  const out = {};
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) {
      out[`${r}/`] = null;
      Object.assign(out, treeSnapshot(dir, r));
    } else {
      out[r] = readFileSync(join(dir, r), 'utf8');
    }
  }
  return out;
}

function ancestorCase(t, { baselineFiles, victimFiles, mutate }) {
  makeHome();
  const { dir } = makeRepo();
  git(dir, 'config', 'core.hooksPath', 'sub/hooks');
  const sub = join(dir, 'sub');
  for (const [rel, body] of Object.entries(baselineFiles)) {
    mkdirSync(dirname(join(sub, rel)), { recursive: true });
    writeFileSync(join(sub, rel), body);
  }
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const victim = mkTmp('zc-victim-anc-');
    for (const [rel, body] of Object.entries(victimFiles)) {
      if (rel.endsWith('/')) {
        mkdirSync(join(victim, rel), { recursive: true });
        continue;
      }
      mkdirSync(dirname(join(victim, rel)), { recursive: true });
      writeFileSync(join(victim, rel), body);
    }
    rmSync(sub, { recursive: true, force: true });
    try {
      symlinkSync(victim, sub, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`symlink creation failed: ${err.message}`);
      return;
    }
    if (mutate) mutate(victim);
    const before = treeSnapshot(victim);
    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });
    assert.deepEqual(treeSnapshot(victim), before);
    for (const e of entries.filter((x) => x.area === 'hooks')) {
      assert.equal(e.restorable, false, JSON.stringify(e));
      assert.equal(e.restored, false, JSON.stringify(e));
    }
    return { entries, saveDir };
  } finally {
    unpinLayout(dir);
  }
}

test('B20: ancestor symlink over baseline hooks: no victim change, no evidence of victim content', (t) => {
  const r = ancestorCase(t, {
    baselineFiles: { 'hooks/h': 'orig' },
    victimFiles: { 'hooks/h': 'EVIL', 'hooks/extra': 'x' }
  });
  if (!r) return;
  assert.ok(r.entries.some((e) => e.area === 'hooks'), 'hooks entries expected');
  const ev = existsSync(r.saveDir) ? JSON.stringify(treeSnapshot(r.saveDir)) : '';
  assert.ok(!ev.includes('EVIL') && !ev.includes('"x"'), 'evidence must not hold victim content');
});

test('B21: ancestor symlink to empty victim: removed hooks are not recreated', (t) => {
  ancestorCase(t, { baselineFiles: { 'hooks/h': 'orig' }, victimFiles: {}, mutate: null });
});

test('B22: ancestor symlink with no baseline hooks dir: victim untouched', (t) => {
  ancestorCase(t, { baselineFiles: {}, victimFiles: { 'hooks/keep': 'k' } });
});

test('B23: ancestor symlink with added directory in victim: victim untouched', (t) => {
  ancestorCase(t, { baselineFiles: {}, victimFiles: { 'hooks/d/f': 'f' } });
});

test('B24: private hooks dir outside every layout root fails closed', () => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const outside = mkTmp('zc-b24-');
    baseline.hooks = { ...baseline.hooks, private: true, dir: outside, exists: false, entries: [] };
    const added = join(outside, 'added');
    writeFileSync(added, 'a');
    const entries = checkMetaFiles(dir, layout, baseline, {});
    const hit = entries.filter((e) => e.area === 'hooks');
    assert.ok(hit.length > 0, 'entry expected');
    for (const e of hit) assert.equal(e.restorable, false);
    assert.ok(existsSync(added));
  } finally {
    unpinLayout(dir);
  }
});

test('B25: ancestor symlink, victim has empty hooks dir: it is not removed', (t) => {
  ancestorCase(t, { baselineFiles: {}, victimFiles: { 'hooks/': null } });
});

test('B26: ancestor symlink, victim has empty subdirectory under hooks: it is not removed', (t) => {
  ancestorCase(t, { baselineFiles: {}, victimFiles: { 'hooks/d/': null, 'hooks/keep': 'k' } });
});

test('B27: ancestor symlink, baseline hooks exist, victim has extra empty dir: it is not removed', (t) => {
  ancestorCase(t, { baselineFiles: { 'hooks/h': 'orig' }, victimFiles: { 'hooks/h': 'orig', 'hooks/e/': null } });
});

test('B28: POSIX directory name containing a backslash that becomes a symlink: victim untouched', (t) => {
  if (process.platform === 'win32') {
    t.skip('backslash is a path separator on Windows');
    return;
  }
  makeHome();
  const { dir } = makeRepo();
  const bsDir = join(dir, '.git', 'hooks', 'a\\b');
  mkdirSync(bsDir, { recursive: true });
  writeFileSync(join(bsDir, 'f'), 'orig');
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const victim = mkTmp('zc-victim-bs-');
    rmSync(bsDir, { recursive: true, force: true });
    try {
      symlinkSync(victim, bsDir, 'dir');
    } catch (err) {
      t.skip(`symlink creation failed: ${err.message}`);
      return;
    }
    const before = treeSnapshot(victim);
    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });
    assert.deepEqual(treeSnapshot(victim), before);
    const removed = entries.find((e) => e.change === 'removed');
    assert.ok(removed, 'removed entry expected');
    assert.equal(removed.restorable, false);
    assert.equal(removed.restored, false);
  } finally {
    unpinLayout(dir);
  }
});

// B29-B32: hard-linked targets must never be modified in place.
function hardlinkCase(t, { name, baseBody, baseMode, victimBody, victimMode, change }) {
  makeHome();
  const { dir } = makeRepo();
  const hooks = join(dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-commit');
  if (baseBody !== null) {
    writeFileSync(hook, baseBody);
    chmodSync(hook, baseMode);
  }
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const vd = mkdtempSync(join(tmpdir(), `zc-victim-${name}-`));
    const victim = join(vd, 'victim');
    writeFileSync(victim, victimBody);
    chmodSync(victim, victimMode);
    rmSync(hook, { force: true });
    try {
      linkSync(victim, hook);
    } catch (err) {
      t.skip(`hard link creation failed: ${err.message}`);
      return;
    }
    const saveDir = mkTmp('zc-ev-');
    const entries = checkMetaFiles(dir, layout, baseline, { saveDir });
    assert.equal(readFileSync(victim, 'utf8'), victimBody);
    assert.equal(lstatSync(victim).mode & 0o777, victimMode);
    const hit = entries.find((e) => e.area === 'hooks' && e.path.endsWith('pre-commit'));
    assert.ok(hit, `entry expected (${change})`);
    assert.equal(hit.change, change);
    return hit;
  } finally {
    unpinLayout(dir);
  }
}

test('B29: hard-linked modified hook is not overwritten in place', (t) => {
  const hit = hardlinkCase(t, { name: 'b29', baseBody: 'orig', baseMode: 0o644, victimBody: 'PRECIOUS', victimMode: 0o600, change: 'modified' });
  if (!hit) return;
  assert.equal(hit.restored, false);
  assert.equal(hit.restorable, false);
});

test('B30: hard-linked hook with only a mode change: victim mode and content untouched', (t) => {
  if (process.platform === 'win32') {
    t.skip('mode bits');
    return;
  }
  const hit = hardlinkCase(t, { name: 'b30', baseBody: 'same', baseMode: 0o755, victimBody: 'same', victimMode: 0o644, change: 'mode' });
  if (!hit) return;
  assert.equal(hit.restored, false);
});

test('B31: hard-linked added hook is unlinked without touching the victim', (t) => {
  hardlinkCase(t, { name: 'b31', baseBody: null, baseMode: 0o644, victimBody: 'PRECIOUS', victimMode: 0o600, change: 'added' });
});

test('B32: hard-linked modified config/info file is not overwritten in place', (t) => {
  makeHome();
  const { dir } = makeRepo();
  const layout = gitLayout(dir);
  pinLayout(dir, layout);
  try {
    const baseline = metaBaseline(dir, layout);
    const target = join(dir, '.git', 'zc-b32-info');
    writeFileSync(target, 'orig');
    baseline.files = [...baseline.files, { area: 'info', path: target, private: true, bytes: Buffer.from('orig') }];
    const vd = mkTmp('zc-victim-b32-');
    const victim = join(vd, 'victim');
    writeFileSync(victim, 'PRECIOUS');
    rmSync(target);
    try {
      linkSync(victim, target);
    } catch (err) {
      t.skip(`hard link creation failed: ${err.message}`);
      return;
    }
    const entries = checkMetaFiles(dir, layout, baseline, {});
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS');
    const hit = entries.find((e) => e.path.endsWith('zc-b32-info'));
    assert.ok(hit);
    assert.equal(hit.restored, false);
    assert.equal(hit.restorable, false);
  } finally {
    unpinLayout(dir);
  }
});

test('A10: the no-hooks directory is per project, under the project state folder', () => {
  makeHome();
  const { dir: a } = makeRepo();
  const { dir: b } = makeRepo();
  assert.notEqual(noHooksDir(a), noHooksDir(b));
  assert.equal(noHooksDir(a), join(projectState(a), 'no-hooks'));
  statusEntries(a);
  assert.ok(existsSync(noHooksDir(a)));
  assert.ok(!existsSync(noHooksDir(b)), 'a git call in project A must not create the folder of project B');
});

test('A11: restoreIdentity refuses to write through a hard link', (t) => {
  makeHome();
  const { dir: main } = makeRepo();
  const wt = mkTmp('zc-wt11-');
  git(main, 'worktree', 'add', wt, '-b', 'wt11');
  const layout = gitLayout(wt);
  const dotGit = join(wt, '.git');
  const outside = mkTmp('zc-out11-');
  const victim = join(outside, 'victim');
  overwriteText(dotGit, 'gitdir: /bogus/decoy\n');
  writeFileSync(victim, 'PRECIOUS');
  rmSync(dotGit);
  try {
    linkSync(victim, dotGit);
  } catch (err) {
    t.skip(`hard link creation failed: ${err.message}`);
    return;
  }
  const changes = checkIdentity(wt, layout);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].restorable, true);
  const saveDir = mkTmp('save11-');
  const out = restoreIdentity(wt, layout, changes, { saveDir });
  assert.equal(out[0].restored, false);
  assert.match(out[0].detail, /hard link/);
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS');
});

test('A12: a git failure after the worker (no-hooks dir unusable) ends NEEDS_HUMAN with a result.json', async () => {
  const home = makeHome();
  const { dir, config } = makeRepo();
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  const hooks = noHooksDir(dir);
  const script = `const fs=require('fs');fs.rmSync(${JSON.stringify(hooks)},{recursive:true,force:true});fs.writeFileSync(${JSON.stringify(hooks)},'x');`;
  const t = task('id: T-a12\nallowed:\n  - src/');
  t.meta.verify = [[process.execPath, '-e', script]];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'NEEDS_HUMAN');
  assert.match(r.nextAction, /git/);
  assert.ok(existsSync(join(r.runDir, 'result.json')));
  assert.ok(!('workerState' in JSON.parse(readFileSync(join(r.runDir, 'result.json'), 'utf8'))), 'no git state recorded');
  assert.ok(home);
});

const paths = (dir) => statusEntries(dir).map((e) => e.path);

test('C1: a skip-worktree or assume-unchanged flag added during the phase is cleared and the edit shows', () => {
  makeHome();
  const { dir } = makeRepo();
  const base = flagsBaseline(dir);
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  writeFileSync(join(dir, 'src', 'keep.txt'), 'edited too\n');
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  git(dir, 'update-index', '--assume-unchanged', 'src/keep.txt');
  assert.deepEqual(paths(dir), [], 'the setup hides both edits');
  const out = checkFlags(dir, base);
  assert.deepEqual(out.map((e) => [e.path, e.change, e.restored]).sort(),
    [['README.md', 'flag-added', true], ['src/keep.txt', 'flag-added', true]]);
  assert.deepEqual(paths(dir).sort(), ['README.md', 'src/keep.txt']);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'edited\n');
});

test('C2: a baseline user flag removed during the phase is set again, content untouched', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'my local edit\n');
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  const base = flagsBaseline(dir);
  git(dir, 'update-index', '--no-skip-worktree', 'README.md');
  assert.deepEqual(paths(dir), ['README.md'], 'without the flag the edit looks like a change');
  const out = checkFlags(dir, base);
  assert.deepEqual(out.map((e) => [e.path, e.change, e.restored]), [['README.md', 'flag-removed', true]]);
  assert.deepEqual(paths(dir), []);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'my local edit\n');
});

test('C3: changed content of a baseline-flagged file is restored and the changed copy is saved', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'mine\n');
  git(dir, 'update-index', '--assume-unchanged', 'README.md');
  const base = flagsBaseline(dir);
  writeFileSync(join(dir, 'README.md'), 'worker was here\n');
  const saveDir = mkTmp('save-c3-');
  const out = checkFlags(dir, base, { saveDir });
  assert.deepEqual(out.map((e) => [e.path, e.change, e.restorable, e.restored]), [['README.md', 'modified', true, true]]);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(saveDir, 'README.md'), 'utf8'), 'worker was here\n');
});

test('C4: untouched pre-existing flags give no entries and change nothing', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'mine\n');
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  git(dir, 'update-index', '--assume-unchanged', 'src/keep.txt');
  const before = git(dir, 'ls-files', '-v');
  const base = flagsBaseline(dir);
  assert.deepEqual(checkFlags(dir, base), []);
  assert.equal(git(dir, 'ls-files', '-v'), before);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'mine\n');
});

test('C5: unparsable ls-files output and an over-cap flagged file fail closed', () => {
  assert.throws(() => parseFlags('garbage-without-tag\0'), GitMetaError);
  assert.deepEqual([...parseFlags('H a\0h b\0S c\0s d\0').assume].sort(), ['b', 'd']);
  assert.deepEqual([...parseFlags('H a\0h b\0S c\0s d\0').skip].sort(), ['c', 'd']);
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), 'x'.repeat(100));
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  assert.throws(() => flagsBaseline(dir, { maxFileBytes: 10 }), GitMetaError);
});

test('C6: a symlinked flagged path is never written through', (t) => {
  makeHome();
  const { dir } = makeRepo();
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  const base = flagsBaseline(dir);
  const outside = mkTmp('zc-out-c6-');
  const victim = join(outside, 'victim');
  writeFileSync(victim, 'PRECIOUS');
  rmSync(join(dir, 'README.md'));
  try {
    symlinkSync(victim, join(dir, 'README.md'));
  } catch (err) {
    t.skip(`symlink creation failed: ${err.message}`);
    return;
  }
  const out = checkFlags(dir, base, { saveDir: mkTmp('save-c6-') });
  assert.equal(out.find((e) => e.change === 'modified').restored, false);
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS');
});

test('C7: a flagged file that grows past the cap is reported, not read or restored', () => {
  makeHome();
  const { dir } = makeRepo();
  git(dir, 'update-index', '--skip-worktree', 'README.md');
  const base = flagsBaseline(dir);
  writeFileSync(join(dir, 'README.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
  const out = checkFlags(dir, base);
  assert.deepEqual(out.map((e) => [e.path, e.restorable, e.restored]), [['README.md', false, false]]);
  assert.match(out[0].detail, /exceeds/);
});

test('C8: a huge flagged file is rejected from its size before it is read', () => {
  makeHome();
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'README.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
  git(dir, 'update-index', '--assume-unchanged', 'README.md');
  assert.throws(() => flagsBaseline(dir), /exceeds maxFileBytes/);
});
