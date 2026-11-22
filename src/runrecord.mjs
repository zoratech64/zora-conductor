import { join } from 'node:path';
import { writeJsonAtomic } from './atomicfile.mjs';
import { groupAlive, isAlive, processIdentity } from './procid.mjs';

/**
 * The run record is written as RUNNING the moment a dispatch starts, with who owns it and
 * which worker process it started, and rewritten as the run progresses. If the dispatcher
 * dies, the stored RUNNING is never overwritten, so listRuns can tell what happened:
 *   owner alive            -> RUNNING
 *   owner gone, worker may still live -> ORPHAN   (do not touch the tree)
 *   owner gone, worker gone           -> INTERRUPTED
 * Records without an owner (older zc) keep whatever status they were stored with.
 */

const describe = (id, pid) => (id
  ? { pid: id.pid, identity: id.identity, startTicks: id.startTicks, bootId: id.bootId }
  : { pid, identity: 'pid-only' });

export const identityOf = (pid) => {
  try { return describe(processIdentity(pid), pid); } catch { return { pid, identity: 'pid-only' }; }
};

export function createRecorder({ runDir, result }) {
  const file = join(runDir, 'result.json');
  const owner = identityOf(process.pid);
  let worker = null;
  const live = {};
  const write = () => writeJsonAtomic(file, { ...result, ...live, status: 'RUNNING', exitCode: null, owner, worker }, { mode: 0o600 });
  // Telemetry must never decide the outcome: after the first write succeeded, a failed rewrite only warns.
  const soft = (change) => {
    change();
    try { write(); } catch (error) { console.error(`zc: warning: could not update the run record (${error.message})`); }
  };
  return {
    start: write,
    update: (extra = {}) => soft(() => Object.assign(live, extra)),
    setWorker: (next) => soft(() => { worker = next; }),
    identity: () => ({ owner, worker }) // kept in a final record whose worker was not proven gone, so `zc recover` can prove it later
  };
}

/** Anything unclear counts as alive: a record is never called INTERRUPTED on a guess. */
function stillRuns(identity) {
  try { return isAlive(identity); } catch { return true; }
}

function workerMayLive(worker) {
  if (worker.starting) return true; // the dispatcher died between deciding to spawn and recording the process
  if (stillRuns(worker)) return true;
  if (!worker.pgid) return false;
  try { return groupAlive(worker.pgid).verdict !== 'none'; } catch { return true; }
}

/** The record as it should be shown: a stale RUNNING becomes ORPHAN or INTERRUPTED. */
export function deriveStatus(record) {
  if (record?.status !== 'RUNNING' || !record.owner) return record;
  if (stillRuns(record.owner)) return record;
  const orphan = record.worker ? workerMayLive(record.worker) : false;
  return { ...record, status: orphan ? 'ORPHAN' : 'INTERRUPTED', storedStatus: 'RUNNING', statusDerived: true };
}
