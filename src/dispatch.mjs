import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as accounts from './accounts.mjs';
import { runAgy } from './agy.mjs';
import { classify, parseResetHint } from './classify.mjs';
import { acquireLock, readJson, writeJsonAtomic } from './fsx.mjs';
import { processIdentity } from './procid.mjs';
import { proveWorkerGone, recordWorker, reserve, settleLease } from './reserve.mjs';
import { gitLayout } from './gitmeta.mjs';
import { runGate, takeMetaBaseline } from './gitmeta-gate.mjs';
import * as G from './gitx.mjs';
import { lockFile, runsDir } from './paths.mjs';
import { attemptMetrics } from './metrics.mjs';
import { buildPrompt, loadEccAssets, loadPrefix, selectEccRules } from './prompt.mjs';
import { parseMinutes } from './limits.mjs';
import { partitionByScope } from './scope.mjs';
import { restoreZc, sameState, snapshotZc } from './snapshot.mjs';
import { runVerify } from './verify.mjs';

/** Exit codes the manager branches on. */
export const EXIT = { OK: 0, FAILED: 1, NO_CAPACITY: 2, NEEDS_HUMAN: 3 };

const REPAIR_NOTE =
  'The working tree already contains your earlier, uncommitted work on this task. Read it first, ' +
  'then apply the instructions below on top of it. Do not start over.';
const NO_COMMANDS_NOTE = 'Your previous attempt ended because you tried to run a shell command, which is not allowed here. Do the task using only file read, list, search and edit tools. Do not run any command.';
const CONTINUE_NOTE =
  'A previous worker was interrupted (usage limit) before finishing. Its partial, uncommitted work is ' +
  'in the working tree. Inspect it, keep what is correct, and complete the task.';

const newRunId = () =>
  `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

export function listRuns(root, limit = 10) {
  let names = [];
  try { names = readdirSync(runsDir(root)); } catch { return []; }
  return names.sort().reverse().slice(0, limit)
    .map((name) => readJson(join(runsDir(root), name, 'result.json'), null))
    .filter(Boolean);
}

/** Same repository layout: git directories, pointer files and directory identity all equal. */
const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Newest run that left unrepaired git metadata nobody acknowledged. Runs that merely refused to start do not
 * carry the flag, so they are skipped, however many pile up: every run is scanned.
 */
const pendingMetaRun = (root, exceptId = null) =>
  listRuns(root, Infinity).find((r) => r.gitMetaUnrestored && !r.gitMetaAcknowledged && r.runId !== exceptId) ?? null;

export const getRun = (root, id) => (/^[\w-]+$/.test(String(id)) ? readJson(join(runsDir(root), id, 'result.json'), null) : null);

/**
 * Combine project and task verification commands. Project commands always run first in order;
 * task commands are appended unless their argv string is already present (deduping exact duplicates).
 * Returns a new array without mutating inputs.
 */
export function effectiveVerify(projectVerify = [], taskVerify = []) {
  const result = [...(projectVerify ?? [])];
  const seen = new Set(result.map((argv) => JSON.stringify(argv)));
  for (const cmd of taskVerify ?? []) {
    const key = JSON.stringify(cmd);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cmd);
    }
  }
  return result;
}

function taskPrompt({ root, task, config, resumeNote }) {
  const allowed = task.meta.allowed.length ? task.meta.allowed : config.defaults.allowed;
  const verify = effectiveVerify(config.verify, task.meta.verify);
  const { text: eccRulesText, included, excluded, omitted } = selectEccRules(config);
  return {
    allowed,
    verify,
    eccRules: { included, excluded, omitted },
    prompt: buildPrompt({
      prefix: loadPrefix(root, config),
      eccRules: eccRulesText,
      eccAssets: loadEccAssets(config, task),
      task,
      allowed,
      forbiddenExtra: config.forbidden,
      verify,
      resumeNote
    })
  };
}

/** Map a refused reservation to the finish() arguments of the dispatch that asked. */
function reserveOutcome(got) {
  const named = (ids) => ids.join(', ');
  switch (got.reason) {
    case 'cooling':
      return ['NO_CAPACITY', EXIT.NO_CAPACITY, {
        retryAfter: new Date(got.retryAfter).toISOString(),
        nextAction: `every account is cooling down; the earliest is back at ${new Date(got.retryAfter).toISOString()}. Wait, or add an account with \`zc account add\`.`
      }];
    case 'all-reserved':
      return ['NO_CAPACITY', EXIT.NO_CAPACITY, { reason: 'all-reserved', nextAction: 'every ready account is in use by another dispatch. Wait for one to finish, or add an account with `zc account add`.' }];
    case 'max-projects':
      return ['NO_CAPACITY', EXIT.NO_CAPACITY, { reason: 'max-projects', nextAction: `${got.projects.length} other projects are already dispatching (the limit is defaults.maxLiveProjects). Wait for one to finish.` }];
    case 'account-unattested':
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { reason: 'account-unattested', nextAction: `these accounts have no valid, unique attestation: ${named(got.ids)}. Confirm each is a different Google account used in no other profile with \`zc account attest ${got.ids[0]} --label <name>\`.` }];
    case 'legacy-dispatcher':
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { reason: 'legacy-dispatcher', nextAction: `an older zc is dispatching right now (${named(got.dispatchers)}); it does not take account leases. Wait for it to finish; do not run older zc copies.` }];
    case 'profile-in-use':
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { reason: 'profile-in-use', nextAction: `account ${got.account} has no lease but processes already use its profile (pids ${got.pids.join(' ')}), for example an older zc worker or a manual agy. Stop them, then dispatch again.` }];
    case 'stale-lease':
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { reason: 'stale-lease', nextAction: `account ${got.account} is still leased by run ${got.holder.runId} whose dispatcher (pid ${got.holder.ownerPid}) is gone. It was not taken over; check for stray agy processes and release it by hand.` }];
    case 'no-accounts':
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: 'no worker accounts yet. Run `zc account add <id>` for each Gemini account.' }];
    default:
      return ['NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: 'no account is ready (needs-login or blocked). See `zc status`; fix with `zc account login <id>`.' }];
  }
}

