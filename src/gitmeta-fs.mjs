import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
    if (fstatSync(fd).nlink > 1) {
      throw new Error('refusing in-place write: target has multiple hard links');
    }
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

export class GitMetaError extends Error {
  constructor(message) {
    const msg = message && message.startsWith('git metadata:')
      ? message
      : `git metadata: ${message}`;
    super(msg);
    this.name = 'GitMetaError';
    this.code = 'ZC_GIT_META';
  }
}

function isInsideOrEqual(parent, target) {
  if (typeof parent !== 'string' || typeof target !== 'string') return false;
  let p = resolve(parent);
  let t = resolve(target);
  if (process.platform === 'win32') {
    p = p.toLowerCase();
    t = t.toLowerCase();
  }
  if (p === t) return true;
  const sepChar = process.platform === 'win32' ? '\\' : '/';
  const prefix = p.endsWith(sepChar) ? p : p + sepChar;
  return t.startsWith(prefix);
}

export function isPrivate(layout, absPath) {
  if (!layout || !absPath) return false;
  if (isInsideOrEqual(layout.gitDir, absPath)) return true;
  if (!layout.linked && isInsideOrEqual(layout.commonDir, absPath)) return true;
  if (isInsideOrEqual(layout.workTree, absPath)) return true;
  return false;
}

export function evidencePath(saveDir, root, absPath) {
  const fullRoot = resolve(root);
  const fullTarget = resolve(absPath);
  const rel = relative(fullRoot, fullTarget);
  if (!rel.startsWith('..') && !isAbsolute(rel) && rel !== '') {
    return join(saveDir, rel);
  }
  let p = fullTarget;
  if (/^[a-zA-Z]:/.test(p)) {
    p = p.replace(/^([a-zA-Z]):/, '$1');
  }
  p = p.replace(/^[\\/]+/, '');
  return join(saveDir, 'abs', p);
}

export function overwriteBytes(path, buffer) {
  let fd;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      writeFileSync(path, buffer);
      return;
    }
    throw error;
  }
  try {
    // In-place writes would also change every other hard link to this inode.
    if (fstatSync(fd).nlink > 1) {
      throw new Error('refusing in-place write: target has multiple hard links');
    }
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
}

export function hasSymlinkBelow(rootDir, target, layout = null) {
  // Fail closed: anything not provably inside rootDir counts as a crossing.
  if (!rootDir || !target) return true;
  const rRoot = resolve(rootDir);
  const rTarget = resolve(target);
  if (!isInsideOrEqual(rRoot, rTarget)) return true;
  const isGitRoot = layout && (samePath(rRoot, resolve(layout.gitDir)) ||
    (layout.commonDir && samePath(rRoot, resolve(layout.commonDir))));
  const parts = relative(rRoot, rTarget).split(sep).filter(Boolean);
  let cur = rRoot;
  const toCheck = isGitRoot ? [''].concat(parts) : parts;
  for (const part of toCheck) {
    if (part) cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch (err) {
      // Split on the platform separator only (a POSIX name may contain '\\').
      // A missing or non-directory component hides nothing deeper: nothing
      // below it can exist, so ending the walk here is sound.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) break;
      return true;
    }
  }
  return false;
}

export function layoutRootFor(layout, target) {
  if (!layout || !target) return null;
  if (isInsideOrEqual(layout.gitDir, target)) return layout.gitDir;
  if (!layout.linked && isInsideOrEqual(layout.commonDir, target)) return layout.commonDir;
  if (isInsideOrEqual(layout.workTree, target)) return layout.workTree;
  return null;
}
