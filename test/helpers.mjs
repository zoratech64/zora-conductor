import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as accounts from '../src/accounts.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseTask } from '../src/task.mjs';

export const FAKE_AGY = resolve(import.meta.dirname, '..', 'fixtures', 'fake-agy.mjs');
const PASS = [process.execPath, '-e', 'process.exit(0)'];
export const FAIL = [process.execPath, '-e', 'console.error("boom"); process.exit(1)'];

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Fresh git repo with one commit and a zc config whose verify command always passes. */
export function makeRepo(configExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false'); // Windows would otherwise turn restored files into CRLF
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(join(dir, 'src', 'keep.txt'), 'keep\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  mkdirSync(join(dir, '.zc'), { recursive: true });
  writeFileSync(join(dir, '.zc', 'config.json'), JSON.stringify({ version: 1, verify: [PASS], ...configExtra }));
  return { dir, config: loadConfig(dir) };
}

/** Isolated machine-global state, with the fake agy wired in. */
export function makeHome({ isolation = 'none' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'zc-home-'));
  process.env.ZC_HOME = home;
  process.env.ZC_AGY = FAKE_AGY;
  process.env.ZC_ISOLATION = isolation;
  return home;
}

export function addFake(id, scenario) {
  const account = accounts.addAccount(id);
  mkdirSync(account.profileDir, { recursive: true });
  setScenario(account, scenario);
  return accounts.updateAccount(id, { status: 'ready' });
}

export const setScenario = (account, scenario) =>
  writeFileSync(join(account.profileDir, 'scenario.json'), JSON.stringify(scenario));

export const calls = (account) => {
  const file = join(account.profileDir, 'calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
};

export const lastPrompt = (account) => readFileSync(join(account.profileDir, 'last-prompt.txt'), 'utf8');

export const task = (frontMatter, body = 'Do the thing.') =>
  parseTask(`---\n${frontMatter}\n---\n${body}`, { fallbackId: 'T' });

/** A tiny ECC checkout with one of each kind of asset. */
export function fakeEcc() {
  const dir = mkdtempSync(join(tmpdir(), 'zc-fake-ecc-'));
  const w = (rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  w('skills/flutter-magic/SKILL.md', '---\nname: flutter-magic\ndescription: Widget tricks for Flutter apps\n---\nSKILL-BODY-FLUTTER');
  w('skills/nest-magic/SKILL.md', '---\nname: nest-magic\ndescription: NestJS module patterns\n---\nSKILL-BODY-NEST');
  w('agents/flutter-reviewer.md', '---\nname: flutter-reviewer\ndescription: Reviews Flutter code\ntools: Read, Bash\n---\nAGENT-BODY');
  w('commands/flutter-test.md', '---\ndescription: Run Flutter tests\n---\nCOMMAND-BODY');
  w('rules/dart/style.md', 'RULE-BODY');
  w('rules/common/base.md', 'RULE-COMMON');
  w('rules/common/style.md', 'ALWAYS-USE-SMALL-FILES');
  w('VERSION', '9.9.9');
  return dir;
}

