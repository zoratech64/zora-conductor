import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/dispatch.mjs';
import { buildIndex, eccRoot, formatAssets, installFrom, installedEccDir, loadAssets, parseSpec, searchIndex } from '../src/ecc.mjs';
import { main } from '../src/cli.mjs';
import { fakeEcc, makeHome, makeRepo, task } from './helpers.mjs';

test('ecc index lists every kind with descriptions, and search ranks names above descriptions', () => {
  const index = buildIndex(fakeEcc());
  assert.deepEqual(index.map((e) => `${e.kind}:${e.name}`).sort(),
    ['agent:flutter-reviewer', 'command:flutter-test', 'rule:common/base', 'rule:common/style', 'rule:dart/style', 'skill:flutter-magic', 'skill:nest-magic']);
  assert.equal(index.find((e) => e.name === 'flutter-test').description, 'Run Flutter tests');
  assert.equal(searchIndex(index, ['flutter'])[0].kind !== undefined, true);
  assert.deepEqual(searchIndex(index, ['nestjs']).map((e) => e.name), ['nest-magic']);
  assert.deepEqual(searchIndex(index, ['flutter'], { kind: 'agent' }).map((e) => e.name), ['flutter-reviewer']);
});

test('ecc references: parse, load with framing, strip front matter, whole rule packs', () => {
  assert.deepEqual(parseSpec('rules:dart'), { kind: 'rule', name: 'dart' });
  assert.deepEqual(parseSpec('command:/flutter-test'), { kind: 'command', name: 'flutter-test' });
  assert.throws(() => parseSpec('flutter-magic'), /bad ECC reference/);
  const dir = fakeEcc();
  const text = loadAssets(dir, ['skill:flutter-magic', 'agent:flutter-reviewer', 'command:flutter-test', 'rules:dart', 'skill:flutter-magic']).map((x) => x.text).join('\n');
  for (const part of ['SKILL-BODY-FLUTTER', 'AGENT-BODY', 'COMMAND-BODY', 'RULE-BODY']) assert.match(text, new RegExp(part));
  assert.doesNotMatch(text, /tools: Read/);
  assert.equal(text.split('SKILL-BODY-FLUTTER').length, 2, 'duplicate references are loaded once');
  assert.match(text, /Expert role: flutter-reviewer/);
  assert.throws(() => loadAssets(dir, ['skill:flutter-magik']), /did you mean skill:flutter-magic/);
});

test('ecc guidance is capped instead of flooding the worker prompt', () => {
  const sec = (label, ch) => ({ label, text: ch.repeat(500) });
  const out = formatAssets([sec('skill:a', 'A'), sec('skill:b', 'B'), sec('skill:c', 'C')], 1100);
  assert.match(out, /A{500}/);
  assert.match(out, /B{500}/);
  assert.doesNotMatch(out, /C{10}/, 'a section is never cut in half');
  assert.match(out, /omitted.*skill:c/);
  assert.throws(() => formatAssets([sec('skill:big', 'X')], 100), /skill:big.*over ecc.assetMaxChars/);
});

test('dispatch dry run puts project and per-task ECC assets into the worker prompt', async () => {
  makeHome();
  const dir = fakeEcc();
  const { dir: repo, config } = makeRepo({ ecc: { path: dir, rulePacks: [], assets: ['skill:nest-magic'] } });
  const t = task('id: T-9\nallowed:\n  - src/\necc:\n  - skill:flutter-magic\n  - agent:flutter-reviewer');
  const r = await dispatch({ root: repo, task: t, config, dryRun: true });
  assert.match(r.prompt, /ECC guidance/);
  for (const part of ['SKILL-BODY-NEST', 'SKILL-BODY-FLUTTER', 'AGENT-BODY']) assert.match(r.prompt, new RegExp(part));
  assert.ok(r.prompt.indexOf('ECC guidance') < r.prompt.indexOf('## Task T-9'));
});

test('an unknown ECC reference stops the dispatch before any worker runs', async () => {
  makeHome();
  const { dir: repo, config } = makeRepo({ ecc: { path: fakeEcc(), rulePacks: [] } });
  const t = task('id: T-9\nallowed:\n  - src/\necc:\n  - skill:does-not-exist');
  await assert.rejects(dispatch({ root: repo, task: t, config, dryRun: true }), /not found/);
});

test('zc ecc install --from copies the catalog into the state folder, which then becomes the default source', async () => {
  makeHome();
  delete process.env.ZC_ECC_PATH;
  const src = fakeEcc();
  assert.equal(eccRoot({ ecc: { path: '' } }).source, 'bundled');
  assert.equal(await main(['ecc', 'install', '--from', src]), 0);
  const root = eccRoot({ ecc: { path: '' } });
  assert.equal(root.source, 'installed');
  assert.equal(root.dir, installedEccDir());
  assert.equal(buildIndex(root.dir).length, 7);
  assert.throws(() => installFrom(mkdtempSync(join(tmpdir(), 'zc-empty-')), {}), /not a usable ECC checkout/);
});

test('the bundled rules work offline and name the fix when a skill is asked for', () => {
  makeHome();
  delete process.env.ZC_ECC_PATH;
  const root = eccRoot({ ecc: { path: '' } });
  assert.equal(root.source, 'bundled');
  assert.ok(loadAssets(root.dir, ['rules:dart']).length >= 4);
  assert.throws(() => loadAssets(root.dir, ['skill:dart-flutter-patterns']), /zc ecc install/);
});

test('an old frozen copy of the worker prefix follows the current default; a custom one is kept', async () => {
  const { DEFAULT_PREFIX, loadPrefix } = await import('../src/prompt.mjs');
  const { dir, config } = makeRepo();
  const file = join(dir, '.zc', 'worker-prefix.md');
  writeFileSync(file, `${DEFAULT_PREFIX.replace(/^- You cannot run shell commands:.*\n/m, '')}\n`);
  assert.match(loadPrefix(dir, config), /You cannot run shell commands/);
  writeFileSync(file, 'My own rules for this project.\n');
  assert.equal(loadPrefix(dir, config), 'My own rules for this project.');
});