/**
 * Run one task on one worker at a time, in place, switching accounts when one
 * hits a limit. The tree must be clean on entry (or match a prior run when
 * `repairOf` is given). Worker output is never trusted: scope is checked from
 * git itself and verification is run here, not reported by the worker.
 */
export async function dispatch({ root, task, config, repairOf = null, dryRun = false, log = () => {} }) {
  const { allowed, verify: verifyCmds, prompt: dryPrompt, eccRules } = taskPrompt({
    root, task, config, resumeNote: repairOf ? REPAIR_NOTE : ''
  });
  if (dryRun) return { status: 'DRY_RUN', exitCode: 0, taskId: task.meta.id, allowed, prompt: dryPrompt };

  const id = newRunId();
  const runDir = join(runsDir(root), id);
  mkdirSync(runDir, { recursive: true });
  const result = {
    runId: id, runDir, taskId: task.meta.id, repairOf,
    repairCause: repairOf ? { kind: task.meta.cause ?? null, note: task.meta.causeNote ?? null } : null,
    status: 'FAILED', exitCode: 1,
    startedAt: new Date().toISOString(), account: null, allowed, attempts: [], changed: [],
    outOfScope: [], forbidden: [], inherited: [], verify: [], workerSummary: '', nextAction: '', head: null, branch: null
  };
  result.eccRules = eccRules;
  result.verifyPlan = verifyCmds.map((argv) => argv.join(' '));
  let metaBlocked = Boolean(pendingMetaRun(root, id));
  const finish = (status, exitCode, extra = {}, checkedState) => {
    Object.assign(result, { status, exitCode, finishedAt: new Date().toISOString() }, extra);
    if (checkedState === false || metaBlocked) {
      // the repository cannot be inspected safely (or unrepaired metadata is pending): run no git, record no state
    } else if (checkedState !== undefined) {
      result.workerState = checkedState;
    } else {
      try { result.workerState = G.dirtyState(root); } catch { /* not a git repo yet: nothing to record */ }
    }
    writeJsonAtomic(join(runDir, 'result.json'), result);
    return result;
  };

  if (!allowed.length) {
    return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
      nextAction: 'the task declares no allowed paths. Add `allowed:` to the task file (workers never get an open scope).'
    });
  }

  let release;
  try {
    release = acquireLock(lockFile(root), { runId: id, registry: true });
  } catch (error) {
    return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: error.message });
  }

  try {
    const last = pendingMetaRun(root, id);
    metaBlocked = Boolean(last);
    if (last) {
      // No git command may run here: the metadata that run left is still unrepaired, so record no state.
      return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
        nextAction: `no worker was started: run ${last.runId} left git metadata that zc could not repair. Check the items it lists by hand, then run \`zc ack ${last.runId}\`.`
      }, false);
    }
    let layout;
    try {
      layout = gitLayout(root);
    } catch (error) {
      return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
        nextAction: `no worker was started: zc could not resolve a trustworthy git directory (${error.message}).`
      });
    }
    G.pinLayout(root, layout);
    result.gitLayout = layout;

    const head0 = G.head(root);
    if (!head0) return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: 'the repository has no commits yet; make an initial commit first.' });
    const branch0 = G.branch(root);
    Object.assign(result, { head: head0, branch: branch0 });

    const dirty = G.statusEntries(root);
    let resetAllowed = config.defaults.onLimit === 'reset';
    let resumeNote = '';
    let inheritable = false;
    let baseline = null;
    let prevChanged = new Set();
    let prevVerify = new Set();
    if (repairOf) {
      const prev = getRun(root, repairOf);
      if (!prev) return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: `unknown run "${repairOf}" (see \`zc runs\`).` });
      if (!prev.workerState) {
        return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
          nextAction: `run ${repairOf} has no recorded file contents (it predates content checks), so zc cannot prove the tree is still its result. Commit or \`zc reject --force\` it, then dispatch again.`
        });
      }
      const same = prev.head === head0 && sameState(prev.workerState, G.dirtyState(root));
      if (!same) {
        return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
          changed: G.changedPaths(dirty),
          nextAction: `the working tree no longer matches run ${repairOf} (HEAD moved or file contents changed). Commit or \`zc reject\` first.`
        });
      }
      inheritable = prev.status === 'OK' || prev.status === 'VERIFY_FAILED';
      baseline = prev.workerState;
      prevChanged = new Set(prev.changed ?? []);
      prevVerify = new Set([...(prev.verifyChanged ?? []), ...(prev.carriedVerify ?? [])]);
      resetAllowed = false; // the baseline is reviewed-in-progress work; never wipe it automatically
      resumeNote = REPAIR_NOTE;
    } else if (dirty.length) {
      return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
        changed: G.changedPaths(dirty),
        nextAction: 'the working tree is not clean. Commit the previous result, discard it with `zc reject`, or continue it with `--repair <runId>`.'
      });
    }

    let timeoutSec;
    try {
      timeoutSec = Math.round(parseMinutes(task.meta.minutes ?? config.defaults.minutes, 'task minutes') * 60);
    } catch (error) {
      return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: error.message });
    }
    let metaBase;
    try {
      metaBase = takeMetaBaseline(root, layout);
    } catch (error) {
      return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
        nextAction: `no worker was started: zc could not record the git metadata safely (${error.message}). Fix or remove what it names, then dispatch again.`
      });
    }
    /** Run the integrity gate for one untrusted phase; entries with restored === false need a human. */
    const metaGate = (phase, n) => {
      const saveDir = join(runDir, phase === 'verify' ? `git-meta-violations-verify-${n}` : `git-meta-violations-${n}`);
      try {
        return runGate(root, layout, metaBase, { saveDir });
      } catch (error) {
        return [{ area: 'git', path: '.git', change: 'unreadable', restorable: false, restored: false, detail: error?.message ?? String(error) }];
      }
    };
    const metaStop = (entries, phase, extra = {}) => finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
      ...extra, phase, gitMeta: entries, gitMetaUnrestored: true,
      nextAction: `git metadata changed during the ${phase} phase and could not be fully repaired: ${entries.filter((e) => !e.restored).map((e) => `${e.path} (${e.change}${e.detail ? `: ${e.detail}` : ''})`).join(', ')}. ` +
        (entries.some((e) => e.area === 'refs') ? 'If the worker moved HEAD, a branch or a tag, nothing was rolled back automatically; inspect with `git reflog`. ' : '') +
        `Evidence is in ${join(runDir, phase === 'verify' ? 'git-meta-violations-verify-<n>' : 'git-meta-violations-<n>')}. Edits the worker made under .zc/ were not rolled back; check them by hand too. Do not run git commands in this repository until you have checked these items by hand, then \`zc ack ${id}\`.`
    }, false);
    /** Paths made visible by a rollback (for example by a rolled-back .gitignore) that were not part of the result. */
    const revealedAfterRollback = (before) => {
      const known = new Set([...G.changedPaths(before), ...Object.keys(baseline ?? {})]);
      return G.changedPaths(G.statusEntries(root)).filter((p) => !known.has(p)).sort();
    };
    const cooldownMs = config.defaults.cooldownMinutes * 60_000;
    const flakyMs = config.defaults.flakyCooldownMinutes * 60_000;
    const maxCooldownMs = config.defaults.maxCooldownMinutes * 60_000;
    const flakyRetried = new Set();
    let deniedRetried = false;

    /** Keep the failed worker's partial work, then roll it back (or hand it on). */
    const settlePartial = (n, state) => {
      const entries = G.statusEntries(root);
      if (!entries.length) return { saved: false, rolledBack: false, stuck: [] };
      G.savePartial(root, join(runDir, `partial-${n}`), entries);
      if (!resetAllowed) {
        resumeNote = CONTINUE_NOTE;
        return { saved: true, rolledBack: false, stuck: [] };
      }
      const rb = G.rollbackPaths(root, entries, state);
      const revealed = revealedAfterRollback(entries);
      return {
        saved: true,
        rolledBack: rb.conflicts.length === 0 && !revealed.length,
        stuck: [...rb.conflicts.map((c) => `${c.path} (${c.reason})`), ...revealed.map((p) => `${p} (revealed after rollback)`)]
      };
    };

    const settleHealth = (health) => { settleLease(held, health); held = null; }; // health update and release in one transaction
    let workerUnproven = false; // a worker was spawned and its death is not yet proven: never release the lease
    let held = null; // the account lease of the attempt in progress; null once released or deliberately kept
    while (result.attempts.length < config.defaults.maxAttempts) {
      let got;
      try {
        got = reserve({ root, runId: id, maxProjects: config.defaults.maxLiveProjects });
      } catch (error) {
        return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: `no account could be reserved safely: ${error.message}` });
      }
      if (!got.ok) return finish(...reserveOutcome(got));
      const { account } = got;
      held = got.lease;

      try {
        const n = result.attempts.length + 1;
        const attempt = { n, account: account.id, startedAt: new Date().toISOString() };
        result.attempts.push(attempt);
        log(`attempt ${n} on ${account.id}`);

        const { prompt } = taskPrompt({ root, task, config, resumeNote });
        writeFileSync(join(runDir, `attempt-${n}.prompt.txt`), prompt);
        let zcSnap;
        try {
          zcSnap = snapshotZc(root, join(runDir, `zc-snapshot-${n}`));
        } catch (error) {
          attempt.outcome = 'not-started';
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            nextAction: `no worker was started: .zc/ could not be fully read to protect it (${error.code ?? 'error'}: ${error.message}). Fix its permissions and dispatch again.`
          });
        }
        if (zcSnap.uncopied.length) {
          attempt.outcome = 'not-started';
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            nextAction: `no worker was started: these .zc/ files are too large (or not regular files) to protect with a restorable copy: ${zcSnap.uncopied.slice(0, 5).join(', ')}. Move them out of .zc/ and dispatch again.`
          });
        }
        const started = Date.now();
        let spawned = null;
        const r = await runAgy({
          account, prompt, cwd: root, timeoutSec,
          permissions: config.worker.permissions,
          model: task.meta.model || config.worker.model,
          effort: config.worker.effort,
          onSpawn: (child) => {
            workerUnproven = true;
            spawned = { pgid: child.pid, worker: null };
            try { spawned.worker = processIdentity(child.pid); } catch { /* unreadable: the scan then runs without an age bound */ }
            recordWorker(held, child);
          }
        });
        attempt.durationMs = Date.now() - started;
        // The lease is released only when the worker is proven gone; otherwise the account stays reserved for a human.
        const proof = proveWorkerGone({ profileDir: account.profileDir, pgid: spawned?.pgid, worker: spawned?.worker });
        if (!proof.gone) {
          attempt.outcome = 'worker-unproven';
          const lease = held;
          held = null; // keep the lease
          // false: run no git at all, the worker may still be writing to the repository and its config
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            account: account.id,
            nextAction: `the worker's processes could not be proven gone (group ${proof.group}, profile scan ${proof.scan}${proof.pids?.length ? `, pids ${proof.pids.join(' ')}` : ''}). The account stays reserved (lease ${lease.key}) and no git command was run. Check for stray agy processes, then release it by hand.`
          }, false);
        }
        workerUnproven = false;
        attempt.metrics = attemptMetrics(r.parsed, prompt);
        writeFileSync(join(runDir, `attempt-${n}.events.jsonl`), r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''));

        // Git metadata first: nothing below may run a git command against hooks or config the worker changed.
        const metaEntries = metaGate('worker', n);
        if (metaEntries.length) attempt.gitMeta = metaEntries;
        if (metaEntries.some((e) => !e.restored)) {
          attempt.outcome = 'git-meta-not-restored';
          return metaStop(metaEntries, 'worker', { account: account.id });
        }
        const metaPaths = metaEntries.map((e) => e.path);

        // .zc/ belongs to the manager: undo any change a worker made there, keeping its version as evidence.
        let zcViolations;
        try {
          zcViolations = restoreZc(root, zcSnap, { saveDir: join(runDir, `zc-violations-${n}`) });
        } catch (error) {
          attempt.outcome = 'zc-not-checked';
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            account: account.id,
            nextAction: `after the worker ran, .zc/ could not be read to check it (${error.code ?? 'error'}: ${error.message}). Nothing was rolled back. The pre-run copy is in ${join(runDir, `zc-snapshot-${n}`)}; fix permissions and compare by hand.`
          });
        }
        if (zcViolations.length) attempt.zcViolations = zcViolations;
        const unrestored = zcViolations.filter((v) => !v.restored);
        if (unrestored.length) {
          attempt.outcome = 'zc-not-restored';
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            account: account.id,
            forbidden: unrestored.map((v) => v.path),
            nextAction: `the worker changed .zc/ files that could not be restored: ${unrestored.map((v) => v.path).join(', ')}. Its versions are in ${join(runDir, `zc-violations-${n}`)}; the originals are in ${join(runDir, `zc-snapshot-${n}`)}. Restore them by hand before continuing.`
          });
        }
        const workerState = G.dirtyState(root);

        if (G.head(root) !== head0 || G.branch(root) !== branch0) {
          attempt.outcome = 'moved-head';
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            account: account.id,
            nextAction: 'the worker moved HEAD or switched branches. Nothing was rolled back automatically; inspect with `git reflog`.'
          });
        }

        const p = r.parsed;
        // The edits are the deliverable, so an empty written report is not a failure: git decides (NO_CHANGES below).
        const succeeded = !r.timedOut && !r.error && r.code === 0 && p.status === 'SUCCESS' && !p.error;

        if (succeeded) {
          attempt.outcome = 'ok';
          const entries = G.statusEntries(root);
          let changed = G.changedPaths(entries);
          Object.assign(result, { account: account.id, changed, workerSummary: p.response.slice(0, 2000) || '(the worker wrote no report)' });
          if (!changed.length && p.permissionAsks.length) {
            result.denied = p.denied;
            if (!deniedRetried) { // the model tried a command once; say plainly that commands are off and try again
              deniedRetried = true;
              Object.assign(attempt, { outcome: 'failed', kind: 'permission', error: p.denied[0] ?? 'denied action' });
              resumeNote = NO_COMMANDS_NOTE;
              continue;
            }
            return finish('DENIED', EXIT.FAILED, {
              nextAction: `the worker tried an action it is not allowed (${p.denied.join('; ') || 'a command'}) and stopped with nothing done. Make the task need only file edits, or set worker.permissions to "all" in .zc/config.json if you accept that risk.`
            });
          }
          if (!changed.length && !zcViolations.length && !metaPaths.length) {
            return finish('NO_CHANGES', EXIT.FAILED, {
              nextAction: 'the worker reported success but changed nothing. Read workerSummary, then sharpen the task or give up on it.'
            });
          }
          let inherited = [];
          let scope;
          if (repairOf && inheritable) {
            inherited = changed.filter((p) => prevChanged.has(p) && Object.hasOwn(baseline, p) && workerState[p] === baseline[p]).sort();
            const inheritedSet = new Set(inherited);
            const own = changed.filter((p) => !inheritedSet.has(p));
            const ownScope = partitionByScope(own, allowed, config.forbidden);
            const inheritedScope = partitionByScope(inherited, ['**'], config.forbidden);
            scope = {
              outOfScope: ownScope.outOfScope,
              forbidden: [...ownScope.forbidden, ...inheritedScope.forbidden]
            };
          } else {
            scope = partitionByScope(changed, allowed, config.forbidden);
          }
          result.inherited = inherited;
          const zcPaths = zcViolations.map((v) => v.path);
          if (scope.forbidden.length || scope.outOfScope.length || zcPaths.length || metaPaths.length) {
            G.savePartial(root, join(runDir, 'rejected'), entries);
            let rolledBack = resetAllowed && G.rollbackPaths(root, entries, workerState).conflicts.length === 0;
            const revealed = rolledBack ? revealedAfterRollback(entries) : [];
            if (revealed.length) { rolledBack = false; result.revealedAfterRollback = revealed; }
            return finish('SCOPE_VIOLATION', EXIT.FAILED, {
              phase: 'worker',
              outOfScope: scope.outOfScope,
              forbidden: [...scope.forbidden, ...zcPaths, ...metaPaths],
              gitMeta: metaEntries,
              rolledBack,
              nextAction: rolledBack
                ? 'the worker edited files outside its allowed paths; its work was saved to the run folder and rolled back. Tighten the task or widen `allowed` deliberately.'
                : 'the worker edited files outside its allowed paths and the tree was left as-is. Review with `git status`, then `zc reject`.'
            });
          }
          result.preVerifyState = workerState;
          if (repairOf) {
            const carried = changed.filter((p) => prevVerify.has(p) && Object.hasOwn(baseline, p) && workerState[p] === baseline[p]).sort();
            if (carried.length) {
              result.carriedVerify = carried;
              const carriedSet = new Set(carried);
              changed = changed.filter((p) => !carriedSet.has(p));
              result.changed = changed;
              result.inherited = result.inherited.filter((p) => !carriedSet.has(p));
            }
          }
          const vStarted = Date.now();
          result.verify = await runVerify(root, verifyCmds, { timeoutMs: config.defaults.verifyTimeoutMinutes * 60_000 });
          result.verifyDurationMs = Date.now() - vStarted;

          const vMetaEntries = metaGate('verify', n);
          if (vMetaEntries.length) attempt.gitMetaVerify = vMetaEntries;
          if (vMetaEntries.some((e) => !e.restored)) {
            attempt.outcome = 'git-meta-not-restored';
            return metaStop(vMetaEntries, 'verify', { account: account.id });
          }
          const vMetaPaths = vMetaEntries.map((e) => e.path);

          let verifyZc;
          try {
            verifyZc = restoreZc(root, zcSnap, { saveDir: join(runDir, `zc-violations-verify-${n}`) });
          } catch (error) {
            attempt.outcome = 'zc-not-checked';
            return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
              account: account.id,
              phase: 'verify',
              nextAction: `after verify, .zc/ could not be read to check it (${error.code ?? 'error'}: ${error.message}). Nothing was rolled back. The pre-run copy is in ${join(runDir, `zc-snapshot-${n}`)}; fix permissions and compare by hand.`
            });
          }
          if (verifyZc.length) attempt.zcViolationsVerify = verifyZc;
          const verifyUnrestored = verifyZc.filter((v) => !v.restored);
          if (verifyUnrestored.length) {
            attempt.outcome = 'zc-not-restored';
            return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
              account: account.id,
              phase: 'verify',
              forbidden: verifyUnrestored.map((v) => v.path),
              nextAction: `a verify command changed .zc/ files that could not be restored: ${verifyUnrestored.map((v) => v.path).join(', ')}. Its versions are in ${join(runDir, `zc-violations-verify-${n}`)}; the originals are in ${join(runDir, `zc-snapshot-${n}`)}. Restore them by hand before continuing.`
            });
          }

          if (G.head(root) !== head0 || G.branch(root) !== branch0) {
            attempt.outcome = 'moved-head';
            return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
              account: account.id,
              phase: 'verify',
              nextAction: 'a verify command moved HEAD or switched branches. Nothing was rolled back automatically; inspect with `git reflog`.'
            });
          }

          const postEntries = G.statusEntries(root);
          const postState = G.dirtyState(root);
          const allKeys = new Set([...Object.keys(workerState), ...Object.keys(postState)]);
          const verifyChanged = [...allKeys].filter((p) => workerState[p] !== postState[p]).sort();
          const vScope = partitionByScope(verifyChanged, allowed, config.forbidden);
          const vZcPaths = verifyZc.map((v) => v.path);

          if (vScope.forbidden.length || vScope.outOfScope.length || vZcPaths.length || vMetaPaths.length) {
            G.savePartial(root, join(runDir, 'rejected-verify'), postEntries);
            let rolledBack = resetAllowed && G.rollbackPaths(root, postEntries, G.dirtyState(root)).conflicts.length === 0;
            const revealed = rolledBack ? revealedAfterRollback(postEntries) : [];
            if (revealed.length) { rolledBack = false; result.revealedAfterRollback = revealed; }
            return finish('SCOPE_VIOLATION', EXIT.FAILED, {
              phase: 'verify',
              verifyChanged,
              outOfScope: vScope.outOfScope,
              forbidden: [...vScope.forbidden, ...vZcPaths, ...vMetaPaths],
              gitMeta: vMetaEntries,
              rolledBack,
              nextAction: rolledBack
                ? 'a verify command changed files outside the allowed paths (or .zc/); the whole result was saved to the run folder and rolled back. If your build or tests legitimately write these files, add them to `allowed` or .gitignore.'
                : 'a verify command changed files outside the allowed paths (or .zc/); the tree was left as-is. Review with `git status`, then `zc reject`.'
            });
          }

          if (verifyChanged.length) {
            result.verifyChanged = verifyChanged;
          }

          if (result.verify.some((v) => !v.ok)) {
            return finish('VERIFY_FAILED', EXIT.FAILED, {
              nextAction: 'the changes stay in the working tree. Read the failing tail, then send a fix with `zc dispatch --repair <runId>` or discard with `zc reject`.'
            }, postState);
          }
          return finish('OK', EXIT.OK, {
            nextAction: 'review `git diff` yourself, run your own checks, then `zc accept <runId>` (stages only this run\'s files) and commit; or send a repair / reject.'
          }, postState);
        }

        const errorText = [p.error, ...p.softErrors, r.error, r.stderr.slice(-2000)].filter(Boolean).join('\n');
        let kind;
        if (r.timedOut) kind = 'timeout';
        else if (p.permissionAsks.length && !p.response) kind = 'permission';
        else kind = classify(errorText) ?? (r.code === 0 && !p.error ? 'empty' : 'unknown');
        Object.assign(attempt, {
          outcome: 'failed', kind, error: (p.error || p.softErrors[0] || r.error || '').slice(0, 300)
        });

        const settled = settlePartial(n, workerState);
        attempt.partialSaved = settled.saved;
        attempt.rolledBack = settled.rolledBack;
        if (settled.stuck.length) {
          return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
            changed: settled.stuck,
            nextAction: 'could not roll the working tree back cleanly. Inspect `git status`; the worker\'s partial work is in the run folder.'
          });
        }

        switch (kind) {
          case 'quota': {
            const now = Date.now();
            const hint = parseResetHint(errorText, now, { maxMs: maxCooldownMs });
            const until = Math.min(hint ?? now + cooldownMs, now + maxCooldownMs);
            attempt.cooldownSource = hint ? 'hint' : 'default';
            settleHealth(() => accounts.cooldown(account.id, until, 'quota'));
            attempt.cooldownUntil = new Date(until).toISOString();
            continue;
          }
          case 'auth':
            settleHealth(() => accounts.setStatus(account.id, 'needs-login', attempt.error));
            continue;
          case 'license':
            settleHealth(() => accounts.setStatus(account.id, 'blocked', 'no Antigravity license'));
            continue;
          case 'location':
            return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
              account: account.id,
              nextAction: 'Google refused the request on location, not on the account. Switching accounts cannot fix that, so none was tried. Run from a location Antigravity serves.'
            });
          case 'timeout':
            return finish('TIMEOUT', EXIT.FAILED, {
              account: account.id,
              nextAction: 'the worker ran past its time limit. Split the task into smaller pieces rather than raising the limit.'
            });
          case 'permission':
            return finish('DENIED', EXIT.FAILED, {
              account: account.id,
              denied: p.denied,
              nextAction: 'the worker was denied an action under worker.permissions. Rephrase the task to need only file edits, or set worker.permissions to "all" in .zc/config.json if you accept that risk.'
            });
          default:
            if (!flakyRetried.has(account.id)) { flakyRetried.add(account.id); continue; } // one unchanged rerun
            settleHealth(() => accounts.cooldown(account.id, Date.now() + Math.min(flakyMs, maxCooldownMs), kind));
            continue;
        }
      } finally {
        // A spawned worker whose death was never proven (an error in between) keeps its lease.
        if (held && !workerUnproven) { settleLease(held); held = null; }
      }
    }
    return finish('FAILED', EXIT.FAILED, {
      nextAction: `gave up after ${config.defaults.maxAttempts} worker attempts; see the attempts list and the run folder.`
    });
  } catch (error) {
    if (error?.code !== 'ZC_GIT_TIMEOUT' && error?.code !== 'ZC_NO_HOOKS_DIR') throw error;
    return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
      nextAction: `a git call could not run safely (${error.message}). Check the repository by hand before running git commands in it; the working tree was not rolled back.`
    }, false);
  } finally {
    G.unpinLayout(root);
    release();
  }
}

