import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

export { writeJsonAtomic } from './atomicfile.mjs';

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
        throw new Error(`another zc operation (dispatch, reject or accept) is already running (pid ${current.pid}); only one runs at a time`);
      }
      try { unlinkSync(path); } catch { /* raced with another cleanup */ }
    }
  }
  throw new Error(`could not acquire ${path}`);
}
