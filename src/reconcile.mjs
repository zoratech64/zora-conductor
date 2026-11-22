import { realpathSync } from 'node:fs';
import { listAccounts } from './accounts.mjs';
import { isolationMode } from './agy.mjs';
import { groupAlive, isAlive, scanProfileUsers } from './procid.mjs';
import { evaluateStale } from './registry.mjs';

/**
 * Safe reconciliation of leases left behind by dispatchers that no longer run.
 *
 * A lease is reaped only when ALL of these are proven: its dispatcher is dead, no process that
 * started after it uses the profile, and its worker's process group is empty. Anything unproven
 * (an unreadable /proc entry, another platform, a profile without private isolation) keeps the
 * lease. A reboot changes nothing about that: the boot id only proves the old dispatcher is dead,
 * the profile is still scanned. Heartbeat age is only a hint for display and never decides.
 * A project lease goes only together with the account lease of the same run.
 */

function ownerState(lease, d) {
  const identity = process.platform === 'linux' && lease.ownerStart != null && lease.ownerBoot
    ? { pid: lease.ownerPid, identity: 'linux-proc', startTicks: lease.ownerStart, bootId: lease.ownerBoot }
    : { pid: lease.ownerPid, identity: 'pid-only' };
  try { return d.isAlive(identity); } catch { return 'unknown'; }
}

/** A corrupt row must not abort every dispatch: a throw is an unproven answer. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RANK = { found: 2, unknown: 1, none: 0 };
const worst = (verdicts) => verdicts.reduce((a, b) => (RANK[b] ?? 1) > (RANK[a] ?? 1) ? b : a, 'none');
const configuredDirs = () => { try { return listAccounts().map((a) => a.profileDir).filter(Boolean); } catch { return []; } };
const sameDir = (dir, real) => { try { return realpathSync.native(dir) === real; } catch { return false; } };
const linkedDirs = (real, dirs) => dirs.filter((dir) => dir !== real && sameDir(dir, real));
const attempt = (fn) => { try { return fn(); } catch { return 'unknown'; } };

/** The verdict on one lease: { verdict: live|stale|orphan|unknown, reason }. */
export function proveLease(lease, deps = {}) {
  const d = { platform: process.platform, isolation: isolationMode(), profileDirs: configuredDirs, retryDelays: [50, 150, 400], isAlive, groupAlive, scan: scanProfileUsers, ...deps };
  if (d.platform !== 'linux') return { verdict: 'unknown', reason: 'no process identity on this platform, so nothing is proven' };
  if (d.isolation !== 'dbus') return { verdict: 'unknown', reason: 'private profile isolation is off, so the profile scan cannot prove a worker gone' };
  const owner = ownerState(lease, d);
  if (owner !== false) return evaluateStale({ ownerAlive: owner });
  const after = lease.workerStart != null ? lease.workerStart : lease.ownerStart;
  const bound = after != null && lease.ownerBoot ? { startedAfter: { startTicks: after, bootId: lease.ownerBoot } } : {};
  const probe = () => {
    const group = lease.workerPgid ? attempt(() => d.groupAlive(lease.workerPgid).verdict) : 'none';
    // A worker is launched with the account's profileDir as configured (maybe a symlink); the lease holds its realpath.
    const scan = lease.profilePath
      ? worst([lease.profilePath, ...linkedDirs(lease.profilePath, d.profileDirs())].map((dir) => attempt(() => d.scan(dir, bound).verdict)))
      : 'none';
    return { group, scan };
  };
  // A process that is starting or exiting can be unreadable for a moment: look again a few times before giving up.
  let seen = probe();
  for (const delay of d.retryDelays) {
    if (seen.group !== 'unknown' && seen.scan !== 'unknown') break;
    pause(delay);
    seen = probe();
  }
  const { group, scan } = seen;
  const verdict = evaluateStale({ ownerAlive: false, workerScan: scan, groupAlive: group });
  return scan === 'unknown' || group === 'unknown' ? { ...verdict, reason: `${verdict.reason}: a process entry could not be read` } : verdict;
}

/**
 * Reap what is proven stale, inside the caller's registry transaction. Returns
 * { reaped: [lease], kept: Map(key -> {verdict, reason}) } (kept only holds dead-owner leases).
 */
export function reconcile(registry, { deps = {} } = {}) {
  const reaped = [];
  const kept = new Map();
  const leases = registry.listLeases();
  const accountFirst = [...leases.filter((l) => l.kind !== 'project'), ...leases.filter((l) => l.kind === 'project')];
  for (const lease of accountFirst) {
    const proof = proveLease(lease, deps);
    if (proof.verdict === 'live') continue;
    const blocker = lease.kind === 'project' ? registry.listLeases().find((l) => l.runId === lease.runId && l.kind !== 'project') : null;
    if (proof.verdict !== 'stale' || blocker) {
      kept.set(lease.key, blocker ? { verdict: 'unknown', reason: `its account lease ${blocker.key} is still held` } : proof);
      continue;
    }
    if (registry.releaseLease(lease.key, lease.runId)) {
      registry.recordEvent({ key: lease.key, runId: lease.runId, kind: lease.kind, reason: proof.reason, detail: { ownerPid: lease.ownerPid, profilePath: lease.profilePath } });
      reaped.push(lease);
    }
  }
  return { reaped, kept };
}
