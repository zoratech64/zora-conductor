import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getAccount } from './accounts.mjs';
import { getRun, listRuns } from './dispatch.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { gitLayout } from './gitmeta.mjs';
import * as G from './gitx.mjs';
import { acquireProjectLease } from './lease-project.mjs';
import { withAccountsLock } from './migrate.mjs';
import { runsDir } from './paths.mjs';
import { isAlive } from './procid.mjs';
import { proveLease } from './reconcile.mjs';
import { deriveStatus } from './runrecord.mjs';
import { sameState } from './snapshot.mjs';

/**
 * Explicit recovery of a run whose zc died. It never touches the working tree: it only proves the
 * worker is gone, shows what the tree holds, and (with --yes) records that content as the run's
 * result (status RECOVERED, workerState) so `zc reject` can later discard exactly it. The caller
 * attests that the printed paths are the worker's; anything changed since is not told apart.
 * A recovered run was never verified, so `zc accept` still refuses it.
 */

export const releaseConfirmation = (runId, account) => `worker of ${runId} on ${account} is gone`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A stored RUNNING whose zc died, or an INTERRUPTED run that kept its leases because its worker was unproven. */
function eligible(shown) {
  return (shown.statusDerived && (shown.status === 'INTERRUPTED' || shown.status === 'ORPHAN')) ||
    (shown.status === 'INTERRUPTED' && shown.orphan === true);
}

/** The run's own facts shaped as a lease, so recovery uses the same proof as reconcile. */
function pseudoLease(run) {
  const owner = run.owner ?? {};
  let profilePath = null;
  if (run.account) {
    const dir = getAccount(run.account)?.profileDir;
    if (!dir) return { error: `account ${run.account} no longer exists, so its profile cannot be checked` };
    try { profilePath = realpathSync.native(dir); } catch { return { error: `the profile of ${run.account} cannot be read` }; }
  }
  return {
    lease: {
      ownerPid: owner.pid, ownerStart: owner.startTicks ?? null, ownerBoot: owner.bootId ?? null,
      workerPgid: run.worker?.pgid ?? null, workerStart: run.worker?.startTicks ?? null, profilePath
    }
  };
}

function prove(run, deps) {
  const built = pseudoLease(run);
  if (built.error) return { verdict: 'unknown', reason: built.error };
  if (!run.owner?.pid) return { verdict: 'unknown', reason: 'the run record has no owner identity' };
  return proveLease(built.lease, deps);
}

function describeTree(root) {
  const entries = G.statusEntries(root);
  return { paths: G.changedPaths(entries), state: G.dirtyState(root) };
}

function isAliveSafe(identity) {
  try { return isAlive(identity); } catch { return true; }
}

/** Everything the person's --release must satisfy; throws, changes nothing. */
function checkRelease({ run, account, confirm }) {
  if (account !== run.account) throw new Error(`run ${run.runId} used account ${run.account ?? '(none)'}, not ${account}`);
  if (confirm !== releaseConfirmation(run.runId, account)) {
    throw new Error(`to release by hand, check with your own tools that no agy process uses the profile of ${account}, then pass --confirm "${releaseConfirmation(run.runId, account)}"`);
  }
  if (!run.owner?.pid || isAliveSafe(run.owner)) throw new Error(`the zc of run ${run.runId} is still running (or unknown); nothing was released`);
}

/** Human override: release this run's leases (its own runId only), in the caller's registry transaction. */
function releaseByHand(registry, { run, account }) {
  const released = registry.listLeases().filter((l) => l.runId === run.runId && registry.releaseLease(l.key, l.runId));
  for (const l of released) registry.recordEvent({ key: l.key, runId: l.runId, kind: l.kind, reason: 'human-release', detail: { account } });
  return released.map((l) => l.key);
}

/** The run must still be the project's latest, on the commit it started from, in the layout it recorded. */
function checkTreeBelongs(root, raw) {
  if (!raw.gitLayout) throw new Error(`run ${raw.runId} recorded no git layout, so its tree cannot be checked; nothing was changed`);
  if (!same(raw.gitLayout, gitLayout(root))) {
    throw new Error(`refusing to recover run ${raw.runId}: the repository's git layout differs from the one the run recorded`);
  }
  if (G.head(root) !== raw.head) throw new Error(`refusing to recover run ${raw.runId}: HEAD is not the commit it started from, so the tree is no longer its tree`);
  const newer = listRuns(root, Infinity).find((r) => r.runId > raw.runId);
  if (newer) throw new Error(`refusing to recover run ${raw.runId}: a newer run (${newer.runId}) exists, so the tree may be its work. Nothing was changed.`);
}

