---
id: ZCH-011A-r1
title: Repair for ZCH-011A (hidden .git files on Windows, A1 setup)
allowed:
  - src/gitmeta.mjs
  - src/gitx.mjs
  - src/dispatch.mjs
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 30
---
Objective: fix the two causes of the failing ZCH-011A run. Everything else in the current uncommitted work stays as it is. Contract: .zc/tasks/ZCH-011A.md (unchanged; read it).

Failing output (npm test, Windows):
- A1: `AssertionError: fsmonitor marker must exist after plain git status` (test/gitmeta.test.mjs:84).
- A3: `Error: EPERM: operation not permitted, open '...\zc-wt3-...\.git'` at test/gitmeta.test.mjs:130 (writeFileSync).
- A7: `Error: EPERM: operation not permitted, open '...\zc-wt7-...\.git'` at test/gitmeta.test.mjs:264 (writeFileSync).

Causes (verified by the manager):
1. Git for Windows marks a linked worktree's `.git` pointer file as hidden (`attrib` shows `H`). Node's `writeFileSync` (flag 'w') fails with EPERM on an existing hidden file on Windows. The same applies to production code: `restoreIdentity` in src/gitmeta.mjs uses `writeFileSync` and therefore cannot restore a tampered pointer on Windows.
2. A1 creates `fsmon.sh`, `fsmon.marker` and `hook.marker` inside the repository. They are untracked, so the test's own `rollbackPaths(dir, statusEntries(dir), ds)` deletes `fsmon.sh`; the final plain `git status` then has no fsmonitor script to run.

Decisions (final):
- src/gitmeta.mjs: add and export `overwriteText(path, text)`: if the file exists, open it with flag 'r+', `ftruncateSync(fd, 0)`, `writeSync(fd, text, 0, 'utf8')`, `closeSync(fd)` in try/finally; if it does not exist (ENOENT), `writeFileSync(path, text)`. `restoreIdentity` uses `overwriteText` instead of `writeFileSync`. Also make `restoreIdentity` never throw: wrap the evidence copy and the write per entry in try/catch; on any error leave `restored = false` and append the error message to `entry.detail`. Copy the evidence BEFORE writing; if the evidence copy fails, do not write (restored stays false).
- test/gitmeta.test.mjs:
  - A1: create the fsmonitor script, the hook marker and the fsmonitor marker in a separate `mkdtempSync(join(tmpdir(), 'zc-a1-'))` folder, outside the repository (the hook script itself stays in `.git/hooks`). Keep every assertion.
  - A3 and A7: every write to an existing `.git` pointer file, `<gitDir>/gitdir` or `<gitDir>/commondir` uses `overwriteText` (imported from ../src/gitmeta.mjs), including the writes that restore the original content. Keep every assertion.
  - Add one assertion to A7: after `restoreIdentity`, the evidence copy in saveDir contains the tampered text.
- No other changes. src/gitx.mjs and src/dispatch.mjs stay as they are unless a fix strictly needs them (it should not).

Done when: test/gitmeta.test.mjs A1-A8 pass on Windows (A9 skips with "no mkfifo"); all other tests pass unchanged; `npm test` and `npm run check` pass.

If blocked: report with file and line evidence; do not widen scope.

Verification: the manager (zc) runs `npm test` and `npm run check`; the worker cannot run commands.
