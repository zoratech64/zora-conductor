import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/dispatch.mjs';
import { statusEntries } from '../src/gitx.mjs';
import { WORKER_EXCLUDED_RULES, WORKER_REQUIRED_RULES, loadEccRules, selectEccRules } from '../src/prompt.mjs';
import { addFake, makeHome, makeRepo, task } from './helpers.mjs';

function makeTestEcc(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-test-ecc-'));
  const w = (rel, text) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  w('skills/flutter-magic/SKILL.md', '---\nname: flutter-magic\ndescription: Widget tricks for Flutter apps\n---\nSKILL-BODY-FLUTTER');
  w('agents/flutter-reviewer.md', '---\nname: flutter-reviewer\ndescription: Reviews Flutter code\ntools: Read, Bash\n---\nAGENT-BODY');
  w('commands/flutter-test.md', '---\ndescription: Run Flutter tests\n---\nCOMMAND-BODY');
  w('rules/common/agents.md', 'MARKER-AGENTS');
  w('rules/common/code-review.md', 'MARKER-CODE-REVIEW');
  w('rules/common/development-workflow.md', 'MARKER-DEV-WORKFLOW');
  w('rules/common/git-workflow.md', 'MARKER-GIT-WORKFLOW');
  w('rules/common/hooks.md', 'MARKER-HOOKS');
  w('rules/common/performance.md', 'MARKER-PERFORMANCE');
  w('rules/common/security.md', 'MARKER-SECURITY');
  w('rules/common/testing.md', 'MARKER-TESTING');
  w('VERSION', '9.9.9');
  for (const [rel, text] of Object.entries(extraFiles)) {
    w(rel, text);
  }
  return dir;
}

