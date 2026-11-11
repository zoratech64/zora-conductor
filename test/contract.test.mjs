import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { DEFAULT_PREFIX, loadPrefix } from '../src/prompt.mjs';
import { parseTask } from '../src/task.mjs';
import { TASK_TEMPLATE } from '../src/template.mjs';
import { git, makeRepo } from './helpers.mjs';

test('TASK_TEMPLATE parses with parseTask and contains all section labels', () => {
  const { meta, body } = parseTask(TASK_TEMPLATE);
  assert.equal(meta.id, 'T-001');
  assert.deepEqual(meta.allowed, ['src/example/']);
  assert.deepEqual(meta.verify, [['npm', 'test']]);
  assert.equal(meta.minutes, 30);
  const labels = [
    'Objective',
    'Decisions',
    'Per file',
    'Read first',
    'Do not',
    'Done when',
    'If blocked',
    'Verification'
  ];
  for (const label of labels) {
    assert.ok(body.includes(label), `body should include "${label}"`);
  }
});

test('zc init writes TASK_TEMPLATE to .zc/tasks/TEMPLATE.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-init-'));
  git(dir, 'init', '-q', '-b', 'main');
  await main(['init', '--project', dir]);
  const written = readFileSync(join(dir, '.zc', 'tasks', 'TEMPLATE.md'), 'utf8');
  assert.equal(written, TASK_TEMPLATE);
});

test('backward compatibility: old-style task parses with same meta and body', () => {
  const oldTask = `---
id: T-002
title: Legacy task
allowed:
  - src/legacy/
verify:
  - npm test
minutes: 15
---
Add X.`;
  const { meta, body } = parseTask(oldTask);
  assert.equal(meta.id, 'T-002');
  assert.equal(meta.title, 'Legacy task');
  assert.deepEqual(meta.allowed, ['src/legacy/']);
  assert.deepEqual(meta.verify, [['npm', 'test']]);
  assert.equal(meta.minutes, 15);
  assert.equal(body, 'Add X.');
});

test('DEFAULT_PREFIX contains required safety lines and contract rules', () => {
  assert.ok(DEFAULT_PREFIX.includes('You cannot run shell commands'));
  assert.ok(DEFAULT_PREFIX.includes('Edit only the allowed paths'));
  assert.ok(DEFAULT_PREFIX.includes('Never run git commit'));
  assert.ok(DEFAULT_PREFIX.includes("Working from the manager's contract"));
  assert.ok(DEFAULT_PREFIX.includes('authoritative'));
  assert.ok(DEFAULT_PREFIX.includes('file and line evidence'));
});

test('loadPrefix upgrades legacy default prefix to DEFAULT_PREFIX but preserves custom text', () => {
  const { dir, config } = makeRepo();
  const file = join(dir, '.zc', 'worker-prefix.md');
  const previousDefault = DEFAULT_PREFIX.slice(0, DEFAULT_PREFIX.indexOf('\n\n## Working from the manager'));
  writeFileSync(file, previousDefault);
  assert.equal(loadPrefix(dir, config), DEFAULT_PREFIX);

  writeFileSync(file, 'My own rules.');
  assert.equal(loadPrefix(dir, config), 'My own rules.');
});

test('skills/orchestrate/SKILL.md retains hard rules, zc doctor, template labels and size categories', () => {
  const skillPath = resolve(import.meta.dirname, '..', 'skills', 'orchestrate', 'SKILL.md');
  const skillText = readFileSync(skillPath, 'utf8');
  assert.ok(skillText.includes('You do not edit project files'));
  assert.ok(skillText.includes('zc doctor'));
  const labels = [
    'Objective',
    'Decisions',
    'Per file',
    'Read first',
    'Do not',
    'Done when',
    'If blocked',
    'Verification'
  ];
  for (const label of labels) {
    assert.ok(skillText.includes(label), `skill should include "${label}"`);
  }
  const sizes = ['Small', 'Medium', 'Complex', 'Unclear'];
  for (const size of sizes) {
    assert.ok(skillText.includes(size), `skill should include "${size}"`);
  }
});
