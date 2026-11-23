import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { claudeStatus, installClaude, installType, packageVersion, projectDependency, projectRunner } from '../src/install.mjs';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'zc.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'zc-install-'));
const SKILL = '.claude/skills/orchestrate/SKILL.md';

test('installType: a path under node_modules is a project install, a clone is global', () => {
  assert.equal(installType(join(tmp(), 'node_modules', 'zora-conductor')), 'project', 'a path that does not exist is still judged by its name');
  const real = join(tmp(), 'node_modules', 'zora-conductor');
  mkdirSync(real, { recursive: true });
  assert.equal(installType(real), 'project');
  assert.equal(installType(), 'global', 'this test runs from a clone');
});

test('projectRunner follows the lockfile', () => {
  const dir = tmp();
  assert.equal(projectRunner(dir), 'npx --no-install zc');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(projectRunner(dir), 'pnpm exec zc');
  const yarn = tmp();
  writeFileSync(join(yarn, '.yarnrc.yml'), 'nodeLinker: pnp\n');
  assert.equal(projectRunner(yarn), 'yarn zc', 'Plug\'n\'Play has no node_modules, so only yarn can start it');
});

test('projectDependency: declared, installed, both, or neither (also from a monorepo package folder)', () => {
  const root = tmp();
  assert.deepEqual(projectDependency(root), { declared: false, installed: null });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { 'zora-conductor': '^0.2.0' } }));
  assert.deepEqual(projectDependency(root), { declared: true, installed: null });
  mkdirSync(join(root, 'node_modules', 'zora-conductor'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'zora-conductor', 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.deepEqual(projectDependency(root), { declared: true, installed: '9.9.9' });
  const app = join(root, 'apps', 'web');
  mkdirSync(app, { recursive: true });
  assert.equal(projectDependency(app).installed, '9.9.9', 'workspaces hoist node_modules to the root');
});

test('installClaude: creates, is idempotent, notes the runner, refuses foreign files unless forced', () => {
  const root = tmp();
  assert.deepEqual(claudeStatus(root).map((f) => f.state), ['missing', 'missing', 'missing']);
  const first = installClaude(root, { runner: 'pnpm exec zc' });
  assert.deepEqual(first.map((f) => f.action), ['created', 'created', 'created']);
  const skill = readFileSync(join(root, SKILL), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: orchestrate\\n[\\s\\S]*?\\n---\\n\\n<!-- zc-managed ${packageVersion().replace(/\./g, '\\.')}; zc command: pnpm exec zc -->`));
  assert.match(skill, /run zc as `pnpm exec zc`/);
  assert.deepEqual(installClaude(root, { runner: 'pnpm exec zc' }).map((f) => f.action), ['unchanged', 'unchanged', 'unchanged']);
  assert.equal(claudeStatus(root, { runner: 'npx --no-install zc' })[0].state, 'outdated', 'another runner needs a refresh');
  writeFileSync(join(root, SKILL), '# my own skill\n');
  assert.equal(claudeStatus(root, { runner: 'pnpm exec zc' })[0].state, 'foreign');
  assert.throws(() => installClaude(root, { runner: 'pnpm exec zc' }), /did not write/);
  assert.equal(readFileSync(join(root, SKILL), 'utf8'), '# my own skill\n', 'nothing was overwritten');
  assert.equal(installClaude(root, { runner: 'pnpm exec zc', force: true })[0].action, 'updated');
});

test('global runner: no extra note in the installed files', () => {
  const root = tmp();
  installClaude(root, { runner: 'zc' });
  assert.doesNotMatch(readFileSync(join(root, SKILL), 'utf8'), /In this project run zc as/);
});

test('zc init --claude and zc claude status through the CLI', () => {
  const root = tmp();
  const env = { ...process.env, ZC_HOME: join(root, 'state') };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const init = run('init', '--claude');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(existsSync(join(root, SKILL)), true);
  assert.match(run('claude', 'status').stdout, /current\s+\.claude\/skills\/orchestrate\/SKILL\.md/);
  assert.notEqual(run('claude', 'bogus').status, 0);
  const doctor = run('doctor').stdout;
  assert.match(doctor, /zc install — global v/);
  assert.match(doctor, /Claude manager files in \.claude\/ — current/);
});
