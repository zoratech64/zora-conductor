---
id: ZCH-011B
title: Git metadata baseline, comparison and private restore (unit level)
allowed:
  - src/gitmeta.mjs
  - test/gitmeta.test.mjs
verify:
  - npm test
  - npm run check
minutes: 60
---
Objective: add to src/gitmeta.mjs a baseline of the protected git metadata (hooks, config files, effective config, info/history files, refs) and two comparison functions that detect changes, restore private files and report everything else. Unit level only: dispatch does not call any of it yet (that is 011-D). Source: docs/audits/ZC-HARDENING-SPEC.md, ZCH-011 sections 11.1, 11.2 (inert/gated table), 11.3, 11.10 (011-B, criteria B1-B10). Read those; do not edit the spec.

Everything already in src/gitmeta.mjs and src/gitx.mjs stays as it is (011-A is committed and reviewed). Use `G.git(...)` from ./gitx.mjs for every git call; callers pin the layout first (`G.pinLayout`). Never run `status`, `diff`, `restore`, `update-index` or any other gated command in this task: only `rev-parse`, `config --list` (via `G.configList`) and `for-each-ref`.

Decisions (final, do not reopen):

1. Fail-closed error. Export `class GitMetaError extends Error` with `code = 'ZC_GIT_META'`; messages start with `git metadata:`. Baseline problems throw it.

2. Private. `isPrivate(layout, absPath)` (exported): true when `absPath` is equal to or inside `layout.gitDir`, or inside `layout.commonDir` when `!layout.linked`, or inside `layout.workTree`. Use the same case rule as `samePath` (case-insensitive on win32) and compare whole path segments (`/a/bc` is not inside `/a/b`).

3. Hooks path. zc's own git calls override `core.hooksPath`, so `rev-parse --git-path hooks` cannot be used (verified: it returns the override). Instead: parse `G.configList(root)` (see 5) and take the value of the LAST row whose key is `core.hookspath` (case-insensitive) and whose scope is not `command`; expand a leading `~/` or `~\` with `os.homedir()`; resolve it against `layout.workTree`. With no such row the hooks path is `join(layout.commonDir, 'hooks')`.

4. Other paths: one call `G.git(root, ['rev-parse', '--git-path', 'config', '--git-path', 'config.worktree', '--git-path', 'info/exclude', '--git-path', 'info/attributes', '--git-path', 'info/sparse-checkout', '--git-path', 'info/grafts', '--git-path', 'shallow', '--git-path', 'objects/info/alternates'], { timeoutMs: G.inertTimeoutMs() })`; exactly 8 non-empty lines expected (else GitMetaError), each resolved against `root`.

5. Config listing parse: `parseConfigList(stdout)` (exported). Split on `\0`; drop one trailing empty element; the rest must be a multiple of 3 (else GitMetaError): `scope`, `origin`, `keyValue` where key is the text before the first `\n` (whole text when there is none) and value the rest (null when no `\n`). Returns `[{ scope, origin, key, value }]`. Effective config text = the rows with scope `local` or `worktree`, each as `${scope}\t${origin}\t${key}\t${value === null ? '' : value}`, joined with `\n`.

6. Caps, injectable: options `{ maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 8 * 1024 * 1024 }`. Every file the baseline copies counts towards the total.

7. `metaBaseline(root, layout, opts = {})` (exported) returns an in-memory object (Buffers allowed):
   - `paths`: the resolved paths from 3 and 4, plus `hooksDir`.
   - `hooks`: `{ dir, private: isPrivate(layout, dir), exists, entries }`. When the directory exists: walk it recursively with `lstatSync`; any symlink, or any entry that is neither a regular file nor a directory, or any read error -> GitMetaError. `entries` is a Map from the `/`-separated relative path to `{ kind: 'dir' }` or `{ kind: 'file', size, sha256, mode: stat.mode & 0o111, bytes }`. A file over `maxFileBytes` -> GitMetaError. When the path exists but is not a directory, or is a symlink -> GitMetaError. A missing directory gives `exists: false`, empty Map.
   - `files`: one record per protected file, in this order: the `config` and `config.worktree` paths (area `config`), then every distinct origin file of the `local`/`worktree` rows of the listing that is not already listed (area `config`), then `info/exclude`, `info/attributes`, `info/sparse-checkout`, `info/grafts`, `shallow`, `objects/info/alternates` (area `info`). Origins are checked by an exported `checkOrigins(rows)`: for the `local`/`worktree` rows, each origin must start with `file:` (anything else, e.g. `blob:` or `command line:` -> GitMetaError); it returns the distinct paths (the text after `file:`) resolved against `root`. Record `{ area, path (absolute), private: isPrivate(layout, path), bytes }` with `bytes` = the file content, or null when it does not exist (ENOENT/ENOTDIR). A symlink, a non-regular file, any other read error, or a file over `maxFileBytes` -> GitMetaError. Compare paths with `samePath` for the de-duplication.
   - `effective`: the effective config text (5) from the same listing.
   - `refs`: `refsListing(root)` (exported): `G.git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)'], { timeoutMs: G.inertTimeoutMs() })`, lines split into a Map refname -> objectname, skipping names that start with `refs/remotes/`; a non-empty line without exactly one `\0` -> GitMetaError.
   - Sum of all copied bytes (hook files plus non-null `files`) over `maxTotalBytes` -> GitMetaError.
   - Any git call that throws (including `ZC_GIT_TIMEOUT`) propagates unchanged (keep its code).

