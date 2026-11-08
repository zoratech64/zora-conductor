import { createHash } from 'node:crypto';
import {
  copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_COPY_BYTES = 2 * 1024 * 1024; // per file kept for restore
const MAX_COPY_TOTAL = 32 * 1024 * 1024;

/**
 * Exact state of one path: `missing`, `dir`, `other`, `link:<target>` or `file:<sha256>:<size>`.
 * Two states are equal only if the bytes are equal, so a changed file is never mistaken for an untouched one.
 */
export function fingerprint(root, rel) {
  const full = resolve(root, rel);
  let st;
  try {
    st = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (st.isSymbolicLink()) return `link:${readlinkSync(full)}`;
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return `file:${createHash('sha256').update(readFileSync(full)).digest('hex')}:${st.size}`;
  return 'other';
}

export const captureState = (root, paths) => Object.fromEntries([...new Set(paths)].sort().map((p) => [p, fingerprint(root, p)]));

export function sameState(a, b) {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export const describeState = (fp) => (fp === 'missing' ? 'absent' : fp.startsWith('file:') ? 'a file' : fp.startsWith('link:') ? 'a symlink' : fp);

/** Only "it is not there" counts as missing; permission and other errors must stop the caller. */
const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** What `.zc` itself is: missing, dir, link or file. */
const rootKind = (root) => {
  const st = (() => {
    try { return lstatSync(resolve(root, '.zc')); } catch (error) { if (isMissing(error)) return null; throw error; }
  })();
  return !st ? 'missing' : st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
};

/** Every file, directory and symlink under <root>/.zc, as forward-slash paths. */
function walkZc(root) {
  const out = { files: {}, dirs: new Set() };
  const visit = (rel) => {
    let names;
    try { names = readdirSync(resolve(root, rel)); } catch (error) { if (isMissing(error)) return; throw error; }
    for (const name of names) {
      const child = `${rel}/${name}`;
      let st;
      try { st = lstatSync(resolve(root, child)); } catch (error) { if (isMissing(error)) continue; throw error; }
      if (st.isDirectory()) { out.dirs.add(child); visit(child); } else out.files[child] = fingerprint(root, child);
    }
  };
  visit('.zc');
  return out;
}

/**
 * The project's own `.zc/` folder (config, tasks, notes) is never writable by a worker. Take an exact
 * copy before the worker starts so any change can be detected and undone afterwards. `uncopied` lists
 * files too big (or not regular files) to keep a copy of; the caller must not start a worker while it is non-empty.
 */
export function snapshotZc(root, copyDir) {
  const walked = walkZc(root);
  let total = 0;
  const copied = new Set();
  for (const rel of Object.keys(walked.files)) {
    if (!walked.files[rel].startsWith('file:')) continue;
    const size = Number(walked.files[rel].split(':')[2]);
    if (size > MAX_COPY_BYTES || total + size > MAX_COPY_TOTAL) continue;
    const target = join(copyDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, rel), target);
    copied.add(rel);
    total += size;
  }
  const uncopied = Object.keys(walked.files).filter((rel) => !copied.has(rel));
  const kind = rootKind(root);
  if (kind === 'link' || kind === 'file') uncopied.push(`.zc (a ${kind}, not a folder)`);
  return { files: walked.files, dirs: [...walked.dirs], copied: [...copied], uncopied, rootKind: kind, copyDir };
}

/**
 * Compare `.zc/` with the snapshot and put it back. A worker's version of a changed file is saved to
 * `saveDir` first, so nothing is lost even if the change was really a manual edit made during the run.
 * Returns one entry per difference: { path, change: modified|added|removed, restored }.
 */
export function restoreZc(root, snap, { saveDir }) {
  const copied = new Set(snap.copied);
  const violations = [];
  // The .zc folder itself: deleted, created, or swapped for something that is not a folder.
  const before = snap.rootKind ?? 'dir';
  const after = rootKind(root);
  const rootEntry = { path: '.zc', kind: 'root', change: before === 'missing' ? 'added' : after === 'missing' ? 'removed' : 'replaced', restored: false };
  const rootChanged = after !== before && !(before === 'missing' && after === 'missing');
  if (rootChanged && before === 'dir') {
    try {
      if (after !== 'missing') rmSync(resolve(root, '.zc'), { force: true, recursive: true });
      mkdirSync(resolve(root, '.zc'), { recursive: true });
      rootEntry.restored = rootKind(root) === 'dir';
    } catch { /* reported as not restored */ }
    violations.push(rootEntry);
  }
  const now = walkZc(root);
  const paths = [...new Set([...Object.keys(snap.files), ...Object.keys(now.files)])].sort();
  for (const rel of paths) {
    const before = snap.files[rel] ?? 'missing';
    const after = now.files[rel] ?? 'missing';
    if (before === after) continue;
    const change = before === 'missing' ? 'added' : after === 'missing' ? 'removed' : 'modified';
    const entry = { path: rel, change, restored: false };
    if (after.startsWith('file:')) {
      try {
        const keep = join(saveDir, rel);
        mkdirSync(dirname(keep), { recursive: true });
        copyFileSync(resolve(root, rel), keep);
      } catch { /* best effort */ }
    }
    try {
      if (before === 'missing') {
        rmSync(resolve(root, rel), { force: true, recursive: true });
        entry.restored = true;
      } else if (copied.has(rel)) {
        rmSync(resolve(root, rel), { force: true, recursive: true });
        mkdirSync(dirname(resolve(root, rel)), { recursive: true });
        copyFileSync(join(snap.copyDir, rel), resolve(root, rel));
        entry.restored = fingerprint(root, rel) === before;
      }
    } catch { /* reported as not restored */ }
    violations.push(entry);
  }
  // directories: recreate ones the worker deleted, remove (and report) ones it created
  const knownDirs = new Set(snap.dirs);
  for (const dir of [...snap.dirs].sort()) {
    if (now.dirs.has(dir)) continue;
    const entry = { path: dir, change: 'removed', kind: 'dir', restored: false };
    try {
      mkdirSync(resolve(root, dir), { recursive: true });
      entry.restored = true;
    } catch { /* reported as not restored */ }
    violations.push(entry);
  }
  for (const dir of [...now.dirs].sort().reverse()) {
    if (knownDirs.has(dir)) continue;
    const entry = { path: dir, change: 'added', kind: 'dir', restored: false };
    try {
      rmdirSync(resolve(root, dir));
      entry.restored = true;
    } catch { /* not empty: a file in it is reported separately */ }
    violations.push(entry);
  }
  if (before === 'missing' && rootKind(root) !== 'missing') {
    try {
      rmSync(resolve(root, '.zc'), { recursive: true, force: true });
      rootEntry.restored = true;
    } catch { /* reported as not restored */ }
    violations.push(rootEntry);
  }
  return violations;
}
