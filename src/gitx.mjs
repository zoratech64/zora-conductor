import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return allowFail ? result : result.stdout;
}

export function toplevel(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return result.status === 0 ? resolve(result.stdout.trim()) : null;
}

export function head(root) {
  const result = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function branch(root) {
  const result = git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  return result.status === 0 ? result.stdout.trim() : '(detached)';
}

const isZc = (path) => path === '.zc' || path.startsWith('.zc/');

/** Changed paths from `git status`, ignoring the project's own .zc/ folder. */
export function statusEntries(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    entries.push({ xy, path: parts[i].slice(3) });
    if (/[RC]/.test(xy)) entries.push({ xy, path: parts[++i] }); // rename/copy: also the source path
  }
  return entries.filter((entry) => !isZc(entry.path));
}

export const changedPaths = (entries) => [...new Set(entries.map((e) => e.path))].sort();

/** Keep a copy of a worker's uncommitted work before anything is rolled back. */
export function savePartial(root, dir, entries) {
  mkdirSync(dir, { recursive: true });
  const patch = git(root, ['diff', 'HEAD', '--binary', '--', '.', ':(exclude).zc'], { allowFail: true });
  writeFileSync(join(dir, 'tracked.patch'), patch.stdout ?? '');
  const saved = [];
  for (const entry of entries.filter((e) => e.xy === '??')) {
    const source = resolve(root, entry.path);
    try {
      if (statSync(source).size > 5 * 1024 * 1024 || saved.length >= 200) continue;
      const target = join(dir, 'untracked', entry.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      saved.push(entry.path);
    } catch { /* vanished or unreadable: nothing to keep */ }
  }
  writeFileSync(join(dir, 'paths.json'), JSON.stringify({ changed: changedPaths(entries), untrackedSaved: saved }, null, 2));
  return dir;
}

function removeUntracked(root, relPath) {
  const full = resolve(root, relPath);
  if (!full.startsWith(resolve(root) + sep) || /(^|[\\/])\.git([\\/]|$)/.test(relPath)) return;
  rmSync(full, { force: true });
  for (let dir = dirname(full); dir !== resolve(root); dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length) break;
      rmdirSync(dir);
    } catch { break; }
  }
}

/**
 * Roll the working tree back to HEAD. Only called when the tree was verified
 * clean before the worker started, so everything dirty now is the worker's.
 * Returns the paths that are still dirty afterwards (expected: none).
 */
export function resetTree(root) {
  // .zc/ holds the manager's own notes (progress log, tasks); a worker rollback must never touch it.
  git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.', ':(exclude).zc'], { allowFail: true });
  for (const entry of statusEntries(root)) {
    if (entry.xy === '??') removeUntracked(root, entry.path);
  }
  return changedPaths(statusEntries(root));
}
