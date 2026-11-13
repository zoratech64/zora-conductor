import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { stateRoot } from './paths.mjs';
import { captureState } from './snapshot.mjs';

export function inertTimeoutMs() {
  const envVal = Number(process.env.ZC_GIT_INERT_TIMEOUT_MS);
  return Number.isInteger(envVal) && envVal > 0 ? envVal : 60000;
}

export const noHooksDir = () => join(stateRoot(), 'no-hooks');

function prepareNoHooksDir() {
  const dir = noHooksDir();
  try {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    if (readdirSync(dir).length > 0) {
      throw new Error(`hooks directory is not empty: ${dir}`);
    }
  } catch (error) {
    if (error.message?.includes(dir)) throw error;
    throw new Error(`cannot create or empty hooks directory "${dir}": ${error.message}`);
  }
  return dir;
}

const pinnedLayouts = new Map();

function layoutKey(root) {
  const full = resolve(root);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function pinLayout(root, layout) {
  pinnedLayouts.set(layoutKey(root), layout);
}

export function unpinLayout(root) {
  pinnedLayouts.delete(layoutKey(root));
}

/** Fingerprints of every currently changed path (never `.zc/`). */
/** Index entry (mode, blob, stage) of each path, or '-' when it is not in the index. */
function indexState(root, paths) {
  const out = Object.fromEntries(paths.map((p) => [p, '-']));
  for (let i = 0; i < paths.length; i += 100) {
    const raw = git(root, ['ls-files', '-s', '-z', '--', ...paths.slice(i, i + 100)], {
      allowFail: true,
      timeoutMs: inertTimeoutMs()
    }).stdout ?? '';
    for (const row of raw.split('\0').filter(Boolean)) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(row);
      if (m) out[m[4]] = out[m[4]] === '-' ? `${m[1]}:${m[2]}:${m[3]}` : `${out[m[4]]},${m[1]}:${m[2]}:${m[3]}`;
    }
  }
  return out;
}

/**
 * What each path looks like right now: working-tree content plus staged (index) state. Staging a file
 * therefore counts as a change, so nothing you staged is ever discarded as "the worker's".
 */
export function pathStates(root, paths) {
  const unique = [...new Set(paths)].sort();
  const wt = captureState(root, unique);
  const idx = indexState(root, unique);
  return Object.fromEntries(unique.map((p) => [p, `${wt[p]}#${idx[p]}`]));
}

export const dirtyState = (root) => pathStates(root, changedPaths(statusEntries(root)));

export function git(root, args, { allowFail = false, timeoutMs = 0 } = {}) {
  prepareNoHooksDir();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) {
      env[key] = value;
    }
  }
  const layout = pinnedLayouts.get(layoutKey(root));
  if (layout) {
    env.GIT_DIR = layout.gitDir;
    env.GIT_COMMON_DIR = layout.commonDir;
    env.GIT_WORK_TREE = layout.workTree;
  }
  const argv = [
    '-c', 'core.quotepath=off',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${noHooksDir()}`,
    ...args
  ];
  const result = spawnSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs || undefined
  });
  if (result.error?.code === 'ETIMEDOUT') {
    const subcmd = args.find((a) => !a.startsWith('-')) ?? args[0] ?? 'command';
    const err = new Error(`git ${subcmd} timed out after ${timeoutMs}ms`);
    err.code = 'ZC_GIT_TIMEOUT';
    throw err;
  }
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return allowFail ? result : result.stdout;
}

export function toplevel(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true, timeoutMs: inertTimeoutMs() });
  return result.status === 0 ? resolve(result.stdout.trim()) : null;
}

export function head(root) {
  const result = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true, timeoutMs: inertTimeoutMs() });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function branch(root) {
  const result = git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true, timeoutMs: inertTimeoutMs() });
  return result.status === 0 ? result.stdout.trim() : '(detached)';
}

export function configList(root) {
  return git(root, ['config', '--list', '--show-origin', '--show-scope', '--includes', '-z'], {
    timeoutMs: inertTimeoutMs()
  });
}

const isZc = (path) => path === '.zc' || path.startsWith('.zc/');

export const isZcPath = isZc;

/**
 * Changed paths from `git status`. The project's own .zc/ folder is left out unless `includeZc` is set;
 * action code (rollback, clean-tree checks) never touches it, scope checks look at it separately.
 */
export function statusEntries(root, { includeZc = false } = {}) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    entries.push({ xy, path: parts[i].slice(3) });
    if (/[RC]/.test(xy)) entries.push({ xy, path: parts[++i] }); // rename/copy: also the source path
  }
  return includeZc ? entries : entries.filter((entry) => !isZc(entry.path));
}

export const changedPaths = (entries) => [...new Set(entries.map((e) => e.path))].sort();

/** Keep a copy of a worker's uncommitted work before anything is rolled back. */
export function savePartial(root, dir, entries) {
  mkdirSync(dir, { recursive: true });
  const patch = git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--', '.', ':(exclude).zc'], { allowFail: true });
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

const inHead = (root, path) =>
  git(root, ['cat-file', '-e', `HEAD:${path}`], { allowFail: true, timeoutMs: inertTimeoutMs() }).status === 0;

/**
 * Roll back only the given dirty paths, and only those whose content is exactly what `expected` records
 * (path -> fingerprint). A path that changed again since, or that is not in `expected`, is left alone and
 * reported as a conflict. Returns { restored, conflicts: [{path, reason}] }.
 */
export function rollbackPaths(root, entries, expected) {
  const restored = [];
  const conflicts = [];
  const todo = [];
  const paths = changedPaths(entries).filter((p) => !isZc(p));
  const now = pathStates(root, paths);
  for (const path of paths) {
    if (!(path in expected)) { conflicts.push({ path, reason: 'not part of the recorded worker result' }); continue; }
    if (now[path] !== expected[path]) { conflicts.push({ path, reason: 'changed or staged after the worker finished' }); continue; }
    todo.push(path);
  }
  const tracked = todo.filter((p) => inHead(root, p));
  const fresh = todo.filter((p) => !tracked.includes(p));
  for (let i = 0; i < tracked.length; i += 100) {
    git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked.slice(i, i + 100)], { allowFail: true });
  }
  for (const path of fresh) {
    git(root, ['rm', '-r', '-f', '--cached', '-q', '--ignore-unmatch', '--', path], { allowFail: true });
    removeUntracked(root, path);
  }
  const still = new Set(changedPaths(statusEntries(root)));
  for (const path of todo) (still.has(path) ? conflicts : restored).push(still.has(path) ? { path, reason: 'could not be restored' } : path);
  return { restored, conflicts };
}