/**
 * Discard a worker result: save the tree first, then restore only the paths whose content is still exactly
 * what the run left. Anything you changed since is kept and reported. Takes the same lock as dispatch.
 * Returns { runId, rolledBack, restored[], conflicts[{path, reason}], note? }.
 */
export function rejectRun({ root, runId, force = false }) {
  const prev = runId ? getRun(root, runId) : listRuns(root, 1)[0];
  if (!prev) throw new Error('no run to reject (see `zc runs`)');
  const release = acquireLock(lockFile(root), { runId: `reject-${prev.runId}`, registry: true });
  let pinned = false;
  try {
    if (prev.gitLayout) {
      let current;
      try {
        current = gitLayout(root);
      } catch (error) {
        throw new Error(`refusing to reject run ${prev.runId}: the git layout cannot be verified (${error.message})`);
      }
      if (!sameLayout(prev.gitLayout, current)) {
        throw new Error(`refusing to reject run ${prev.runId}, even with --force: the repository's git layout differs from the one the run recorded (git directory, pointer files or identity changed)`);
      }
      G.pinLayout(root, prev.gitLayout);
      pinned = true;
    }
    const pending = pendingMetaRun(root);
    if (pending && !force) {
      throw new Error(`run ${pending.runId} ended with git metadata that zc could not repair (gitMetaUnrestored). Check the listed items by hand and run \`zc ack ${pending.runId}\`, or use --force to discard anyway`);
    }
    const entries = G.statusEntries(root);
    if (!entries.length) return { runId: prev.runId, rolledBack: false, restored: [], conflicts: [], note: 'working tree already clean' };
    if (!prev.workerState && !force) {
      throw new Error(`run ${prev.runId} has no recorded file contents (it predates content checks), so zc cannot tell its changes from yours; use --force to discard everything`);
    }
    const current = G.dirtyState(root);
    const expected = force ? current : prev.workerState;
    const foreign = Object.keys(current).filter((p) => !(p in expected) || expected[p] !== current[p]);
    if (foreign.length && !force) {
      throw new Error(`these changes are not exactly run ${prev.runId}'s result; refusing to discard them: ${foreign.join(', ')} (use --force to override)`);
    }
    G.savePartial(root, join(prev.runDir, 'rejected-manual'), entries);
    const rb = G.rollbackPaths(root, entries, expected);
    return { runId: prev.runId, rolledBack: rb.conflicts.length === 0, restored: rb.restored, conflicts: rb.conflicts };
  } finally {
    if (pinned) G.unpinLayout(root);
    release();
  }
}

