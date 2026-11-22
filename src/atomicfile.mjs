import { randomBytes } from 'node:crypto';
import {
  closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Durable atomic file replacement: exclusive temp file, data fsync, rename,
 * directory fsync where the platform supports it. A crash at any point leaves
 * either the old or the new complete file, never a partial one. Leftover temp
 * files (`<name>.<pid>.<random>.tmp`) are ignored by readers and swept by
 * sweepTemp once their writer is dead.
 *
 * `fault(point)` is a hook for tests: it is called at before-write, after-write,
 * before-fsync, before-rename and after-rename, and may throw or kill the process.
 */

const DEFAULT_MODE = 0o600;
const WIN = process.platform === 'win32';
const RENAME_RETRIES = 20;
const SWEEP_MIN_AGE_MS = 60_000; // never delete a temp file a writer in another namespace may still own

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function existingMode(path) {
  try { return statSync(path).mode & 0o777; } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(from, to); } catch (error) {
      // Windows refuses to replace a file another process has open; that is brief.
      const transient = WIN && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
      if (!transient || attempt >= RENAME_RETRIES) throw error;
      pause(10 + attempt * 5);
    }
  }
}

function syncDirectory(dir) {
  if (WIN) return; // directories cannot be opened for fsync on Windows
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (error) {
    // Best effort: the rename already happened, so the new file is in place either way.
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EACCES'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/**
 * `mode` forces the permission bits. `defaultMode` applies only to a new file;
 * an existing file keeps its bits. Replacing a symlink or hard link target
 * replaces it with a regular file (rename semantics), and ownership/ACLs are not kept.
 */
export function writeFileAtomic(path, data, { mode, defaultMode = DEFAULT_MODE, fault = () => {} } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = join(dir, `${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const wanted = mode ?? existingMode(path) ?? defaultMode;
  const fd = openSync(tmp, 'wx', wanted);
  let renamed = false;
  try {
    try {
      if (!WIN) fchmodSync(fd, wanted); // openSync's mode is reduced by the umask; keep it exact
      fault('before-write');
      writeAll(fd, bytes);
      fault('after-write');
      fault('before-fsync');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fault('before-rename');
    renameWithRetry(tmp, path);
    renamed = true;
    syncDirectory(dir);
    try { sweepTemp(path); } catch { /* cleanup is best effort */ }
    fault('after-rename');
  } finally {
    if (!renamed) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

export function writeJsonAtomic(path, value, options) {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw new TypeError('value cannot be serialized as JSON');
  writeFileAtomic(path, `${text}\n`, options);
}

function pidRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH'; // anything but "no such process" counts as alive
  }
}

/** Remove temp files of `path` whose writer process is gone. Returns the removed names. */
export function sweepTemp(path, { minAgeMs = SWEEP_MIN_AGE_MS } = {}) {
  const dir = dirname(path);
  const pattern = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{1,10})\\.[A-Za-z0-9]+\\.tmp$`);
  const removed = [];
  let names;
  try { names = readdirSync(dir); } catch (error) {
    if (error.code === 'ENOENT') return removed;
    throw error;
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match || pidRuns(Number(match[1]))) continue;
    try {
      if (minAgeMs > 0 && Date.now() - statSync(join(dir, name)).mtimeMs < minAgeMs) continue;
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch { /* raced with another sweeper */ }
  }
  return removed;
}
