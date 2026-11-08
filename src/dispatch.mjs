import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as accounts from './accounts.mjs';
import { runAgy } from './agy.mjs';
import { classify, parseResetHint } from './classify.mjs';
import { acquireLock, readJson, writeJsonAtomic } from './fsx.mjs';
import * as G from './gitx.mjs';
import { lockFile, runsDir } from './paths.mjs';
import { buildPrompt, loadEccAssets, loadEccRules, loadPrefix } from './prompt.mjs';
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

export const getRun = (root, id) => readJson(join(runsDir(root), id, 'result.json'), null);

function taskPrompt({ root, task, config, resumeNote }) {
  const allowed = task.meta.allowed.length ? task.meta.allowed : config.defaults.allowed;
  const verify = task.meta.verify.length ? task.meta.verify : config.verify;
  return {
    allowed,
    verify,
    prompt: buildPrompt({
      prefix: loadPrefix(root, config),
      eccRules: loadEccRules(config),
      eccAssets: loadEccAssets(config, task),
      task,
      allowed,
      forbiddenExtra: config.forbidden,
      verify,
      resumeNote
    })
  };
}

/**
 * Run one task on one worker at a time, in place, switching accounts when one
 * hits a limit. The tree must be clean on entry (or match a prior run when
 * `repairOf` is given). Worker output is never trusted: scope is checked from
 * git itself and verification is run here, not reported by the worker.
 */
export async function dispatch({ root, task, config, repairOf = null, dryRun = false, log = () => {} }) {
  const { allowed, verify: verifyCmds, prompt: dryPrompt } = taskPrompt({
    root, task, config, resumeNote: repairOf ? REPAIR_NOTE : ''
  });
  if (dryRun) return { status: 'DRY_RUN', exitCode: 0, taskId: task.meta.id, allowed, prompt: dryPrompt };

  const id = newRunId();
  const runDir = join(runsDir(root), id);
  mkdirSync(runDir, { recursive: true });
  const result = {
    runId: id, runDir, taskId: task.meta.id, repairOf, status: 'FAILED', exitCode: 1,
    startedAt: new Date().toISOString(), account: null, allowed, attempts: [], changed: [],
    outOfScope: [], forbidden: [], verify: [], workerSummary: '', nextAction: '', head: null, branch: null
  };
  const finish = (status, exitCode, extra = {}) => {
    Object.assign(result, { status, exitCode, finishedAt: new Date().toISOString() }, extra);
    try { result.workerState = G.dirtyState(root); } catch { /* not a git repo yet: nothing to record */ }
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
    release = acquireLock(lockFile(root), { runId: id });
  } catch (error) {
    return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: error.message });
  }

  try {
    const head0 = G.head(root);
    if (!head0) return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: 'the repository has no commits yet; make an initial commit first.' });
    const branch0 = G.branch(root);
    Object.assign(result, { head: head0, branch: branch0 });

    const dirty = G.statusEntries(root);
    let resetAllowed = config.defaults.onLimit === 'reset';
    let resumeNote = '';
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
    const cooldownMs = config.defaults.cooldownMinutes * 60_000;
    const flakyMs = config.defaults.flakyCooldownMinutes * 60_000;
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
      return { saved: true, rolledBack: rb.conflicts.length === 0, stuck: rb.conflicts.map((c) => `${c.path} (${c.reason})`) };
    };

    while (result.attempts.length < config.defaults.maxAttempts) {
      const account = accounts.pickNext();
      if (!account) {
        const at = accounts.nextAvailableAt();
        if (at) {
          return finish('NO_CAPACITY', EXIT.NO_CAPACITY, {
            retryAfter: new Date(at).toISOString(),
            nextAction: `every account is cooling down; the earliest is back at ${new Date(at).toISOString()}. Wait, or add an account with \`zc account add\`.`
          });
        }
        return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, {
          nextAction: accounts.listAccounts().length
            ? 'no account is ready (needs-login or blocked). See `zc status`; fix with `zc account login <id>`.'
            : 'no worker accounts yet. Run `zc account add <id>` for each Gemini account.'
        });
      }

      const n = result.attempts.length + 1;
      const attempt = { n, account: account.id, startedAt: new Date().toISOString() };
      result.attempts.push(attempt);
      accounts.markUsed(account.id);
      log(`attempt ${n} on ${account.id}`);

      const { prompt } = taskPrompt({ root, task, config, resumeNote });
      writeFileSync(join(runDir, `attempt-${n}.prompt.txt`), prompt);
      const zcSnap = snapshotZc(root, join(runDir, `zc-snapshot-${n}`));
      const started = Date.now();
      const r = await runAgy({
        account, prompt, cwd: root, timeoutSec,
        permissions: config.worker.permissions,
        model: task.meta.model || config.worker.model,
        effort: config.worker.effort
      });
      attempt.durationMs = Date.now() - started;
      writeFileSync(join(runDir, `attempt-${n}.events.jsonl`), r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''));

      // .zc/ belongs to the manager: undo any change a worker made there, keeping its version as evidence.
      const zcViolations = restoreZc(root, zcSnap, { saveDir: join(runDir, `zc-violations-${n}`) });
      if (zcViolations.length) attempt.zcViolations = zcViolations;
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
        const changed = G.changedPaths(entries);
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
        if (!changed.length && !zcViolations.length) {
          return finish('NO_CHANGES', EXIT.FAILED, {
            nextAction: 'the worker reported success but changed nothing. Read workerSummary, then sharpen the task or give up on it.'
          });
        }
        const scope = partitionByScope(changed, allowed, config.forbidden);
        const zcPaths = zcViolations.map((v) => v.path);
        if (scope.forbidden.length || scope.outOfScope.length || zcPaths.length) {
          G.savePartial(root, join(runDir, 'rejected'), entries);
          const rolledBack = resetAllowed && G.rollbackPaths(root, entries, workerState).conflicts.length === 0;
          return finish('SCOPE_VIOLATION', EXIT.FAILED, {
            outOfScope: scope.outOfScope,
            forbidden: [...scope.forbidden, ...zcPaths],
            rolledBack,
            nextAction: rolledBack
              ? 'the worker edited files outside its allowed paths; its work was saved to the run folder and rolled back. Tighten the task or widen `allowed` deliberately.'
              : 'the worker edited files outside its allowed paths and the tree was left as-is. Review with `git status`, then `zc reject`.'
          });
        }
        result.verify = await runVerify(root, verifyCmds, { timeoutMs: config.defaults.verifyTimeoutMinutes * 60_000 });
        if (result.verify.some((v) => !v.ok)) {
          return finish('VERIFY_FAILED', EXIT.FAILED, {
            nextAction: 'the changes stay in the working tree. Read the failing tail, then send a fix with `zc dispatch --repair <runId>` or discard with `zc reject`.'
          });
        }
        return finish('OK', EXIT.OK, {
          nextAction: 'review `git diff` yourself, run your own checks, then commit; or send a repair / reject.'
        });
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
          const until = parseResetHint(errorText) ?? Date.now() + cooldownMs;
          accounts.cooldown(account.id, until, 'quota');
          attempt.cooldownUntil = new Date(until).toISOString();
          continue;
        }
        case 'auth':
          accounts.setStatus(account.id, 'needs-login', attempt.error);
          continue;
        case 'license':
          accounts.setStatus(account.id, 'blocked', 'no Antigravity license');
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
          accounts.cooldown(account.id, Date.now() + flakyMs, kind);
          continue;
      }
    }
    return finish('FAILED', EXIT.FAILED, {
      nextAction: `gave up after ${config.defaults.maxAttempts} worker attempts; see the attempts list and the run folder.`
    });
  } finally {
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
  const release = acquireLock(lockFile(root), { runId: `reject-${prev.runId}` });
  try {
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
    release();
  }
}

