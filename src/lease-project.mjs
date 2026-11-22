import { pidAlive } from './fsx.mjs';
import { inspectLock, withAccountsLock } from './migrate.mjs';
import { lockFile, projectKey, stateRoot } from './paths.mjs';
import { processIdentity } from './procid.mjs';
import { reconcile } from './reconcile.mjs';
import { VERSION, ownerAlive } from './reserve.mjs';

/**
 * One zc operation per project at a time (dispatch, reject, accept, ack), enforced by a
 * `project:<key>` lease in the machine-wide registry, taken in the same transaction as
 * everything else. The old dispatch.lock file is only READ: a live legacy dispatcher
 * blocks, a dead or foreign file is ignored and never deleted or rewritten. (The old
 * acquireLock deleted dead locks and could let two takers race; that behaviour stays
 * only for ecc-install.lock.) A lease whose zc process is gone is refused, not reaped.
 *
 * shortcut: an older zc takes no leases, so it is detected (its lock file), not excluded; one
 * that starts in the instant between the check and the insert is not seen. Do not run older copies.
 */

export function acquireProjectLease({ root, runId, deps = {} }) {
  const key = `project:${projectKey(root)}`;
  return withAccountsLock((registry) => {
    const legacy = inspectLock(lockFile(root), pidAlive);
    if (legacy) throw new Error(`an older zc is using this project (${legacy}; see ${lockFile(root)}); it does not take leases. Wait for it to finish; do not run older zc copies.`);
    reconcile(registry, { deps }); // proven-stale leases of dead zc processes are cleared first
    const self = processIdentity(process.pid);
    const taken = registry.acquireLease({
      key, kind: 'project', runId, projectKey: projectKey(root), stateRoot: stateRoot(), zcVersion: VERSION,
      ownerPid: process.pid, ownerStart: self?.startTicks ?? null, ownerBoot: self?.bootId ?? null
    });
    if (!taken.acquired) {
      const { holder } = taken;
      if (ownerAlive(holder)) {
        throw new Error(`another zc operation (dispatch, reject or accept) is already running (pid ${holder.ownerPid}, run ${holder.runId}); only one runs at a time`);
      }
      throw new Error(`this project is still leased by run ${holder.runId} whose zc (pid ${holder.ownerPid}) is gone. It was not taken over; check for stray agy processes, then release it by hand.`);
    }
    // Releasing must never mask the outcome of the operation: report a failure and carry on.
    return () => {
      try { return withAccountsLock((reg) => reg.releaseLease(key, runId)); } catch (error) {
        console.error(`zc: warning: could not release the project lease ${key} (${error.message}); it stays until released by hand`);
        return false;
      }
    };
  });
}