8. Evidence path: `evidencePath(saveDir, root, absPath)` (exported): inside root -> `join(saveDir, <relative path>)`; else `join(saveDir, 'abs', <absolute path with the drive colon removed and leading separators stripped>)`. Create parent folders before copying.

9. `checkMetaFiles(root, layout, baseline, { saveDir })` (exported): filesystem only, never runs git, never throws (catch per item; an error makes that entry `restorable: false`, `restored: false`, with the message in `detail`). Returns entries `{ area, path, change, restorable, restored, detail }`, `path` relative to root (`/` separators) when inside it, else absolute (reuse the 011-A helper).
   - Hooks (area `hooks`), always walking the BASELINE `hooks.dir`: compare the current tree with `entries`. `change` is `added`, `removed`, `modified` (sha256 or size differ) or `mode` (only the `0o111` bits differ; compare only when `process.platform !== 'win32'`). A symlink or non-file/non-dir entry found now -> `modified` (for a baseline path) or `added`, restorable false. An unreadable directory or file -> change `unreadable`, restorable false. When `hooks.private`: restorable true for the others; repair = save the current version (files only) to evidence, then: `added` file -> delete; added directory -> delete after its contents (only if then empty); `removed` -> recreate (directories first, then file bytes and mode); `modified`/`mode` -> write the baseline bytes back in place (a Buffer variant of `overwriteText`: open 'r+', ftruncate, writeSync(buffer), close; writeFileSync on ENOENT) and `chmodSync` to the baseline mode bits when not win32. If the hooks dir did not exist at baseline and exists now: everything in it is `added`; remove the files, then the directories, then the hooks dir itself. When not private: restorable false, nothing written.
   - Files (areas `config`/`info`): current content vs `bytes`. Baseline null and now present -> `added`; baseline present and now missing -> `removed`; different bytes -> `modified`; symlink or non-regular now -> `modified`, restorable false. Private: save the current version to evidence (when it exists), then `added` -> delete the file; `removed`/`modified` -> write the baseline bytes back in place (mkdir the parent for `removed`). Not private: restorable false.
   - `restored` = true only when a re-read (for a deletion: `existsSync` false; for mode: the re-read mode bits) matches the baseline.

10. `checkMetaInert(root, layout, baseline)` (exported): runs only the inert git commands; call it after `checkMetaFiles`. Never throws: an error (parse failure, timeout, git failure) gives one entry `{ area: 'git', path: '.git', change: 'unreadable', restorable: false, restored: false, detail: message }` and stops. Entries:
    - Effective config differs from `baseline.effective` -> one entry `{ area: 'config-effective', path: <report path of the config file>, change: 'modified', restorable: false, restored: false, detail }` where detail lists the added and removed rows (at most 20 each).
    - Refs: for each name added, removed, or with a different object -> `{ area: 'refs', path: <refname>, change: 'added'|'removed'|'modified', restorable: false, restored: false, detail: '<old> -> <new>' }` (use `(none)` for a missing side). Never rewrite refs.

