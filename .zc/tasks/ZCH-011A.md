---
id: ZCH-011A
title: Pinned git dir and hardened git invocation
allowed:
  - src/gitmeta.mjs
  - src/gitx.mjs
  - src/dispatch.mjs
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 45
---
Objective: zc resolves the repository's git directories once per dispatch, pins every zc git call to them, and runs every zc git call hardened so repository config cannot make zc execute fsmonitor commands, hooks or external diff tools. Source: docs/audits/ZC-HARDENING-SPEC.md, ZCH-011 sections 11.2 and 11.10 (011-A, criteria A1-A9). Read those two sections; do not edit the spec.

Decisions (final, do not reopen):

1. src/gitx.mjs (gitx must NOT import gitmeta; gitmeta imports gitx):
   - `inertTimeoutMs()` (exported): 60000, or `Number(process.env.ZC_GIT_INERT_TIMEOUT_MS)` when that is a positive integer; read at call time.
   - `noHooksDir()` (exported) = `join(stateRoot(), 'no-hooks')` (import `stateRoot` from ./paths.mjs). Before every git call ensure it exists and is empty: mkdir -p; if `readdirSync` is non-empty, `rmSync(dir, { recursive: true, force: true })` then mkdir again; if it is still non-empty or cannot be created, throw an Error naming the folder.
   - `pinLayout(root, layout)` / `unpinLayout(root)` (exported): a module-level Map keyed by `resolve(root)` (lower-cased on win32).
   - `git(root, args, { allowFail = false, timeoutMs = 0 } = {})`: argv becomes `['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', \`core.hooksPath=${noHooksDir()}\`, ...args]`. env = a copy of `process.env` without every key matching `/^GIT_/i`; when `root` is pinned, add `GIT_DIR=layout.gitDir`, `GIT_COMMON_DIR=layout.commonDir`, `GIT_WORK_TREE=layout.workTree`. Pass `timeout: timeoutMs || undefined` to spawnSync. If the call timed out (`result.error?.code === 'ETIMEDOUT'`), throw an Error with `code = 'ZC_GIT_TIMEOUT'` and a message naming the git subcommand, even when `allowFail` is true. Keep every other current behaviour (cwd, encoding, maxBuffer, windowsHide, error handling).
   - Inert callers pass `{ timeoutMs: inertTimeoutMs() }`: `toplevel`, `head`, `branch`, `inHead`, `indexState` (ls-files), and the new `configList`.
   - New export `configList(root)`: `git(root, ['config', '--list', '--show-origin', '--show-scope', '--includes', '-z'], { timeoutMs: inertTimeoutMs() })`, returns stdout. Not used by dispatch yet.
   - `savePartial`: the diff becomes `['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--', '.', ':(exclude).zc']`.
   - Do not change statusEntries/rollbackPaths/pathStates/dirtyState logic; they inherit the hardening through `git()`.
2. New file src/gitmeta.mjs (ESM, node: modules only, imports `* as G from './gitx.mjs'`) exports:
   - `samePath(a, b)`: `resolve(a) === resolve(b)`, case-insensitive on win32.
   - `gitLayout(root)`: runs `G.git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { timeoutMs: G.inertTimeoutMs() })`. Parse the three lines; make the common dir absolute with `resolve(root, line3)`. Throw an Error whose message starts with `git layout:` when: rev-parse fails (this covers bare repositories), toplevel is not `samePath` with `root`, `<root>/.git` is missing or a symlink (lstat), the git-dir or common-dir is missing, not a directory, or a symlink (lstat). Return a plain JSON-serialisable object `{ workTree, gitDir, commonDir, linked, dotGit: { kind: 'dir' | 'file', text }, worktreeFiles: { gitdir, commondir }, identity: { gitDir: { real, dev, ino }, commonDir: { real, dev, ino } } }`: `linked` = !samePath(gitDir, commonDir); `dotGit.text` is the `.git` file content (utf8) when it is a file, else null; `worktreeFiles` holds the utf8 contents of `<gitDir>/gitdir` and `<gitDir>/commondir` when linked (null for a missing file), both null when not linked; `real` = `realpathSync.native(dir)`; `dev`/`ino` = `String(lstatSync(dir, { bigint: true }).dev / .ino)`.
   - `checkIdentity(root, layout)`: filesystem only, never runs git. Returns `[{ area: 'git-dir', path, change, restorable, restored: false, detail }]` (empty array = unchanged). Rules: `.git` now missing, a symlink, or of a different kind than `layout.dotGit.kind` → `replaced`, restorable false. `.git` is a file and its text differs → `modified`, restorable true. When linked, each of `<gitDir>/gitdir` and `<gitDir>/commondir` whose text differs from the record → `modified`, restorable true. For gitDir and commonDir: missing, a symlink, not a directory, `realpathSync.native` differs, or (when recorded and current dev and ino are all non-zero) dev or ino differ → `replaced`, restorable false, `detail` saying which. `path` is relative to root when inside it, else absolute.
   - `restoreIdentity(root, layout, changes, { saveDir })`: for each restorable change, copy the current file into `saveDir` (inside-root paths keep their relative path; absolute paths use `git-dir-<basename>`), then write the recorded text back; set `restored = true` only if a re-read equals the record. Never touches a non-restorable entry. Returns the same array.
3. src/dispatch.mjs, `dispatch()` only: right after the lock is acquired, as the first statement inside the existing `try` (before `G.head(root)`):
   `let layout; try { layout = gitLayout(root); } catch (error) { return finish('NEEDS_HUMAN', EXIT.NEEDS_HUMAN, { nextAction: \`no worker was started: zc could not resolve a trustworthy git directory (${error.message}).\` }); }` then `G.pinLayout(root, layout); result.gitLayout = layout;`. In the existing `finally`, call `G.unpinLayout(root)` before `release()`. Import `gitLayout` from './gitmeta.mjs'. Nothing else in dispatch changes in this task.

