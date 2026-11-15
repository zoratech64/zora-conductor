# Zora-Conductor Hardening Specification

Status: authoritative for the hardening phase. Written 2026-11-13 against `main` at `adafef0` (version 0.2.0-alpha.1).
Audience: the engineering model implementing the work, and the manager (Claude Code + `zc:orchestrate`) that dispatches it as scoped tasks.
Every source reference below was verified against the working tree on the date above. Line numbers are approximate anchors; symbol names are exact.
Updated 2026-11-13 on `hardening/zch` at `63bc634` (ZCH-001 implemented): added finding F8 and task ZCH-011 (git metadata integrity); invariants, order and completion criteria adjusted accordingly.

---

## A. Executive summary

**Current condition.** zc is a small (about 2.6k lines, zero dependencies) Node 22 CLI with a deliberate safety design: statuses come from git and from zc's own verify commands, never from the worker's report; rollback is content-fingerprinted; `.zc/` is snapshotted and restored around every worker run; the ECC install is staged and recoverable. 123 behavioural tests run against a scriptable fake `agy` (117 pass, 6 skip on Windows). The real `agy` CLI has never been exercised by the author.

**Main gaps (all verified, see section C).**
1. The verify gate executes worker-authored code with the manager's full privileges, and it runs *after* the `.zc/` integrity restore and the scope check. Nothing is re-checked afterwards, so changes made during verify (to the repository, to `.zc/`, or to HEAD) end as `OK`.
2. The worker process inherits the manager's entire environment.
3. Stale-lock takeover can delete a live lock, and PID reuse can block a project forever.
4. Account state is machine-global but guarded only by a per-project lock, so concurrent projects race on it.
5. zc has no signal handlers; an interrupted run can leave a worker alive and a lock behind.
6. A cooldown hint parsed from free text has no upper bound (reproduced: a 1510-day cooldown).
7. Output capture drops everything after 8 MB, so a successful worker whose final `result` event falls past the cap is classified `empty` and rolled back (reproduced).
8. Nothing protects git metadata. `git status` never lists `.git/`, so planted hooks, config (aliases, `core.fsmonitor`, filters, includes), ignore sources and index flags pass unseen, can hide out-of-scope edits from the scope check, and some make zc's own git calls execute code (reproduced; found during the ZCH-001 review).

**Target condition.** Every untrusted execution phase (worker, verify) is followed by the same integrity checks; shared state is serialized; interruptions have a defined outcome; parsed hints are bounded; the worker's result is never lost to buffering; the documentation states exactly what zc guarantees and what it does not.

**What must remain unchanged.** The manager/CLI/worker layering, git as the source of truth, the clean-tree and content-verified rollback model, `.zc/` ownership by the manager, the one-dispatch-per-project rule, the exit-code contract (0/1/2/3), existing CLI commands and `.zc/config.json` keys, the stream-json worker protocol, the zero-dependency rule, and the fake-agy test approach.

---

## B. Existing architecture (relevant parts)

**Entry.** `bin/zc.mjs` → `main()` in `src/cli.mjs`. `cmdDispatch` → `dispatch()` in `src/dispatch.mjs`. Any thrown error in `main` becomes exit 3.

**Dispatch lifecycle (`dispatch()`, `src/dispatch.mjs`).**
1. Build the prompt (`taskPrompt` → `buildPrompt` in `src/prompt.mjs`); dry run returns here.
2. Create `<state>/projects/<key>/runs/<runId>/`; `finish()` writes `result.json` via `writeJsonAtomic` and records `result.workerState = G.dirtyState(root)` at the moment it is called.
3. Guards: non-empty `allowed`; project lock (`acquireLock(lockFile(root))`); HEAD exists; tree clean, or equal (by `sameState`) to the run named in `repairOf`; durations via `parseMinutes`.
4. Attempt loop (`while attempts < maxAttempts`): `accounts.pickNext()` then `accounts.markUsed()`; `snapshotZc()` (fails closed on unreadable or oversize `.zc/`); `runAgy()`; `restoreZc()` (worker edits under `.zc/` are undone and saved as evidence); `workerState = G.dirtyState(root)`; HEAD/branch unchanged check.
5. Success path (`succeeded` = exit 0, `status === 'SUCCESS'`, no error): `changed` from `statusEntries`; `DENIED` / `NO_CHANGES` handling; `partitionByScope(changed, allowed, config.forbidden)`; on violation `savePartial` + `rollbackPaths` (only if `resetAllowed`); otherwise `runVerify()`; `VERIFY_FAILED` keeps the tree; else `OK`.
6. Failure path: `kind` from `classify()` over `[p.error, softErrors, r.error, stderr tail]`; `settlePartial` saves and (if `resetAllowed`) rolls back; `quota` → `accounts.cooldown(id, parseResetHint(text) ?? now + cooldownMinutes)`; `auth` → `needs-login`; `license` → `blocked`; `location` → `NEEDS_HUMAN`; `timeout`/`permission` terminal; anything else → one unchanged rerun, then `flakyCooldownMinutes`.
7. `finally { release() }` releases the lock (only on normal JS completion).

**Worker integration (`src/agy.mjs`).** `findAgy()` locates the binary (`ZC_AGY` override lets tests inject `fixtures/fake-agy.mjs`). `agyEnv()` builds the environment as `{ ...process.env, NO_COLOR, GEMINI_FORCE_FILE_STORAGE }` plus SSH hints on Windows/macOS. `launchPlan()` wraps the call in `dbus-run-session` on Linux with a private `HOME`/`XDG_RUNTIME_DIR` and deletes bus/keyring variables. `agyRunArgs()` maps `worker.permissions` to `--mode plan|accept-edits` or `--dangerously-skip-permissions`. `runAgy()` sends the prompt on stdin and returns `{ code, timedOut, stdout, stderr, error, parsed }` where `parsed = parseAgyOutput(stdout + stderr)`.

**Verification (`src/verify.mjs`).** `runVerify(root, commands, { timeoutMs })` runs each argv array with `run(command, args, { cwd: root, env: process.env })`, no shell, stops at the first failure, returns `{ cmd, ok, code, timedOut, durationMs, tail }`.

**Process control (`src/proc.mjs`).** `run()` spawns with `detached: process.platform !== 'win32'`, captures stdout/stderr into strings capped by `maxBytes` (default 8 000 000; `append` discards whole chunks once the cap is reached), supports `onStdoutLine` streaming, kills the tree on timeout (`killTree`: process-group SIGTERM then SIGKILL, or `taskkill /T /F`). It never rejects.

**Git safety (`src/gitx.mjs`, `src/snapshot.mjs`).** `statusEntries` (porcelain v1, `-z`, untracked-all, `.zc/` filtered out), `changedPaths`, `pathStates` (= working-tree SHA-256 fingerprint `#` index entry, so staging counts as a change), `dirtyState`, `savePartial` (patch + untracked copies), `rollbackPaths` (restores only paths whose fingerprint equals `expected`; others are conflicts). `snapshotZc`/`restoreZc` cover files, empty directories, the `.zc` root itself, and fail closed on any error other than ENOENT/ENOTDIR.

**State (`src/paths.mjs`).** Global: `<state>/accounts.json`, `<state>/profiles/<id>/`, `<state>/ecc/`. Per project: `<state>/projects/<name>-<hash>/{runs,dispatch.lock}`. Project-side: `<project>/.zc/`.

**Accounts (`src/accounts.mjs`).** Every function is `load()` → mutate → `save()` (atomic write, no lock). `pickNext` is sticky on `currentId`, else least-recently-used among `status === 'ready'` and not cooling. `cooldown`/`setStatus` go through `hold()`, which also clears `currentId`.

**Locks (`src/fsx.mjs`).** `acquireLock(path, info)`: `openSync(path, 'wx')`; on `EEXIST` read the record, throw if `pidAlive(record.pid)`, else `unlinkSync` and retry once. Used for the project lock, `reject`, and the ECC install lock.

---

## C. Verified findings

Severity scale: Critical / High / Medium / Low. Verification status: **Confirmed** (traced in code and, where marked, reproduced in memory), **Partially confirmed**, or **Requires real-runtime verification**.

### F1. Verify executes worker-authored code; post-verification blind spot
- Severity: **High**. Status: **Confirmed** (code trace; ordering is unambiguous).
- Files: `src/verify.mjs` `runVerify`; `src/dispatch.mjs` `dispatch` (restoreZc ≈ line 210, `partitionByScope` ≈ 264, `runVerify` ≈ 279, `finish('OK')` ≈ 286); `src/agy.mjs` `agyRunArgs` (permission modes).
- Root cause: verify commands are manager-configured (`npm test`, `flutter test`, …) but their inputs are the files the worker just wrote. Scope, `.zc/` and HEAD checks all precede verify; nothing runs after it.
- Scenario: a worker (honestly following injected text in a repository file, or a tampered ECC asset) writes a test that, when `npm test` runs, rewrites `.zc/config.json` (`worker.permissions: "all"`, extra verify commands), drops files outside `allowed`, reads `~/.ssh` or environment variables, or commits. The run ends `OK`; the skill's `git add -A && git commit` persists the tampering.
- Consequences: arbitrary code execution as the manager user; silent scope and `.zc/` bypass; the "edit-only" claim in README is not a security property.
- Existing protections: forbidden-path list, prompt rules, pre-verify scope check, `.zc/` restore before verify, the skill's instruction to read `git diff` before committing, README's "guard rail, not a sandbox" caveat.
- Remaining limitations after the planned fix (ZCH-001): post-verify checks detect and undo repository-visible effects only. Effects outside the repository (home directory, network, credentials) are not detectable by zc; only OS-level isolation addresses them (section G).

### F2. Worker inherits the manager's complete environment
- Severity: **Low–Medium**. Status: **Partially confirmed**.
- Files: `src/agy.mjs` `agyEnv` (`{ ...env, … }`), `launchPlan` (deletes only bus/keyring/XDG variables on Linux).
- Root cause: no allowlist; the full shell environment of the manager reaches the `agy` process.
- Scenario: the shell that runs zc carries `ANTHROPIC_API_KEY`, `GH_TOKEN`, cloud credentials. In `edit` mode the model's tools cannot read the environment, so exposure is to the vendor binary only. In `all` mode, or through F1, a command can print or exfiltrate it.
- Consequences: defence-in-depth gap; becomes a direct leak when combined with F1 or `permissions: all`.
- Existing protections: `edit` mode by default; verify commands are the manager's own and legitimately need the environment.
- Remaining limitation: the exact variables `agy` needs to authenticate are not documented by the vendor; the allowlist must be validated against a real login (ZCH-010).