Tests (test/gitmeta.test.mjs, append; keep A1-A9 unchanged). Each repository from `makeRepo()` under tmpdir; `makeHome()` first (noHooksDir lives under the state root); `pinLayout(dir, gitLayout(dir))` before the baseline and `unpinLayout(dir)` in `finally`. Use the test helper `git` (plain git) to set things up and to mutate. Evidence folders from `mkdtempSync(join(tmpdir(), 'zc-ev-'))`.
- B1: baseline with hooks `.git/hooks/pre-commit` and `.git/hooks/pre-push` (content `#!/bin/sh\nexit 0\n`). Then: modify `pre-commit`, add `.git/hooks/post-checkout`, delete `pre-push`. `checkMetaFiles` returns exactly one `modified`, one `added` and one `removed` hooks entry, all `restored: true`; afterwards `pre-commit` and `pre-push` equal their baseline bytes, `post-checkout` is gone, and the evidence folder holds the modified `pre-commit` and the added `post-checkout`.
- B2: POSIX only (skip on win32 with reason "no exec bits on win32"): baseline hook mode 0o644; chmod 0o755 during the phase; one entry `mode`, restored, mode back to 0o644.
- B3: commit a `.gitignore` containing `.hooks/`; `git config core.hooksPath .hooks`; mkdir `.hooks`. Assert `baseline.paths.hooksDir` is `samePath` with `resolve(dir, <plain helper git rev-parse --git-path hooks, trimmed>)`. Write `.hooks/pre-commit`; one entry `added`, restored true, file gone.
- B4: baseline with the default hooks dir; then `git config core.hooksPath <a separate mkdtemp dir>` and write a hook into `.git/hooks`. `checkMetaFiles` reports a `config` `modified` entry for `.git/config` (restored) and a `hooks` `added` entry (restored); afterwards `.git/config` equals the baseline bytes.
- B5: append `[alias]\n\tst = !echo pwned\n` to `.git/config`; one entry `config` `modified`, restored; bytes equal the baseline exactly; then `checkMetaInert` returns `[]`.
- B6: commit a `.gitignore` with `local.cfg`; write `local.cfg` (`[user]\n\tname = Base\n`); `git config include.path ../local.cfg` (git resolves it relative to .git/config). Baseline `files` contains a private record whose path is `samePath` with `join(dir, 'local.cfg')`. Modify `local.cfg`; `checkMetaFiles` returns one entry with path `local.cfg`, restored; `checkMetaInert` returns `[]`.
- B7: `git config include.path <tmpOutside>/later.cfg` (forward slashes) where the file does not exist (tmpOutside = a separate mkdtemp folder). Baseline. Create `later.cfg` with `[core]\n\tfsmonitor = x\n`. `checkMetaFiles` returns `[]`; `checkMetaInert` returns exactly one `config-effective` entry, restorable false; `later.cfg` still exists.
- B8: append a line to `.git/info/exclude` -> entry `modified`, restored; create `.git/info/attributes` (absent at baseline; remove it before the baseline if it exists) -> entry `added`, the file is deleted, restored true.
- B9: create branch `b9` and tag `t9` with the plain helper -> `checkMetaInert` entries for `refs/heads/b9` and `refs/tags/t9` (`added`, restorable false); both refs still exist. A fresh baseline, then `git update-ref refs/remotes/origin/main HEAD` -> `[]`. A fresh baseline, then `git pack-refs --all` -> `[]`.
- B10: (a) a 3 MB hook file -> `metaBaseline` throws with `code === 'ZC_GIT_META'`; (b) a symlink in the hooks dir (`symlinkSync(<an existing file>, <hooks>/link)`; skip only that part, with the error message, if creation throws) -> throws `ZC_GIT_META`; (c) `checkOrigins([{ scope: 'local', origin: 'blob:abc', key: 'a.b', value: 'c' }])` throws `ZC_GIT_META`; (d) `parseConfigList('a\0b\0')` throws `ZC_GIT_META`; (e) POSIX non-root only (skip on win32 or when `process.getuid?.() === 0`): baseline, then `chmodSync(hooksDir, 0)`; `checkMetaFiles` returns an `unreadable` entry, restorable false, and does not throw; restore the mode in `finally`.

Read first: src/gitmeta.mjs, src/gitx.mjs, test/gitmeta.test.mjs (A1-A9 for style), test/helpers.mjs, the spec sections named above. Do not explore anything else.

Do not: change src/dispatch.mjs, src/gitx.mjs, any other src file, existing tests or their assertions, fixtures, package.json, docs, the spec, or any .zc file. No new dependencies. Match style (ESM, 2-space, single quotes, node: imports).

Done when: B1-B10 exist and pass (or skip with the stated reasons on this platform), A1-A9 unchanged and passing, every existing test passes, `npm test` and `npm run check` pass.

If blocked: report the contradiction with file and line evidence; do not guess or widen scope.

Verification: the manager (zc) runs `npm test` and `npm run check`; the worker cannot run commands.
