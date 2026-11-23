import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import * as accounts from './accounts.mjs';
import { liveDispatchers, withAccountsLock } from './migrate.mjs';
import { pidAlive } from './fsx.mjs';
import { projectKey, stateRoot } from './paths.mjs';
import { groupAlive, isAlive, processIdentity, scanProfileUsers } from './procid.mjs';
import { reconcile } from './reconcile.mjs';
import { profileIdentity } from './registry.mjs';

/**
 * Account reservation. One transaction chooses an account, takes the lease on
 * its profile directory and records the use, so two dispatchers can never get
 * the same Google profile. A lease is released only when the worker is proven
 * gone; a lease whose owner died is never taken over here (reaping is a later,
 * separate decision), it only makes the account unavailable.
 */

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function ownerIdentity(lease) {
  if (process.platform === 'linux' && lease.ownerStart != null && lease.ownerBoot) {
    return { pid: lease.ownerPid, identity: 'linux-proc', startTicks: lease.ownerStart, bootId: lease.ownerBoot };
  }
  return { pid: lease.ownerPid, identity: 'pid-only' };
}

/** Is the lease's dispatcher still running? Anything unclear counts as alive (fail closed). */
export function ownerAlive(lease) {
  try { return isAlive(ownerIdentity(lease)); } catch { return true; }
}

function liveProjects(registry, except) {
  const projects = new Set();
  // Short sign-in/check leases are labelled "login:<id>"; project keys never contain ':'.
  for (const lease of registry.listLeases()) {
    if (lease.projectKey && !lease.projectKey.includes(':') && ownerAlive(lease)) projects.add(lease.projectKey);
  }
  projects.delete(except);
  return projects;
}

const nested = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** A lease on a different key whose directory is this one, or inside or around it (recreated or hand-edited profiles). */
function overlappingLease(registry, id) {
  return registry.listLeases().find((l) => l.key !== id.key && l.profilePath && nested(l.profilePath, id.path));
}

function takeFirstFree(registry, attested, base, kept = new Map()) {
  let stale = null;
  let inUse = null;
  for (const account of attested) {
    if (typeof account.profileDir !== 'string' || !isAbsolute(account.profileDir)) continue; // hand-edited entry: never usable
    mkdirSync(account.profileDir, { recursive: true, mode: 0o700 });
    const id = profileIdentity(account.profileDir);
    const clash = overlappingLease(registry, id);
    if (clash) {
      if (!ownerAlive(clash)) stale = { account: account.id, holder: clash, why: kept.get(clash.key)?.reason };
      continue;
    }
    const taken = registry.acquireLease({
      ...base, key: id.key, kind: 'account', profilePath: id.path, profileDev: id.dev, profileIno: id.ino
    });
    if (!taken.acquired) {
      if (!ownerAlive(taken.holder)) stale = { account: account.id, holder: taken.holder, why: kept.get(taken.holder.key)?.reason };
      continue;
    }
    // Something that holds no lease may already be using this profile (an older zc worker, a manual agy).
    const users = scanProfileUsers(account.profileDir);
    if (users.verdict === 'found') {
      registry.releaseLease(id.key, base.runId);
      inUse = { account: account.id, pids: users.pids };
      continue;
    }
    accounts.markUsed(account.id);
    return { ok: true, account, lease: { key: id.key, runId: base.runId } };
  }
  if (stale) return refuse('stale-lease', stale);
  return inUse ? refuse('profile-in-use', inUse) : refuse('all-reserved');
}

/** Choose an attested, ready account and lease its profile in one transaction. */
export function reserve({ root, runId, maxProjects = 2, exclude = [], only = null, now = Date.now(), deps = {} }) {
  return withAccountsLock((registry) => {
    const legacy = liveDispatchers(stateRoot(), pidAlive, { legacyOnly: true });
    if (legacy.length) return refuse('legacy-dispatcher', { dispatchers: legacy });
    const all = accounts.listAccounts();
    if (!all.length) return refuse('no-accounts');
    // `only` pins the dispatch to one account: no fallback to another one, whatever its state.
    const pinned = only ? all.find((a) => a.id === only) : null;
    if (only && !pinned) return refuse('unknown-account', { id: only });
    const ready = accounts.candidates({ now, exclude }).filter((a) => !only || a.id === only);
    if (only && !ready.length) return refuse('pinned-unavailable', { id: only, status: pinned.status, cooldownUntil: pinned.cooldownUntil || 0, holdReason: pinned.holdReason || '' });
    if (!ready.length) {
      const at = accounts.nextAvailableAt(now);
      return at ? refuse('cooling', { retryAfter: at }) : refuse('not-ready');
    }
    const attested = ready.filter((a) => accounts.attestationStatus(a, all) === 'attested');
    if (!attested.length) {
      return refuse('account-unattested', { ids: ready.filter((a) => accounts.attestationStatus(a, all) !== 'attested').map((a) => a.id) });
    }
    const { kept } = reconcile(registry, { deps }); // proven-stale leases of dead dispatchers go; the rest stay and explain themselves
    const mine = projectKey(root);
    const others = liveProjects(registry, mine);
    if (others.size >= maxProjects) return refuse('max-projects', { projects: [...others] });
    const self = processIdentity(process.pid);
    return takeFirstFree(registry, attested, {
      runId, projectKey: mine, stateRoot: stateRoot(), zcVersion: VERSION,
      ownerPid: process.pid, ownerStart: self?.startTicks ?? null, ownerBoot: self?.bootId ?? null
    }, kept);
  });
}

