import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as G from './gitx.mjs';

export function overwriteText(path, text) {
  let fd;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      writeFileSync(path, text);
      return;
    }
    throw error;
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

function toReportPath(root, targetPath) {
  const fullRoot = resolve(root);
  const fullTarget = resolve(targetPath);
  const rel = relative(fullRoot, fullTarget);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    return rel.split('\\').join('/');
  }
  return fullTarget;
}

export function gitLayout(root) {
  let out;
  try {
    out = G.git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
      timeoutMs: G.inertTimeoutMs()
    });
  } catch (error) {
    throw new Error(`git layout: rev-parse failed: ${error.message}`);
  }

  const lines = out.split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) {
    throw new Error('git layout: incomplete rev-parse output');
  }

  const workTree = resolve(lines[0]);
  const gitDir = resolve(lines[1]);
  const commonDir = resolve(root, lines[2]);

  if (!samePath(workTree, root)) {
    throw new Error(`git layout: toplevel "${workTree}" does not match root "${root}"`);
  }

  const dotGitPath = join(root, '.git');
  let dotGitStat;
  try {
    dotGitStat = lstatSync(dotGitPath);
  } catch {
    throw new Error(`git layout: .git is missing at ${dotGitPath}`);
  }

  if (dotGitStat.isSymbolicLink()) {
    throw new Error(`git layout: .git is a symlink at ${dotGitPath}`);
  }

  if (!dotGitStat.isDirectory() && !dotGitStat.isFile()) {
    throw new Error(`git layout: .git is neither directory nor file at ${dotGitPath}`);
  }

  for (const [name, dirPath] of [['git-dir', gitDir], ['common-dir', commonDir]]) {
    let st;
    try {
      st = lstatSync(dirPath);
    } catch {
      throw new Error(`git layout: ${name} is missing at ${dirPath}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`git layout: ${name} is a symlink at ${dirPath}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`git layout: ${name} is not a directory at ${dirPath}`);
    }
  }

  const linked = !samePath(gitDir, commonDir);
  const dotGit = {
    kind: dotGitStat.isDirectory() ? 'dir' : 'file',
    text: dotGitStat.isFile() ? readFileSync(dotGitPath, 'utf8') : null
  };

  let worktreeFiles;
  if (linked) {
    let gd = null;
    try { gd = readFileSync(join(gitDir, 'gitdir'), 'utf8'); } catch { gd = null; }
    let cd = null;
    try { cd = readFileSync(join(gitDir, 'commondir'), 'utf8'); } catch { cd = null; }
    worktreeFiles = { gitdir: gd, commondir: cd };
  } else {
    worktreeFiles = { gitdir: null, commondir: null };
  }

  const stGitDir = lstatSync(gitDir, { bigint: true });
  const stCommonDir = lstatSync(commonDir, { bigint: true });

  const identity = {
    gitDir: {
      real: realpathSync.native(gitDir),
      dev: String(stGitDir.dev),
      ino: String(stGitDir.ino)
    },
    commonDir: {
      real: realpathSync.native(commonDir),
      dev: String(stCommonDir.dev),
      ino: String(stCommonDir.ino)
    }
  };

  return {
    workTree,
    gitDir,
    commonDir,
    linked,
    dotGit,
    worktreeFiles,
    identity
  };
}

