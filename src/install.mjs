import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Running zc from inside one project (npm/pnpm/Yarn dev dependency) instead of globally.
 * The accounts, leases and run records stay machine-global; only the program and the Claude
 * manager files (skill, command, reviewer agent) can live in the repository.
 */

const PACKAGE = 'zora-conductor';
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const STAMP = 'zc-managed';

// source file inside this package -> path inside the project
const CLAUDE_FILES = [
  ['skills/orchestrate/SKILL.md', '.claude/skills/orchestrate/SKILL.md'],
  ['commands/orchestrate.md', '.claude/commands/orchestrate.md'],
  ['agents/zc-reviewer.md', '.claude/agents/zc-reviewer.md']
];

export const packageVersion = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/** 'project' (a dependency under node_modules), 'plugin' (Claude Code's plugin cache) or 'global' (npm link, global install, clone). */
export function installType(root = PACKAGE_ROOT) {
  let real = root;
  try { real = realpathSync(root); } catch { /* keep the given path */ }
  if (real.split(sep).includes('node_modules')) return 'project';
  if (/[\\/]\.claude[\\/]plugins[\\/]/.test(real)) return 'plugin';
  return 'global';
}

/** How to start the project's own zc: the project's package manager, found from its lockfile. */
export function projectRunner(root) {
  const has = (name) => existsSync(join(root, name));
  if (has('pnpm-lock.yaml')) return 'pnpm exec zc';
  if (has('yarn.lock') || has('.yarnrc.yml')) return 'yarn zc'; // also the only way under Plug'n'Play
  return 'npx --no-install zc';
}

/** The zora-conductor the project itself depends on: declared in package.json and/or installed in a node_modules at or above root. */
export function projectDependency(root) {
  let declared = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    declared = Boolean(pkg.dependencies?.[PACKAGE] || pkg.devDependencies?.[PACKAGE] || pkg.optionalDependencies?.[PACKAGE]);
  } catch { /* no package.json: not a Node project */ }
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', PACKAGE, 'package.json');
    if (existsSync(file)) {
      try { return { declared, installed: JSON.parse(readFileSync(file, 'utf8')).version }; } catch { return { declared, installed: null }; }
    }
    if (dirname(dir) === dir) break;
  }
  return { declared, installed: null };
}

function managedText(source, { version, runner }) {
  const text = readFileSync(join(PACKAGE_ROOT, source), 'utf8').replace(/\r\n/g, '\n');
  const note = [`<!-- ${STAMP} ${version}; zc command: ${runner} -->`];
  if (runner !== 'zc') note.push(`> In this project run zc as \`${runner}\` wherever this file says \`zc\` (for example \`${runner} doctor\`).`);
  const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
  if (end < 0) return `${note.join('\n')}\n\n${text}`;
  const cut = end + 5;
  return `${text.slice(0, cut)}\n${note.join('\n')}\n${text.slice(cut)}`;
}

/** Per file: missing | current | outdated (ours, other version or runner) | foreign (not written by zc). */
export function claudeStatus(root, { runner = 'zc' } = {}) {
  const want = { version: packageVersion(), runner };
  return CLAUDE_FILES.map(([source, rel]) => {
    const target = join(root, rel);
    if (!existsSync(target)) return { rel, state: 'missing' };
    const have = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (have === managedText(source, want)) return { rel, state: 'current' };
    return { rel, state: have.includes(`<!-- ${STAMP} `) ? 'outdated' : 'foreign' };
  });
}

/** Copy the manager files into <root>/.claude. Never overwrites a file zc did not write unless force. */
export function installClaude(root, { runner = 'zc', force = false } = {}) {
  const want = { version: packageVersion(), runner };
  const before = claudeStatus(root, { runner });
  const blocked = before.filter((f) => f.state === 'foreign' && !force).map((f) => f.rel);
  if (blocked.length) {
    throw new Error(`not overwriting files that zc did not write: ${blocked.join(', ')} (move them, or run again with --force)`);
  }
  return CLAUDE_FILES.map(([source, rel], i) => {
    if (before[i].state === 'current') return { rel, action: 'unchanged' };
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, managedText(source, want));
    return { rel, action: before[i].state === 'missing' ? 'created' : 'updated' };
  });
}
