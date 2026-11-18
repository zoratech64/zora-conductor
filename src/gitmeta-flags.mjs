import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as G from './gitx.mjs';
import { fingerprint } from './snapshot.mjs';
import { GitMetaError, evidencePath, hasSymlinkBelow, overwriteBytes } from './gitmeta-fs.mjs';

// Index flags hide edits from `git status`: assume-unchanged (lowercase `ls-files -v` tag) and
// skip-worktree (tag `S`, or `s` together with assume-unchanged). See spec 11.4.

const CHUNK = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KINDS = [
  ['assume', '--no-assume-unchanged', '--assume-unchanged', 'assume-unchanged'],
  ['skip', '--no-skip-worktree', '--skip-worktree', 'skip-worktree']
];

/** Parse `ls-files -v -z` into { assume: Set, skip: Set }. Throws GitMetaError on any record it cannot read. */
export function parseFlags(stdout) {
  const assume = new Set();
  const skip = new Set();
  for (const record of String(stdout ?? '').split('\0')) {
    if (!record) continue;
    const m = /^([A-Za-z?]) (.+)$/s.exec(record);
    if (!m) throw new GitMetaError(`cannot parse ls-files -v output: ${JSON.stringify(record.slice(0, 80))}`);
    const [, tag, path] = m;
    if (tag >= 'a' && tag <= 'z') assume.add(path);
    if (tag === 'S' || tag === 's') skip.add(path);
  }
  return { assume, skip };
}

const readFlags = (root) =>
  parseFlags(G.git(root, ['ls-files', '-v', '-z'], { timeoutMs: G.inertTimeoutMs() }));

/**
 * Baseline: the flagged paths, and for each a content fingerprint plus a copy of the bytes.
 * Throws GitMetaError (before any worker starts) when the output is unreadable or a flagged file is over a cap.
 */
export function flagsBaseline(root, { maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = 8 * 1024 * 1024 } = {}) {
  const { assume, skip } = readFlags(root);
  const paths = [...new Set([...assume, ...skip])].sort();
  const files = [];
  let total = 0;
  for (const path of paths) {
    const st = lstatSync(resolve(root, path), { throwIfNoEntry: false });
    if (st?.isFile() && st.size > maxFileBytes) throw new GitMetaError(`flagged file exceeds maxFileBytes: ${path}`);
    const fp = fingerprint(root, path);
    let bytes = null;
    if (fp.startsWith('file:')) {
      const full = resolve(root, path);
      if (lstatSync(full).size > maxFileBytes) throw new GitMetaError(`flagged file exceeds maxFileBytes: ${path}`);
      bytes = readFileSync(full);
      total += bytes.length;
      if (total > maxTotalBytes) throw new GitMetaError(`flagged files exceed maxTotalBytes (${total} > ${maxTotalBytes})`);
    }
    files.push({ path, fingerprint: fp, bytes });
  }
  return { assume: [...assume].sort(), skip: [...skip].sort(), files };
}

const entry = (path, change, restorable, detail) => ({
  area: 'index-flags', path, change, restorable, restored: false, detail
});

/** Run one repair for a group of entries, then mark each restored if a re-read of the flags agrees. */
function repair(root, entries, option, wantSet, kind) {
  if (!entries.length) return;
  try {
    const paths = entries.map((e) => e.path);
    for (let i = 0; i < paths.length; i += CHUNK) {
      G.git(root, ['update-index', option, '--', ...paths.slice(i, i + CHUNK)], { timeoutMs: G.inertTimeoutMs() });
    }
  } catch (err) {
    for (const e of entries) e.detail = `${e.detail}; repair failed: ${err.message}`;
    return;
  }
  const now = readFlags(root)[kind];
  for (const e of entries) e.restored = wantSet ? now.has(e.path) : !now.has(e.path);
}

function restoreContent(root, file, e, saveDir) {
  const full = resolve(root, file.path);
  if (hasSymlinkBelow(root, full)) {
    e.restorable = false;
    e.detail += '; path crosses a symlink';
    return;
  }
  try {
    if (saveDir && lstatSync(full).isFile()) {
      const dest = evidencePath(saveDir, root, full);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(full));
    }
    overwriteBytes(full, file.bytes);
    e.restored = fingerprint(root, file.path) === file.fingerprint;
  } catch (err) {
    e.detail += `; ${err.message}`;
  }
}

/**
 * Compare the current flags and flagged-file content with the baseline, repairing what is safe to repair:
 * flags added outside the baseline are cleared, baseline flags that vanished are set again, and changed
 * content of a baseline-flagged file is restored from the copy (the changed version goes to saveDir first).
 * Returns entries { area: 'index-flags', path, change, restorable, restored, detail }; [] means unchanged.
 */
export function checkFlags(root, baseline, { saveDir } = {}) {
  const unreadable = (err) => [entry('.git/index', 'unreadable', false, err?.message ?? String(err))];
  const out = [];
  try {
    const current = readFlags(root);
    for (const [kind, noOpt, setOpt, label] of KINDS) {
      const base = new Set(baseline[kind]);
      const added = [...current[kind]].filter((p) => !base.has(p)).sort()
        .map((p) => entry(p, 'flag-added', true, `${label} was set during the phase`));
      const removed = [...base].filter((p) => !current[kind].has(p)).sort()
        .map((p) => entry(p, 'flag-removed', true, `${label} was cleared during the phase`));
      repair(root, added, noOpt, false, kind);
      repair(root, removed, setOpt, true, kind);
      out.push(...added, ...removed);
    }
  } catch (err) {
    return out.concat(unreadable(err));
  }

  for (const file of baseline.files) {
    let fp;
    try {
      // fingerprint() reads the whole file: never do that for one that grew past the baseline cap
      const st = lstatSync(resolve(root, file.path), { throwIfNoEntry: false });
      if (st?.isFile() && st.size > MAX_FILE_BYTES) {
        out.push(entry(file.path, 'modified', false, `flagged file now exceeds ${MAX_FILE_BYTES} bytes; not read or restored`));
        continue;
      }
      fp = fingerprint(root, file.path);
    } catch (err) {
      out.push(entry(file.path, 'unreadable', false, err.message));
      continue;
    }
    if (fp === file.fingerprint) continue;
    const e = entry(file.path, 'modified', file.bytes !== null, 'content of a flagged file changed during the phase');
    out.push(e);
    if (file.bytes === null) e.detail += '; no baseline copy to restore';
    else restoreContent(root, file, e, saveDir);
  }
  return out;
}