export function formatResult(r) {
  const lines = [`zc: run ${r.runId} -> ${r.status} (exit ${r.exitCode})`];
  if (r.taskId) lines.push(`task: ${r.taskId}${r.account ? `   account: ${r.account}` : ''}`);
  if (r.attempts?.length) {
    lines.push(`attempts: ${r.attempts.map((a) => `${a.account} ${a.outcome ?? '?'}${a.kind ? `(${a.kind})` : ''}`).join(' -> ')}`);
  }
  if (r.changed?.length) lines.push(`changed (${r.changed.length}): ${r.changed.slice(0, 15).join(', ')}${r.changed.length > 15 ? ', ...' : ''}`);
  if (r.outOfScope?.length) lines.push(`OUT OF SCOPE: ${r.outOfScope.join(', ')}`);
  if (r.forbidden?.length) lines.push(`FORBIDDEN: ${r.forbidden.join(', ')}`);
  for (const v of r.verify ?? []) lines.push(`verify ${v.ok ? 'PASS' : 'FAIL'}: ${v.cmd}${v.ok ? '' : `\n${v.tail}`}`);
  if (r.retryAfter) lines.push(`retry after: ${r.retryAfter}`);
  if (r.workerSummary) lines.push(`worker says: ${r.workerSummary.slice(0, 600)}`);
  if (r.nextAction) lines.push(`next: ${r.nextAction}`);
  if (r.runDir) lines.push(`record: ${r.runDir}`);
  return lines.join('\n');
}
