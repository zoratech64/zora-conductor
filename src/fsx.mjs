import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

/** Write via temp file + rename so a crash never leaves half a JSON file. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Exclusive lock file. Only one dispatch may write to a project at a time;
 * a lock whose owner process is gone is taken over.
 */
export function acquireLock(path, info = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...info }));
      closeSync(fd);
      return () => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readJson(path, null);
      if (current && pidAlive(current.pid)) {
        throw new Error(`another zc dispatch is already running (pid ${current.pid}); only one worker runs at a time`);
      }
      try { unlinkSync(path); } catch { /* raced with another cleanup */ }
    }
  }
  throw new Error(`could not acquire ${path}`);
}
