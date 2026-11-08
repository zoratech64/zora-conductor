import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_ASSET_BYTES, parseSpec } from './ecc.mjs';
import { readJson } from './fsx.mjs';
import { configPath } from './paths.mjs';
import { parseCount, parseMinutes } from './limits.mjs';
import { splitArgv } from './task.mjs';

export const DEFAULTS = {
  version: 1,
  /** Commands the manager's gate runs after every worker task (argv arrays or strings). */
  verify: [],
  defaults: {
    allowed: [],
    minutes: 30,
    maxAttempts: 8,
    cooldownMinutes: 60,
    flakyCooldownMinutes: 10,
    verifyTimeoutMinutes: 15,
    /** reset: roll a failed worker's partial edits back (patch saved first). continue: next account picks up. */
    onLimit: 'reset'
  },
  forbidden: [],
  worker: {
    adapter: 'agy',
    model: '',
    effort: '',
    /** edit: file edits only. read: plan mode. all: also lets the worker run commands (opt-in). */
    permissions: 'edit',
    prefixFile: '.zc/worker-prefix.md'
  },
  ecc: { path: '', rulePacks: [], maxChars: 40000, assets: [], assetMaxChars: 60000, assetMaxBytes: DEFAULT_ASSET_BYTES }
};

const ON_LIMIT = ['reset', 'continue'];
const PERMISSIONS = ['read', 'edit', 'all'];

function normalizeCommands(list, where) {
  if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
  return list.map((entry) => {
    const argv = typeof entry === 'string' ? splitArgv(entry) : entry;
    if (!Array.isArray(argv) || !argv.length || !argv.every((p) => typeof p === 'string')) {
      throw new Error(`${where}: each command must be a string or an array of strings`);
    }
    return argv;
  });
}

function validateEcc(ecc, root) {
  if (typeof ecc.path !== 'string') throw new Error('ecc.path must be text');
  if (ecc.path) ecc.path = resolve(root, ecc.path); // relative paths mean "relative to the project", not to wherever zc was started
  if (!Array.isArray(ecc.assets)) throw new Error('ecc.assets must be a list like ["skill:dart-flutter-patterns"]');
  for (const a of ecc.assets) {
    try { parseSpec(a); } catch (error) { throw new Error(`ecc.assets: ${error.message}`); }
  }
  if (!Array.isArray(ecc.rulePacks) || !ecc.rulePacks.every((p) => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))) {
    throw new Error('ecc.rulePacks must be a list of pack names such as ["common", "dart"]');
  }
  parseCount(ecc.maxChars, 'ecc.maxChars', { min: 1000, max: 400_000 });
  parseCount(ecc.assetMaxChars, 'ecc.assetMaxChars', { min: 1000, max: 400_000 });
  parseCount(ecc.assetMaxBytes, 'ecc.assetMaxBytes', { min: 1024, max: 2_000_000 });
}

export function loadConfig(root) {
  const file = configPath(root);
  const user = readJson(file, null);
  if (!user) throw new Error(`no ${file} — run \`zc init\` in the project root first`);
  const config = {
    ...DEFAULTS,
    ...user,
    defaults: { ...DEFAULTS.defaults, ...user.defaults },
    worker: { ...DEFAULTS.worker, ...user.worker },
    ecc: { ...DEFAULTS.ecc, ...user.ecc }
  };
  config.verify = normalizeCommands(config.verify, 'verify');
  validateEcc(config.ecc, root);
  for (const key of ['minutes', 'cooldownMinutes', 'flakyCooldownMinutes', 'verifyTimeoutMinutes']) parseMinutes(config.defaults[key], `defaults.${key}`);
  parseCount(config.defaults.maxAttempts, 'defaults.maxAttempts', { max: 50 });
  if (!ON_LIMIT.includes(config.defaults.onLimit)) throw new Error(`defaults.onLimit must be ${ON_LIMIT.join(' or ')}`);
  if (!PERMISSIONS.includes(config.worker.permissions)) throw new Error(`worker.permissions must be ${PERMISSIONS.join(', ')}`);
  if (config.worker.adapter !== 'agy') throw new Error(`worker.adapter "${config.worker.adapter}" is not supported yet (only "agy")`);
  return config;
}

/** Starting point for `zc init`, based on what the project looks like. */
export function detectStack(root) {
  const has = (name) => existsSync(join(root, name));
  if (has('pubspec.yaml')) {
    return { stack: 'flutter', verify: [['dart', 'analyze'], ['flutter', 'test']], rulePacks: ['common', 'dart'] };
  }
  if (has('package.json')) {
    const pkg = readJson(join(root, 'package.json'), {}) ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const nest = Boolean(deps['@nestjs/core']);
    const verify = [];
    if (pkg.scripts?.build) verify.push(['npm', 'run', 'build']);
    if (pkg.scripts?.test) verify.push(['npm', 'test']);
    return { stack: nest ? 'nestjs' : 'node', verify, rulePacks: ['common', 'typescript'] };
  }
  return { stack: 'unknown', verify: [], rulePacks: ['common'] };
}
