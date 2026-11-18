---
id: ZCH-011B-r3
title: The symlink guard checks every ancestor up to the private root and fails closed
allowed:
  - src/gitmeta.mjs
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 40
cause: worker
causeNote: r2 guards start at dirname(hooksDir), so a symlinked ancestor of the hooks directory still redirects restores outside the repository (reproduced by the manager and by the independent reviewer)
---
Objective: close the remaining escape in `checkMetaFiles`. Today the hooks guards use `hooksRoot = dirname(resolve(hooksDir))` (src/gitmeta.mjs:785) as `rootDir` of `hasSymlinkBelow`, so every ancestor of the hooks directory above that root is never checked.

Reproduction (manager, verified on run 20261116084214-6ofj): `git config core.hooksPath .cfg/hooks`; baseline with `.cfg/hooks/pre-commit`; then delete `.cfg` and `symlinkSync(<victim dir outside the repo>, <repo>/.cfg)`. `checkMetaFiles` returns one `removed` entry, `restorable: true`, `restored: true`, and `<victim>/hooks/pre-commit` now exists. The reviewer also showed an overwrite of `<victim>/hooks/h`, deletion of `<victim>/hooks/extra`, and evidence copies that read victim files, all with `hooksPath` = `sub/hooks`.

Decisions (final):
1. `hooksRoot` becomes the private layout root that contains the baseline hooks directory: the same `layoutRootFor(layout, hooksDir)` that config/info files use. All eight hooks guards keep calling `hasSymlinkBelow(hooksRoot, <path>)`; only the root changes. Compute it once, next to the current `hooksRoot` line.
2. `hasSymlinkBelow(rootDir, target)` fails closed: it returns `true` when `rootDir` or `target` is falsy, when `target` is not inside `rootDir` (and not equal to it), and when `lstatSync` of a component throws anything other than `ENOENT` or `ENOTDIR`. Missing components (`ENOENT`/`ENOTDIR`) still end the walk with `false`, as now. `target` equal to `rootDir` stays `false`.
3. When `rootDir` is `layout.gitDir` or `layout.commonDir`, the root itself is also checked with `lstatSync` (a symlinked git directory returns `true`). The work tree root is never checked itself, because the project folder may legitimately be reached through a symlink.
4. Callers: an entry whose guard returns `true` is `restorable: false`, `restored: false`, with the existing `path crosses a symlink` detail, and nothing is touched. A non-private hooks directory keeps its detect-only behavior (with `hooksRoot` null the guard returns `true`, which gives the same outcome).
5. Do not touch `metaBaseline`, `checkMetaInert`, any exported signature, or any other behavior. No refactor, no file split.

Tests to add (test/gitmeta.test.mjs, ADD only; existing tests unchanged; skip each with the error message if `symlinkSync` throws). B20-B23 use `core.hooksPath sub/hooks` (a path in the work tree with two components) and a victim directory from `mkdtemp` outside the repository. Each asserts that the victim directory is byte-for-byte the same as before the call (same file list, same contents) and that the entries are `restorable: false`, `restored: false`:
- B20: baseline hooks `sub/hooks/h` (content `orig`). Delete `sub`, symlink `sub` to a victim that contains `hooks/h` (content `EVIL`) and `hooks/extra` (content `x`). Covers modified/added through the symlinked ancestor, including the evidence copy: the evidence folder must not contain victim content (`EVIL` or `x`).
- B21: same baseline, but the victim is an empty directory (restore of removed files must not create `hooks/h` in the victim).
- B22: baseline has no hooks directory at all (`sub` does not exist). Then symlink `sub` to a victim that contains `hooks/keep` (content `k`). The victim keeps `hooks/keep`, and `hooks` is not removed.
- B23: as B22 with a victim holding `hooks/d/f`, to cover the added-directory cleanup: nothing in the victim changes.
- B24 (fail closed): hand-edit a baseline copy so that `baseline.hooks.private = true` and `baseline.hooks.dir` is a mkdtemp folder outside every layout root, then add a hook file there. `checkMetaFiles` reports that entry `restorable: false`, and the added file still exists.

Acceptance criteria:
- B20-B24 pass. B1-B19, A1-A9 and every existing test pass unchanged. `npm test` and `npm run check` pass.
- This repair changes only src/gitmeta.mjs and test/gitmeta.test.mjs.
- Manager checks after the run (mutation): each of the eight `hasSymlinkBelow(hooksRoot, ...)` guards at the hooks sites, replaced one at a time by `false`, must fail at least one of B14-B24, or the manager shows the guard is unreachable. The `hooksRoot` line reverted to `dirname(resolve(hooksDir))` must fail B20-B22. Decision 2 reverted must fail B24.

Do not: change any other file, any assertion of an existing test, or any signature. No new dependencies.

Manager notes (not for the worker):
- Source: manager PoC (`.cfg/hooks`) and independent review of run 20261116084214-6ofj (HIGH ancestor hole, MEDIUM fail-open, MEDIUM `.git` symlink). A symlinked `.git` is caught earlier by `checkIdentity` (011-A, first step of the gate); decision 3 only makes this function consistent. No test for it here.
- TOCTOU between lstat and write stays a documented limit (spec 11.1); do not claim race-free.
- The refactor/split contract follows as ZCH-011B-r4.