Per file:
- src/gitx.mjs, src/gitmeta.mjs, src/dispatch.mjs: as above.
- test/gitmeta.test.mjs (new): node:test + node:assert/strict; helpers from ./helpers.mjs (`makeHome`, `makeRepo`, `addFake`, `task`, `git`). Every repository under `tmpdir()`. Marker scripts are files with content `#!/bin/sh\necho x >> "<marker>"\n<rest>\n`, chmod 0o755; the marker path is unique per test and absolute with forward slashes; on win32 git runs them through its bundled sh. If `spawnSync('sh', ['-c', 'exit 0']).status !== 0`, skip the test with reason "needs sh". Restore any `process.env` change in `finally`. Use `makeHome()` in every test that dispatches.
  - A1: repo config `core.fsmonitor=<fsmon script>` (script body after the echo: `exit 1`) and `.git/hooks/post-index-change` = marker script; modify a tracked file and add an untracked file; call `head`, `branch`, `statusEntries`, `dirtyState`, `pathStates`, `savePartial` (into a tmp dir), then `rollbackPaths(dir, statusEntries(dir), dirtyState(dir))`; assert neither marker exists. Then run plain `git status` through the test helper `git` and assert the fsmonitor marker now exists (proves the setup was live).
  - A2: repo config `diff.external=<marker script>`; modify a tracked file; `savePartial`; marker absent; `git apply --check --reverse <dir>/tracked.patch` (test helper) succeeds while the change is still in the tree.
  - A3: from a makeRepo repo, `git worktree add <tmp>/wt -b wt`; a decoy repo (`git init`, one commit, branch `decoy`); `pinLayout(wt, gitLayout(wt))`; overwrite `<wt>/.git` with `gitdir: <decoy>/.git\n`; assert `branch(wt) === 'wt'` and `head(wt)` equals the worktree's HEAD recorded before; restore the pointer; overwrite `<gitDir>/commondir` with the decoy's `.git` path; assert `branch(wt) === 'wt'`; restore; `unpinLayout(wt)`.
  - A4: `gitLayout` on a normal repo (`linked` false, `dotGit.kind` 'dir'), a linked worktree (`linked` true, `dotGit.kind` 'file', text starts with `gitdir:`, `worktreeFiles.commondir` not null), and a `git init --separate-git-dir <tmp>/sep.git <tmp>/sepwt` repo with one commit (`linked` false, `dotGit.kind` 'file'); each `gitDir`/`commonDir` is `samePath` with `git rev-parse --absolute-git-dir` / `--git-common-dir` (resolved against the root).
  - A5: `dispatch` (fake account `g1`, ok scenario writing `src/a.txt`, task allowing `src/`) ends `NEEDS_HUMAN`, `nextAction` matching /git directory/, and the account profile has no `calls.log`, for (a) a bare repository root created with `git init --bare` (give it a `.zc/config.json` like makeRepo does and load config with `loadConfig`); (b) a makeRepo repo whose `.git` directory was moved to `<tmp>/real.git` and replaced by a directory symlink to it (`symlinkSync(target, join(dir, '.git'), process.platform === 'win32' ? 'junction' : 'dir')`; skip with the error message if creation throws).
  - A6: with `process.env.GIT_DIR` set to another repo's `.git` and `process.env.GIT_INDEX_FILE` set to `<tmp>/bogus-index`, `head(dir)` equals `dir`'s HEAD and `statusEntries(dir)` lists `dir`'s modified file.
  - A7: `checkIdentity` returns `[]` for an untouched layout; a linked worktree with rewritten `.git` text gives exactly one entry `modified`, restorable true, and `restoreIdentity` restores it (`restored` true, evidence file present in saveDir); a normal repo whose `.git` directory was renamed away and copied back with `cpSync(src, dst, { recursive: true })` gives an entry `replaced`, restorable false — unless the recorded dev and ino are '0', in which case assert the list is empty (document this in a comment); a repo whose `.git` directory was replaced by a regular file gives `replaced`, restorable false.
  - A8: write an executable `post-index-change` marker script into `noHooksDir()`, then call `statusEntries` on a dirty repo; marker absent; `readdirSync(noHooksDir())` is empty afterwards.
  - A9: POSIX only (skip on win32 with reason "no mkfifo"): `mkfifo <tmp>/fifo.cfg` (execFileSync); repo config `include.path=<tmp>/fifo.cfg`; with `process.env.ZC_GIT_INERT_TIMEOUT_MS = '500'`, `configList(dir)` throws an error with `code === 'ZC_GIT_TIMEOUT'`.

Read first: src/gitx.mjs, src/dispatch.mjs (lines 1-110 and the end of `dispatch()` with its finally), src/paths.mjs, src/config.mjs (`loadConfig`), test/helpers.mjs, fixtures/fake-agy.mjs (scenario format), test/safety.test.mjs lines 1-40 (style). Do not explore anything else.

Do not: change any other src file, existing tests, fixtures, package.json, docs, the spec, or any .zc file. No new dependencies. Match style (ESM, 2-space, single quotes).

Done when: tests A1-A9 exist and pass (or skip with the stated reasons on this platform); every existing test passes unchanged; `npm test` and `npm run check` pass.

If blocked: report the contradiction with file and line evidence; do not guess or widen scope.

Verification: the manager (zc) runs `npm test` and `npm run check`; the worker cannot run commands.
