# Architecture

## Layers

1. **Manager (Claude Code).** Makes every decision: plans, splits work, reviews, commits. Its procedure lives in `skills/orchestrate/SKILL.md`; ECC supplies the planner, reviewers, TDD and security skills it calls.
2. **`zc` (this repo's CLI).** Deterministic. It never judges code quality. It controls access (accounts, scope, clean tree), runs the worker, and reports facts read from git and from the verification commands.
3. **Workers (`agy`).** Gemini accounts, each in an isolated profile. Stateless between tasks (`--new-project` per run). They get file-edit permission only by default.

## One dispatch

```
guard      git repo, has a commit, tree clean (or equals the --repair run), task has allowed paths, lock taken
loop       pick account (sticky, else least recently used among ready + not cooling)
           run agy with the prompt on stdin; time limit enforced by zc (process tree killed)
           HEAD/branch changed?            → NEEDS_HUMAN, nothing touched
           success?                        → changed files from git status
                no change                  → NO_CHANGES
                outside allowed/forbidden  → SCOPE_VIOLATION (saved, rolled back)
                verify commands fail       → VERIFY_FAILED (work kept for repair)
                else                       → OK (work left uncommitted for the manager)
           failure?   save partial work to the run folder, roll back (onLimit=reset) or keep (continue)
                quota → cooldown, next account     auth → needs-login, next     license → blocked, next
                location → stop (NEEDS_HUMAN)      timeout → TIMEOUT            permission → DENIED
                server/empty/unknown → rerun once on the same account, then cooldown, next
none ready  NO_CAPACITY (exit 2, retryAfter) or NEEDS_HUMAN (nothing usable at all)
```

Every run writes `result.json`, each attempt's prompt and raw event stream, and any saved partial work to `<state>/projects/<project>/runs/<runId>/`. It records `attempts[].metrics` and `verifyDurationMs`, with missing measurements set to `null`, never invented.

## Invariants

- Only one dispatch per project at a time (lock file, stale locks from dead processes are taken over).
- A rollback happens only after the tree was verified clean at the start, and only after the partial work is saved. `.zc/` is excluded from rollbacks.
- In `--repair` mode the baseline is someone's in-progress work, so automatic rollback is switched off and failed attempts hand their work to the next account instead.
- The worker's report is shown to the manager but never decides a status. Statuses come from the agy result event plus git plus the verify commands.
- Verification commands are argv arrays; no shell is involved (on Windows `.cmd` launchers go through `cmd.exe` with strict argument checks).
- A location refusal is terminal for the run. No account is tried afterwards.

## ECC's two roles

- **Manager side:** installed as a Claude Code plugin. The skill names the ECC agents and skills to use for planning, TDD, review and security.
- **Worker side:** Gemini does not run ECC hooks, so the chosen rule packs (`rules/common`, `rules/dart`, `rules/typescript`, ...) are read from `ecc.path`, capped at `ecc.maxChars`, and placed in each worker prompt. `zc dispatch --dry-run` shows exactly what a worker will receive.

## State

| What | Where |
|---|---|
| accounts, profiles (credentials) | `<state>/accounts.json`, `<state>/profiles/<id>/` |
| runs, locks | `<state>/projects/<name>-<hash>/` |
| project config, tasks, progress, worker prefix | `<project>/.zc/` (commit it) |

`<state>` is `~/.local/state/zora-conductor` (Linux), `%LOCALAPPDATA%\zora-conductor` (Windows) or `$ZC_HOME`.

## Extending

- **Another worker CLI:** add an adapter beside `src/agy.mjs` that exposes `runX({account, prompt, cwd, timeoutSec, permissions})` returning `{code, timedOut, stdout, stderr, parsed}` where `parsed` has `status`, `response`, `error`, `softErrors`, `permissionAsks`; then select it with `worker.adapter`. `src/dispatch.mjs` currently calls `runAgy` directly; routing by adapter is a few lines.
- **Another failure kind:** add a pattern in `src/classify.mjs` and a case in the `switch` in `src/dispatch.mjs`.
- **Headless manager:** a `zc auto` command could drive `claude -p` in a loop. The interactive plugin is the supported path in 0.1.

## How ECC reaches each side

| ECC part | Claude (manager) | Gemini (workers) |
|---|---|---|
| Skills, agents, commands | Used natively through the installed ECC plugin | Their text is pasted into the worker prompt: per task with `ecc: [skill:x, agent:y, command:z]`, per project with `ecc.assets` |
| Rules | Applied by the ECC plugin | Rule packs from `ecc.rulePacks` are pasted in; `common`, `dart`, `typescript` ship with zc |
| Hooks | Run by Claude Code | Not applicable: workers run headless. zc's own scope check, rollback and verify gate stand in |
| Catalog | `zc ecc search/list/show` finds what exists | Same text, chosen by the manager |

Commands and agents describe procedures that rely on tools workers do not have (shell, sub-agents). The worker prompt tells the model to follow only the parts that need reading and editing files; the manager runs everything else. `zc ecc install` copies skills, agents, commands and rules out of an ECC checkout into the zc state folder (`ecc/`); a reference to a name that does not exist stops the dispatch before any worker is started.

## Integrity rules (v0.1.3)

- **`.zc/` belongs to the manager.** Rollbacks never touch it. Before each worker run `zc` snapshots it (SHA-256 per file, copies kept in the run folder); afterwards any difference is restored, the worker's version is saved under `zc-violations-<n>/`, and a run that would otherwise have succeeded ends as `SCOPE_VIOLATION`.
- **Rollback is content-verified.** After the worker exits, `zc` records a fingerprint of every changed path (`workerState` in `result.json`). Rollback and `zc reject` restore a path only if it still has exactly that content; anything else is left alone and reported (`PARTIAL rollback`, exit 3). Results without `workerState` need `--force`. `--force` still saves the current files first.
- **Staged changes count.** Recorded state includes the git index, so a file you `git add` after a run is no longer "the worker's" and is never discarded by `reject` or a rollback.
- **Protected `.zc/` must be restorable.** If a `.zc/` file is too large to snapshot (2 MB each, 32 MB total), no worker is started; if a worker change there cannot be restored, the run stops as `NEEDS_HUMAN`, never as a successful rollback.
- **One lock for everything that changes the tree.** `dispatch` and `reject` take the same project lock; it is released on every path, including errors.
- **Repair compares contents**, not just file names: the tree must hash identically to the run being repaired.
- **Durations** (task `minutes`, `--minutes`, `defaults.*Minutes`) must be finite numbers greater than 0 and at most 480; anything else is refused before a timer is armed.
- **ECC**: one validator (`validateCatalog`) decides what a usable ECC folder is and is used by install, status, doctor and source selection. Installs are staged and swapped atomically and record provenance in `INSTALLED.json` (origin, requested ref, full commit, whether it tracks a moving branch). Assets load by path with a per-file byte limit (`ecc.assetMaxBytes`); the prompt budget (`ecc.assetMaxChars`) includes whole sections only and lists what was left out.
- **ECC install recovery** takes the same lock as installs, and a backup is never deleted unless the new install is in place; if the old one cannot be restored it is kept and restored by the next `zc ecc` command.
- The npm package includes `vendor/` (bundled rules).
- Empty `.zc/` folders are protected like files (deleted ones are recreated, new ones removed and reported). A lookup that meets an install mid-swap waits for it (up to 15 s, `ZC_ECC_WAIT_MS`) and then fails clearly; it never falls back to the bundled rules.
- The `.zc` folder itself is tracked too: deleting, creating or replacing it (by a file) is detected, undone and reported as a violation. A `.zc` that is a symlink or a file blocks the run before a worker starts.
- `.zc/` inspection fails closed: only "not there" (`ENOENT`/`ENOTDIR`) counts as missing. Any other error (for example a permission error) stops the run as `NEEDS_HUMAN` before a worker starts, or, after a worker ran, without claiming the folder was checked.
