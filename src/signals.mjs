import { terminateTracked } from './proc.mjs';

/**
 * Orderly shutdown on SIGINT, SIGTERM and SIGHUP (on Windows Node only delivers Ctrl+C).
 *
 * The first signal stops every tracked child process (TERM to its group, KILL after the
 * grace period) and records the signal; the running operation notices at its next
 * checkpoint, keeps the working tree as the worker left it, and finishes as INTERRUPTED
 * (exit 130). A repeat is only reported, so cleanup can finish; the third forces an
 * immediate exit and leaves any lease for a human. Installed only while an operation runs.
 */

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const EXIT_INTERRUPTED = 130;
let active = null;
let lastCaught = null;

/** The signal caught since the last resetSignalCaught(), even after the guard was removed (null if none). */
export const signalCaught = () => lastCaught;
export const resetSignalCaught = () => { lastCaught = null; };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

export function installSignalGuard({ log = () => {}, exit = (code) => process.exit(code), graceMs = 5000, forceAfter = 3 } = {}) {
  if (active) return holdGuard(active);
  const waiters = new Set();
  let count = 0;
  let signal = null;
  const handler = (name) => {
    count++;
    if (count === 1) {
      signal = name;
      lastCaught = name;
      terminateTracked({ graceMs }); // stop the worker first; logging must never get in its way
      try { log(`${name} received: stopping the worker, keeping the tree as it is`); } catch { /* ignore */ }
      for (const wake of [...waiters]) wake();
      return;
    }
    if (count >= forceAfter) {
      try { log('forced exit: leases are left for a human to release'); } catch { /* ignore */ }
      exit(EXIT_INTERRUPTED);
      return;
    }
    try { log(`${name} received while stopping; ${forceAfter - count} more to force exit (leaving leases behind)`); } catch { /* ignore */ }
  };
  for (const name of SIGNALS) {
    try { process.on(name, handler); } catch { /* signal not supported here */ }
  }
  const shared = {
    holders: 0, // callers sharing this guard; handlers are removed when the last one lets go
    get signal() { return signal; },
    interrupted: () => signal !== null,
    waiters,
    release() {
      if (--shared.holders > 0) return signal;
      for (const name of SIGNALS) process.off(name, handler);
      if (active === shared) active = null;
      return signal;
    }
  };
  active = shared;
  return holdGuard(shared);
}

/** A per-caller handle on the shared guard: letting go twice only counts once. */
function holdGuard(shared) {
  shared.holders++;
  let released = false;
  return {
    get signal() { return shared.signal; },
    interrupted: () => shared.interrupted(),
    /** Let a signal that arrived during synchronous work be recorded before the next checkpoint. */
    yield: nextTurn,
    uninstall() {
      if (released) return shared.signal;
      released = true;
      return shared.release();
    }
  };
}

export const interrupted = () => active?.interrupted() ?? false;

/** Sleep that ends early on a signal. Resolves true when the full time passed, false when interrupted. */
export function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const guard = active;
    if (guard?.interrupted()) return resolve(false);
    const wake = () => { clearTimeout(timer); guard?.waiters.delete(wake); resolve(false); };
    const timer = setTimeout(() => { guard?.waiters.delete(wake); resolve(true); }, ms);
    guard?.waiters.add(wake);
  });
}
