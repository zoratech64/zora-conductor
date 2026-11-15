import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/dispatch.mjs';
import { loadEccRules, selectEccRules } from '../src/prompt.mjs';
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

test('exact boundary: maxChars equal to summed cost includes all, one less omits the last whole section', () => {
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

  // One less: omits the last whole section
  config.ecc.maxChars = totalCost - 1;
  const omitsLast = selectEccRules(config);
  assert.deepEqual(omitsLast.included, ['common/security.md']);
  assert.deepEqual(omitsLast.omitted, ['common/testing.md']);
  assert.equal(
    omitsLast.text,
    `${sec1Text}\n\n[ECC rules omitted - over ecc.maxChars (${totalCost - 1}): common/testing.md]`
  );
});

test('over budget: omitted labels listed in marker, each included body whole, no omitted body appears', () => {
  const eccDir = makeTestEcc({
    'rules/common/z-extra.md': 'MARKER-EXTRA'
  });
  const { config } = makeRepo({ ecc: { path: eccDir, rulePacks: ['common'] } });

  const sec1Text = '### common/security.md\nMARKER-SECURITY';
  const cost1 = sec1Text.length + 2;

  // Budget accommodates only the first section
  config.ecc.maxChars = cost1;
  const r = selectEccRules(config);
  assert.deepEqual(r.included, ['common/security.md']);
  assert.deepEqual(r.omitted, ['common/testing.md', 'common/z-extra.md']);
  assert.equal(
    r.text,
    `${sec1Text}\n\n[ECC rules omitted - over ecc.maxChars (${cost1}): common/testing.md, common/z-extra.md]`
  );
  // Each included body appears whole
  assert.ok(r.text.includes('MARKER-SECURITY'));
  // No omitted body appears at all
  assert.ok(!r.text.includes('MARKER-TESTING'));
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
