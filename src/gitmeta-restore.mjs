import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { evidencePath, hasSymlinkBelow, layoutRootFor, overwriteBytes } from './gitmeta-fs.mjs';
import { toReportPath } from './gitmeta-layout.mjs';

export function checkMetaFiles(root, layout, baseline, { saveDir } = {}) {
  const entries = [];

  try {
    const hooksDir = baseline.hooks.dir;
    const hooksPrivate = baseline.hooks.private;
    const hooksRoot = layoutRootFor(layout, resolve(hooksDir));

    let currentHooksStat = null;
    let currentHooksExists = false;
    let hooksDirUnreadable = false;

    try {
      currentHooksStat = lstatSync(hooksDir);
      currentHooksExists = true;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        currentHooksExists = false;
      } else {
        hooksDirUnreadable = true;
        entries.push({
          area: 'hooks',
          path: toReportPath(root, hooksDir),
          change: 'unreadable',
          restorable: false,
          restored: false,
          detail: err.message
        });
      }
    }

    if (!hooksDirUnreadable) {
      if (!baseline.hooks.exists && currentHooksExists) {
        if (currentHooksStat.isSymbolicLink() || !currentHooksStat.isDirectory()) {
          entries.push({
            area: 'hooks',
            path: toReportPath(root, hooksDir),
            change: 'added',
            restorable: false,
            restored: false,
            detail: currentHooksStat.isSymbolicLink()
              ? `path crosses a symlink: ${hooksDir}`
              : `hooks directory is not a directory: ${hooksDir}`
          });
        } else {
          const foundItems = [];
          let walkError = null;

          function collectAdded(dirPath, relPrefix = '') {
            let names;
            try {
              names = readdirSync(dirPath);
            } catch (err) {
              walkError = err;
              return;
            }
            for (const name of names) {
              const full = join(dirPath, name);
              const rel = relPrefix ? `${relPrefix}/${name}` : name;
              let st;
              try {
                st = lstatSync(full);
              } catch (err) {
                foundItems.push({ full, rel, unreadable: true, detail: err.message });
                continue;
              }
              if (st.isDirectory()) {
                foundItems.push({ full, rel, isDir: true, isFile: false });
                collectAdded(full, rel);
              } else if (st.isFile()) {
                foundItems.push({ full, rel, isDir: false, isFile: true });
              } else {
                foundItems.push({ full, rel, isDir: false, isFile: false, isOther: true });
              }
            }
          }

          collectAdded(hooksDir);

          if (walkError) {
            entries.push({
              area: 'hooks',
              path: toReportPath(root, hooksDir),
              change: 'unreadable',
              restorable: false,
              restored: false,
              detail: walkError.message
            });
          } else {
            const files = foundItems.filter((i) => i.isFile);
            const dirs = foundItems.filter((i) => i.isDir).sort((a, b) => b.rel.length - a.rel.length);
            const others = foundItems.filter((i) => !i.isFile && !i.isDir);

            for (const item of files) {
              let restorable = hooksPrivate && !item.unreadable && !item.isOther;
              let restored = false;
              let detail = item.detail ?? null;

              if (hasSymlinkBelow(hooksRoot, item.full, layout)) {
                restorable = false;
                restored = false;
                detail = `path crosses a symlink: ${item.full}`;
              } else if (hooksPrivate) {
                if (saveDir) {
                  try {
                    const dest = evidencePath(saveDir, root, item.full);
                    mkdirSync(dirname(dest), { recursive: true });
                    copyFileSync(item.full, dest);
                  } catch (err) {
                    restorable = false;
                    detail = `failed to save evidence: ${err.message}`;
                  }
                }
                if (restorable) {
                  try {
                    rmSync(item.full, { force: true });
                    restored = !existsSync(item.full);
                  } catch (err) {
                    restorable = false;
                    restored = false;
                    detail = `failed to delete added hook: ${err.message}`;
                  }
                }
              }

              entries.push({
                area: 'hooks',
                path: toReportPath(root, item.full),
                change: item.unreadable ? 'unreadable' : 'added',
                restorable,
                restored,
                detail
              });
            }

            for (const item of others) {
              entries.push({
                area: 'hooks',
                path: toReportPath(root, item.full),
                change: item.unreadable ? 'unreadable' : 'added',
                restorable: false,
                restored: false,
                detail: item.detail ?? null
              });
            }

            for (const d of dirs) {
              let restorable = hooksPrivate && !d.unreadable && !d.isOther;
              let restored = false;
              let detail = d.detail ?? null;

              if (hasSymlinkBelow(hooksRoot, d.full, layout)) {
                restorable = false;
                restored = false;
                detail = `path crosses a symlink: ${d.full}`;
              } else if (hooksPrivate) {
                try {
                  rmdirSync(d.full);
                  restored = !existsSync(d.full);
                } catch (err) {
                  restorable = false;
                  restored = false;
                  detail = `failed to remove directory: ${err.message}`;
                }
              }

              entries.push({
                area: 'hooks',
                path: toReportPath(root, d.full),
                change: d.unreadable ? 'unreadable' : 'added',
                restorable,
                restored,
                detail
              });
            }

            let hooksRestorable = hooksPrivate;
            let hooksRestored = false;
            let hooksDetail = null;

            if (hasSymlinkBelow(hooksRoot, hooksDir, layout)) {
              hooksRestorable = false;
              hooksRestored = false;
              hooksDetail = `path crosses a symlink: ${hooksDir}`;
            } else if (hooksPrivate) {
              try {
                rmdirSync(hooksDir);
                hooksRestored = !existsSync(hooksDir);
              } catch (err) {
                hooksRestorable = false;
                hooksRestored = false;
                hooksDetail = `failed to remove hooks directory: ${err.message}`;
              }
            }

            entries.push({
              area: 'hooks',
              path: toReportPath(root, hooksDir),
              change: 'added',
              restorable: hooksRestorable,
              restored: hooksRestored,
              detail: hooksDetail
            });
          }
        }
      } else if (baseline.hooks.exists && !currentHooksExists) {
        for (const [rel, base] of baseline.hooks.entries) {
          const full = join(hooksDir, rel);
          let restorable = hooksPrivate;
          let restored = false;
          let detail = null;

          if (hasSymlinkBelow(hooksRoot, full, layout)) {
            restorable = false;
            restored = false;
            detail = `path crosses a symlink: ${full}`;
          } else if (hooksPrivate) {
            try {
              if (base.kind === 'dir') {
                mkdirSync(full, { recursive: true });
                restored = existsSync(full) && lstatSync(full).isDirectory();
              } else if (base.kind === 'file') {
                mkdirSync(dirname(full), { recursive: true });
                writeFileSync(full, base.bytes);
                if (process.platform !== 'win32') {
                  const targetMode = base.rawMode ?? (0o644 | base.mode);
                  chmodSync(full, targetMode);
                }
                const reRead = readFileSync(full);
                const matchBytes = Buffer.compare(reRead, base.bytes) === 0;
                const matchMode = process.platform === 'win32' || (lstatSync(full).mode & 0o111) === base.mode;
                restored = matchBytes && matchMode;
              }
            } catch (err) {
              restorable = false;
              restored = false;
              detail = `failed to restore hook: ${err.message}`;
            }
          }

          entries.push({
            area: 'hooks',
            path: toReportPath(root, full),
            change: 'removed',
            restorable,
            restored,
            detail
          });
        }
      } else if (baseline.hooks.exists && currentHooksExists) {
        if (currentHooksStat.isSymbolicLink() || !currentHooksStat.isDirectory()) {
          entries.push({
            area: 'hooks',
            path: toReportPath(root, hooksDir),
            change: 'modified',
            restorable: false,
            restored: false,
            detail: 'hooks directory is no longer a directory'
          });
        } else {
          const currentMap = new Map();
          let walkError = null;

          function walkCurrentHooks(dirPath, relPrefix = '') {
            let names;
            try {
              names = readdirSync(dirPath);
            } catch (err) {
              walkError = err;
              return;
            }
            for (const name of names) {
              const full = join(dirPath, name);
              const rel = relPrefix ? `${relPrefix}/${name}` : name;
              let st;
              try {
                st = lstatSync(full);
              } catch (err) {
                currentMap.set(rel, { full, unreadable: true, detail: err.message });
                continue;
              }
              if (st.isSymbolicLink()) {
                currentMap.set(rel, { full, kind: 'symlink' });
              } else if (st.isDirectory()) {
                currentMap.set(rel, { full, kind: 'dir' });
                walkCurrentHooks(full, rel);
              } else if (st.isFile()) {
                let bytes;
                try {
                  bytes = readFileSync(full);
                } catch (err) {
                  currentMap.set(rel, { full, unreadable: true, detail: err.message });
                  continue;
                }
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                currentMap.set(rel, {
                  full,
                  kind: 'file',
                  size: bytes.length,
                  sha256,
                  mode: st.mode & 0o111,
                  rawMode: st.mode & 0o777,
                  bytes
                });
              } else {
                currentMap.set(rel, { full, kind: 'other' });
              }
            }
          }

          walkCurrentHooks(hooksDir);

          if (walkError) {
            entries.push({
              area: 'hooks',
              path: toReportPath(root, hooksDir),
              change: 'unreadable',
              restorable: false,
              restored: false,
              detail: walkError.message
            });
          } else {
            for (const [rel, cur] of currentMap) {
              const full = cur.full;
              const inBaseline = baseline.hooks.entries.has(rel);
              let change = null;
              let restorable = hooksPrivate;
              let restored = false;
              let detail = cur.detail ?? null;

              if (cur.unreadable) {
                change = 'unreadable';
                restorable = false;
              } else if (!inBaseline) {
                change = 'added';
                if (cur.kind !== 'file' && cur.kind !== 'dir') {
                  restorable = false;
                }
              } else {
                const base = baseline.hooks.entries.get(rel);
                if (cur.kind === 'symlink' || cur.kind === 'other') {
                  change = 'modified';
                  restorable = false;
                } else if (base.kind === 'dir') {
                  if (cur.kind !== 'dir') {
                    change = 'modified';
                    restorable = false;
                  }
                } else if (base.kind === 'file') {
                  if (cur.kind !== 'file') {
                    change = 'modified';
                    restorable = false;
                  } else if (cur.size !== base.size || cur.sha256 !== base.sha256) {
                    change = 'modified';
                  } else if (process.platform !== 'win32' && cur.mode !== base.mode) {
                    change = 'mode';
                  }
                }
              }

              if (change !== null) {
                if (hasSymlinkBelow(hooksRoot, full, layout)) {
                  restorable = false;
                  restored = false;
                  detail = `path crosses a symlink: ${full}`;
                } else if (restorable) {
                  if (cur.kind === 'file' && (change === 'modified' || change === 'mode' || change === 'added')) {
                    if (saveDir) {
                      try {
                        const dest = evidencePath(saveDir, root, full);
                        mkdirSync(dirname(dest), { recursive: true });
                        copyFileSync(full, dest);
                      } catch (err) {
                        restorable = false;
                        detail = `failed to save evidence: ${err.message}`;
                      }
                    }
                  }
                  if (restorable) {
                    try {
                      if (change === 'added') {
                        if (cur.kind === 'file') {
                          rmSync(full, { force: true });
                          restored = !existsSync(full);
                        }
                      } else if (change === 'modified' || change === 'mode') {
                        const base = baseline.hooks.entries.get(rel);
                        overwriteBytes(full, base.bytes);
                        if (process.platform !== 'win32') {
                          const targetMode = (cur.rawMode & ~0o111) | base.mode;
                          chmodSync(full, targetMode);
                        }
                        const reRead = readFileSync(full);
                        const matchBytes = Buffer.compare(reRead, base.bytes) === 0;
                        const matchMode = process.platform === 'win32' || (lstatSync(full).mode & 0o111) === base.mode;
                        restored = matchBytes && matchMode;
                      }
                    } catch (err) {
                      restorable = false;
                      restored = false;
                      detail = `failed to restore hook: ${err.message}`;
                    }
                  }
                }

                entries.push({
                  area: 'hooks',
                  path: toReportPath(root, full),
                  change,
                  restorable,
                  restored,
                  detail
                });
              }
            }

            for (const [rel, base] of baseline.hooks.entries) {
              if (!currentMap.has(rel)) {
                const full = join(hooksDir, rel);
                let restorable = hooksPrivate;
                let restored = false;
                let detail = null;

                if (hasSymlinkBelow(hooksRoot, full, layout)) {
                  restorable = false;
                  restored = false;
                  detail = `path crosses a symlink: ${full}`;
                } else if (hooksPrivate) {
                  try {
                    if (base.kind === 'dir') {
                      mkdirSync(full, { recursive: true });
                      restored = existsSync(full) && lstatSync(full).isDirectory();
                    } else if (base.kind === 'file') {
                      mkdirSync(dirname(full), { recursive: true });
                      writeFileSync(full, base.bytes);
                      if (process.platform !== 'win32') {
                        const targetMode = base.rawMode ?? (0o644 | base.mode);
                        chmodSync(full, targetMode);
                      }
                      const reRead = readFileSync(full);
                      const matchBytes = Buffer.compare(reRead, base.bytes) === 0;
                      const matchMode = process.platform === 'win32' || (lstatSync(full).mode & 0o111) === base.mode;
                      restored = matchBytes && matchMode;
                    }
                  } catch (err) {
                    restorable = false;
                    restored = false;
                    detail = `failed to restore removed hook: ${err.message}`;
                  }
                }

                entries.push({
                  area: 'hooks',
                  path: toReportPath(root, full),
                  change: 'removed',
                  restorable,
                  restored,
                  detail
                });
              }
            }

            if (hooksPrivate) {
              const addedDirs = entries
                .filter((e) => e.change === 'added' && currentMap.has(relative(hooksDir, isAbsolute(e.path) ? e.path : resolve(root, e.path)).split('\\').join('/')) && currentMap.get(relative(hooksDir, isAbsolute(e.path) ? e.path : resolve(root, e.path)).split('\\').join('/')).kind === 'dir')
                .sort((a, b) => b.path.length - a.path.length);
              for (const d of addedDirs) {
                const full = isAbsolute(d.path) ? d.path : resolve(root, d.path);
                if (hasSymlinkBelow(hooksRoot, full, layout)) {
                  d.restorable = false;
                  d.restored = false;
                  d.detail = `path crosses a symlink: ${full}`;
                  continue;
                }
                try {
                  rmdirSync(full);
                  d.restored = !existsSync(full);
                } catch (err) {
                  d.restorable = false;
                  d.restored = false;
                  d.detail = `failed to remove directory: ${err.message}`;
                }
              }
            }
          }
        }
      }
    }

    for (const file of baseline.files) {
      let st = null;
      let currentExists = false;
      try {
        st = lstatSync(file.path);
        currentExists = true;
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
          currentExists = false;
        } else {
          entries.push({
            area: file.area,
            path: toReportPath(root, file.path),
            change: 'unreadable',
            restorable: false,
            restored: false,
            detail: err.message
          });
          continue;
        }
      }

      let change = null;
      let restorable = file.private;
      let detail = null;
      let currentBytes = null;

      if (!currentExists) {
        if (file.bytes !== null) {
          change = 'removed';
        }
      } else {
        if (st.isSymbolicLink() || !st.isFile()) {
          change = 'modified';
          restorable = false;
          detail = st.isSymbolicLink() ? 'file is a symlink' : 'file is not a regular file';
        } else {
          try {
            currentBytes = readFileSync(file.path);
          } catch (err) {
            change = 'unreadable';
            restorable = false;
            detail = err.message;
          }
          if (change === null) {
            if (file.bytes === null) {
              change = 'added';
            } else if (Buffer.compare(currentBytes, file.bytes) !== 0) {
              change = 'modified';
            }
          }
        }
      }

      if (change !== null) {
        let restored = false;
        const fileRoot = layoutRootFor(layout, file.path);
        if (hasSymlinkBelow(fileRoot, file.path, layout)) {
          restorable = false;
          restored = false;
          detail = `path crosses a symlink: ${file.path}`;
        } else if (restorable) {
          if (currentExists && currentBytes !== null && (change === 'added' || change === 'modified')) {
            if (saveDir) {
              try {
                const dest = evidencePath(saveDir, root, file.path);
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(file.path, dest);
              } catch (err) {
                restorable = false;
                detail = `failed to save evidence: ${err.message}`;
              }
            }
          }
          if (restorable) {
            try {
              if (change === 'added') {
                rmSync(file.path, { force: true });
                restored = !existsSync(file.path);
              } else if (change === 'removed') {
                mkdirSync(dirname(file.path), { recursive: true });
                writeFileSync(file.path, file.bytes);
                restored = Buffer.compare(readFileSync(file.path), file.bytes) === 0;
              } else if (change === 'modified') {
                overwriteBytes(file.path, file.bytes);
                restored = Buffer.compare(readFileSync(file.path), file.bytes) === 0;
              }
            } catch (err) {
              restorable = false;
              restored = false;
              detail = `failed to restore file: ${err.message}`;
            }
          }
        }

        entries.push({
          area: file.area,
          path: toReportPath(root, file.path),
          change,
          restorable,
          restored,
          detail
        });
      }
    }

    console.error("ZCDBG", JSON.stringify(entries.filter((e)=>!e.restored))); return entries;
  } catch (err) {
    entries.push({
      area: 'git',
      path: '.git',
      change: 'unreadable',
      restorable: false,
      restored: false,
      detail: err?.message ?? String(err)
    });
    console.error("ZCDBG-catch", JSON.stringify(entries)); return entries;
  }
}
