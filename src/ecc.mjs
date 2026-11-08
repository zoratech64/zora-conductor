import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { acquireLock } from './fsx.mjs';
import { stateRoot } from './paths.mjs';
import { run as defaultRun } from './proc.mjs';

/** Rules shipped inside zora-conductor (common, dart, typescript). Always available, rules only. */
export const BUNDLED_ECC = resolve(import.meta.dirname, '..', 'vendor', 'ecc');
export const ECC_URL = 'https://github.com/affaan-m/ECC.git';
export const DEFAULT_ASSET_BYTES = 262_144;

export const KINDS = ['skill', 'agent', 'command', 'rule'];
const COPY_DIRS = ['skills', 'agents', 'commands', 'rules'];
const REQUIRED = ['skills', 'agents', 'commands'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCAN_ENTRIES = 100_000;

export const installedEccDir = () => join(stateRoot(), 'ecc');

// ---------------------------------------------------------------- markdown

const unescapeDouble = (s) => s.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));

/**
 * `---` front matter, then the body. Understands plain and quoted scalars, folded/literal block scalars
 * (`>`, `|`) and indented continuation lines. A flow collection or an unterminated quote in `name` or
 * `description`, and a front matter block that never closes, are reported in `errors`.
 */
export function parseMarkdown(text) {
  const source = text.replace(/^\uFEFF/, '');
  const start = /^---[ \t]*\r?\n/.exec(source);
  const errors = [];
  if (!start) return { meta: {}, body: source.trim(), errors };
  const lines = source.slice(start[0].length).split(/\r?\n/);
  const end = lines.findIndex((l) => /^---[ \t]*$/.test(l));
  if (end === -1) return { meta: {}, body: source.trim(), errors: ['front matter is not closed with ---'] };
  const body = lines.slice(end + 1).join('\n').trim();
  const meta = {};
  const block = lines.slice(0, end);
  for (let i = 0; i < block.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(block[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    const important = key === 'name' || key === 'description';
    const continuation = [];
    while (i + 1 < block.length && (/^[ \t]+\S/.test(block[i + 1]) || (block[i + 1].trim() === '' && /^[ \t]/.test(block[i + 2] ?? '')))) {
      continuation.push(block[++i]);
    }
    const value = raw.trim();
    const scalar = /^([>|])[+-]?\d*[ \t]*(?:#.*)?$/.exec(value);
    if (scalar) {
      const rows = continuation.map((l) => l.replace(/^[ \t]+/, ''));
      meta[key] = (scalar[1] === '>' ? rows.join(' ').replace(/ {2,}/g, ' ') : rows.join('\n')).trim();
    } else if (value === '') {
      meta[key] = '';
    } else if (/^["']/.test(value)) {
      const quote = value[0];
      let out = '';
      let j = 1;
      let closed = false;
      for (; j < value.length; j++) {
        if (quote === '"' && value[j] === '\\') { out += value[j] + (value[++j] ?? ''); continue; }
        if (quote === "'" && value[j] === "'" && value[j + 1] === "'") { out += "'"; j++; continue; }
        if (value[j] === quote) { closed = true; break; }
        out += value[j];
      }
      if (!closed && important) errors.push(`${key}: unterminated quote`);
      meta[key] = (quote === '"' ? unescapeDouble(out) : out).trim();
    } else if (/^[[{]/.test(value)) {
      if (important) errors.push(`${key}: a list or map is not supported here; write plain text`);
      meta[key] = value;
    } else {
      meta[key] = [value.replace(/\s+#.*$/, ''), ...continuation.map((l) => l.trim())].join(' ').trim();
    }
  }
  return { meta, body, errors };
}

// ---------------------------------------------------------------- catalog validation

const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

function readHead(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** Every entry under `dir` (not following symlinks); symlinks are reported, never descended into. */
function scan(root, top, out = { files: [], links: [], count: 0 }) {
  const stack = [top];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++out.count > MAX_SCAN_ENTRIES) throw new Error(`${root} has more than ${MAX_SCAN_ENTRIES} entries; this is not an ECC checkout`);
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) out.links.push(child);
      else if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) out.files.push(child);
    }
  }
  return out;
}

const isReal = (p, type) => { const st = lstatOrNull(p); return Boolean(st) && !st.isSymbolicLink() && (type === 'dir' ? st.isDirectory() : st.isFile()); };
const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const mdIn = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md').map((e) => e.name).sort();

/**
 * The one definition of "a usable ECC folder". skills/, agents/ and commands/ must be real directories
 * with real content; rules/ is optional. Symlinks anywhere in them are errors. With `deep`, every asset
 * is read: empty files and broken front matter are errors, a name that differs from its file is a warning.
 * Returns { ok, errors, warnings, counts }.
 */
export function validateCatalog(dir, { deep = false } = {}) {
  const errors = [];
  const warnings = [];
  const counts = { skills: 0, agents: 0, commands: 0, rules: 0 };
  const base = resolve(dir);
  let baseOk = false;
  try { baseOk = statSync(base).isDirectory(); } catch { /* reported below */ }
  if (!baseOk) {
    return { ok: false, errors: [`${base} is not a folder`], warnings, counts };
  }
  const assets = []; // [rel, expectedName | null]
  for (const name of [...REQUIRED, 'rules']) {
    const p = join(base, name);
    const st = lstatOrNull(p);
    if (!st) { if (REQUIRED.includes(name)) errors.push(`${name}/ is missing`); continue; }
    if (st.isSymbolicLink()) { errors.push(`${name}/ is a symlink; zc only accepts real folders`); continue; }
    if (!st.isDirectory()) { errors.push(`${name} must be a folder`); continue; }
    const found = scan(base, name);
    for (const link of found.links) errors.push(`${link} is a symlink; zc only accepts real files`);
    if (name === 'skills') {
      for (const skill of subdirs(p)) {
        const file = `skills/${skill}/SKILL.md`;
        if (isReal(join(base, file), 'file')) { counts.skills++; assets.push([file, skill]); } else warnings.push(`skills/${skill}/ has no SKILL.md and is ignored`);
      }
    } else if (name === 'agents' || name === 'commands') {
      for (const f of mdIn(p)) { counts[name]++; assets.push([`${name}/${f}`, name === 'agents' ? f.replace(/\.md$/, '') : null]); }
    } else {
      for (const pack of subdirs(p)) for (const f of mdIn(join(p, pack))) { counts.rules++; assets.push([`rules/${pack}/${f}`, null]); }
    }
    if (REQUIRED.includes(name) && !counts[name]) errors.push(`${name}/ has no ${name === 'skills' ? 'skill (skills/<name>/SKILL.md)' : '.md file'}`);
  }
  if (!existsSync(join(base, 'VERSION'))) warnings.push('no VERSION file; the installed version cannot be shown');
  if (deep && !errors.length) {
    for (const [rel, expected] of assets) {
      const full = join(base, rel);
      const parsed = parseMarkdown(readFileSync(full, 'utf8'));
      for (const e of parsed.errors) errors.push(`${rel}: ${e}`);
      if (!parsed.body) errors.push(`${rel}: empty`);
      if (expected && parsed.meta.name && parsed.meta.name !== expected) warnings.push(`${rel}: name "${parsed.meta.name}" differs from "${expected}"`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, counts };
}

const describeProblems = (v) => v.errors.slice(0, 8).map((e) => `  - ${e}`).join('\n') + (v.errors.length > 8 ? `\n  ... and ${v.errors.length - 8} more` : '');

// ---------------------------------------------------------------- which ECC folder is used

/** Restore a backup left by an interrupted swap, so a crash never leaves zc without its installed ECC. */
export function recoverInterrupted(parent = dirname(installedEccDir()), { locked = false } = {}) {
  const target = installedEccDir();
  if (existsSync(target) || !existsSync(parent)) return false;
  if (!readdirSync(parent).some((n) => n.startsWith('.ecc-old-'))) return false;
  let release = () => {};
  if (!locked) {
    try { release = acquireLock(join(parent, 'ecc-install.lock'), {}); } catch { return false; } // an install is running; it will finish or restore by itself
  }
  try {
    if (existsSync(target)) return false;
    const backups = readdirSync(parent).filter((n) => n.startsWith('.ecc-old-')).sort();
    if (!backups.length) return false;
    renameSync(join(parent, backups[backups.length - 1]), target);
    return true;
  } finally {
    release();
  }
}

const hasBackup = (parent) => existsSync(parent) && readdirSync(parent).some((n) => n.startsWith('.ecc-old-'));

/**
 * While an install swaps folders the installed ECC is briefly absent. Wait for it instead of silently
 * choosing different rules; fail clearly if it does not come back.
 */
function waitForInstall(timeoutMs = Number(process.env.ZC_ECC_WAIT_MS) || 15_000) {
  const parent = dirname(installedEccDir());
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(installedEccDir()) && hasBackup(parent)) {
    if (recoverInterrupted()) return;
    if (Date.now() > deadline) throw new Error(`an ECC install is in progress (or was interrupted) and the installed ECC is not available yet; retry in a moment, or run \`zc ecc install\`. Backup: ${parent}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

export const readInstalled = () => {
  try { return JSON.parse(readFileSync(join(installedEccDir(), 'INSTALLED.json'), 'utf8')); } catch { return null; }
};

/**
 * Project setting, then ZC_ECC_PATH, then the copy from `zc ecc install`, then the bundled rules.
 * A chosen folder that is incomplete is an error, never a silent fallback to something else.
 * Returns { dir, source, complete }.
 */
export function eccRoot(config) {
  recoverInterrupted();
  waitForInstall();
  const explicit = config.ecc.path ? { dir: resolve(config.ecc.path), source: 'configured' }
    : process.env.ZC_ECC_PATH ? { dir: resolve(process.env.ZC_ECC_PATH), source: 'ZC_ECC_PATH' }
      : existsSync(installedEccDir()) ? { dir: installedEccDir(), source: 'installed' } : null;
  if (!explicit) return { dir: BUNDLED_ECC, source: 'bundled', complete: false };
  const v = validateCatalog(explicit.dir);
  if (!v.ok) {
    const hint = explicit.source === 'installed' ? 'Run `zc ecc install` again.' : 'Fix the path or remove it to use the bundled rules.';
    throw new Error(`ECC folder (${explicit.source}: ${explicit.dir}) is not usable:\n${describeProblems(v)}\n${hint}`);
  }
  return { ...explicit, complete: true };
}

// ---------------------------------------------------------------- index / search

/** Everything the ECC folder offers, with the one-line description from each file's front matter. */
export function buildIndex(dir) {
  const items = [];
  const add = (kind, name, rel, description) => {
    const st = lstatOrNull(join(dir, rel));
    if (!st || !st.isFile()) return;
    items.push({ kind, name, rel, description: (description ?? '').replace(/\s+/g, ' ').slice(0, 400), bytes: st.size });
  };
  const head = (rel) => parseMarkdown(readHead(join(dir, rel), 16_384)).meta.description;
  const dirs = (d) => (isReal(join(dir, d), 'dir') ? subdirs(join(dir, d)) : []);
  const mds = (d) => (isReal(join(dir, d), 'dir') ? mdIn(join(dir, d)) : []);
  for (const name of dirs('skills')) add('skill', name, `skills/${name}/SKILL.md`, head(`skills/${name}/SKILL.md`));
  for (const f of mds('agents')) add('agent', f.replace(/\.md$/, ''), `agents/${f}`, head(`agents/${f}`));
  for (const f of mds('commands')) add('command', f.replace(/\.md$/, ''), `commands/${f}`, head(`commands/${f}`));
  for (const pack of dirs('rules')) {
    for (const f of mds(`rules/${pack}`)) add('rule', `${pack}/${f.replace(/\.md$/, '')}`, `rules/${pack}/${f}`, `${pack} rule: ${f.replace(/\.md$/, '')}`);
  }
  return items;
}

/** Word search over names and descriptions; names weigh more. */
export function searchIndex(index, words, { kind, limit = 15 } = {}) {
  const terms = words.map((w) => w.toLowerCase()).filter(Boolean);
  return index
    .filter((e) => !kind || e.kind === kind)
    .map((e) => {
      const name = e.name.toLowerCase();
      const desc = e.description.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name === t) score += 10;
        else if (name.includes(t)) score += 5;
        if (desc.includes(t)) score += 1;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);
}

// ---------------------------------------------------------------- references

const SPEC_KINDS = { skill: 'skill', agent: 'agent', command: 'command', rule: 'rule', rules: 'rule' };

/** `skill:name`, `agent:name`, `command:name`, `rules:pack` or `rule:pack/file`. */
export function parseSpec(spec) {
  const text = String(spec ?? '').trim();
  const m = /^([A-Za-z]+):(.*)$/.exec(text);
  const usage = 'use skill:<name>, agent:<name>, command:<name>, rules:<pack> or rule:<pack>/<file>';
  if (!m) throw new Error(`bad ECC reference "${text}" - ${usage}`);
  const kind = SPEC_KINDS[m[1].toLowerCase()];
  if (!kind) throw new Error(`unsupported ECC kind "${m[1]}" in "${text}" - ${usage}`);
  let name = m[2].trim();
  if (kind === 'command') name = name.replace(/^\//, '');
  const parts = name.split('/');
  const ok = name && parts.length <= (kind === 'rule' ? 2 : 1) && parts.every((p) => NAME_RE.test(p));
  if (!ok) throw new Error(`bad ECC name "${name}" in "${text}" - ${usage}; names are letters, digits, . _ - (no spaces, no ..)`);
  return { kind, name };
}

const FRAMING = {
  skill: (name) => `### Skill: ${name}`,
  agent: (name) => `### Expert role: ${name} (use this expertise; ignore any tools it mentions that you do not have)`,
  command: (name) => `### Procedure: /${name} (follow the steps that need only reading and editing files; the manager runs any commands)`,
  rule: (name) => `### Rule: ${name}`
};

/** Read one asset safely: inside the ECC folder, a real file, within the byte limit, with sound front matter. */
export function readAsset(dir, rel, { maxBytes = DEFAULT_ASSET_BYTES } = {}) {
  const base = resolve(dir);
  const full = resolve(base, rel);
  if (!full.startsWith(base + sep)) throw new Error(`ECC asset path escapes the ECC folder: ${rel}`);
  const st = lstatOrNull(full);
  if (!st) throw new Error(`ECC asset not found: ${rel}`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`ECC asset ${rel} is not a regular file`);
  if (st.size > maxBytes) throw new Error(`ECC asset ${rel} is ${st.size} bytes, over the ${maxBytes} byte limit (ecc.assetMaxBytes)`);
  const parsed = parseMarkdown(readFileSync(full, 'utf8'));
  if (parsed.errors.length) throw new Error(`ECC asset ${rel}: ${parsed.errors.join('; ')}`);
  if (!parsed.body) throw new Error(`ECC asset ${rel} is empty`);
  return parsed;
}

function locate(dir, kind, name) {
  if (kind === 'skill') return [[name, `skills/${name}/SKILL.md`]];
  if (kind === 'agent') return [[name, `agents/${name}.md`]];
  if (kind === 'command') return [[name, `commands/${name}.md`]];
  if (name.includes('/')) return [[name, `rules/${name}.md`]];
  const packDir = join(dir, 'rules', name);
  if (!isReal(packDir, 'dir')) return [];
  return mdIn(packDir).map((f) => [`${name}/${f.replace(/\.md$/, '')}`, `rules/${name}/${f}`]);
}

/**
 * Resolve references to `{ key, label, text }` sections by path (no full scan). Unknown or unreadable
 * references fail closed so a typo never silently drops guidance.
 */
export function loadAssets(dir, specs, { maxBytes = DEFAULT_ASSET_BYTES } = {}) {
  const sections = [];
  const seen = new Set();
  for (const spec of specs) {
    const { kind, name } = parseSpec(spec);
    const targets = locate(dir, kind, name).filter(([, rel]) => lstatOrNull(join(dir, rel)));
    if (!targets.length) {
      let near = [];
      try { near = searchIndex(buildIndex(dir), name.split(/[-_/]/), { kind, limit: 3 }).map((e) => `${e.kind}:${e.name}`); } catch { /* suggestions are best effort */ }
      const rulesOnly = !REQUIRED.every((d) => isReal(join(dir, d), 'dir'));
      throw new Error(`ECC ${kind} "${name}" not found in ${dir}${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}.${rulesOnly ? ' Only rules are bundled; run `zc ecc install` for skills, agents and commands.' : ''}`);
    }
    for (const [label, rel] of targets) {
      const key = `${kind}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { body } = readAsset(dir, rel, { maxBytes });
      sections.push({ key, label: key, text: `${FRAMING[kind](label)}\n${body}` });
    }
  }
  return sections;
}

/**
 * Whole sections only, in order, up to `maxChars`. Sections that do not fit are listed in a visible
 * notice instead of being cut mid-sentence. If not even the first fits, that is an error.
 */
export function formatAssets(sections, maxChars) {
  const parts = [];
  let used = 0;
  let i = 0;
  for (; i < sections.length; i++) {
    const cost = sections[i].text.length + 2;
    if (used + cost > maxChars) break;
    parts.push(sections[i].text);
    used += cost;
  }
  if (i === 0 && sections.length) {
    throw new Error(`ECC guidance ${sections[0].label} is ${sections[0].text.length} characters, over ecc.assetMaxChars (${maxChars}); raise the limit or reference something smaller`);
  }
  const omitted = sections.slice(i).map((s) => s.label);
  if (omitted.length) parts.push(`[ECC guidance omitted - over ecc.assetMaxChars (${maxChars}): ${omitted.join(', ')}. Give the task fewer references.]`);
  return parts.join('\n\n').trim();
}

// ---------------------------------------------------------------- install

const rmQuiet = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* cleanup must not hide the real error */ } };

/**
 * Install an ECC checkout into zc's state folder, all or nothing: validate the source, copy into a
 * sibling staging folder, validate the copy, then swap it in. A failure at any point leaves the previously
 * installed ECC untouched and no staging folder behind.
 */
export function installFrom(sourceDir, meta = {}, hooks = {}) {
  const source = resolve(sourceDir);
  const found = validateCatalog(source, { deep: true });
  if (!found.ok) throw new Error(`${source} is not a usable ECC checkout:\n${describeProblems(found)}`);
  const target = installedEccDir();
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const release = acquireLock(join(parent, 'ecc-install.lock'), {});
  let staging = null;
  let backup = null;
  try {
    recoverInterrupted(parent, { locked: true });
    for (const n of readdirSync(parent).filter((x) => x.startsWith('.ecc-new-'))) rmQuiet(join(parent, n)); // from a crashed install
    staging = mkdtempSync(join(parent, '.ecc-new-'));
    for (const name of COPY_DIRS) {
      if (existsSync(join(source, name))) cpSync(join(source, name), join(staging, name), { recursive: true, verbatimSymlinks: true });
    }
    for (const name of ['LICENSE', 'VERSION']) if (existsSync(join(source, name))) cpSync(join(source, name), join(staging, name));
    const version = existsSync(join(source, 'VERSION')) ? readFileSync(join(source, 'VERSION'), 'utf8').trim() : 'unknown';
    hooks.afterCopy?.(staging);
    const copied = validateCatalog(staging, { deep: true });
    if (!copied.ok) throw new Error(`the copied ECC failed validation:\n${describeProblems(copied)}`);
    const record = {
      source: meta.source ?? 'local', origin: meta.origin ?? source, requestedRef: meta.requestedRef ?? '',
      resolvedCommit: meta.resolvedCommit ?? '', tracking: meta.tracking ?? 'local copy',
      version, installedAt: new Date().toISOString(), counts: copied.counts
    };
    writeFileSync(join(staging, 'INSTALLED.json'), `${JSON.stringify(record, null, 2)}\n`);
    if (existsSync(target)) {
      backup = join(parent, `.ecc-old-${Date.now()}`);
      renameSync(target, backup);
    }
    try {
      hooks.beforePromote?.();
      renameSync(staging, target);
    } catch (error) {
      if (backup) {
        try {
          hooks.beforeRestore?.();
          renameSync(backup, target);
          backup = null;
        } catch (restoreError) {
          // Never delete the only copy of the previous install: keep it where `recoverInterrupted` will find it.
          const kept = backup;
          backup = null;
          throw new Error(`${error.message}; and the previous ECC could not be put back (${restoreError.message}). It is preserved at ${kept} and is restored automatically by the next zc ecc command.`);
        }
      }
      throw error;
    }
    staging = null;
    return { target, version, warnings: copied.warnings, ...record, ...copied.counts };
  } finally {
    if (staging) rmQuiet(staging);
    if (backup) rmQuiet(backup);
    release();
  }
}

/**
 * Download ECC and install it. `ref` may be a tag, a branch or a commit id. The result records the full
 * commit and whether the install tracks something that can move. `run` is injectable for tests.
 */
export async function installFromGit({ url = process.env.ZC_ECC_URL || ECC_URL, ref = '', run = defaultRun } = {}, hooks = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'zc-ecc-'));
  try {
    const git = async (args, cwd) => {
      const r = await run('git', args, { cwd, timeoutMs: 300_000 });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error || '').trim().slice(-300)}`);
      return r.stdout.trim();
    };
    let tracking = 'unpinned default branch (changes on every install)';
    try {
      if (/^[0-9a-f]{7,40}$/i.test(ref)) {
        await git(['init', '-q'], temp);
        await git(['remote', 'add', 'origin', url], temp);
        await git(['fetch', '--depth', '1', 'origin', ref], temp);
        await git(['checkout', '-q', 'FETCH_HEAD'], temp);
        tracking = 'pinned commit';
      } else {
        await git(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, temp]);
        if (ref) {
          const onBranch = (await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: temp })).code === 0;
          tracking = onBranch ? `branch ${ref} (moving: changes whenever the branch changes)` : `tag ${ref}`;
        }
      }
    } catch (error) {
      throw new Error(`could not download ECC: ${error.message} (or pass --from <path to an ECC checkout>)`);
    }
    const resolvedCommit = await git(['rev-parse', 'HEAD'], temp);
    return installFrom(temp, { source: 'git', origin: url, requestedRef: ref, resolvedCommit, tracking }, hooks);
  } finally {
    rmQuiet(temp);
  }
}