/**
 * Record that a person checked the items a gitMetaUnrestored run listed. Adds `gitMetaAcknowledged`
 * (an ISO time) to that run's result.json and changes nothing else.
 */
export function ackRun({ root, runId }) {
  const prev = runId ? getRun(root, runId) : pendingMetaRun(root);
  if (!prev) throw new Error('no run to acknowledge (see `zc runs`)');
  if (!prev.gitMetaUnrestored) throw new Error(`run ${prev.runId} has nothing to acknowledge (no unrepaired git metadata)`);
  const release = acquireLock(lockFile(root), { runId: `ack-${prev.runId}`, registry: true });
  try {
    const file = join(runsDir(root), prev.runId, 'result.json');
    writeJsonAtomic(file, { ...readJson(file, prev), gitMetaAcknowledged: new Date().toISOString() });
    return { runId: prev.runId, gitMetaAcknowledged: true };
  } finally {
    release();
  }
}

/**
 * Stage only the files a verified worker run produced: checks that the run succeeded (OK),
 * HEAD has not moved, and all owned files still match the recorded worker state. Leaves
 * unrelated changes alone; refuses when unrelated paths are staged. Takes the same project
 * lock as dispatch and reject.
 * Returns { runId, staged, leftAlone }.
 */
export function acceptRun({ root, runId, config = {} }) {
  const prev = runId ? getRun(root, runId) : listRuns(root, 1)[0];
  if (!prev) throw new Error('no run to accept (see `zc runs`)');
  const release = acquireLock(lockFile(root), { runId: `accept-${prev.runId}`, registry: true });
  try {
    const pending = pendingMetaRun(root);
    if (pending) {
      throw new Error(`cannot accept run ${prev.runId}: run ${pending.runId} left git metadata that zc could not repair. Check the items it lists by hand, then run \`zc ack ${pending.runId}\``);
    }
    if (prev.status !== 'OK') {
      throw new Error(`cannot accept run ${prev.runId}: status is ${prev.status} (only OK runs can be accepted)`);
    }
    if (!prev.workerState) {
      throw new Error(`run ${prev.runId} has no recorded file contents`);
    }
    if (G.head(root) !== prev.head) {
      throw new Error(`cannot accept run ${prev.runId}: HEAD moved since the run`);
    }
    const current = G.dirtyState(root);
    const owned = Object.keys(prev.workerState);
    const mismatched = owned.filter((p) => current[p] !== prev.workerState[p]);
    if (mismatched.length) {
      throw new Error(`cannot accept run ${prev.runId}: ambiguous ownership for paths: ${mismatched.join(', ')}`);
    }
    const inheritedSet = new Set(prev.inherited ?? []);
    const outOfScope = partitionByScope(owned.filter((p) => !inheritedSet.has(p)), prev.allowed ?? [], config?.forbidden).outOfScope;
    const forbidden = partitionByScope(owned, ['**'], config?.forbidden).forbidden;
    const notChanged = owned.filter((p) => !(prev.changed ?? []).includes(p));
    const verifyPaths = [...(prev.verifyChanged ?? []), ...(prev.carriedVerify ?? [])];
    const badPaths = [...new Set([...outOfScope, ...forbidden, ...notChanged, ...verifyPaths])].sort();
    if (badPaths.length) {
      throw new Error(`cannot accept run ${prev.runId}: paths outside the task scope or not checked as the worker's change: ${badPaths.join(', ')}. Review them, then stage by hand or zc reject.`);
    }
    const ownedSet = new Set(owned);
    const leftAlone = Object.keys(current).filter((p) => !ownedSet.has(p)).sort();
    const entries = G.statusEntries(root);
    const stagedEntries = new Set(
      entries.filter((e) => e.xy[0] !== ' ' && e.xy[0] !== '?').map((e) => e.path)
    );
    const alreadyStaged = leftAlone.filter((p) => stagedEntries.has(p)).sort();
    if (alreadyStaged.length) {
      throw new Error(`cannot accept run ${prev.runId}: unrelated paths are already staged and would be committed with it: ${alreadyStaged.join(', ')}. Unstage them (git restore --staged -- <path>) or commit them separately, then run zc accept again.`);
    }
    if (owned.length) {
      G.git(root, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: owned.join('\0')
      });
    }
    return { runId: prev.runId, staged: owned.sort(), leftAlone };
  } finally {
    release();
  }
}