### F3. Stale-lock takeover race and PID reuse
- Severity: **Medium**. Status: **Confirmed** by trace (conditional); not reproduced live.
- Files: `src/fsx.mjs` `acquireLock`, `pidAlive`; callers `dispatch`, `rejectRun`, `installFrom`, `recoverInterrupted`.
- Root cause: takeover is read → `pidAlive` → `unlinkSync` → retry, with no check that the file unlinked is the file that was read. `pidAlive` treats any live process with that PID as the holder.
- Scenarios: (a) a stale lock exists (only after a crash or kill), two zc processes start together, B acquires between A's read and unlink, A unlinks B's live lock and acquires too: two dispatches in one project. (b) After a crash and reboot the recorded PID belongs to an unrelated process (Windows reuses PIDs aggressively): every dispatch fails "already running" until someone finds and deletes the file; the error names the PID but not the path.
- Consequences: (a) concurrent edits to one tree, invalid rollback baselines; (b) hard stop that looks like a zc bug.
- Existing protections: `finally { release() }` on every normal path; atomic `wx` creation; record carries `pid`, `startedAt`, `runId`.
- Remaining limitation: process start time is not portably available, so PID reuse can only be made recoverable and visible, not impossible.

### F4. Cross-project account-state concurrency
- Severity: **Medium**. Status: **Confirmed** by trace (conditional on concurrent projects).
- Files: `src/paths.mjs` `lockFile` (per project); `src/accounts.mjs` `load`/`save`, `pickNext`, `markUsed`, `hold`, `updateAccount`; `src/dispatch.mjs` (`pickNext` and `markUsed` are separate calls).
- Root cause: `accounts.json` is global; every mutation is an unlocked load-modify-save; selection and marking are not atomic.
- Scenario: projects A and B dispatch together. Both `pickNext()` return `g1` (sticky `currentId`); both run `g1` concurrently against the same `--gemini_dir`. Later A's `cooldown('g1')` is overwritten by B's `markUsed('g2')` saved from a stale copy, so `g1` is retried while exhausted.
- Consequences: lost cooldown / `needs-login` / `blocked` writes; two workers on one profile directory (behaviour of `agy` under that condition is unknown).
- Existing protections: `writeJsonAtomic` prevents torn files; per-project lock prevents the same project racing itself.
- Remaining limitation: whether concurrent `agy` processes may share one profile safely needs real-runtime verification (ZCH-009).

### F5. Missing signal handling; potential orphaned workers
- Severity: **Low–Medium**. Status: **Partially confirmed; requires real-runtime verification** for the orphan's lifetime.
- Files: `src/proc.mjs` `run` (`detached: true` on POSIX), `killTree`; `src/dispatch.mjs` (no handler, `finally` does not run on a signal); `bin/zc.mjs`.
- Root cause: no `process.on('SIGINT'|'SIGTERM')` anywhere. On POSIX the worker is in its own process group, so a terminal Ctrl+C reaches zc only; zc exits without running `finally`.
- Scenario: the operator interrupts a long run. The lock file remains (reclaimed later by the PID check). The worker keeps running until its next write to the now-closed stdout pipe fails (EPIPE), which for a stream-json process is soon but not immediate; during that window it may still edit the tree. No `result.json` records what happened, so `reject`/`repair` have nothing to compare against. On Windows the child shares the console and normally receives the Ctrl+C.
- Consequences: unrecorded partial edits in the tree; next dispatch refuses the dirty tree with a message that assumes a recorded run.
- Existing protections: stale-lock takeover; the clean-tree guard; EPIPE behaviour of most runtimes.
- Remaining limitation: Windows has no SIGTERM semantics; `process.kill(pid)` there terminates without running handlers.

### F6. Unbounded cooldown timestamps
- Severity: **Medium**. Status: **Confirmed and reproduced** (`parseResetHint('… quota exceeded … valid until 2031-01-01T00:00:00Z')` → cooldown of 1510 days; a timestamp without timezone is parsed as local time).
- Files: `src/classify.mjs` `parseResetHint`; `src/dispatch.mjs` `case 'quota'` (`accounts.cooldown(account.id, until, 'quota')`).
- Root cause: the first future ISO timestamp anywhere in `[error, softErrors, spawn error, last 2000 chars of stderr]` is accepted verbatim; no clamp, no timezone requirement.
- Scenario: any quota-classified failure whose stderr carries an unrelated future date (token validity, log line, tooling banner) removes the account from the pool for months. Recovery is manual (`zc account reset`).
- Consequences: silent capacity loss; `NO_CAPACITY` with a `retryAfter` years away.
- Existing protections: `zc status` shows "cooling until"; `zc account reset` clears it; unit tests cover sane hints only.
- Remaining limitation: none once clamped.

### F7. Output truncation and incorrect result classification
- Severity: **Low–Medium**. Status: **Confirmed and reproduced** (child emitting 9 MB of events then a `SUCCESS` result → captured 8.0 MB, `parsed.status === ''`, exit 0 → kind `empty`). Whether real `agy` streams reach 8 MB in one task **requires real-runtime verification**.
- Files: `src/proc.mjs` `run` (`append` drops chunks after `maxBytes`); `src/agy.mjs` `runAgy`, `parseAgyOutput`; `src/dispatch.mjs` classification (`r.code === 0 && !p.error ? 'empty' : 'unknown'`) and the `default` branch (rerun once, then `flakyCooldownMinutes`).
- Root cause: the result event is parsed from the capped buffer after exit instead of from the stream.
- Scenario: a verbose worker finishes correctly; its final event is discarded; zc classifies `empty`, `settlePartial` rolls the finished work back, reruns once, then cools the account for 10 minutes. The saved `attempt-N.events.jsonl` is also truncated.
- Consequences: completed work discarded, wasted quota, misleading account state.
- Existing protections: `onStdoutLine` streaming already exists in `run()` (unused by `runAgy`); `--print-timeout` bounds runtime.
- Remaining limitation: none once the result is captured from the stream.