test('worker-relevant ECC rules: manager files and hooks/agents are excluded, security and testing included', () => {
  const eccDir = makeTestEcc();
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const result = selectEccRules(config);

  assert.deepEqual(result.excluded, [
    'common/agents.md',
    'common/code-review.md',
    'common/development-workflow.md',
    'common/git-workflow.md',
    'common/hooks.md',
    'common/performance.md'
  ]);
  assert.deepEqual(result.included, [
    'common/security.md',
    'common/testing.md'
  ]);
  assert.deepEqual(result.omitted, []);

  // Included markers present in text
  assert.match(result.text, /### common\/security\.md\nMARKER-SECURITY/);
  assert.match(result.text, /### common\/testing\.md\nMARKER-TESTING/);

  // Excluded markers absent from text
  assert.doesNotMatch(result.text, /MARKER-AGENTS/);
  assert.doesNotMatch(result.text, /MARKER-CODE-REVIEW/);
  assert.doesNotMatch(result.text, /MARKER-DEV-WORKFLOW/);
  assert.doesNotMatch(result.text, /MARKER-GIT-WORKFLOW/);
  assert.doesNotMatch(result.text, /MARKER-HOOKS/);
  assert.doesNotMatch(result.text, /MARKER-PERFORMANCE/);

  // loadEccRules returns identical text
  assert.equal(loadEccRules(config), result.text);
});

test('exact boundary: maxChars equal to summed cost includes all; one less throws because testing.md is required', () => {
  const eccDir = makeTestEcc();
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const sec1Text = '### common/security.md\nMARKER-SECURITY';
  const sec2Text = '### common/testing.md\nMARKER-TESTING';
  const cost1 = sec1Text.length + 2;
  const cost2 = sec2Text.length + 2;
  const totalCost = cost1 + cost2;

  // Exact boundary: includes all, nothing omitted
  config.ecc.maxChars = totalCost;
  const fitsAll = selectEccRules(config);
  assert.deepEqual(fitsAll.included, ['common/security.md', 'common/testing.md']);
  assert.deepEqual(fitsAll.omitted, []);
  assert.equal(fitsAll.text, `${sec1Text}\n\n${sec2Text}`);

  // One less: throws because testing.md is required
  config.ecc.maxChars = totalCost - 1;
  assert.throws(
    () => selectEccRules(config),
    /ECC rule common\/testing\.md is required for workers/
  );
});

test('over budget: omitted labels listed in marker, each included body whole, no omitted body appears', () => {
  const eccDir = makeTestEcc({
    'rules/common/a-extra.md': 'MARKER-A-EXTRA',
    'rules/common/z-extra.md': 'MARKER-EXTRA'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const sec1Text = '### common/security.md\nMARKER-SECURITY';
  const sec2Text = '### common/testing.md\nMARKER-TESTING';
  const cost1 = sec1Text.length + 2;
  const cost2 = sec2Text.length + 2;
  const max = cost1 + cost2;

  config.ecc.maxChars = max;
  const r = selectEccRules(config);
  assert.deepEqual(r.included, ['common/security.md', 'common/testing.md']);
  assert.deepEqual(r.omitted, ['common/a-extra.md', 'common/z-extra.md']);
  assert.equal(
    r.text,
    `${sec1Text}\n\n${sec2Text}\n\n[ECC rules omitted - over ecc.maxChars (${max}): common/a-extra.md, common/z-extra.md]`
  );
  // Each included body appears whole
  assert.ok(r.text.includes('MARKER-SECURITY'));
  assert.ok(r.text.includes('MARKER-TESTING'));
  // Neither MARKER-A-EXTRA nor MARKER-EXTRA appears in text
  assert.ok(!r.text.includes('MARKER-A-EXTRA'));
  assert.ok(!r.text.includes('MARKER-EXTRA'));
});

test('first section too large throws with specific error message', () => {
  const eccDir = makeTestEcc();
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const sec1Text = '### common/security.md\nMARKER-SECURITY';
  const max = 10;
  config.ecc.maxChars = max;

  assert.throws(
    () => selectEccRules(config),
    {
      name: 'Error',
      message: `ECC rule common/security.md is ${sec1Text.length} characters, over ecc.maxChars (${max}); raise ecc.maxChars or remove the pack`
    }
  );
});

test('deterministic: two calls return identical results; order is pack order then file name', () => {
  const eccDir = makeTestEcc({
    'rules/dart/testing.md': 'MARKER-DART-TESTING',
    'rules/dart/architecture.md': 'MARKER-DART-ARCH'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common', 'dart'] } });
  config.ecc.maxChars = 10000;

  const r1 = selectEccRules(config);
  const r2 = selectEccRules(config);

  assert.deepEqual(r1, r2);
  assert.deepEqual(r1.included, [
    'common/security.md',
    'common/testing.md',
    'dart/architecture.md',
    'dart/testing.md'
  ]);
});

test('dispatch: dry-run prompt has filtered rules; real dispatch records result.eccRules', async () => {
  makeHome();
  const eccDir = makeTestEcc();
  const { dir, config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });
  const scopedTask = task('id: T-1\nallowed:\n  - src/');

  // Dry run
  const dry = await dispatch({ root: dir, task: scopedTask, config, dryRun: true });
  assert.equal(dry.status, 'DRY_RUN');
  assert.match(dry.prompt, /## Project standards \(ECC\)/);
  assert.match(dry.prompt, /MARKER-SECURITY/);
  assert.match(dry.prompt, /MARKER-TESTING/);
  assert.doesNotMatch(dry.prompt, /MARKER-AGENTS/);

  // Real dispatch
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok' } });
  const real = await dispatch({ root: dir, task: scopedTask, config });
  assert.equal(real.status, 'OK');
  assert.ok(real.eccRules, 'result.eccRules must exist');
  assert.deepEqual(real.eccRules.included, ['common/security.md', 'common/testing.md']);
  assert.ok(real.eccRules.excluded.includes('common/agents.md'));
  assert.deepEqual(real.eccRules.omitted, []);
});

test('empty rule packs returns empty result', () => {
  const { config } = makeRepo({ ecc: { rulePacks: [] } });
  const result = selectEccRules(config);
  assert.deepEqual(result, { text: '', included: [], excluded: [], omitted: [] });
  assert.equal(loadEccRules(config), '');
});

test('missing rule pack throws pack-not-found error', () => {
  const eccDir = makeTestEcc();
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['missing'] } });
  assert.throws(
    () => selectEccRules(config),
    /ECC rule pack "missing" \(ecc\.rulePacks\) not found/
  );
});

test('required rules across packs are kept first; output keeps pack-then-name order', () => {
  const eccDir = makeTestEcc({
    'rules/common/a-extra.md': 'MARKER-COMMON-EXTRA',
    'rules/dart/architecture.md': 'MARKER-DART-ARCH',
    'rules/dart/security.md': 'MARKER-DART-SECURITY',
    'rules/dart/testing.md': 'MARKER-DART-TESTING'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common', 'dart'] } });

  const secCommonSec = '### common/security.md\nMARKER-SECURITY';
  const secCommonTest = '### common/testing.md\nMARKER-TESTING';
  const secDartSec = '### dart/security.md\nMARKER-DART-SECURITY';
  const secDartTest = '### dart/testing.md\nMARKER-DART-TESTING';

  const max = (secCommonSec.length + 2) +
    (secCommonTest.length + 2) +
    (secDartSec.length + 2) +
    (secDartTest.length + 2);

  config.ecc.maxChars = max;
  const r = selectEccRules(config);
  assert.deepEqual(r.included, [
    'common/security.md',
    'common/testing.md',
    'dart/security.md',
    'dart/testing.md'
  ]);
  assert.deepEqual(r.omitted, [
    'common/a-extra.md',
    'dart/architecture.md'
  ]);
});

test('when everything fits, text keeps original order (non-required before required when they sort first)', () => {
  const eccDir = makeTestEcc({
    'rules/common/a-extra.md': 'MARKER-A-EXTRA',
    'rules/common/z-extra.md': 'MARKER-Z-EXTRA'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });
  config.ecc.maxChars = 10000;

  const secA = '### common/a-extra.md\nMARKER-A-EXTRA';
  const secSec = '### common/security.md\nMARKER-SECURITY';
  const secTest = '### common/testing.md\nMARKER-TESTING';
  const secZ = '### common/z-extra.md\nMARKER-Z-EXTRA';

  const r = selectEccRules(config);
  assert.deepEqual(r.included, [
    'common/a-extra.md',
    'common/security.md',
    'common/testing.md',
    'common/z-extra.md'
  ]);
  assert.deepEqual(r.omitted, []);
  assert.equal(r.text, `${secA}\n\n${secSec}\n\n${secTest}\n\n${secZ}`);
  assert.ok(!r.text.includes('[ECC rules omitted'));
});

test('required rule that does not fit throws; nothing is returned', () => {
  const eccDir = makeTestEcc();
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const secText = '### common/security.md\nMARKER-SECURITY';
  const costSec = secText.length + 2;
  config.ecc.maxChars = costSec + 1;

  assert.throws(
    () => selectEccRules(config),
    /ECC rule common\/testing\.md is required for workers \(security\/testing\) but does not fit in ecc\.maxChars \(\d+\) after \d+ characters/
  );
});

test('dispatch stops before any worker when required rules do not fit', async () => {
  makeHome();
  const eccDir = makeTestEcc();
  const { dir, config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });
  const secText = '### common/security.md\nMARKER-SECURITY';
  config.ecc.maxChars = secText.length + 2 + 1;

  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'x' } });
  await assert.rejects(
    dispatch({ root: dir, task: task('id: T-1\nallowed:\n  - src/'), config }),
    /required for workers/
  );

  assert.deepEqual(statusEntries(dir), []); // .zc/ is zc's own folder and is not counted, as in test/dispatch.test.mjs:12
});

test('WORKER_REQUIRED_RULES and WORKER_EXCLUDED_RULES do not overlap', () => {
  for (const name of WORKER_REQUIRED_RULES) {
    assert.ok(!WORKER_EXCLUDED_RULES.has(name), `${name} must not be in WORKER_EXCLUDED_RULES`);
  }
});

test("pack without required files keeps today's prefix selection", () => {
  const eccDir = makeTestEcc({
    'rules/extra/a.md': 'A'.repeat(50),
    'rules/extra/b.md': 'B'.repeat(50)
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common', 'extra'] } });

  const secCommonSec = '### common/security.md\nMARKER-SECURITY';
  const secCommonTest = '### common/testing.md\nMARKER-TESTING';
  const secExtraA = `### extra/a.md\n${'A'.repeat(50)}`;

  const max = (secCommonSec.length + 2) +
    (secCommonTest.length + 2) +
    (secExtraA.length + 2);

  config.ecc.maxChars = max;
  const r = selectEccRules(config);
  assert.deepEqual(r.included, [
    'common/security.md',
    'common/testing.md',
    'extra/a.md'
  ]);
  assert.deepEqual(r.omitted, ['extra/b.md']);
});

test('pack with only excluded files returns empty text without throwing', () => {
  const eccDir = makeTestEcc({
    'rules/onlyex/hooks.md': 'HOOKS',
    'rules/onlyex/agents.md': 'AGENTS'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['onlyex'] } });
  config.ecc.maxChars = 1000;

  const r = selectEccRules(config);
  assert.deepEqual(r, {
    text: '',
    included: [],
    excluded: ['onlyex/agents.md', 'onlyex/hooks.md'],
    omitted: []
  });
});

test('first required file too large throws even when a non-required file sorting first would fit', () => {
  const secSecBody = 'S'.repeat(200);
  const eccDir = makeTestEcc({
    'rules/common/a-extra.md': 'A',
    'rules/common/security.md': secSecBody
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const secAText = '### common/a-extra.md\nA';
  const secSecText = `### common/security.md\n${secSecBody}`;
  const secTestText = '### common/testing.md\nMARKER-TESTING';
  const costA = secAText.length + 2;
  const costTest = secTestText.length + 2;
  const max = costA + costTest + 10;
  config.ecc.maxChars = max;

  assert.throws(
    () => selectEccRules(config),
    {
      name: 'Error',
      message: `ECC rule common/security.md is ${secSecText.length} characters, over ecc.maxChars (${max}); raise ecc.maxChars or remove the pack`
    }
  );
});

test('required match ignores case', () => {
  const eccDir = makeTestEcc({
    'rules/mixed/a.md': 'A',
    'rules/mixed/Security.md': 'S',
    'rules/mixed/TESTING.md': 'T'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['mixed'] } });

  const secSecText = '### mixed/Security.md\nS';
  const secTestText = '### mixed/TESTING.md\nT';
  const max = (secSecText.length + 2) + (secTestText.length + 2);
  config.ecc.maxChars = max;

  const r = selectEccRules(config);
  assert.deepEqual(r.included, ['mixed/Security.md', 'mixed/TESTING.md']);
  assert.deepEqual(r.omitted, ['mixed/a.md']);
});