export function formatResult(r) {
  const lines = [`zc: run ${r.runId} -> ${r.status}${r.phase === 'verify' ? ' during verify' : ''} (exit ${r.exitCode})`];
  if (r.taskId) lines.push(`task: ${r.taskId}${r.account ? `   account: ${r.account}` : ''}`);
  if (r.attempts?.length) {
    lines.push(`attempts: ${r.attempts.map((a) => `${a.account} ${a.outcome ?? '?'}${a.kind ? `(${a.kind})` : ''}`).join(' -> ')}`);
  }
  if (r.changed?.length) lines.push(`changed (${r.changed.length}): ${r.changed.slice(0, 15).join(', ')}${r.changed.length > 15 ? ', ...' : ''}`);
  if (r.outOfScope?.length) lines.push(`OUT OF SCOPE: ${r.outOfScope.join(', ')}`);
  if (r.forbidden?.length) lines.push(`FORBIDDEN: ${r.forbidden.join(', ')}`);
  for (const e of r.gitMeta ?? []) lines.push(`git metadata ${e.restored ? 'repaired' : 'NOT repaired'}: ${e.path} (${e.area} ${e.change})`);
  if (r.revealedAfterRollback?.length) lines.push(`REVEALED after rollback: ${r.revealedAfterRollback.join(', ')}`);
  for (const v of r.verify ?? []) lines.push(`verify ${v.ok ? 'PASS' : 'FAIL'}: ${v.cmd}${v.ok ? '' : `\n${v.tail}`}`);
  if (r.retryAfter) lines.push(`retry after: ${r.retryAfter}`);
  if (r.workerSummary) lines.push(`worker says: ${r.workerSummary.slice(0, 600)}`);
  if (r.nextAction) lines.push(`next: ${r.nextAction}`);
  if (r.runDir) lines.push(`record: ${r.runDir}`);
  return lines.join('\n');
}