/** Remember the worker process on the lease (pid, group, start time). */
export function recordWorker(lease, child) {
  const id = processIdentity(child.pid);
  withAccountsLock((registry) => registry.updateWorker(lease.key, lease.runId, { pid: child.pid, pgid: child.pid, start: id?.startTicks }));
  return id;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SETTLE_DELAYS_MS = [50, 100, 200, 400, 800, 1000];

function proveOnce({ profileDir, pgid, worker }) {
  const group = pgid ? groupAlive(pgid) : { verdict: 'none', pids: [] };
  const scan = scanProfileUsers(profileDir, worker ? { startedAfter: { startTicks: worker.startTicks, bootId: worker.bootId } } : {});
  return { gone: group.verdict === 'none' && scan.verdict === 'none', group: group.verdict, scan: scan.verdict, pids: [...group.pids, ...scan.pids] };
}

/**
 * Is the worker really gone? On Linux: its process group is empty and no process
 * that started after it still uses the profile. Elsewhere a process cannot be
 * identified, so the awaited exit of the child is the only evidence. Processes
 * that are still exiting (a bus daemon) or just forked (briefly unreadable) get a
 * short, bounded grace before the answer is "not proven".
 */
export function proveWorkerGone({ profileDir, pgid, worker, delays = SETTLE_DELAYS_MS, scanOnly = false }) {
  if (!pgid && !scanOnly) return { gone: true, basis: 'no worker was started' };
  if (process.platform !== 'linux') return { gone: true, basis: 'child exited (no process identity on this platform)' };
  let proof = proveOnce({ profileDir, pgid, worker });
  for (const ms of delays) {
    if (proof.gone) break;
    pause(ms);
    proof = proveOnce({ profileDir, pgid, worker });
  }
  return proof;
}

/** Release a lease, optionally with a health update in the same transaction. */
export function settleLease(lease, health) {
  return withAccountsLock((registry) => {
    health?.();
    return registry.releaseLease(lease.key, lease.runId);
  });
}

/** Short exclusive use of one account's profile (sign-in, usage check). Refuses when it is in use. */
export async function withShortLease(account, label, work) {
  mkdirSync(account.profileDir, { recursive: true, mode: 0o700 });
  const id = profileIdentity(account.profileDir);
  const self = processIdentity(process.pid);
  const runId = `${label}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const taken = withAccountsLock((registry) => registry.acquireLease({
    runId, key: id.key, kind: 'account', projectKey: `${label}:${account.id}`, stateRoot: stateRoot(), zcVersion: VERSION,
    profilePath: id.path, profileDev: id.dev, profileIno: id.ino,
    ownerPid: process.pid, ownerStart: self?.startTicks ?? null, ownerBoot: self?.bootId ?? null
  }));
  if (!taken.acquired) {
    throw new Error(`account ${account.id} is in use by run ${taken.holder.runId} (pid ${taken.holder.ownerPid}); try again when it finishes`);
  }
  let outcome;
  try {
    outcome = { value: await work() };
  } catch (error) {
    outcome = { error };
  }
  // Same rule as a worker: free the account only when nothing started since still uses the profile.
  const proof = proveWorkerGone({ profileDir: account.profileDir, scanOnly: true, worker: self });
  if (!proof.gone) {
    throw new Error(`account ${account.id}: processes still use its profile (pids ${proof.pids.join(' ') || 'unreadable'}); the lease ${id.key} was kept. Check for stray agy processes, then release it by hand.`);
  }
  settleLease({ key: id.key, runId });
  if (outcome.error) throw outcome.error;
  return outcome.value;
}
