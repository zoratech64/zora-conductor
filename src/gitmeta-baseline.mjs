import {
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as G from './gitx.mjs';
import { GitMetaError, isPrivate, samePath } from './gitmeta-fs.mjs';

function resolveHooksDir(rows, layout) {
  let hookVal = null;
  for (const row of rows) {
    if (row.scope !== 'command' && typeof row.key === 'string' && row.key.toLowerCase() === 'core.hookspath') {
      hookVal = row.value;
    }
  }
  if (hookVal === null || hookVal === undefined) {
    return join(layout.commonDir, 'hooks');
  }
  let p = hookVal;
  if (p === '~') {
    p = homedir();
  } else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homedir(), p.slice(2));
  }
  return resolve(layout.workTree, p);
}

export function parseConfigList(stdout) {
  if (typeof stdout !== 'string') {
    throw new GitMetaError('config list stdout must be a string');
  }
  const parts = stdout.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  if (parts.length % 3 !== 0) {
    throw new GitMetaError(`invalid config listing: length ${parts.length} is not a multiple of 3`);
  }
  const rows = [];
  for (let i = 0; i < parts.length; i += 3) {
    const scope = parts[i];
    const origin = parts[i + 1];
    const keyValue = parts[i + 2];
    const nlIdx = keyValue.indexOf('\n');
    let key;
    let value;
    if (nlIdx === -1) {
      key = keyValue;
      value = null;
    } else {
      key = keyValue.slice(0, nlIdx);
      value = keyValue.slice(nlIdx + 1);
    }
    rows.push({ scope, origin, key, value });
  }
  return rows;
}

export function effectiveConfigText(rows) {
  return rows
    .filter((r) => r.scope === 'local' || r.scope === 'worktree')
    .map((r) => `${r.scope}\t${r.origin}\t${r.key}\t${r.value === null ? '' : r.value}`)
    .join('\n');
}

export function checkOrigins(rows, root = process.cwd()) {
  const distinct = [];
  for (const row of rows) {
    if (row.scope === 'local' || row.scope === 'worktree') {
      if (!row.origin || typeof row.origin !== 'string' || !row.origin.startsWith('file:')) {
        throw new GitMetaError(`origin must start with file:, got "${row.origin}"`);
      }
      const rawPath = row.origin.slice('file:'.length);
      const abs = resolve(root, rawPath);
      if (!distinct.some((p) => samePath(p, abs))) {
        distinct.push(abs);
      }
    }
  }
  return distinct;
}

export function refsListing(root) {
  const out = G.git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)'], {
    timeoutMs: G.inertTimeoutMs()
  });
  const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
  const map = new Map();
  for (const line of lines) {
    const parts = line.split('\0');
    if (parts.length !== 2) {
      throw new GitMetaError(`invalid ref line in for-each-ref: ${line}`);
    }
    const [refname, objectname] = parts;
    if (refname.startsWith('refs/remotes/')) {
      continue;
    }
    map.set(refname, objectname);
  }
  return map;
}

