# Zora-Conductor Hardening Specification

Status: authoritative for the hardening phase. Written 2026-11-13 against `main` at `adafef0` (version 0.2.0-alpha.1).
Audience: the engineering model implementing the work, and the manager (Claude Code + `zc:orchestrate`) that dispatches it as scoped tasks.
Every source reference below was verified against the working tree on the date above. Line numbers are approximate anchors; symbol names are exact.

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
- Dependencies: ZCH-001 merged (so the text describes real behaviour). Suggested `allowed`: `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `skills/orchestrate/SKILL.md`, `test/contract.test.mjs`.

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

**New regression tests (by task).** ZCH-001: verify-time out-of-scope write, `.zc/` write, commit, in-scope write, `VERIFY_FAILED` + tamper precedence. ZCH-002: three parser cases, far-future dispatch case, config validation. ZCH-004: stale-lock race (child processes, 20 iterations), `waitMs`, error text, doctor warning. ZCH-005: write-contention child processes, atomic `pickAndMark`. ZCH-006: >8 MB stream ends `OK`, truncation flags recorded. ZCH-007: SIGTERM end-to-end (POSIX), `onSpawn`. ZCH-008: allowlist unit tests, config validation. ZCH-009: lease cases. ZCH-010: recorded-fixture parse test.

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
| Git-based repository enforcement | clean-tree guard, `partitionByScope`, `.zc/` snapshot/restore, HEAD/branch check, content-verified rollback | Enforced for the worker phase; **not** for verify | Enforced after the worker phase **and** after verify (ZCH-001); detects and undoes repository-visible effects only |
| Process isolation | separate `agy` process, timeout, `killTree`, per-project lock | Worker and verify run as the manager's user with the manager's environment | Worker gets an allowlisted environment (ZCH-008); interruption kills the tree (ZCH-007); verify still runs as the manager |
| OS isolation | none (README: "guard rail, not a sandbox") | None | None. Not in scope of this phase; the only way to contain code executed by verify |
| Credential isolation | per-account `--gemini_dir`, Linux private D-Bus session, SSH-hint file storage on Windows/macOS, state dir outside the repo, 0600 JSON | Isolates worker accounts from each other; depends on version-specific `agy` behaviour | Unchanged; verified against a real `agy` version by ZCH-010 |

**Honest statement after hardening.** zc guarantees that no change a worker or a verify command makes *inside the repository* (including `.zc/`, HEAD and the branch) can reach `OK` without passing the scope and integrity checks, and that anything caught is saved and, where safe, undone. zc does not guarantee anything about effects outside the repository: code executed by verify runs as the manager and can read the manager's files, environment and network. Running untrusted repositories or untrusted ECC content requires a disposable user, container or machine. Post-verification checks are detection and repair, not sandboxing.

---

## H. Implementation constraints

- **CLI.** No command removed or renamed; flags keep their meaning. Additive only: new result fields (`phase`, `verifyChanged`, `preVerifyState`, `stdoutTruncated`, `cooldownSource`, `signal`), new status `INTERRUPTED` (exit 3), richer error text, new `doctor` checks.
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

1. ZCH-001, ZCH-002, ZCH-003 (P0) merged; ZCH-004 to ZCH-008 and ZCH-010 (P1) merged; ZCH-009 (P2) merged or explicitly deferred with the ZCH-010 evidence that justifies it.
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
| 1 | ZCH-001 post-verify re-check (P0) | — | all; **do first**, with manual `.zc/` and `git log` inspection before commit |
| 2 | ZCH-002 bounded cooldowns (P0) | — | all |
| 3 | ZCH-003 honest docs (P0) | ZCH-001 | code tasks |
| 4 | ZCH-004 lock takeover (P1) | — | ZCH-002, 006, 007, 008 |
| 5 | ZCH-005 accounts lock (P1) | ZCH-004 | ZCH-006, 007, 008 |
| 6 | ZCH-006 stream-parsed result (P1) | — | ZCH-004, 005, 008 (touches `proc.mjs`: run before 007) |
| 7 | ZCH-007 signal handling (P1) | ZCH-006 merged (shared `run()` edits) | ZCH-004, 005, 008 |
| 8 | ZCH-008 env allowlist (P1) | — | ZCH-004, 005 (touches `agy.mjs`: run after 006) |
| 9 | ZCH-010 real agy verification (P1, manual) | ZCH-006, ZCH-008 | — |
| 10 | ZCH-009 account lease (P2) | ZCH-005, ZCH-010 findings | — |

Tasks 2, 4, 6 and 8 touch disjoint files and could be dispatched in any order relative to each other; the table gives the order that keeps every file touched by at most one in-flight task. Tasks 1, 2, 5, 6 and 7 all edit `src/dispatch.mjs` and must be strictly sequential.

---

## Appendix: findings not turned into tasks

- Unpinned ECC install default (`installFromGit`, `ECC_URL` default branch): Low; already prints a pinning tip; out of this phase's scope.
- `DENIED` taking precedence over a `.zc/` violation when `changed` is empty (`src/dispatch.mjs` success path): Low; `.zc/` is already restored and recorded in `attempt.zcViolations`; revisit after ZCH-001 if the manager finds it confusing.
- `allowed: ['**']` passing the non-empty check: manager-controlled; documented, not fixed.
- Windows `resolveSpawn` quoting untested: add a unit test opportunistically in ZCH-006 or ZCH-007 if `src/proc.mjs` is already in scope; otherwise a separate small task after this phase.