### F8. Git metadata is outside every integrity check
- Severity: **High**. Status: **Confirmed and reproduced** (git 2.55.0.windows.4, temp repos; real `agy`'s ability to write under `.git/` with its edit tools **requires real-runtime verification**, but verify commands and `permissions: all` can do it regardless).
- Files: `src/gitx.mjs` `git` (only `-c core.quotepath=off`), `statusEntries`, `savePartial` (`git diff HEAD --binary`), `rollbackPaths` (`git restore`); `src/scope.mjs` `DEFAULT_FORBIDDEN` (`.git/**`, `**/.git/**`); `src/dispatch.mjs` `dispatch` (worker phase: `restoreZc` ≈ line 210, `G.dirtyState` ≈ 228, HEAD check ≈ 230; verify phase: `restoreZc` ≈ 285, HEAD ≈ 306, `statusEntries` ≈ 315), `finish` (calls `G.dirtyState`); `rejectRun`. No code resolves the git directory; the only `.git` test is the `isForbidden` unit test.
- Root cause: every integrity check reads repository state through `git status`, which never lists `.git/` (probe: a planted `.git/hooks/pre-commit` gives 0 status lines). `DEFAULT_FORBIDDEN`'s `.git/**` entries therefore never match anything. Git metadata also controls what `git status` reports and which external commands git runs.
- Reproduced blind spots (all ended with the change invisible to `git status`, or `OK` through `dispatch`):
  - `.git/hooks/pre-commit` and a `.git/config` alias planted by a verify command: run ends `OK`.
  - `.git/info/exclude` gaining `other/` hides a new out-of-scope `other/x.txt` from the scope check.
  - `git update-index --skip-worktree` (flag `S`) or `--assume-unchanged` (flag `h`) hides an out-of-scope modification of a tracked file.
  - `core.fsmonitor` set in local config runs its command on `git status` and on `git diff HEAD`; `-c core.fsmonitor=false` prevents it; `git rev-parse` does not run it.
  - `diff.external` runs on `git diff HEAD --binary` (`--no-ext-diff` prevents it); a `filter.<x>.clean` command assigned through `.git/info/attributes` runs on `git diff HEAD` even with `--no-ext-diff --no-textconv`.
  - `core.hooksPath` redirects hooks anywhere (relative to the work tree, or absolute outside the repository); `git rev-parse --git-path hooks` resolves the effective directory.
  - Include files: values from `include.path` / `includeIf.*.path` appear only with `--includes`, attributed to the included file by `--show-origin`. A relative include path resolves against the directory of the including config file. A missing include target is silently ignored, so a pre-existing dangling include becomes live when the file is created; an include target inside the work tree can be hidden by `.gitignore`.
  - Moving another branch (`update-ref refs/heads/other`) is invisible to status and to the existing HEAD/branch check.
  - Linked worktree: `.git` is a file (`gitdir: <main>/.git/worktrees/<name>`); git-dir (index, HEAD, `config.worktree`) is private, but hooks, `config`, `info/exclude` and refs live in the shared common dir. Rewriting the `.git` pointer to a decoy repository made plain `git rev-parse` report the decoy; rewriting `<git-dir>/commondir` did the same for the common dir. Pinned `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` neutralised both.
  - Per-command execution (marker probe, repo config wiring every program-launching key): `core.fsmonitor` ran on `status`, `ls-files -s/-v`, `update-index`, `restore`, `rm --cached` and `diff HEAD`; a `post-index-change` hook ran on `status`, `update-index` and `restore`; clean/smudge filters and `diff.external` ran on `diff HEAD`; smudge ran on `restore`. With `-c core.fsmonitor=false -c core.hooksPath=<empty dir>`, fsmonitor and hooks never ran, but filters still ran on `diff` and `restore`, and `diff.external` on `diff` without `--no-ext-diff`. `rev-parse`, `symbolic-ref`, `cat-file -e`, `config --list` and `for-each-ref` ran nothing even plain.
  - Removing a user's pre-existing `skip-worktree` flag exposes their hidden local edit in `git status` (`M b.txt`); zc would then treat it as the worker's change and roll it back (data loss).
- Scenario: a worker (or a verify command running worker-written code) sets `core.fsmonitor` or a clean filter in `.git/config`; zc's own `git status`/`git diff HEAD` right after the run executes it as the manager. Or it plants `pre-commit`, which runs on the manager's next `git commit`. Or it hides an out-of-scope edit with `info/exclude` or `skip-worktree`, so the run ends `OK` with the edit in the tree.
- Consequences: code execution as the manager, triggered by zc itself or by the manager's next git command; silent scope bypass that defeats ZCH-001.
- Existing protections: ZCH-001's post-verify HEAD/branch check (catches a moved current branch only); manual review of `git status`/`git diff` (which cannot show any of the above).
- Remaining limitations after ZCH-011: global/system git config, global hook directories and other files outside the repository and its git dirs are not covered (OS isolation, section G); metadata of submodules (`.git/modules/*`) is not covered; refs and shared metadata in linked worktrees are detected, not restored.

---

## D. Target safety invariants

The implementation must preserve or establish all of the following. Each has at least one automated test after the hardening phase (section F).

1. **No silent scope bypass.** Any repository path changed during a worker run *or* during verify that is outside `allowed`, or forbidden, is reported (`outOfScope`/`forbidden`) and the run never ends `OK`.
2. **`.zc/` integrity after every untrusted phase.** `restoreZc` is evaluated against the pre-run snapshot after the worker *and* after verify; any difference is restored, saved as evidence, and fails the run.
3. **Verify is untrusted.** HEAD and branch are re-checked after verify; verify-time differences are classified exactly like worker-time differences.
4. **Minimal worker environment.** The worker receives an allowlisted environment plus explicitly configured passthrough; the manager's verify commands keep the manager's environment.
5. **Serialized global state.** Every write to `accounts.json` happens under one machine-global lock; account selection and marking are one atomic step.
6. **Predictable interruption.** SIGINT/SIGTERM during a run kills the worker tree, writes a `result.json` with status `INTERRUPTED` and the current `workerState`, releases the lock, and exits 3. Partial work is left in the tree (never rolled back on interrupt) and is recorded so `reject`/`--repair` can reason about it.
7. **Bounded cooldowns.** No cooldown written by zc exceeds `defaults.maxCooldownMinutes` (default 1440); unparseable or out-of-range hints fall back to `defaults.cooldownMinutes`.
8. **Result never lost to buffering.** The worker's `result` event is captured from the stream; buffer truncation is recorded (`stdoutTruncated`) and never changes the status.
9. **Staged changes stay protected.** `pathStates` continues to include the index entry; `reject` and rollback continue to refuse paths whose fingerprint differs.
10. **Rollback never destroys pre-existing user changes.** Rollback still requires a clean tree at start (or an exact `--repair` match) and restores only paths whose current fingerprint equals the recorded one.
11. **Fail closed on inspection errors** (existing): any error other than ENOENT/ENOTDIR while reading `.zc/` ends the run as `NEEDS_HUMAN`; the post-verify check inherits this.
12. **Lock takeover is single-writer.** Only one process can perform a takeover at a time, and it unlinks only the record it read.
13. **Exit-code contract unchanged.** 0 OK · 1 failed · 2 no capacity · 3 needs a human. New statuses map onto these codes.
14. **Git metadata integrity after every untrusted phase.** The `.git` entry and git-dir identity, hooks (effective hooks directory), local and worktree config including include files, ignore/attribute/history sources, index flags with the content of flagged files, and refs are compared with the pre-run baseline after the worker and after verify; no difference reaches `OK`.
15. **Pinned git directory.** The git-dir, common-dir and work tree are resolved once before the first worker and pinned for every zc git call of that dispatch; a changed pointer is repaired from recorded bytes, a changed git-dir identity ends `NEEDS_HUMAN` with no further git command.
16. **No unsafe git command before the gate.** Every zc git call is hardened (`core.fsmonitor=false`, `core.hooksPath=<empty dir>`, pinned environment); after an untrusted phase only the inert commands of ZCH-011 §11.2 run until the gate has proven config, attribute sources and hooks equal the baseline; `savePartial` adds `--no-ext-diff --no-textconv`.
17. **No blanket restore of git metadata.** zc restores only individual small files it snapshotted, re-sets or clears only index flags whose state it saw change, and saves every changed version first; refs, objects, index content and shared common-dir metadata of linked worktrees are never rewritten automatically.
18. **Pre-existing hidden user state is preserved.** Index flags and the content of flagged files that existed before the run are never changed by zc and never rolled back as the worker's.

---

## E. Implementation tasks

Conventions: ESM, 2-space, single quotes, `node:test` + `node:assert/strict`, helpers from `test/helpers.mjs` (`makeHome`, `makeRepo`, `addFake`, `setScenario`, `task`, `git`, `calls`, `lastPrompt`), scenarios in `fixtures/fake-agy.mjs`. No new dependencies. Every task ends with `npm test` and `npm run check` passing. Each task lists suggested `allowed:` paths for its zc task file; the manager may narrow them, never widen them beyond `src/`, `test/`, `fixtures/`, `docs/`, `README.md`, `CHANGELOG.md`, `skills/orchestrate/SKILL.md`.

**Important for self-hosted implementation.** Until ZCH-001 lands, verify runs unhardened. For ZCH-001 itself the manager must, after the worker returns and before committing, inspect `git status` including `.zc/` and `git log -1` by hand, and run `zc-reviewer`. Tasks that touch `src/dispatch.mjs` (ZCH-001, ZCH-002, ZCH-005, ZCH-006, ZCH-007) must be dispatched one at a time.

### ZCH-001 · Post-verify integrity re-check · **P0**
- Problem: F1. Scope, `.zc/` and HEAD are checked before verify only.
- Modules: `src/dispatch.mjs` (`dispatch`), `src/snapshot.mjs` (reuse `restoreZc`; no behaviour change expected), `docs/ARCHITECTURE.md`, `skills/orchestrate/SKILL.md` (status table), `test/safety.test.mjs`, `fixtures/fake-agy.mjs` if a new scenario is needed.
- Required behaviour:
  1. Before `runVerify`, record `result.preVerifyState = workerState` (the fingerprint map already computed).
  2. After `runVerify` returns (whether or not it passed), run in this order: (a) `restoreZc(root, zcSnap, { saveDir: join(runDir, 'zc-violations-verify') })` with the same error handling as the worker-phase call (`NEEDS_HUMAN`, outcome `zc-not-checked` on throw, `zc-not-restored` on unrestored entries); (b) HEAD/branch re-check, same handling as the worker-phase check but `nextAction` must say the change happened during verify; (c) `postEntries = statusEntries(root)`, `postChanged = changedPaths(postEntries)`, `verifyChanged = postChanged.filter(p => !changed.includes(p))`, and `partitionByScope(verifyChanged, allowed, config.forbidden)`.
  3. If (a) found differences or (c) found `forbidden`/`outOfScope`: `savePartial(root, join(runDir, 'rejected-verify'), postEntries)`; roll back with `rollbackPaths(root, postEntries, currentState)` only when `resetAllowed` (where `currentState = G.dirtyState(root)` taken immediately after verify, so that only verify-era content is removed); `finish('SCOPE_VIOLATION', EXIT.FAILED, { phase: 'verify', outOfScope, forbidden: [...forbidden, ...zcPaths], verifyChanged, rolledBack, nextAction })`. This takes precedence over `VERIFY_FAILED`.
  4. Paths changed during verify that are inside `allowed` and not forbidden do not fail the run but are listed in `result.verifyChanged` and appended to `result.changed` (sorted, de-duplicated) so `formatResult` and the manager see them.
  5. Add `phase` (`'worker'` default, `'verify'`) to the `SCOPE_VIOLATION` result; `formatResult` prints `SCOPE_VIOLATION during verify` when set.
- Acceptance criteria: a fake worker whose in-scope file causes the verify command to write `other/x.txt` ends `SCOPE_VIOLATION` with `phase: 'verify'`, `verifyChanged: ['other/x.txt']`, the file removed, the copy present under `rejected-verify/`; a verify command that rewrites `.zc/config.json` ends `SCOPE_VIOLATION`, the file restored byte-for-byte, the evidence under `zc-violations-verify/`; a verify command that commits ends `NEEDS_HUMAN` with "verify" in `nextAction`; a verify command that writes only an in-scope file ends `OK` with that path in `changed` and `verifyChanged`; all existing tests unchanged.
- Required tests (in `test/safety.test.mjs`): the four cases above, each using a verify command of the form `[process.execPath, '-e', '<script>']` so no shell or new fixture mode is needed; one test that `VERIFY_FAILED` plus `.zc/` tampering yields `SCOPE_VIOLATION`, not `VERIFY_FAILED`.
- Regression risks: a project whose legitimate verify step writes non-ignored files outside `allowed` (generated code, coverage) will now fail. This is intended; `nextAction` must say to add those paths to `allowed` or to `.gitignore`. Repair mode (`resetAllowed = false`) must leave the tree as-is and say so, as the worker-phase path already does.
- Dependencies: none. Suggested `allowed`: `src/dispatch.mjs`, `test/safety.test.mjs`, `docs/ARCHITECTURE.md`, `skills/orchestrate/SKILL.md`.

### ZCH-002 · Bounded cooldowns · **P0**
- Problem: F6.
- Modules: `src/classify.mjs` (`parseResetHint`), `src/config.mjs` (`DEFAULTS.defaults`, `loadConfig`), `src/dispatch.mjs` (`case 'quota'`, and the `default` flaky cooldown for symmetry), `test/units.test.mjs`, `test/dispatch.test.mjs`, `fixtures/fake-agy.mjs`, `docs/ACCOUNTS.md`. `cmdInit` output does not change; defaults suffice.
- Required behaviour:
  1. `parseResetHint(text, now, { maxMs })`: ignore ISO timestamps that lack a timezone designator; return `null` when `at - now > maxMs` or `at <= now`; apply the same `maxMs` cap to relative hints. Default `maxMs` = 24 h so existing unit tests keep passing.
  2. New config key `defaults.maxCooldownMinutes`, default `1440`, validated with `parseCount(value, 'defaults.maxCooldownMinutes', { min: 1, max: 10080 })`.
  3. In `dispatch`, compute `until = Math.min(parseResetHint(errorText, Date.now(), { maxMs }) ?? Date.now() + cooldownMs, Date.now() + maxMs)` so the clamp holds whatever the source. Record `attempt.cooldownSource: 'hint' | 'default'`.
- Acceptance criteria: the in-memory reproduction (`quota exceeded … valid until 2031-01-01T00:00:00Z`) yields a cooldown of at most 24 h; `2030-06-01T00:00:00` without timezone is ignored; `try again in 30 minutes` still yields 30 minutes; `defaults.maxCooldownMinutes: 0` or `'x'` is rejected by `loadConfig` with a message naming the key.
- Required tests: unit tests for the three parser cases; a dispatch test (fake `quota` mode with a far-future ISO date in the error message via a new optional `scenario.message` field in `fixtures/fake-agy.mjs`) asserting `cooldownUntil <= Date.now() + 24h`.
- Regression risks: a genuine weekly reset hint is now capped at 24 h, costing at most one failed attempt per day on that account. Documented in `docs/ACCOUNTS.md`.
- Dependencies: none. Suggested `allowed`: `src/classify.mjs`, `src/config.mjs`, `src/dispatch.mjs`, `fixtures/fake-agy.mjs`, `test/units.test.mjs`, `test/dispatch.test.mjs`, `docs/ACCOUNTS.md`.

### ZCH-003 · Honest safety documentation · **P0**
- Problem: F1 (documentation half). README says edit-only mode "should keep them from running git or shell commands"; ARCHITECTURE says a moved HEAD means "nothing touched" (the `.zc/` restore runs first); README counts 99 tests (there are 123); CHANGELOG's known limitation says automatic account switching will be removed, contradicting the README.
- Modules: `README.md` (Safety model, What is and is not verified), `docs/ARCHITECTURE.md` (One dispatch, Invariants, Integrity rules), `CHANGELOG.md` (Unreleased), `skills/orchestrate/SKILL.md` (Rules).
- Required behaviour: add a "What zc does and does not guarantee" subsection to README using the six layers of section G; state that verify executes repository code with the manager's privileges and that `.zc/`, scope and HEAD are re-checked after verify (once ZCH-001 is merged) but effects outside the repository are not detectable; correct the HEAD-moved wording; replace the hard-coded test count with "the test suite" or the current count; resolve the CHANGELOG contradiction one way or the other and record the decision under Unreleased.
- Acceptance criteria: `test/contract.test.mjs` keeps passing (it asserts specific strings in `SKILL.md` and `DEFAULT_PREFIX`); a grep for "should keep them from running" returns nothing; the README section names each of the six layers.
- Required tests: extend `test/contract.test.mjs` with one assertion that README contains the new subsection heading.
- Regression risks: none in code.
- Dependencies: ZCH-001 and ZCH-011 merged (so the text describes real behaviour, including git metadata). Suggested `allowed`: `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `skills/orchestrate/SKILL.md`, `test/contract.test.mjs`.

### ZCH-011 · Git metadata integrity · **P0**
- Problem: F8. Hooks, config, ignore/attribute sources, index flags, refs and the `.git` pointer can be changed by the worker or by verify without any zc check seeing it. Several of those changes make zc's own git calls run attacker-chosen programs, retarget them to another repository, or make zc roll back the user's own hidden edits.
- Priority: **P0, before ZCH-002.** Reproduced end to end through `dispatch`; gives code execution as the manager through zc's own post-run git calls (no further manager mistake needed) or on the next `git commit`; its hiding variants defeat ZCH-001; one variant destroys pre-existing user edits. Exploitable through verify without real accounts.
- Nature: integrity **detection and repair** of repository-level git metadata, plus hardening of zc's own git invocations. It is not a sandbox and does not contain a malicious process (threat model below and section G).

#### 11.1 Threat model and trust assumptions
- **Trusted:** the zc process, Node, the `git` binary, zc's state folder, and the repository and its git metadata **as they are when the dispatch starts** (the baseline is the user's own state). Global and system git config and any global hooks directory are the user's; they are outside the boundary (11.8).
- **Untrusted:** everything the worker and the verify commands do while they run, including every file they write anywhere inside the work tree, the git-dir and the common-dir.
- **Assumed:** when `runAgy` / `runVerify` return, the processes they started have exited. A process they leave running in the background can change metadata after a check (time-of-check/time-of-use). zc narrows this window: its git calls always carry the overrides in 11.2, so the programs that remain reachable are filters and diff drivers, and only during the short span between the integrity gate and zc's next git call. zc does not close it.
- **Not protected against:** a process with unrestricted manager-level filesystem access that targets zc itself (its state folder, snapshots, run records or source), global/system config, or anything outside the repository's work tree and git dirs. Containing such a process needs OS isolation (section G).

#### 11.2 Trusted git directory resolution and zc's git invocations
- **Resolution, once per dispatch, before the first worker:** run from `root`, with no `GIT_*` variables in the environment: `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`. Make the common-dir absolute (relative to `root`). Record the layout: `{ workTree, gitDir, commonDir, linked: gitDir !== commonDir, dotGit: { kind: 'dir'|'file', bytes (if file) }, worktreeFiles: bytes of <gitDir>/gitdir and <gitDir>/commondir (if linked), identity: { gitDir, commonDir } each as realpath plus lstat dev/ino }`. Store it in `result.gitLayout`. Fail closed (`NEEDS_HUMAN`, no worker started) if: `.git` at `root` is missing or a symlink; the git-dir or common-dir is a symlink, missing, or not a directory; `rev-parse` fails; `workTree` ≠ `root`; the repository is bare.
- **Pinning:** from that moment until the dispatch ends, every zc git call for this `root` runs with the environment stripped of all inherited `GIT_*` variables and then `GIT_DIR=<gitDir>`, `GIT_COMMON_DIR=<commonDir>`, `GIT_WORK_TREE=<root>`. zc never re-resolves the git dir during a dispatch. Probe evidence: with the worktree's `.git` pointer rewritten to a decoy repository, plain `git rev-parse` reported the decoy; with the pinned variables it reported the original and `status` worked; rewriting `<gitDir>/commondir` was likewise neutralised by `GIT_COMMON_DIR`.
- **Identity check after each untrusted phase (filesystem only, first step of the gate):** `.git` kind and pointer bytes, the linked-worktree `gitdir`/`commondir` file bytes, and the realpath plus dev/ino of git-dir and common-dir must match the record. A changed pointer or worktree file with an unchanged git-dir identity is restorable (write back the recorded bytes, evidence saved). A changed `.git` kind, or a changed git-dir/common-dir identity, ends `NEEDS_HUMAN` with **no further git command** and no restore. Where the platform reports dev/ino as 0, realpath equality alone is used and recorded as `identity: 'path-only'`.
- **Hardened invocation (all zc git calls, always):** `git -c core.quotepath=off -c core.fsmonitor=false -c core.hooksPath=<noHooksDir> ...` with the pinned environment, where `noHooksDir` is an empty directory zc creates under the project's state folder and verifies empty before use (recreated if not; `NEEDS_HUMAN` if that fails). `spawnSync` gets a timeout (60 s for the inert commands below, the existing behaviour otherwise); a timeout is `NEEDS_HUMAN` (protects against an include file replaced by a FIFO or similar).
- **Inventory of git commands zc runs after an untrusted phase, with probe evidence** (git 2.55.0.windows.4; repo config wired `core.fsmonitor`, a `post-index-change` hook, `filter.x.clean/smudge`, `diff.external` and a textconv driver to marker scripts, attributes in `.git/info/attributes`):

| Command (zc call site) | Runs, plain | Runs, hardened | Class and treatment |
|---|---|---|---|
| `rev-parse --verify HEAD` (`head`), `symbolic-ref --short -q HEAD` (`branch`), `cat-file -e HEAD:<p>` (`inHead`) | nothing | nothing | Inert. Allowed any time after the identity check |
| `config --list --show-origin --show-scope --includes` (new) | nothing | nothing | Inert. Allowed after the identity check |
| `for-each-ref` (new) | nothing | nothing | Inert. Allowed after the identity check |
| `ls-files -s -z` (`indexState`), `ls-files -v -z` (new) | fsmonitor | nothing | Inert **only when hardened** |
| `update-index --[no-]skip-worktree / --[no-]assume-unchanged` (new) | fsmonitor, hook | nothing | Inert **only when hardened**; writes the index |
| `rm -r -f --cached --ignore-unmatch` (`rollbackPaths`) | fsmonitor | nothing | Inert only when hardened; runs only after the gate passes |
| `status --porcelain=v1 -z --untracked-files=all` (`statusEntries`, `dirtyState`, `finish`) | clean filter, fsmonitor, hook | nothing observed; may run clean filters when it must hash files | **Gated:** only after the gate has verified config, attribute sources and hooks equal the baseline |
| `diff HEAD --binary` (`savePartial`) | clean, smudge, `diff.external`, fsmonitor | clean, smudge, `diff.external` | **Gated** and must add `--no-ext-diff --no-textconv`; probe: with those flags, hardened, only the clean filter ran |
| `restore --source=HEAD --staged --worktree` (`rollbackPaths`) | smudge, fsmonitor, hook | smudge | **Gated** |

- **Filters are not disabled by any flag.** `--no-ext-diff`/`--no-textconv` do not stop clean or smudge filters (probe), and filter driver names are unknown in advance. Filters are therefore made safe by **ordering**: gated commands run only after the gate has proven that the effective local/worktree config and the protected attribute sources equal the baseline. Filters and diff drivers that then run are the user's baseline programs. In-tree `.gitattributes` can only route files to drivers defined in config; the new scope rule in 11.6 keeps an out-of-scope `.gitattributes` or `.gitignore` change from passing.
- **No unsafe command for discovery:** the gate discovers changes with filesystem reads and the inert commands above only. No gated command runs until the gate has passed for the current phase. If the gate does not pass, the run ends `NEEDS_HUMAN` and `finish` captures no `workerState` (no `git status`).
- `toplevel()` in `cli.mjs` keeps plain discovery for choosing `root` (before a dispatch, the repository is trusted). `rejectRun` must compare its fresh resolution with the `gitLayout` recorded in the run and refuse on any mismatch, `--force` included (11.7).

#### 11.3 Protected metadata

"Private" = inside the git-dir; or inside the common-dir when not `linked`; or inside the work tree. Paths are taken from the recorded layout plus `git rev-parse --git-path <p>` evaluated **once, at baseline**, under the pinned environment.

| Area | Baseline (before the worker) | After each untrusted phase | Repair |
|---|---|---|---|
| `.git` entry, pointer, worktree files, dir identity | 11.2 | 11.2 identity check, first | Pointer/worktree file bytes restorable; kind or identity change: `NEEDS_HUMAN` |
| Hooks | Recursive walk of the effective hooks dir (`--git-path hooks`, honours `core.hooksPath`): per file SHA-256, size and, on POSIX, the executable bits; directory set. A symlink anywhere in it, or an unreadable entry: fail closed before the worker | Same walk of the **baseline** hooks path (a `core.hooksPath` change is caught as a config change) | Private: restore changed/removed files from copies, delete added files and added empty dirs. Not private (shared common-dir of a linked worktree; a `core.hooksPath` outside the work tree and git dirs): detect only, `NEEDS_HUMAN` |
| Config files | Bytes and copies of `--git-path config`, `--git-path config.worktree` and every origin file of `local`/`worktree` rows from `config --list --show-origin --show-scope --includes`. An origin that is not a regular file (for example `blob:` or `command line:`): fail closed | Byte compare of every baseline file, filesystem only | Private: restore bytes; delete a newly created `config.worktree` |
| Effective config | The `local`/`worktree` rows of the same listing, as text | After the file restores: listing again (inert), compared as text. **No allowlist** | Still different (for example a dangling baseline include whose target now exists outside the private area, or a non-private origin): `NEEDS_HUMAN` |
| Ignore, attribute and history sources | Bytes and copies of `info/exclude`, `info/attributes`, `info/sparse-checkout`, `info/grafts`, `shallow`, `objects/info/alternates` (via `--git-path`) | Byte compare, filesystem only | Private: restore bytes or delete if newly created. Not private: `NEEDS_HUMAN` |
| Index flags | 11.4 | 11.4 | 11.4 |
| Refs | `for-each-ref --format='%(refname)%00%(objectname)'`, excluding `refs/remotes/` | Same listing (inert) | Never rewritten: any difference, including a concurrent commit in another linked worktree, is `NEEDS_HUMAN` listing each ref old → new |

Caps: per copied file 2 MB, total 8 MB. Over a cap, unreadable (any error other than ENOENT/ENOTDIR), a symlink where a file or directory is expected, or any parse failure of git output: **fail closed** with `NEEDS_HUMAN` (before the worker if found at baseline).

Not compared (they change during a normal run and carry no execution path, or are outside the boundary): index bytes (a plain `status` rewrites them; probe), objects and packs, loose vs packed refs (refs compare by value), reflogs, `ORIG_HEAD`, `FETCH_HEAD`, `COMMIT_EDITMSG`, `refs/remotes/*`, `.git/lfs`, `.git/modules/*`.

#### 11.4 Index flags
- Baseline (inert `ls-files -v -z`, hardened): the set `A` of assume-unchanged paths (lowercase tag) and `S` of skip-worktree paths (tag `S`), and for every path in `A ∪ S` a content fingerprint (`fingerprint()` from `src/snapshot.mjs`) and a copy (caps as above). These files are invisible to `git status`, so their content is not covered by `workerState`.
- After each untrusted phase (after the config gate, before any gated command): read the flags again (inert, hardened).
  - Flags **added** to paths outside the baseline sets: clear exactly those, with `update-index --no-assume-unchanged` / `--no-skip-worktree -- <paths>` (hardened). The edits they hid then appear in `git status` and go through the scope check.
  - Flags **removed** from baseline paths: set exactly those again (`--assume-unchanged` / `--skip-worktree`). Without this, the user's hidden local edits appear in `git status` and zc would roll them back as the worker's (probe: removing a user's `skip-worktree` exposed `M b.txt`).
  - **Content** of a baseline-flagged path changed: restore the baseline bytes from the copy (evidence saved), and count it as a violation.
  - Pre-existing user flags and their content are never changed in any other way.
- Any repair that fails, a path that cannot be copied, or `ls-files` output that cannot be parsed: `NEEDS_HUMAN`.

#### 11.5 The integrity gate, its order and outcomes
After `runAgy` returns, and again after `runVerify` returns, zc runs this gate **before anything else** (before `restoreZc`, before any `G.statusEntries`/`G.dirtyState`), and only then the existing `.zc/`, HEAD/branch and scope checks:
1. Identity check (11.2), filesystem only.
2. Filesystem comparisons and private restores: hooks, config files, ignore/attribute/history sources, flagged-file contents (11.3, 11.4). Save every changed version to `git-meta-violations-<n>` (worker) or `git-meta-violations-verify-<n>` (verify) before restoring.
3. Inert git comparisons: effective config, then index flags (with their repairs), then refs.
4. Outcome:
   - Nothing changed: continue with the existing checks.
   - Changes found and **all** repaired: continue with the existing checks (now safe to run the gated commands), then end `SCOPE_VIOLATION` with `phase` (`worker`/`verify`), the metadata paths added to `forbidden`, and `gitMeta` entries on the result. A metadata-only change must not end `NO_CHANGES` or `DENIED` (extend the `!changed.length && !zcViolations.length` guard). The usual save-and-rollback of the work-tree result follows.
   - Anything not repaired, detect-only, ambiguous, or a step that throws: `finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { phase, gitMeta, gitMetaUnrestored: true, nextAction }, { captureState: false })`. No gated git command runs and nothing is rolled back. `nextAction` lists each path and change, names the snapshot and evidence folders, and says not to run git commands in this repository until the listed items are checked by hand.
5. Record entries on `attempt.gitMeta` / `attempt.gitMetaVerify` with `{ area, path, change, restorable, restored, detail }`; `path` relative to `root` when inside it, else absolute.

`finish(status, code, extra, { captureState = true } = {})` skips `G.dirtyState` when `captureState` is false. Every other `finish` call keeps today's behaviour.

#### 11.6 Scope rule for ignore and attribute files in the work tree
A change to any `.gitignore` or `.gitattributes` file in the work tree passes the scope check only if that exact path is listed in `allowed` (a directory or glob entry is not enough). Reason: these files decide what `git status` shows and which filter or diff driver git applies, so a change inside a broadly allowed directory can hide or reroute other files. After any rollback, zc re-runs `statusEntries`. A path that is now visible but was not part of the recorded result, for example a file a rolled-back `.gitignore` had hidden, makes `rolledBack` false and is listed in `revealedAfterRollback`.

#### 11.7 Across runs: reject, repair and the next dispatch
- `rejectRun`: refuse, `--force` included, when the current layout does not match the run's recorded `gitLayout`. Refuse without `--force` when the run has `gitMetaUnrestored: true`. Use the same hardened, pinned invocation as dispatch.
- Next dispatch, including `--repair`: if the project's latest run has `gitMetaUnrestored: true` and no acknowledgement, end `NEEDS_HUMAN` before any worker starts.
- New command `zc ack <runId>`: after the user has checked the reported items by hand, it records `gitMetaAcknowledged: <ISO time>` in that run's `result.json` and changes nothing else. It is additive.

#### 11.8 Outside the boundary (documented, not protected)
- Global and system git config, `~/.gitconfig` includes, and global hook directories configured there. The hardened invocation neutralises a global `core.fsmonitor` and global hooks for zc's own calls. A change to those files by the worker is not detected; no safe, testable repository-level mechanism was established for them.
- Submodule metadata (`.git/modules/*`) and nested repositories.
- Anything outside the work tree and the two git dirs, and any process still running after its phase (11.1).
- First-time hook installers such as Husky. A first install during verify changes config and hooks, so the run ends `SCOPE_VIOLATION`. The user must run the installer by hand before dispatching. A repeat install that writes identical bytes is not a change. There is no allowlist.

#### 11.9 Implementation steps
Each step is its own zc dispatch, review and commit, in this order. A step may not weaken any criterion of an earlier step.

| Step | Scope | Files (suggested `allowed`) | Criteria |
|---|---|---|---|
| 011-A | Layout resolution, identity, pinned and hardened git invocation, `noHooksDir`, timeouts, `--no-ext-diff --no-textconv` in `savePartial`. Dispatch: resolve and pin at start, unpin in `finally`, record `gitLayout` | `src/gitmeta.mjs` (new: `gitLayout`, `checkIdentity`), `src/gitx.mjs`, `src/dispatch.mjs` (pin/unpin, layout fail-closed only), `test/gitmeta.test.mjs` (new) | A1–A9 |
| 011-B | Baseline snapshot and filesystem plus inert comparisons and private restores for hooks, config files, effective config, info files and refs. Unit level, no dispatch wiring | `src/gitmeta.mjs`, `test/gitmeta.test.mjs` | B1–B10 |
| 011-C | Index flags and flagged-file content (11.4). Unit level | `src/gitmeta.mjs`, `test/gitmeta.test.mjs` | C1–C5 |
| 011-D | Gate wiring in both phases, outcomes, `finish` `captureState`, the 11.6 scope rule and the post-rollback reveal check, `formatResult` line | `src/dispatch.mjs`, `src/scope.mjs`, `test/gitmeta.test.mjs`, `test/safety.test.mjs` | D1–D12 |
| 011-E | `rejectRun` guards, next-dispatch guard, `zc ack`, docs | `src/dispatch.mjs`, `src/cli.mjs`, `test/gitmeta.test.mjs`, `docs/ARCHITECTURE.md`, `skills/orchestrate/SKILL.md` | E1–E5 |

#### 11.10 Acceptance criteria
Tests live in `test/gitmeta.test.mjs` unless noted. Every repository is built with `makeRepo` (or `git init`) under `tmpdir()`. A test marked ★ must prove that a malicious configured program **did not run**, by the absence of a per-test marker file written by a `#!/bin/sh` script. Git for Windows runs these through its bundled `sh`. Skip with a stated reason if `sh` is unavailable. Worker-side writes use the fake agy `write:` map, which accepts `.git/...` paths. Verify-side changes use `[process.execPath, '-e', script]` with `execFileSync('git', …)`.

- **011-A**
  - A1 ★ With `core.fsmonitor` and a `post-index-change` hook wired to markers in the repo config, each zc helper (`head`, `branch`, `statusEntries`, `dirtyState`, `pathStates`, `rollbackPaths`, `savePartial`) runs without creating the fsmonitor or hook marker.
  - A2 ★ With `diff.external` wired to a marker, `savePartial` does not create it, and its patch is still a valid `git apply --check` patch.
  - A3 A linked worktree whose `.git` pointer is rewritten to a decoy repository after pinning: `head`/`branch`/`statusEntries` still report the original repository. The same holds for a rewritten `<gitDir>/commondir`.
  - A4 `gitLayout` on a normal repository, a linked worktree and a `--separate-git-dir` repository returns the same git-dir and common-dir as `git rev-parse`, sets `linked` correctly, and records the pointer bytes.
  - A5 Fail closed before any worker starts (`calls.log` absent) when `.git` is a symlink, the git-dir is a symlink, or the repository is bare.
  - A6 Inherited `GIT_DIR`/`GIT_INDEX_FILE` in zc's own environment do not change which repository or index zc reads.
  - A7 `checkIdentity`: a restorable result for a rewritten pointer file with an unchanged git-dir. A non-restorable result (the caller must run no git command) when the git-dir was replaced by a different directory at the same path (rename it away, copy it back), or when `.git` changed kind.
  - A8 A file placed in `noHooksDir` before a zc git call is not executed as a hook. zc recreates the directory empty, or fails closed if it cannot.
  - A9 POSIX only: a baseline `include.path` whose target is replaced by a FIFO makes the inert config listing time out. The result is `NEEDS_HUMAN`, not a hang (timeout injectable for the test).
- **011-B**
  - B1 Hook added, modified or removed in a private hooks dir is detected and restored, with evidence saved.
  - B2 On POSIX, an executable bit added to an existing hook is detected and restored (skip on `win32`).
  - B3 A `core.hooksPath` pointing to an ignored in-tree directory: a hook written there is detected and removed.
  - B4 A `core.hooksPath` change in config is caught as a config change, and the baseline hooks path keeps being checked.
  - B5 An `[alias]` appended to `.git/config` is restored byte for byte.
  - B6 A baseline include file inside the work tree, hidden by `.gitignore`, is modified: detected and restored.
  - B7 A dangling baseline include gets its target created outside the private area: `NEEDS_HUMAN`, file left in place.
  - B8 `info/exclude` and `info/attributes` changes are restored. A newly created `info/attributes` is deleted.
  - B9 A new branch or tag is detected as a ref change and left in place. A `refs/remotes/*` change is ignored. A `git pack-refs --all` is no change.
  - B10 A hooks file of 3 MB, a symlink in the hooks dir, or a config origin that is not a regular file fail closed at baseline. On POSIX non-root, an unreadable hooks dir fails closed after the phase.
- **011-C**
  - C1 Added `skip-worktree` on an out-of-scope edited tracked file is cleared and the edit becomes visible to `statusEntries`. The same holds for `assume-unchanged`.
  - C2 A baseline user `skip-worktree` with a local edit, whose flag is removed during the phase, gets the flag back, and the user's content is unchanged.
  - C3 Content of a baseline-flagged file changed during the phase is restored from the copy and reported.
  - C4 Pre-existing flags that nobody touched are unchanged after the gate.
  - C5 Output of `ls-files -v` that cannot be parsed, or a flagged file over the copy cap, gives `NEEDS_HUMAN`.
- **011-D** (dispatch end to end)
  - D1 The original reproduction: verify plants `.git/hooks/pre-commit` and a config alias. The run ends `SCOPE_VIOLATION`, `phase: 'verify'`, with both repaired.
  - D2 A worker writes `.git/hooks/pre-commit`: `SCOPE_VIOLATION`, `phase: 'worker'`, hook removed. A run that only touches metadata ends `SCOPE_VIOLATION`, not `NO_CHANGES`.
  - D3 ★ Verify sets `core.fsmonitor` to a marker script: after `dispatch` returns the marker is absent and the config is restored.
  - D4 ★ Verify defines `filter.x.clean`/`smudge` and assigns them via `.git/info/attributes`, and the worker's file is out of scope, which forces `savePartial` and `rollbackPaths`: markers absent, config and attributes restored.
  - D5 ★ Verify plants a `post-index-change` hook: marker absent after the rollback.
  - D6 The worker writes `other/x.txt` and appends `other/` to `info/exclude`: `other/x.txt` is reported in `outOfScope`.
  - D7 Verify edits tracked `README.md` and sets `skip-worktree` on it: `README.md` is in `outOfScope` with `phase: 'verify'` and is rolled back. The `assume-unchanged` variant behaves the same.
  - D8 A user-flagged `skip-worktree` file with a local edit survives a run whose worker is rolled back for quota, and survives a `SCOPE_VIOLATION` rollback. This is the data-loss regression test.
  - D9 Verify creates `refs/heads/other`: `NEEDS_HUMAN`, `gitMetaUnrestored: true`, no `workerState` in `result.json`, nothing rolled back.
  - D10 A linked worktree: verify writes into the shared hooks dir, giving `NEEDS_HUMAN`, detect only. A worker that rewrites the worktree's `.git` pointer gets it restored, giving `SCOPE_VIOLATION`.
  - D11 `.gitignore` or `.gitattributes` changed inside an allowed directory but not listed by exact path is out of scope. After rolling back a `.gitignore` that hid files, `revealedAfterRollback` lists those files and `rolledBack` is false.
  - D12 Normal operations still end `OK`:
    - verify runs `git status`, `git diff`, `git log`, `git stash list` and `git pack-refs --all`;
    - pre-existing `core.hooksPath` (Husky already installed), `core.fsmonitor` and a baseline clean/smudge filter, which still applies during rollback (output equals the filter's);
    - dispatch from a linked worktree and from a `--separate-git-dir` repository.
- **011-E**
  - E1 `rejectRun` refuses a layout mismatch, even with `force`.
  - E2 `rejectRun` refuses a run with `gitMetaUnrestored` unless `force` is given.
  - E3 The next dispatch after an unacknowledged `gitMetaUnrestored` run ends `NEEDS_HUMAN` and no worker starts.
  - E4 After `zc ack <runId>`, the next dispatch proceeds. `zc ack` changes no file other than that run's `result.json`.
  - E5 `test/contract.test.mjs` still passes. ARCHITECTURE and the skill describe the gate, the outcomes and 11.8.
- **All steps:** every existing test passes unchanged. This includes the staged-change protection tests, the content-verified rollback tests and the ZCH-001 post-verify tests. `npm run check` passes.

#### 11.11 Risks, dependencies, verification
- **Regression risks:**
  - Repositories that legitimately change git metadata during verify now fail. This covers first-time hook installers, tools that write config, and IDEs writing config or refs during a run. The `nextAction` must say what changed.
  - A concurrent commit in another linked worktree ends the run `NEEDS_HUMAN`. This is by decision.
  - `core.fsmonitor=false` makes zc's own `status` slower on repositories that rely on an fsmonitor daemon.
  - The 11.6 rule rejects `.gitignore`/`.gitattributes` edits not listed by exact path.
  - A mistake in gate ordering would reintroduce code execution. The ★ tests are the guard.
- **Dependencies:** ZCH-001 (implemented, `63bc634`). ZCH-011 must land before ZCH-002 and before ZCH-003, which documents it. All of its steps edit files that ZCH-002 also edits (`src/dispatch.mjs`), so dispatch them strictly in sequence.
- **Manual verification per step:** before each commit, compare HEAD, branch, `.zc/` hashes, the local git config, `.git/hooks`, `.git/info/*`, refs, stash and `git ls-files -v` flags against a baseline saved outside the repository before dispatch. This is the ZCH-001 procedure. Each step's own verify run executes under the protection of the previous steps only.

### ZCH-004 · Serialized lock takeover, optional wait, recoverable PID reuse · **P1**
- Problem: F3.
- Modules: `src/fsx.mjs` (`acquireLock`, `pidAlive`), `src/cli.mjs` (`cmdDoctor`), `test/safety.test.mjs`, `docs/ARCHITECTURE.md` (Invariants).
- Required behaviour:
  1. Takeover guard: all acquisition attempts for a given lock path, including the first `wx`, run while holding `mkdirSync(path + '.guard')`; `EEXIST` on the guard means another process is acquiring: wait (see 3) and retry; a guard directory older than 30 s by mtime is removed as stale before retrying. The guard is removed in `finally`.
  2. Inside the guard, takeover unlinks the lock only if a fresh read returns a record whose `pid` and `startedAt` equal the ones first read and `pidAlive(pid)` is false.
  3. New option `acquireLock(path, info, { waitMs = 0, pollMs = 25 })`: when the holder is alive and `waitMs > 0`, poll until `waitMs` elapses, then throw the existing message. Default remains fail-fast so `dispatch`/`reject` behaviour is unchanged.
  4. The "already running" error must include the lock path, `pid`, `startedAt` (ISO) and `runId`, and the sentence "If that process is not zc, delete the lock file."
  5. `zc doctor` adds a `warn`-level check listing a project lock whose `startedAt` is older than 8 h (`MAX_MINUTES`) or whose PID is dead.
- Acceptance criteria: two processes (spawned test children) racing on a pre-seeded stale lock never both succeed (run 20 iterations); a live holder still causes an immediate throw by default; with `waitMs` the second caller acquires after the first releases; the error text contains the path; `doctor` reports a seeded stale lock.
- Required tests: a child-process race test in `test/safety.test.mjs` using `process.execPath -e` scripts that import `acquireLock` (pattern already used in `test/ecc-hardening.test.mjs`); existing `reject takes the project lock` test unchanged.
- Regression risks: the ECC install lock and `recoverInterrupted` use the same function; their tests must stay green. Guard directory left behind by a crash is self-healing via the 30 s rule.
- Dependencies: none. Suggested `allowed`: `src/fsx.mjs`, `src/cli.mjs`, `test/safety.test.mjs`, `docs/ARCHITECTURE.md`.

### ZCH-005 · Global accounts lock and atomic pick-and-mark · **P1**
- Problem: F4 (lost updates and non-atomic selection).
- Modules: `src/accounts.mjs`, `src/paths.mjs` (add `accountsLockFile = () => join(stateRoot(), 'accounts.lock')`), `src/dispatch.mjs` (replace `pickNext()` + `markUsed()` with one call), `src/cli.mjs` (`cmdAccount` mutations go through the same functions; no CLI change), `test/units.test.mjs`, `test/dispatch.test.mjs`.
- Required behaviour:
  1. Internal `withAccountsLock(fn)` using `acquireLock(accountsLockFile(), {}, { waitMs: 5000 })`; every function that calls `save()` runs inside it: `addAccount`, `updateAccount`, `removeAccount`, `markUsed`, `hold` (hence `cooldown`, `setStatus`), `resetAccount`. Readers (`listAccounts`, `getAccount`, `currentId`, `pickNext`, `nextAvailableAt`) stay lock-free.
  2. New export `pickAndMark({ now, exclude })`: under the lock, `pickNext` then `markUsed`, return the account or `null`. `dispatch` uses it; `pickNext` and `markUsed` remain exported for tests and the CLI.
  3. The record written by `markUsed` gains `lastUsedBy: { pid, project: projectKey, since }` (informational, used by ZCH-009).
- Acceptance criteria: 10 concurrent child processes each performing 50 `cooldown`/`markUsed` round-trips on 3 accounts leave `accounts.json` with every write applied (count of a monotonically incremented field in `holdReason` or a test-only field equals 500); `pickAndMark` under contention never returns the same account to two callers in the same instant when `exclude` is honoured; all existing account tests pass.
- Required tests: the child-process contention test; a unit test that `pickAndMark` sets `currentId` and `lastUsedAt` in one step.
- Regression risks: a dead lock holder now delays account operations by up to 5 s before takeover (ZCH-004 makes takeover safe). Tests that call `makeHome()` per test already isolate state.
- Dependencies: ZCH-004. Suggested `allowed`: `src/accounts.mjs`, `src/paths.mjs`, `src/dispatch.mjs`, `test/units.test.mjs`, `test/dispatch.test.mjs`.

### ZCH-006 · Stream-parsed worker result and truncation accounting · **P1**
- Problem: F7.
- Modules: `src/agy.mjs` (`parseAgyOutput`, `runAgy`), `src/proc.mjs` (`run`: add `stdoutBytes`, `stderrBytes`, `stdoutTruncated`, `stderrTruncated` to the result; keep `maxBytes`), `src/dispatch.mjs` (persist the flags on the attempt; write the events file with a truncation marker), `src/metrics.mjs` (no change expected), `test/units.test.mjs`, `test/dispatch.test.mjs`.
- Required behaviour:
  1. Refactor `parseAgyOutput` into `createAgyParser()` returning `{ feed(line), result() }` with identical semantics; `parseAgyOutput(text)` becomes `feed` over `text.split(/\r?\n/)` and stays exported (tests and `test/units.test.mjs` import it).
  2. `runAgy` passes `onStdoutLine: parser.feed` to `run()`, then feeds `result.stderr` lines after exit (stderr is small and still buffered), and returns `parsed = parser.result()`.
  3. `run()` counts total bytes seen and sets `stdoutTruncated` when `append` dropped data. `dispatch` records `attempt.stdoutTruncated`, `attempt.stdoutBytes`, and writes `attempt-N.events.jsonl` with a final line `[zc: stdout truncated at <maxBytes> bytes; <total> bytes received]` when truncated.
- Acceptance criteria: the reproduction (child prints 9 MB of events then a `SUCCESS` result) ends `OK` with `attempt.stdoutTruncated === true`; all existing `parseAgyOutput` unit tests pass unchanged; `denied-empty`, `permission` and `metrics` dispatch tests unchanged.
- Required tests: a `run()`-level unit test with a `process.execPath -e` child emitting >8 MB then a result line, asserting `parsed.status === 'SUCCESS'` via `runAgy` with `ZC_AGY` pointing at a tiny inline script written to the test temp dir (or extend `fixtures/fake-agy.mjs` with `scenario.noise: <bytes>` that emits filler `step_update` events before the result).
- Regression risks: `parseAgyOutput` ordering of stdout-then-stderr must be preserved (stderr lines feed last). `onStdoutLine` currently splits on `\r?\n`; keep it.
- Dependencies: none. Suggested `allowed`: `src/agy.mjs`, `src/proc.mjs`, `src/dispatch.mjs`, `fixtures/fake-agy.mjs`, `test/units.test.mjs`, `test/dispatch.test.mjs`.

### ZCH-007 · Signal handling and `INTERRUPTED` status · **P1**
- Problem: F5.
- Modules: `src/proc.mjs` (`run`: new option `onSpawn(child)`), `src/verify.mjs` (pass `onSpawn` through), `src/dispatch.mjs`, `src/cli.mjs` (`main`: top-level handler), `skills/orchestrate/SKILL.md` and `docs/ARCHITECTURE.md` (status table), `test/dispatch.test.mjs`, `fixtures/fake-agy.mjs` (write its PID to `<profile>/pid.txt`).
- Required behaviour:
  1. `dispatch` installs `SIGINT` and `SIGTERM` handlers for the duration of the attempt loop and removes them in `finally`. On signal: `killTree(currentChild)` if a worker or verify child is running; `attempt.outcome = 'interrupted'`; `finish('INTERRUPTED', EXIT.NEEDS_HUMAN, { signal, nextAction: 'the run was interrupted. Partial work is in the tree and recorded; `zc reject <runId>` discards it, `--repair <runId>` continues it.' })` (this records `workerState` so `reject` works); release the lock; `process.exit(3)`.
  2. Never roll back on interrupt.
  3. `runVerify` passes `onSpawn` through so a verify child is also killed.
  4. `rejectRun` must accept an `INTERRUPTED` run like any other (it already keys on `workerState`).
  5. Document `INTERRUPTED` (exit 3) in the skill's status table and ARCHITECTURE.
- Acceptance criteria (POSIX): spawning `bin/zc.mjs dispatch` with fake `slow` mode and `partial: true`, then sending SIGTERM to zc, results in: the fake agy process gone within 5 s, no lock file, `result.json` with `status: 'INTERRUPTED'` and a non-empty `workerState`, exit code 3; a following `zc reject <runId>` cleans the tree. On Windows the test is skipped with reason "no SIGTERM semantics on win32" and the stale-lock path (ZCH-004) is the documented recovery.
- Required tests: the end-to-end interruption test above (Linux/macOS), skipped on win32; a unit test that `run()` calls `onSpawn` with a child that has a `pid`.
- Regression risks: handler leakage between tests (always remove in `finally`); `process.exit` inside tests must only happen in the spawned child, never in the test process.
- Dependencies: ZCH-006 merged first (both edit `run()`; sequence them, do not merge into one task). Suggested `allowed`: `src/proc.mjs`, `src/verify.mjs`, `src/dispatch.mjs`, `src/cli.mjs`, `fixtures/fake-agy.mjs`, `test/dispatch.test.mjs`, `skills/orchestrate/SKILL.md`, `docs/ARCHITECTURE.md`.

### ZCH-008 · Worker environment allowlist · **P1**
- Problem: F2.
- Modules: `src/agy.mjs` (`agyEnv`, `launchPlan`), `src/config.mjs` (`worker.envPassthrough: []`, validated as a list of names matching `/^[A-Z_][A-Z0-9_]*\*?$/i`), `src/cli.mjs` (`cmdDoctor`: print the effective passthrough), `test/agy-env.test.mjs`, `test/units.test.mjs`, `docs/ACCOUNTS.md`, `docs/SETUP.md`.
- Required behaviour:
  1. `agyEnv(platform, env, { passthrough = [] })` starts from an allowlist, not from `env`: `PATH`, `HOME`, `USERPROFILE`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_*`, `TZ`, `TERM`, `SystemRoot`, `SystemDrive`, `ComSpec`, `windir`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `PATHEXT`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase variants), `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `GEMINI_*`, `GOOGLE_*`, `ANTIGRAVITY_*`, `BROWSER`; plus `worker.envPassthrough`; plus the existing `NO_COLOR`, `GEMINI_FORCE_FILE_STORAGE` and SSH hints. `launchPlan` then applies its existing deletions and overrides on top.
  2. The allowlist is a single exported constant `WORKER_ENV_ALLOW` so `doctor` and tests reference one source.
  3. `runVerify` is explicitly unchanged (manager's commands, manager's environment).
- Acceptance criteria: `agyEnv('linux', { PATH: 'p', ANTHROPIC_API_KEY: 'k' })` has `PATH` and no `ANTHROPIC_API_KEY`; `GEMINI_X` passes; `worker.envPassthrough: ['MY_VAR']` passes `MY_VAR`; `['bad name']` is rejected by `loadConfig`; the dbus launch plan still has `HOME`/`XDG_RUNTIME_DIR` overridden; all `test/agy-env.test.mjs` cases pass after being adjusted to the new signature.
- Required tests: unit tests above; one dispatch dry-run test proving no change to the prompt.
- Regression risks: **real `agy` login or runtime may depend on an unlisted variable.** This task is not complete until ZCH-010 confirms `zc account check` and one real dispatch work with the allowlist on Linux and Windows. If a variable is missing, add it to `WORKER_ENV_ALLOW` with a comment naming the evidence; do not fall back to passing everything.
- Dependencies: none for code; ZCH-010 for sign-off. Suggested `allowed`: `src/agy.mjs`, `src/config.mjs`, `src/cli.mjs`, `test/agy-env.test.mjs`, `test/units.test.mjs`, `docs/ACCOUNTS.md`, `docs/SETUP.md`.

### ZCH-009 · Exclusive account lease across projects · **P2**
- Problem: F4 (two projects running the same profile concurrently). Deferred to P2 because the cost of concurrent use of one `--gemini_dir` is unknown.
- Modules: `src/accounts.mjs` (`pickNext` skips accounts whose `lastUsedBy.pid` is alive and whose `since` is younger than `MAX_MINUTES`; `release(id)` clears it), `src/dispatch.mjs` (call `release` in `finally`), `src/cli.mjs` (`printAccounts` shows the lease; `reset` clears it), `test/units.test.mjs`.
- Required behaviour: lease is advisory and self-expiring (dead PID or age > 8 h); `zc status` shows `in use by pid N` for leased accounts; `zc account reset` clears a lease.
- Acceptance criteria: with two accounts and a live lease on `g1`, `pickNext` returns `g2`; with a dead-PID lease it returns `g1`; `dispatch` always clears its lease, including on `NEEDS_HUMAN` paths.
- Required tests: unit tests for the three cases.
- Regression risks: a single-project user never sees a difference. Needs ZCH-010 to decide whether this should become P1 (if concurrent `agy` on one profile corrupts the token file).
- Dependencies: ZCH-005, ZCH-004. Suggested `allowed`: `src/accounts.mjs`, `src/dispatch.mjs`, `src/cli.mjs`, `test/units.test.mjs`.

### ZCH-010 · Real `agy` integration verification and recorded fixtures · **P1** (manual + fixtures)
- Problem: the flags, event format, environment needs and output volume of the real worker are unverified (F2, F7, and the README's own admission).
- Modules: `fixtures/` (new recorded event stream, secrets scrubbed), `test/units.test.mjs` (parse the recorded stream and assert `status`, `tools`, `usage` fields), `README.md` ("What is and is not verified"), `docs/SETUP.md`.
- Required behaviour: on one Linux machine and one Windows machine with a real account: `zc doctor`; `zc account add` + `check` with the ZCH-008 allowlist; one small real dispatch (edit one file) ending `OK`; capture `attempt-1.events.jsonl` and record `agy --version`, total stdout bytes, whether `stdoutTruncated` was set, and the exact `result` event shape. Commit a scrubbed copy as `fixtures/agy-events-<version>.jsonl` and a unit test that parses it. Update README's verification list with what was actually run.
- Acceptance criteria: the fixture parses to `status: 'SUCCESS'` with the real field names; README no longer lists "the real agy CLI" as unverified for the tested version; any environment variable added to `WORKER_ENV_ALLOW` cites this run.
- Regression risks: none in code. Findings here may reprioritize ZCH-009 and may change `tokenFile()` in `src/agy.mjs` if the token path differs.
- Dependencies: ZCH-006, ZCH-008. This task is performed by a human with the manager, not by a worker (needs real accounts and a browser sign-in).

---

## F. Verification strategy

**Automated (every task).** `npm test` and `npm run check` green on Node 22 and 24, Ubuntu and Windows (CI matrix in `.github/workflows/ci.yml`). The Linux job must not skip the `.zc/` permission tests (existing CI step enforces this). No test may write inside the repository; use `mkdtempSync` under `tmpdir()` and `makeHome()`.

**New regression tests (by task).** ZCH-001: verify-time out-of-scope write, `.zc/` write, commit, in-scope write, `VERIFY_FAILED` + tamper precedence. ZCH-002: three parser cases, far-future dispatch case, config validation. ZCH-004: stale-lock race (child processes, 20 iterations), `waitMs`, error text, doctor warning. ZCH-005: write-contention child processes, atomic `pickAndMark`. ZCH-006: >8 MB stream ends `OK`, truncation flags recorded. ZCH-007: SIGTERM end-to-end (POSIX), `onSpawn`. ZCH-008: allowlist unit tests, config validation. ZCH-009: lease cases. ZCH-010: recorded-fixture parse test. ZCH-011: criteria A1–A9, B1–B10, C1–C5, D1–D12, E1–E5 in §11.10, per implementation step (pinning and hardening, metadata compare and repair, index flags, dispatch gate, cross-run guards), including the ★ non-execution tests and the D12 normal-operation tests.

**Git metadata tests (ZCH-011).** Build every repository with `makeRepo` under `tmpdir()`; never point a test at the project's own `.git`. Marker-file tests prove "zc did not execute it" by absence, so the marker path must be unique per test. Scripts used as hooks, fsmonitor or filters are `#!/bin/sh`, which Git for Windows runs through its bundled `sh` (verified on this machine); skip a case with a stated reason if `sh` is unavailable.

**Concurrency tests.** Always real processes (`spawn(process.execPath, ['-e', …])` or the CLI), never in-process promises: the locks are PID-based. Seed the race deterministically (pre-create the stale lock, start both children, wait for both exits, assert at most one `result.json` or lock-success marker).

**Process-interruption tests.** Spawn `bin/zc.mjs` as a child with `ZC_HOME`, `ZC_AGY` (fake, `slow` + `partial`), send `SIGTERM`, poll up to 5 s for: the fake agy PID (written by `fixtures/fake-agy.mjs` to `<profile>/pid.txt`) no longer alive, no lock file, `result.json` status `INTERRUPTED`. Skip on `win32`.

**Adversarial tests.** Written as verify commands (`[process.execPath, '-e', script]`) or fake-agy `write:` maps, covering: tampering `.zc/config.json` during verify; writing `.env` during verify; `git commit` during verify; a worker that writes a file whose content is a script executed by the verify command. Each must end as the status in ZCH-001 and must leave the tree in the documented state.

**Real `agy` integration (manual, ZCH-010).** Linux (Ubuntu with `dbus-run-session`) and Windows, real account, allowlisted environment, one real dispatch, events recorded and scrubbed. Also observe: does Ctrl+C during a real run leave an `agy` process (F5 lifetime)? Does `attempt-1.events.jsonl` approach 8 MB on a 30-minute task (F7 likelihood)? Record both answers in README.

**Windows-specific.** `detached: false`, so `killTree` relies on `taskkill /T /F`; signal handlers do not run on `process.kill` from another process, so ZCH-007's guarantee is "best effort" there and the recovery path is ZCH-004. PIDs are reused quickly: ZCH-004's error text and doctor check are the main mitigations. `.cmd` launchers go through `resolveSpawn`; its metacharacter checks remain untested and should get a unit test if any task touches `src/proc.mjs` (ZCH-006/007 may add it opportunistically, within scope).

**Linux-specific.** D-Bus isolation requires `dbus-run-session`; tests that need it already skip when absent. Permission-based `.zc/` tests must run (CI enforces). Process-group kill (`process.kill(-pid)`) depends on `detached: true`; do not change that flag.

---

## G. Security model

Six layers, from weakest to strongest. zc currently implements the first three for the worker phase only.

| Layer | Mechanism in zc | Guarantee before hardening | Guarantee after hardening |
|---|---|---|---|
| Prompt-level | `DEFAULT_PREFIX`, task body, `allowed`/`forbidden` lists in the prompt (`src/prompt.mjs`) | Advisory only; a model may ignore it | Unchanged: advisory |
| Tool permission | `--mode accept-edits` / `plan` / `--dangerously-skip-permissions` (`agyRunArgs`) | Limits the *model's tools* during the worker phase; not enforced by zc, depends on `agy` honouring it | Unchanged, now documented as a usability control, not a security boundary |
| Git-based repository enforcement | clean-tree guard, `partitionByScope`, `.zc/` snapshot/restore, HEAD/branch check, content-verified rollback | Enforced for the worker phase; **not** for verify; git metadata (`.git/`) never checked; zc's own git calls run whatever the repository config says | Enforced after the worker phase **and** after verify (ZCH-001); git metadata compared against the baseline, private files and index flags repaired, refs and linked-worktree shared metadata detect-only; zc's git calls pinned and hardened and gated behind the metadata check (ZCH-011); detects and undoes effects inside the work tree and its git dirs only |
| Process isolation | separate `agy` process, timeout, `killTree`, per-project lock | Worker and verify run as the manager's user with the manager's environment | Worker gets an allowlisted environment (ZCH-008); interruption kills the tree (ZCH-007); verify still runs as the manager |
| OS isolation | none (README: "guard rail, not a sandbox") | None | None. Not in scope of this phase; the only way to contain code executed by verify |
| Credential isolation | per-account `--gemini_dir`, Linux private D-Bus session, SSH-hint file storage on Windows/macOS, state dir outside the repo, 0600 JSON | Isolates worker accounts from each other; depends on version-specific `agy` behaviour | Unchanged; verified against a real `agy` version by ZCH-010 |

**Git metadata (ZCH-011).** Its threat model is §11.1: the repository state at dispatch start is trusted; the worker and verify are not; processes they leave running in the background can still act after a check (time-of-check/time-of-use), which zc narrows but does not close; global/system git config and anything outside the work tree and git dirs are outside the boundary (§11.8). Metadata integrity checks are detection and repair, not containment.

**Honest statement after hardening.** zc guarantees that no change a worker or a verify command makes *inside the repository* (including `.zc/`, HEAD and the branch) can reach `OK` without passing the scope and integrity checks, and that anything caught is saved and, where safe, undone. zc does not guarantee anything about effects outside the repository: code executed by verify runs as the manager and can read the manager's files, environment and network. Running untrusted repositories or untrusted ECC content requires a disposable user, container or machine. Post-verification checks are detection and repair, not sandboxing.

---

## H. Implementation constraints

- **CLI.** No command removed or renamed; flags keep their meaning. Additive only: new result fields (`phase`, `verifyChanged`, `preVerifyState`, `stdoutTruncated`, `cooldownSource`, `signal`, `gitMeta`, `gitMetaUnrestored`, `gitLayout`, `revealedAfterRollback`, `gitMetaAcknowledged`), new status `INTERRUPTED` (exit 3), new command `zc ack <runId>` (ZCH-011), richer error text, new `doctor` checks. ZCH-011 also changes scope semantics for `.gitignore`/`.gitattributes` (exact-path allowance) and makes zc's own git calls ignore inherited `GIT_*` variables; both go in the CHANGELOG under **Changed**.
- **Configuration.** `.zc/config.json` written by older `zc init` must load unchanged. New keys (`defaults.maxCooldownMinutes`, `worker.envPassthrough`) have defaults in `DEFAULTS` and are validated only when present. `cmdInit` output need not change.
- **Account semantics.** `needs-login`/`ready`/`blocked`, sticky selection, LRU fallback, `reset`/`remove` behave as today. Lease (ZCH-009) is advisory and self-expiring. `accounts.json` gains optional fields only; older files load.
- **Worker protocol.** stream-json on stdin/stdout, `--gemini_dir`, `--new-project`, permission flags: unchanged. `parseAgyOutput` keeps its export and semantics.
- **Git ownership and rollback.** Clean tree at start (or exact `--repair` match); rollback only of fingerprint-matching paths; `.zc/` never rolled back; staged files count as changes. ZCH-001 extends the same model to the verify phase; it does not relax it anywhere.
- **Zero dependencies.** Keep. Locks, parsing and process control stay hand-written in `node:` modules.
- **Workflows.** `zc:orchestrate` loop unchanged except for one new row in the status table and the recovery sentence for `INTERRUPTED`.
- **Compatibility notes.** Old `result.json` files lack the new fields; nothing may require them (same rule as metrics in T-001). A repository whose verify step generates non-ignored files outside `allowed` will start failing with a clear `nextAction`; this is the intended consequence of invariant 1 and must be in the CHANGELOG under **Changed**.

---

## I. Completion criteria

The hardening phase is complete when all of the following hold:

1. ZCH-001, ZCH-011, ZCH-002, ZCH-003 (P0) merged; ZCH-004 to ZCH-008 and ZCH-010 (P1) merged; ZCH-009 (P2) merged or explicitly deferred with the ZCH-010 evidence that justifies it.
2. Every new regression test listed in section F exists and passes on the CI matrix; no test writes inside the repository.
3. All pre-existing tests pass unchanged except where a task explicitly lists an adjusted signature (ZCH-008's `agyEnv`).
4. The staged-change tests (`staging a worker file counts as a change…`, `repair also refuses when you staged…`) and the content-verified rollback tests pass unchanged.
5. README and ARCHITECTURE contain the six-layer statement and no sentence claims containment by `edit` mode or by post-verify checks.
6. ZCH-010 evidence (fixture, versions, environment findings, F5 and F7 observations) is committed and README's "not verified" list is updated.
7. CHANGELOG `Unreleased` lists every behavioural change, including the verify-phase scope enforcement under **Changed**.
8. An independent read-only review of the merged branch finds no unresolved Critical or High finding and confirms each invariant in section D maps to at least one passing test.

---

## J. Recommended execution order

One task per dispatch, `npm test` + `npm run check` as verify commands, `zc-reviewer` after each `OK`, commit before the next task.

| Step | Task | Depends on | Independent of |
|---|---|---|---|
| 1 | ZCH-001 post-verify re-check (P0) | — | **done** (`63bc634`) |
| 2 | ZCH-011 git metadata integrity (P0), as steps 011-A → 011-E, each reviewed and committed before the next | ZCH-001 | ZCH-004, 008 in logic; shares `dispatch.mjs` with 002, 005, 006, 007, `gitx.mjs` with nothing else, `cli.mjs` with 004 and 008; manual baseline comparison before each commit |
| 3 | ZCH-002 bounded cooldowns (P0) | — | all |
| 4 | ZCH-003 honest docs (P0) | ZCH-001, ZCH-011 | code tasks |
| 5 | ZCH-004 lock takeover (P1) | — | ZCH-002, 006, 007, 008 |
| 6 | ZCH-005 accounts lock (P1) | ZCH-004 | ZCH-006, 007, 008 |
| 7 | ZCH-006 stream-parsed result (P1) | — | ZCH-004, 005, 008 (touches `proc.mjs`: run before 007) |
| 8 | ZCH-007 signal handling (P1) | ZCH-006 merged (shared `run()` edits) | ZCH-004, 005, 008 |
| 9 | ZCH-008 env allowlist (P1) | — | ZCH-004, 005 (touches `agy.mjs`: run after 006) |
| 10 | ZCH-010 real agy verification (P1, manual) | ZCH-006, ZCH-008 | — |
| 11 | ZCH-009 account lease (P2) | ZCH-005, ZCH-010 findings | — |

ZCH-011 goes before ZCH-002 because it closes a reproduced code-execution path and because ZCH-003 must describe it. Tasks ZCH-002, ZCH-004, ZCH-006 and ZCH-008 touch disjoint files and could be dispatched in any order relative to each other; the table gives the order that keeps every file touched by at most one in-flight task. ZCH-001, ZCH-011, ZCH-002, ZCH-005, ZCH-006 and ZCH-007 all edit `src/dispatch.mjs` and must be strictly sequential.

---

## Appendix: findings not turned into tasks

- Unpinned ECC install default (`installFromGit`, `ECC_URL` default branch): Low; already prints a pinning tip; out of this phase's scope.
- `DENIED` taking precedence over a `.zc/` violation when `changed` is empty (`src/dispatch.mjs` success path): Low; `.zc/` is already restored and recorded in `attempt.zcViolations`; revisit after ZCH-001 if the manager finds it confusing.
- `allowed: ['**']` passing the non-empty check: manager-controlled; documented, not fixed.
- Windows `resolveSpawn` quoting untested: add a unit test opportunistically in ZCH-006 or ZCH-007 if `src/proc.mjs` is already in scope; otherwise a separate small task after this phase.