export function metaBaseline(root, layout, opts = {}) {
  const { maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 8 * 1024 * 1024 } = opts;

  const configOut = G.configList(root);
  const configRows = parseConfigList(configOut);
  const hooksDir = resolveHooksDir(configRows, layout);

  const revParseOut = G.git(root, [
    'rev-parse',
    '--git-path', 'config',
    '--git-path', 'config.worktree',
    '--git-path', 'info/exclude',
    '--git-path', 'info/attributes',
    '--git-path', 'info/sparse-checkout',
    '--git-path', 'info/grafts',
    '--git-path', 'shallow',
    '--git-path', 'objects/info/alternates'
  ], { timeoutMs: G.inertTimeoutMs() });

  const lines = revParseOut.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 8) {
    throw new GitMetaError(`expected exactly 8 paths from rev-parse, got ${lines.length}`);
  }
  const [
    cfgPath,
    cfgWorktreePath,
    infoExcludePath,
    infoAttributesPath,
    infoSparseCheckoutPath,
    infoGraftsPath,
    shallowPath,
    objectsAlternatesPath
  ] = lines.map((l) => resolve(root, l));

  const paths = {
    hooksDir,
    config: cfgPath,
    configWorktree: cfgWorktreePath,
    infoExclude: infoExcludePath,
    infoAttributes: infoAttributesPath,
    infoSparseCheckout: infoSparseCheckoutPath,
    infoGrafts: infoGraftsPath,
    shallow: shallowPath,
    objectsInfoAlternates: objectsAlternatesPath
  };

  let totalBytes = 0;
  let hooksExists = false;
  let hooksStat = null;
  const hooksEntries = new Map();

  try {
    hooksStat = lstatSync(hooksDir);
    hooksExists = true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      hooksExists = false;
    } else {
      throw new GitMetaError(`cannot stat hooks directory "${hooksDir}": ${err.message}`);
    }
  }

  if (hooksExists) {
    if (hooksStat.isSymbolicLink()) {
      throw new GitMetaError(`hooks directory is a symlink: ${hooksDir}`);
    }
    if (!hooksStat.isDirectory()) {
      throw new GitMetaError(`hooks directory is not a directory: ${hooksDir}`);
    }

    function walkHooks(dirPath, relPrefix = '') {
      let entries;
      try {
        entries = readdirSync(dirPath);
      } catch (err) {
        throw new GitMetaError(`cannot read hooks directory "${dirPath}": ${err.message}`);
      }
      for (const name of entries) {
        const full = join(dirPath, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        let st;
        try {
          st = lstatSync(full);
        } catch (err) {
          throw new GitMetaError(`cannot stat hook "${full}": ${err.message}`);
        }
        if (st.isSymbolicLink()) {
          throw new GitMetaError(`symlink not allowed in hooks: ${full}`);
        }
        if (st.isDirectory()) {
          hooksEntries.set(rel, { kind: 'dir' });
          walkHooks(full, rel);
        } else if (st.isFile()) {
          if (st.size > maxFileBytes) {
            throw new GitMetaError(`hook file exceeds maxFileBytes: ${full}`);
          }
          let bytes;
          try {
            bytes = readFileSync(full);
          } catch (err) {
            throw new GitMetaError(`cannot read hook file "${full}": ${err.message}`);
          }
          if (bytes.length > maxFileBytes) {
            throw new GitMetaError(`hook file exceeds maxFileBytes: ${full}`);
          }
          totalBytes += bytes.length;
          if (totalBytes > maxTotalBytes) {
            throw new GitMetaError(`total copied bytes exceeds maxTotalBytes (${totalBytes} > ${maxTotalBytes})`);
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          hooksEntries.set(rel, {
            kind: 'file',
            size: bytes.length,
            sha256,
            mode: st.mode & 0o111,
            rawMode: st.mode & 0o777,
            bytes
          });
        } else {
          throw new GitMetaError(`hook entry is neither file nor directory: ${full}`);
        }
      }
    }

    walkHooks(hooksDir);
  }

  const originPaths = checkOrigins(configRows, root);
  const targetSpecs = [
    { area: 'config', path: cfgPath },
    { area: 'config', path: cfgWorktreePath }
  ];
  for (const op of originPaths) {
    if (!targetSpecs.some((s) => samePath(s.path, op))) {
      targetSpecs.push({ area: 'config', path: op });
    }
  }
  const infoPaths = [
    infoExcludePath,
    infoAttributesPath,
    infoSparseCheckoutPath,
    infoGraftsPath,
    shallowPath,
    objectsAlternatesPath
  ];
  for (const ip of infoPaths) {
    targetSpecs.push({ area: 'info', path: ip });
  }

  const files = [];
  for (const spec of targetSpecs) {
    let bytes = null;
    let exists = true;
    let st = null;
    try {
      st = lstatSync(spec.path);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        exists = false;
      } else {
        throw new GitMetaError(`cannot stat protected file "${spec.path}": ${err.message}`);
      }
    }
    if (exists) {
      if (st.isSymbolicLink()) {
        throw new GitMetaError(`protected file is a symlink: ${spec.path}`);
      }
      if (!st.isFile()) {
        throw new GitMetaError(`protected file is not a regular file: ${spec.path}`);
      }
      if (st.size > maxFileBytes) {
        throw new GitMetaError(`protected file exceeds maxFileBytes: ${spec.path}`);
      }
      try {
        bytes = readFileSync(spec.path);
      } catch (err) {
        throw new GitMetaError(`cannot read protected file "${spec.path}": ${err.message}`);
      }
      if (bytes.length > maxFileBytes) {
        throw new GitMetaError(`protected file exceeds maxFileBytes: ${spec.path}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) {
        throw new GitMetaError(`total copied bytes exceeds maxTotalBytes (${totalBytes} > ${maxTotalBytes})`);
      }
    }
    files.push({
      area: spec.area,
      path: spec.path,
      private: isPrivate(layout, spec.path),
      bytes
    });
  }

  const effective = effectiveConfigText(configRows);
  const refs = refsListing(root);

  return {
    paths,
    hooks: {
      dir: hooksDir,
      private: isPrivate(layout, hooksDir),
      exists: hooksExists,
      entries: hooksEntries
    },
    files,
    effective,
    refs
  };
}