/** Still the interrupted run it was a moment ago (another zc may have recovered or replaced it). */
function currentlyEligible(root, runId) {
  const raw = getRun(root, runId);
  if (!raw) throw new Error(`run ${runId} vanished`);
  if (!eligible(deriveStatus(raw))) throw new Error(`run ${runId} is ${raw.status} now (another zc changed it); nothing was changed`);
  return raw;
}

/**
 * Returns { runId, dryRun, proof, paths, recovered, released[] }. Throws when the run is not recoverable or
 * the worker is not proven gone (use `release` for platforms that cannot prove it). Without `yes` nothing at all
 * is written, but every check runs.
 */
export function recoverRun({ root, runId, yes = false, release = null, confirm = null, deps = {} }) {
  const raw = getRun(root, runId);
  if (!raw) throw new Error(`no run ${runId} (see \`zc runs\`)`);
  const shown = deriveStatus(raw);
  if (!eligible(shown)) {
    throw new Error(`run ${raw.runId} is ${shown.status}: only an interrupted run (zc died mid-run, shown as INTERRUPTED or ORPHAN) can be recovered. Nothing was changed.`);
  }
  if (release) checkRelease({ run: shown, account: release, confirm });
  const proof = release ? { verdict: 'human', reason: 'released by hand' } : prove(shown, deps);
  if (proof.verdict !== 'stale' && !release) {
    throw new Error(`the worker of run ${raw.runId} is not proven gone (${proof.reason}). Nothing was changed. If you checked by hand that no agy process uses the account's profile, use --release <account> --confirm "…" --yes.`);
  }
  checkTreeBelongs(root, raw);
  G.pinLayout(root, raw.gitLayout); // the worker never ran its metadata restore: git runs against the layout the run recorded
  try {
    if (!yes) return { runId: raw.runId, dryRun: true, proof, ...describeTree(root), recovered: false, released: [] };
    return writeRecovery({ root, raw, shown, release, deps, initialProof: proof });
  } finally {
    G.unpinLayout(root);
  }
}

function writeRecovery({ root, raw, shown, release, deps, initialProof }) {
  let released = [];
  let lease;
  try {
    // One transaction: if the project lease cannot be taken, the by-hand release is rolled back with it.
    lease = withAccountsLock((registry) => {
      if (release) released = releaseByHand(registry, { run: shown, account: release });
      return acquireProjectLease({ root, runId: `recover-${raw.runId}`, deps });
    });
  } catch (error) {
    throw new Error(`${error.message}${released.length ? ' (the by-hand release was rolled back)' : ''}`);
  }
  try {
    const now = currentlyEligible(root, raw.runId);
    checkTreeBelongs(root, now);
    if (!release) {
      const again = prove(deriveStatus(now), deps); // under the project lease, once more
      if (again.verdict !== 'stale') throw new Error(`the worker of run ${raw.runId} is no longer proven gone (${again.reason}). Nothing was changed.`);
    }
    const before = describeTree(root);
    const file = join(runsDir(root), raw.runId, 'result.json');
    writeJsonAtomic(file, {
      ...readJson(file, now), status: 'RECOVERED', storedStatus: now.status, recoveredAt: new Date().toISOString(),
      recoveredBy: release ? 'human-release' : 'proof', workerState: before.state, exitCode: 3,
      nextAction: 'the work was never verified. Review the files, then run `zc reject` to discard it or finish by hand; `zc accept` will not take a recovered run.'
    }, { mode: 0o600 });
    const after = describeTree(root);
    if (!sameState(before.state, after.state) || !same(before.paths, after.paths)) {
      throw new Error(`the working tree changed while run ${raw.runId} was recovered; check it by hand`);
    }
    return { runId: raw.runId, dryRun: false, proof: initialProof, paths: before.paths, recovered: true, released };
  } catch (error) {
    throw new Error(`${error.message}${released.length ? ` (leases ${released.join(', ')} were already released by hand)` : ''}`);
  } finally {
    lease();
  }
}
