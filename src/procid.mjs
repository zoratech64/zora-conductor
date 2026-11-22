import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Process identity and worker-liveness scanning.
 *
 * A pid alone proves nothing (pids are reused). On Linux an identity is
 * pid + start ticks + boot id, read from /proc. Elsewhere only a bare pid
 * check exists and every scan answers `unknown`, so callers keep their lease.
 *
 * Scan verdicts: 'found' (at least one user), 'none' (every process was read
 * and none uses the profile), 'unknown' (something could not be read; never
 * treated as 'none').
 */

const DEFAULT_PROC = '/proc';
const DEAD_STATES = new Set(['Z', 'X']);
const GONE = new Set(['ENOENT', 'ESRCH']);

const isLinux = (platform) => platform === 'linux';
const pidOnly = (pid) => ({ pid, identity: 'pid-only' });
const unknownScan = () => ({ verdict: 'unknown', identity: 'pid-only', pids: [], unreadable: [] });

function options(opts = {}) {
  return { procRoot: opts.procRoot ?? DEFAULT_PROC, platform: opts.platform ?? process.platform };
}

/** Fields after the command name; the name may contain spaces and parentheses. */
function parseStat(text) {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (!/^[A-Za-z]$/.test(rest[0]) || !/^-?\d+$/.test(rest[2]) || !/^\d+$/.test(rest[19])) {
    throw new Error('malformed /proc stat');
  }
  return { state: rest[0], pgrp: Number(rest[2]), startTicks: Number(rest[19]) };
}