export function checkIdentity(root, layout) {
  const entries = [];
  const dotGitPath = join(root, '.git');
  let dotGitStat = null;
  let dotGitMissing = false;

  try {
    dotGitStat = lstatSync(dotGitPath);
  } catch {
    dotGitMissing = true;
  }

  if (dotGitMissing) {
    entries.push({
      area: 'git-dir',
      path: toReportPath(root, dotGitPath),
      change: 'replaced',
      restorable: false,
      restored: false,
      detail: '.git is missing'
    });
  } else if (dotGitStat.isSymbolicLink()) {
    entries.push({
      area: 'git-dir',
      path: toReportPath(root, dotGitPath),
      change: 'replaced',
      restorable: false,
      restored: false,
      detail: '.git is a symlink'
    });
  } else {
    const currentKind = dotGitStat.isDirectory() ? 'dir' : (dotGitStat.isFile() ? 'file' : 'other');
    if (currentKind !== layout.dotGit.kind) {
      entries.push({
        area: 'git-dir',
        path: toReportPath(root, dotGitPath),
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `.git changed kind from ${layout.dotGit.kind} to ${currentKind}`
      });
    } else if (layout.dotGit.kind === 'file') {
      let currentText = null;
      try {
        currentText = readFileSync(dotGitPath, 'utf8');
      } catch {
        currentText = null;
      }
      if (currentText !== layout.dotGit.text) {
        entries.push({
          area: 'git-dir',
          path: toReportPath(root, dotGitPath),
          change: 'modified',
          restorable: true,
          restored: false,
          detail: '.git file content modified'
        });
      }
    }
  }

  if (layout.linked) {
    const checkWf = (name, recorded) => {
      const p = join(layout.gitDir, name);
      let text = null;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      if (text !== recorded) {
        entries.push({
          area: 'git-dir',
          path: toReportPath(root, p),
          change: 'modified',
          restorable: true,
          restored: false,
          detail: `${name} file content modified`
        });
      }
    };
    checkWf('gitdir', layout.worktreeFiles.gitdir);
    checkWf('commondir', layout.worktreeFiles.commondir);
  }

  const dirs = [['git-dir', layout.gitDir, layout.identity.gitDir]];
  if (layout.linked || !samePath(layout.gitDir, layout.commonDir)) {
    dirs.push(['common-dir', layout.commonDir, layout.identity.commonDir]);
  }

  for (const [label, dirPath, recorded] of dirs) {
    const repPath = toReportPath(root, dirPath);
    if (entries.some((e) => e.path === repPath && e.change === 'replaced')) {
      continue;
    }

    let st = null;
    try {
      st = lstatSync(dirPath, { bigint: true });
    } catch {
      st = null;
    }

    if (!st) {
      entries.push({
        area: 'git-dir',
        path: repPath,
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `${label} directory is missing`
      });
      continue;
    }

    if (st.isSymbolicLink()) {
      entries.push({
        area: 'git-dir',
        path: repPath,
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `${label} is a symlink`
      });
      continue;
    }

    if (!st.isDirectory()) {
      entries.push({
        area: 'git-dir',
        path: repPath,
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `${label} is not a directory`
      });
      continue;
    }

    let real = null;
    try {
      real = realpathSync.native(dirPath);
    } catch {
      real = null;
    }

    if (real !== recorded.real) {
      entries.push({
        area: 'git-dir',
        path: repPath,
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `${label} realpath differs: ${real} !== ${recorded.real}`
      });
      continue;
    }

    const nonZero = recorded.dev !== '0' && recorded.ino !== '0' && st.dev !== 0n && st.ino !== 0n;
    if (nonZero && (String(st.dev) !== recorded.dev || String(st.ino) !== recorded.ino)) {
      entries.push({
        area: 'git-dir',
        path: repPath,
        change: 'replaced',
        restorable: false,
        restored: false,
        detail: `${label} dev or ino differs`
      });
    }
  }

  return entries;
}

export function restoreIdentity(root, layout, changes, { saveDir }) {
  for (const entry of changes) {
    if (!entry.restorable) continue;
    try {
      const fullPath = isAbsolute(entry.path) ? entry.path : resolve(root, entry.path);
      const destPath = isAbsolute(entry.path)
        ? join(saveDir, `git-dir-${basename(entry.path)}`)
        : join(saveDir, entry.path);

      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(fullPath, destPath);

      let recordedText = null;
      if (samePath(fullPath, join(root, '.git'))) {
        recordedText = layout.dotGit.text;
      } else if (layout.linked && samePath(fullPath, join(layout.gitDir, 'gitdir'))) {
        recordedText = layout.worktreeFiles.gitdir;
      } else if (layout.linked && samePath(fullPath, join(layout.gitDir, 'commondir'))) {
        recordedText = layout.worktreeFiles.commondir;
      }

      if (recordedText !== null) {
        overwriteText(fullPath, recordedText);
        const reRead = readFileSync(fullPath, 'utf8');
        if (reRead === recordedText) {
          entry.restored = true;
        } else {
          entry.restored = false;
        }
      }
    } catch (error) {
      entry.restored = false;
      entry.detail = entry.detail ? `${entry.detail}: ${error.message}` : error.message;
    }
  }
  return changes;
}
