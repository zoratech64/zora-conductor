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

Every run writes `result.json`, each attempt's prompt and raw event stream, and any saved partial work to `<state>/projects/<project>/runs/<runId>/`.

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
