# Changelog

All notable changes to zora-conductor are recorded here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0 a minor release may contain an approved breaking change, which is always marked **Breaking** here and comes with migration guidance. The release process is in [docs/RELEASING.md](docs/RELEASING.md).

0.2.0-alpha.1 is the first version published as a git tag and GitHub Pre-release; the versions before it were never tagged or released. The commit hashes refer to `main` in [zoratech64/zora-conductor](https://github.com/zoratech64/zora-conductor).

Versions 0.1.0 and 0.1.3 to 0.1.7 are recorded in git: the manifest files in the listed commits carry that version. 0.1.1 and 0.1.2 were local development version bumps only. They were never recorded in git, and no commit carries those version numbers. They are listed separately at the end so the history of the code is complete.

## [Unreleased]

### Added

- `scripts/measure.mjs compare --key <name>` compares one named prompt-size section of combined measurement files such as `.zc/baseline-pre.json`. Without `--key`, a combined file is still rejected, and the error now names the sections it holds.

### Changed

- Worker prompts always keep the ECC `security.md` and `testing.md` rule files: past `ecc.maxChars`, other rule files are dropped first, and if those two files alone do not fit, `zc dispatch` (and `zc doctor`) report an error instead of leaving them out.

### Fixed

- `scripts/measure.mjs prompt` reports `rulesTruncated: true` again when ECC rule files are left out past `ecc.maxChars`. Since whole-file rule selection it looked for a marker that is no longer written, so it was always `false`.

## [0.2.0-alpha.2] - 2026-11-15

Second pre-release, for testing only. It adds `zc accept`, makes project verification mandatory, sends workers leaner prompts with an execution contract, and records run metrics.

### Breaking

- A task's `verify:` no longer replaces the project's `verify` commands from `.zc/config.json`; the project commands always run first and the task's commands are added after them (exact duplicates run once). `result.json` lists the effective commands in `verifyPlan`. **Migration:** a task that used `verify:` to replace or skip a project command must now also pass that command. If a project command should not run for every task, remove it from `verify` in `.zc/config.json` and list it in the `verify:` of the tasks that need it.

### Added

- `zc accept [<runId>]` stages only the files a verified worker run produced; it never commits. It checks run status, HEAD and the recorded file contents first, and refuses paths outside the task's `allowed`, forbidden paths and paths not recorded as the worker's change (for example files written by verify commands). Staging is all-or-nothing: on any mismatch nothing is staged. It also refuses, staging nothing, when unrelated files are already staged, so the next `git commit` contains only the run's files. It takes the same project lock as `dispatch` and `reject`.
- `result.json` records per-attempt worker metrics in `attempts[].metrics` (prompt size, turns, usage, tool and file-operation counts) and `verifyDurationMs`. A measurement that is not available is `null`.
- `scripts/measure.mjs` measures worker prompt sizes, and gains read-only `runs` (metrics aggregated across recorded runs) and `compare` (before/after prompt-size comparison).

### Changed

- Worker prompts leave out manager-only ECC rule files. Past `ecc.maxChars`, whole rule files are dropped (never cut mid-file), and `result.json` records which rules were included, excluded and omitted in `eccRules`.
- The default task template (`zc init`) and the manager skill use the execution contract.
- The built-in worker prefix gains the contract rules. Projects with an unmodified copy of an older prefix pick them up automatically; customised prefixes are left alone.
- The manager skill and the `zc-reviewer` agent now agree: specialist review is risk-based, zc's verify outcome is the gate, and acceptance uses `zc accept` instead of broad staging.

### Fixed

- Worker accounts on Windows and macOS are isolated: agy there ignores file-based token storage and kept one shared login in the OS credential store, so every account was the same identity. zc now sets local SSH-session hints (`SSH_CLIENT`, `SSH_CONNECTION`; no SSH connection is made) so agy keeps each account's token in its own profile folder. `ZC_ISOLATION=none` turns this off. Linux is unchanged.

### Known limitations

- The Claude plugin does not yet run a project-local CLI.
- Automatic switching to the next account is still present; its removal is a planned change that is not in this pre-release.
- Windows and macOS are still untested end to end; the account-isolation fix was checked against agy 1.5.1 only.

## [0.2.0-alpha.1] - 2026-11-08

First pre-release, for testing only. It adds the release foundation; zora-conductor's behaviour is otherwise unchanged from 0.1.7.

### Added

- `zc --version` prints the installed zora-conductor version.
- `npm run check` now also checks that `package.json`, `.claude-plugin/plugin.json` and the `zc` entry in `.claude-plugin/marketplace.json` declare the same, valid version (`X.Y.Z`, or `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` or `X.Y.Z-rc.N` for pre-releases), so one tag always identifies one compatible CLI and plugin release.
- `npm run check` also fails if a file under `vendor/` is not listed in the new `THIRD_PARTY_NOTICES.md`, which records the source, version, licence and copyright of the bundled ECC rules (MIT) and classifies every other file as original. The README has a licence section.
- CI runs on Ubuntu and Windows (required) and macOS (CI-only, non-blocking), with Node 22 and 24. On Linux it fails if the `.zc/` permission tests were skipped.
- A release workflow: a `v*` tag that matches the package version and has a changelog section runs the required tests and creates a **draft** GitHub Release with that section. It never publishes; a maintainer reviews and publishes by hand. It can also be run by hand as a dry run that creates nothing.
- This changelog and the release process in `docs/RELEASING.md`.

### Known limitations

- The Claude plugin does not yet run a project-local CLI.
- Automatic switching to the next account is still present; its removal is a planned change that is not in this pre-release.

## [0.1.7] - 2026-11-08

Commits `b451aab`, `bc8f003`.

### Fixed

- Reading `.zc/` now fails closed: only "not there" counts as missing. Any other error (for example a permission error) stops the run as `NEEDS_HUMAN`: before a worker starts, or, if a worker already ran, without claiming that `.zc/` was checked.

### Tests

- Dispatch-level test for a worker that makes `.zc/` unreadable during a run.

## [0.1.6] - 2026-11-08

Commits `afd1729`, `3b5020a`.

### Fixed

- The `.zc` folder itself is protected: deleting it, creating it when it was absent, or replacing it with a file is detected, undone and reported. A `.zc` that is a symlink or a file blocks the run before a worker starts.

### Tests

- Real symlink cases for `.zc`, and replacement of `.zc/` with an identical or a different copy.

## [0.1.5] - 2026-11-08

Commit `0024bda`.

### Fixed

- Empty folders inside `.zc/` are protected like files: deleted ones are recreated, new ones are removed and reported.
- An ECC lookup that meets an install in progress waits for it (up to 15 s, `ZC_ECC_WAIT_MS`) and then fails clearly, instead of silently using the bundled rules.

## [0.1.4] - 2026-11-08

Commit `21b9946`.

### Fixed

- Recorded file state includes git's index, so a file staged after a run is never discarded by `zc reject`, rollback or `--repair`.
- A `.zc/` file too large to snapshot stops the run before a worker starts; a `.zc/` change that cannot be restored ends as `NEEDS_HUMAN`.
- A failed ECC install never deletes the backup of the previous install; recovery of an interrupted install takes the install lock.
- The npm package includes `vendor/` (the bundled ECC rules).
- Test repositories disable `core.autocrlf`, fixing line-ending failures on Windows.

## [0.1.3] - 2026-11-08

Commit `5e28905`, which also contains the code of the local-only 0.1.2 bump (see the end of this file).

### Fixed

- Worker changes under `.zc/` are detected from a snapshot, undone, kept as evidence and reported as `SCOPE_VIOLATION`; rollbacks never delete the manager's `.zc/` files.
- Rollback and `zc reject` restore only files whose content still matches what the worker left; anything changed since is kept and reported (`PARTIAL rollback`). `zc reject` takes the project lock; runs without recorded contents need `--force`.
- `--repair` requires the same file contents as the run being repaired, not just the same paths.
- Task durations (task `minutes`, `--minutes`, `defaults.*Minutes`) must be finite numbers greater than 0 and at most 480.
- ECC: one catalog validator; installs are staged and swapped in atomically and record their source, requested ref and commit in `INSTALLED.json`; temporary clones are always removed; ECC assets have a per-file byte limit and are included whole or listed as omitted; malformed config and invalid ECC references are reported instead of ignored.

## [0.1.0] - 2026-11-08

Commits `5dda6e3`, `8dd22cf`, `7257be5`, `aa4e129`.

### Added

- First version: the `zc` CLI and the Claude Code plugin. Scoped tasks dispatched to one Gemini (Antigravity) worker at a time, in place, with scope checks, a verify gate, partial-work save and rollback, `--repair`, `zc reject`, a project lock, account cooldowns and automatic switching to the next account when one fails or hits a limit.
- Per-account private D-Bus session on Linux, so each worker account keeps its own sign-in.
- Stricter manager rules in the skill and command: the manager does not edit project files itself.
- Bundled ECC rule packs (`common`, `dart`, `typescript`, MIT) pasted into worker prompts.

## Local development version bumps (not recorded in git)

These two version numbers were used only on the development machine, to make Claude Code reload the plugin. No commit, tag or release carries them. The code each one described is part of the recorded commits named below.

### 0.1.1 (local only)

Its code is commit `8bd8d91`, whose manifest files still say 0.1.0.

- Fixed: a worker whose command was refused in headless mode is retried once with a no-commands note, then reported as `DENIED` with the refused command, instead of `NO_CHANGES`.

### 0.1.2 (local only)

Its code was first committed in `5e28905`, together with the 0.1.3 changes; that commit's manifest files say 0.1.3.

- Added: `zc ecc install | status | list | search | show` to install and browse the full ECC catalog (skills, agents, commands, rules).
- Added: `ecc:` in a task file and `ecc.assets` in `.zc/config.json` give a worker any ECC asset.

[Unreleased]: https://github.com/zoratech64/zora-conductor/compare/v0.2.0-alpha.1...HEAD
[0.2.0-alpha.1]: https://github.com/zoratech64/zora-conductor/releases/tag/v0.2.0-alpha.1
[0.1.7]: https://github.com/zoratech64/zora-conductor/commit/bc8f003
[0.1.6]: https://github.com/zoratech64/zora-conductor/commit/3b5020a
[0.1.5]: https://github.com/zoratech64/zora-conductor/commit/0024bda
[0.1.4]: https://github.com/zoratech64/zora-conductor/commit/21b9946
[0.1.3]: https://github.com/zoratech64/zora-conductor/commit/5e28905
[0.1.0]: https://github.com/zoratech64/zora-conductor/commit/aa4e129