/** Real uid from `status` (world-readable). The /proc/<pid> inode owner is root for dumpable=0 processes. */
function readUid(procRoot, pid) {
  const line = readFileSync(`${procRoot}/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('Uid:'));
  const field = line?.split(/\s+/)[1] ?? '';
  if (!/^\d+$/.test(field)) throw new Error('malformed /proc status');
  return Number(field);
}

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2 ** 31 - 1;

function readStat(procRoot, pid) {
  try {
    return parseStat(readFileSync(`${procRoot}/${pid}/stat`, 'utf8'));
  } catch (error) {
    if (GONE.has(error.code)) return null;
    throw error;
  }
}

function bootIdOf(procRoot) {
  return readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
}

function pidBarelyAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH'; // only "no such process" means gone
  }
}

/** Identity of a running process, or null when it does not exist. */
export function processIdentity(pid, opts) {
  const { procRoot, platform } = options(opts);
  if (!validPid(pid)) throw new TypeError(`invalid pid ${pid}`);
  if (!isLinux(platform)) return pidBarelyAlive(pid) ? pidOnly(pid) : null;
  let stat;
  let uid;
  try {
    stat = readStat(procRoot, pid);
    if (!stat) return null;
    uid = readUid(procRoot, pid);
  } catch (error) {
    if (GONE.has(error.code)) return null; // exited between the reads
    throw error;
  }
  return { pid, identity: 'linux-proc', startTicks: stat.startTicks, bootId: bootIdOf(procRoot), uid, state: stat.state };
}

/** True only when the very same process (same start time, same boot) still runs. */
export function isAlive(id, opts) {
  if (!id || !validPid(id.pid)) throw new TypeError('invalid process identity');
  if (id.identity === 'pid-only') return pidBarelyAlive(id.pid);
  if (id.identity !== 'linux-proc' || !Number.isSafeInteger(id.startTicks) || typeof id.bootId !== 'string' ||
      !isLinux(options(opts).platform)) {
    throw new TypeError('invalid process identity');
  }
  const now = processIdentity(id.pid, opts);
  if (!now || DEAD_STATES.has(now.state)) return false;
  return now.bootId === id.bootId && now.startTicks === id.startTicks;
}

function listPids(procRoot) {
  return readdirSync(procRoot).filter((name) => /^\d+$/.test(name)).map(Number);
}

/** Any live process in process group `pgid`. */
export function groupAlive(pgid, opts) {
  const { procRoot, platform } = options(opts);
  if (!validPid(pgid)) throw new TypeError(`invalid process group ${pgid}`);
  if (platform === 'win32') return { verdict: 'unknown', pids: [] };
  if (!isLinux(platform)) {
    try {
      process.kill(-pgid, 0);
      return { verdict: 'found', pids: [] };
    } catch (error) {
      return { verdict: error.code === 'ESRCH' ? 'none' : 'found', pids: [] };
    }
  }
  const pids = [];
  let unreadable = false;
  let listed;
  try { listed = listPids(procRoot); } catch { return { verdict: 'unknown', pids }; }
  for (const pid of listed) {
    try {
      const stat = readStat(procRoot, pid);
      if (stat && stat.pgrp === pgid && !DEAD_STATES.has(stat.state)) pids.push(pid);
    } catch { unreadable = true; }
  }
  if (pids.length) return { verdict: 'found', pids };
  return { verdict: unreadable ? 'unknown' : 'none', pids };
}

const under = (path, bases) => path.startsWith('/') && bases.some((base) => {
  const p = resolve(path);
  return p === base || p.startsWith(base + sep);
});
const stripDeleted = (path) => path.replace(/ \(deleted\)$/, '');

function usesProfileEnv(procRoot, pid, bases) {
  const entries = readFileSync(`${procRoot}/${pid}/environ`, 'utf8').split('\0');
  return entries.some((entry) => {
    const eq = entry.indexOf('=');
    if (eq < 0) return false;
    const name = entry.slice(0, eq);
    return (name === 'HOME' || name === 'XDG_RUNTIME_DIR') && under(entry.slice(eq + 1), bases);
  });
}

function usesProfileArgv(procRoot, pid, bases) {
  const args = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0');
  return args.some((arg, i) => {
    if (arg === '--gemini_dir') return under(args[i + 1] ?? '', bases);
    return arg.startsWith('--gemini_dir=') && under(arg.slice('--gemini_dir='.length).replace(/\/+$/, ''), bases);
  });
}

function usesProfileFiles(procRoot, pid, bases) {
  if (under(stripDeleted(readlinkSync(`${procRoot}/${pid}/cwd`)), bases)) return true;
  for (const fd of readdirSync(`${procRoot}/${pid}/fd`)) {
    try {
      if (under(stripDeleted(readlinkSync(`${procRoot}/${pid}/fd/${fd}`)), bases)) return true;
    } catch (error) {
      if (!GONE.has(error.code)) throw error; // fd closed while scanning is fine
    }
  }
  return false;
}

/** A zombie thread-group leader can still have running threads that hold files. */
function liveThreads(procRoot, pid) {
  try {
    return readdirSync(`${procRoot}/${pid}/task`).some((tid) => {
      const stat = readStat(procRoot, `${pid}/task/${tid}`);
      return stat && !DEAD_STATES.has(stat.state);
    });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return true; // cannot prove the threads are gone; fall through to the file checks
  }
}

/** 'match' | 'clear' | 'unreadable' for one process. */
function inspect(procRoot, pid, bases, uid, olderThan) {
  try {
    const stat = readStat(procRoot, pid);
    if (!stat || (DEAD_STATES.has(stat.state) && !liveThreads(procRoot, pid))) return 'clear';
    const foreign = uid !== undefined && readUid(procRoot, pid) !== uid;
    try {
      const hit = usesProfileEnv(procRoot, pid, bases) || usesProfileArgv(procRoot, pid, bases) ||
        usesProfileFiles(procRoot, pid, bases);
      return hit ? 'match' : 'clear';
    } catch (error) {
      if (GONE.has(error.code)) return 'clear';
      // A worker always runs as the dispatcher's user, so another user's
      // process we may not read cannot be one.
      return foreign || (olderThan !== undefined && stat.startTicks < olderThan) ? 'clear' : 'unreadable';
    }
  } catch (error) {
    return GONE.has(error.code) ? 'clear' : 'unreadable';
  }
}

function profileBases(profileDir) {
  const bases = new Set([resolve(profileDir)]);
  try { bases.add(realpathSync(profileDir)); } catch { /* profile dir may not exist yet */ }
  return [...bases];
}

/**
 * Same-user processes with dumpable=0 (user systemd, ssh-agent) cannot be read
 * on any desktop. A process that started before the worker did cannot be one of
 * its descendants, so `startedAfter` ({startTicks, bootId}) clears unreadable
 * processes by age. Callers must pass the start of the EARLIEST worker that
 * could still hold the profile (e.g. the lease's first worker), never just the
 * newest one, or a non-dumpable orphan from an earlier worker is cleared.
 * Readable processes are always fully checked. The scan is one snapshot: scan
 * only after the worker has exited, while holding the lease.
 */
function ageLimit(startedAfter, procRoot) {
  if (!startedAfter) return undefined;
  if (!Number.isSafeInteger(startedAfter.startTicks)) throw new TypeError('startedAfter.startTicks must be an integer');
  try {
    return bootIdOf(procRoot) === startedAfter.bootId ? startedAfter.startTicks : undefined;
  } catch { return undefined; }
}

/**
 * Who still uses this profile directory? Matches HOME or XDG_RUNTIME_DIR under
 * it, `--gemini_dir <profile>` in argv, and any open file or cwd under it.
 * Does not follow process groups, so a setsid-escaped grandchild is still seen.
 */
export function scanProfileUsers(profileDir, opts = {}) {
  const { procRoot, platform } = options(opts);
  if (!isLinux(platform)) return unknownScan();
  const selfPid = opts.selfPid ?? process.pid;
  const uid = opts.uid ?? process.getuid?.();
  if (uid !== undefined && !Number.isSafeInteger(uid)) throw new TypeError('uid must be an integer');
  if (typeof profileDir !== 'string' || !profileDir || resolve(profileDir) === resolve('/')) {
    throw new TypeError('profileDir must be a specific directory');
  }
  const bases = profileBases(profileDir);
  const olderThan = ageLimit(opts.startedAfter, procRoot);
  const pids = [];
  const unreadable = [];
  let listed;
  try { listed = listPids(procRoot); } catch { return { verdict: 'unknown', identity: 'linux-proc', pids, unreadable }; }
  if (selfPid > 0 && !listed.includes(selfPid)) { // procfs that cannot see us is not the real one
    return { verdict: 'unknown', identity: 'linux-proc', pids, unreadable };
  }
  for (const pid of listed) {
    if (pid === selfPid) continue;
    const result = inspect(procRoot, pid, bases, uid, olderThan);
    if (result === 'match') pids.push(pid);
    else if (result === 'unreadable') unreadable.push(pid);
  }
  const verdict = pids.length ? 'found' : unreadable.length ? 'unknown' : 'none';
  return { verdict, identity: 'linux-proc', pids, unreadable };
}
