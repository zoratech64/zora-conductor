---
id: ZCH-011B-r2
title: checkMetaFiles never writes or deletes through a symlink; coverage for the untested safety branches
allowed:
  - src/gitmeta.mjs
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 45
cause: worker
causeNote: independent review found checkMetaFiles follows symlinks when restoring (reproduced by the manager); contract decision 9 requires no write outside private paths
---
Objective: close the independent review findings on run 20261116083423-vf6j. `checkMetaFiles` must never write, delete, mkdir or chmod through a symlink, and the untested safety branches get tests. Behaviour of B1-B13 stays as it is.

Reproduction (manager, verified): baseline with `git config core.hooksPath .hooks` and no `.hooks` directory; then `symlinkSync(<victim dir outside the repo>, <repo>/.hooks)`. `checkMetaFiles` returns `hooks` `.hooks/keep.txt` `added`, `restorable: true`, `restored: true`, and `<victim>/keep.txt` is deleted. Cause: in the branch where the baseline hooks directory did not exist (about src/gitmeta.mjs:773-845) the code does not check `isSymbolicLink()` on the current hooks path, and `isPrivate` is lexical only.

Decisions (final):
1. Add a small helper `hasSymlinkBelow(rootDir, target)` (not exported): true when `target` itself or any path component between `rootDir` (exclusive) and `target` (inclusive) exists and is a symlink (`lstatSync`); missing components are not symlinks. For hooks, `rootDir` is the parent of the baseline hooks directory path, so the hooks directory itself is checked too. For a config/info file the roots are the private roots of the layout: use the one of `layout.gitDir`, `layout.commonDir` (when not linked) or `layout.workTree` that contains the file.
2. Before every write, delete, mkdir (recursive), chmod or `overwriteBytes` in `checkMetaFiles`, call the helper for the exact path being touched (for a `removed` file, its parent chain). If it returns true: do not touch anything, set that entry `restorable: false`, `restored: false`, `detail: 'path crosses a symlink: <path>'`. Evidence copies (`copyFileSync` of the current file) are skipped for such an entry.
3. Missing-baseline hooks branch: when the baseline hooks dir did not exist and the current path exists but is a symlink or not a directory, return exactly one hooks entry for it (`change: 'added'`, `restorable: false`, `restored: false`, detail as in 2) and do not walk it. When it is a real directory, behave as today.
4. In that same branch every added directory entry gets `restored` set from `!existsSync(path)` after its `rmdirSync`; the final `rmdirSync` of the hooks directory itself is reflected the same way on an entry for the hooks directory (add it: `area: 'hooks'`, path the report path of the hooks dir, `change: 'added'`); no `catch {}` stays empty: a failure puts the message in `detail` and leaves `restored: false`.
5. Wrap the whole body of `checkMetaFiles` in `try/catch`; an unexpected error returns the entries collected so far plus one `{ area: 'git', path: '.git', change: 'unreadable', restorable: false, restored: false, detail: message }`. It never throws.
6. Contract extensions already in the code stay: `rawMode` on baseline hook entries and the second parameter of `checkOrigins`.
7. Do not split files or move code in this task (a separate task does that). Do not touch `metaBaseline`, `checkMetaInert` or any exported signature.

Tests to add (test/gitmeta.test.mjs, ADD only; existing tests unchanged; same helpers as B1-B13):
- B14 (spec 11.3 "no write outside private paths", the reproduction above): victim directory from `mkdtemp` outside the repo holding `keep.txt`. After the symlink swap: one `added` hooks entry, `restorable: false`, `restored: false`; `<victim>/keep.txt` still exists with its content; the symlink still exists. Skip with the error message if `symlinkSync` throws.
- B15: baseline `.git/hooks/sub/x` (a file in a subdirectory, content `a`). Then replace `.git/hooks/sub` by a symlink to a victim directory (remove the real `sub` first). `checkMetaFiles` does not create or write anything inside the victim directory (same file list and contents as before), and the entry for `sub/x` is `restorable: false`, `restored: false`.
- B16: baseline with `.git/info/exclude`; replace `.git/info` by a symlink to a victim directory that holds an `exclude` file with content `v`; `checkMetaFiles` leaves the victim's `exclude` unchanged, and the entry is `restorable: false`.
- B17 (restored flag, decision 4): baseline with `core.hooksPath .hooks2` and no directory; then create `.hooks2/d/h` (a real directory with a file). Afterwards every returned entry has `restored: true`, `.hooks2` no longer exists, and an entry for the hooks directory itself exists.
- B18 (never throws, decision 5): pass a `baseline` whose `hooks.entries` is `null`; `checkMetaFiles` returns an array (no throw) whose last entry has `change: 'unreadable'`.
- B19 (non-private config/info file is detect-only, spec 11.3): hand-edit a baseline: copy `baseline.files`, set one record's `path` to a file in a separate mkdtemp folder with `private: false` and `bytes` equal to its current content, then change that file; one `modified` entry, `restorable: false`, `restored: false`, the changed content is still there.
- Strengthen B10(a) and B10(b): in addition to `code`, assert the message matches `/maxFileBytes/` and `/symlink/`.

Acceptance criteria:
- B14-B19 pass; B1-B13, A1-A9 and every existing test pass unchanged apart from the two added assertions in B10; `npm test` and `npm run check` pass.
- This repair lists only src/gitmeta.mjs and test/gitmeta.test.mjs as changed (cumulative run diff is the same two files).
- Manager checks after the run: B14 fails when decision 3 is removed; B15 and B16 fail when decision 2 is removed; B19 fails when `restorable = file.private` is replaced by `true`.

Do not: change any other file, any assertion of an existing test except the two additions named above, or any signature. No new dependencies. No refactor or file split.

Manager notes (not for the worker):
- Source: independent review of run 20261116083423-vf6j (CRITICAL symlink-following delete, HIGH symlink-following write, MEDIUM wrong `restored`, MEDIUM never-throws) and mutation survivors m5 (non-private files), m11/m16 (evidence copies). Out of scope: TOCTOU between lstat and write (documented limit, spec 11.1) and LOW findings 6-8.
- The refactor/split contract follows as ZCH-011B-r3 once this passes.
