# zora-conductor (`zc`)

Claude Code is the **manager**. Your Gemini (Antigravity) accounts are the **workers**. [ECC](https://github.com/affaan-m/ECC) is the base: it gives the manager its planning, TDD, review and security workflows, and it gives the workers their coding standards.

One worker runs at a time, directly in your project folder (no worktrees). When a worker's account hits a usage limit, `zc` saves its partial work, rolls the tree back, puts that account on cooldown and retries the same task on the next account. The manager only ever sees the final result, then reviews and verifies it before committing.

```
You ── Claude Code (manager, ECC installed, zc plugin)
            │  /zc:orchestrate  → plan → tasks → dispatch → review → commit
            ▼
        zc CLI  ── account pool, failover, scope check, verify gate
            ▼
        agy (Antigravity) ── one isolated profile per Gemini account
            ▼
        your project (same folder, same branch)
```

Works on Ubuntu and Windows. Node 22+, no npm dependencies.

## Quick start

Full steps, including both operating systems, are in [docs/SETUP.md](docs/SETUP.md). In short:

```bash
# once per machine
git clone <this repo> && cd zora-conductor && npm link         # puts `zc` on PATH
# in Claude Code: install ECC, then this plugin
#   /plugin marketplace add https://github.com/affaan-m/ECC   →  /plugin install ecc@ecc
#   /plugin marketplace add <path-or-url-of-this-repo>        →  /plugin install zc@zora-conductor
zc account add g1          # signs in an isolated profile; repeat per Gemini account
zc account add g2

# once per project
cd your-project && zc init && git add .zc && git commit -m "chore: add zc config"
# then, in Claude Code inside the project:
#   /zc:orchestrate add password reset to the auth module
```

**Before you add a second account, read [docs/ACCOUNTS.md](docs/ACCOUNTS.md).** On Linux, agy keeps its login in the shared desktop keyring, so `zc` runs each account in its own private D-Bus session (needs `dbus-run-session`).

## What you get

| Piece | What it does |
|---|---|
| `zc` CLI | Account pool, sticky selection, cooldowns, one-at-a-time dispatch, failover, scope and verify gates, reject, doctor |
| `zc:orchestrate` skill | The manager's operating procedure: plan with ECC, split into scoped tasks, dispatch, review, accept/repair/reject |
| `zc ecc` catalog | Search and print every ECC skill, agent, command and rule; install the full ECC; hand any of them to a worker with an `ecc:` list in the task |
| `zc-reviewer` agent | Fresh-context, read-only reviewer for each worker result |
| Worker prompt | Standing rules + the task's allowed paths + (optionally) ECC rule packs such as `common` and `dart` or `typescript` |

## Commands

```
zc init                                       create .zc/ for this project
zc dispatch --task T.md [--json]              run one task on the next ready account
zc dispatch --repair <runId> --task fix.md    feedback on top of a worker's uncommitted result
zc dispatch --task T.md --dry-run             print the exact worker prompt, run nothing
zc reject [<runId>] [--force]                 discard a result (saved first; only files still exactly as the run left them; takes the project lock)
zc ecc install|status|list|search|show        the whole ECC catalog (skills, agents, commands, rules)
zc runs | status | doctor
zc account add|login|check|list|reset|remove
```

Dispatch exit codes: `0` done and verified · `1` failed / rejected / verify failed · `2` every account is cooling down (`retryAfter` in the result) · `3` needs a human.

A task is a Markdown file with front matter (`ecc:` gives the worker any ECC skill, agent, command or rule pack, pasted into its prompt):

```markdown
---
id: T-001
title: Password reset endpoint
allowed:
  - src/auth/
  - test/auth/
verify:
  - npm run build
  - npm test
minutes: 30
ecc:
  - skill:nestjs-patterns
  - agent:typescript-reviewer
---
Add POST /auth/reset ... (objective, files, acceptance tests, constraints)
```

## Safety model

- The tree must be clean (or exactly match a prior run when using `--repair`) before a worker starts.
- A task without `allowed` paths is refused. After the worker finishes, `zc` reads the changed files from git: anything outside `allowed`, or any secret-like path (`.env`, keys, `.git/`), rejects the result and rolls it back. The project's own `.zc/` folder is snapshotted before every worker run; any change a worker makes there is undone, kept as evidence in the run folder, and fails the run as `SCOPE_VIOLATION`.
- Workers are launched with file-edit permission only by default, which should keep them from running git or shell commands. If one does move HEAD or the branch anyway, `zc` stops and touches nothing.
- `zc` is a guard rail, not a sandbox. A worker runs as you, and the scope check only sees files inside the repository. Do not point it at untrusted code on a machine that holds secrets you care about; use a disposable clone or container for that.
- Verification commands run in `zc` as argv arrays, never through a shell. The worker's own report is never treated as proof.
- Rollbacks only happen when the tree was verified clean beforehand, and the partial work is saved under the run folder first. `.zc/` is never rolled back.
- Region/location refusals stop the whole run; `zc` never rotates accounts to get around them, and never patches the `agy` binary.

## What is and is not verified

Verified here (Linux, 99 automated tests plus an end-to-end CLI run): account pool and sticky selection, quota/auth/license/location/server handling, partial-work save and rollback, scope and forbidden-path rejection, verify and repair flow, timeout kill, HEAD-moved detection, content-verified rollback and reject, atomic ECC install, ECC catalog validation, ECC rule injection, plugin manifest validation.

**Not verified yet, because it needs real accounts and machines:**

1. The real `agy` CLI. The flags and the stream-json event format come from reading the two reference projects (agy 1.1.21 and 1.4.12 are mentioned there). Everything is tested against a fake `agy`. Run `zc doctor`, then one small real task, before relying on it.
2. Account isolation on your Ubuntu machine ([docs/ACCOUNTS.md](docs/ACCOUNTS.md)).
3. Windows. The code paths for `.cmd` launchers, `taskkill` and `%LOCALAPPDATA%` are written but untested; CI runs the suite on `windows-latest`.
4. Loading the plugin in a live Claude Code session (the manifest validates; the skill's behaviour in a real session has not been exercised).

Other limits: only the `agy` adapter exists (a plain Gemini CLI adapter is the natural next one); workers run strictly serially; Flutter code generation (`build_runner`) must be run by the manager between tasks because workers cannot run commands by default.

## Lineage

Built from scratch after reading two projects: `zora-ai-orchestrator` (clean-checkout, scope and HEAD guards; Linux keyring isolation) and `Pirun` (per-account `agy` profiles, failure classification, quota windows). Their ideas are reused; no code was copied (the only third-party material is ECC's `rules/` folder, bundled under `vendor/ecc/` with its MIT license), and the Antigravity binary patcher in `zora-ai-orchestrator` was deliberately left out.

## Licence

zora-conductor is released under the MIT licence (see [LICENSE](LICENSE)). It bundles third-party material, listed with its source, version, licence and copyright in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): the `common`, `dart` and `typescript` rule packs of [ECC](https://github.com/affaan-m/ECC) under `vendor/ecc/`, MIT licensed, with their licence text in `vendor/ecc/LICENSE`.
