import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/dispatch.mjs';
import { head } from '../src/gitx.mjs';
import { parseTask } from '../src/task.mjs';
import { comparePromptSizes, measurePrompts, reportRuns } from '../scripts/measure.mjs';
import { fakeEcc, makeRepo } from './helpers.mjs';

test('measurePrompts: repo with a task file gives promptBytes > 0 and matches dry-run prompt bytes', async () => {
  const { dir, config } = makeRepo();
  const taskFile = join(dir, 'task.md');
  writeFileSync(taskFile, '---\nid: T-001\ntitle: Sample task\nallowed:\n  - src/\n---\nInstructions for the worker.\n');

  const res = await measurePrompts({ root: dir, files: [taskFile] });

  const rawTask = parseTask(readFileSync(taskFile, 'utf8'), { fallbackId: 'task' });
  const dryRun = await dispatch({ root: dir, task: rawTask, config, dryRun: true });

  assert.equal(res.kind, 'prompt-size');
  assert.equal(res.commit, head(dir));
  assert.equal(res.node, process.version);
  assert.equal(res.maxChars, config.ecc.maxChars);
  assert.deepEqual(res.rulePacks, config.ecc.rulePacks);
  assert.ok(typeof res.generatedAt === 'string');

  assert.equal(res.tasks.length, 1);
  const measured = res.tasks[0];
  assert.equal(measured.file, taskFile);
  assert.ok(measured.promptBytes > 0);
  assert.equal(measured.promptBytes, Buffer.byteLength(dryRun.prompt, 'utf8'));
  assert.equal(measured.promptChars, dryRun.prompt.length);
  assert.equal(measured.rulesTruncated, false);
});

test('measurePrompts: packs: [] gives eccRulesChars 0', async () => {
  const eccDir = fakeEcc();
  const { dir: repoWithEcc } = makeRepo({ ecc: { path: eccDir, rulePacks: ['dart'] } });
  const taskFile = join(repoWithEcc, 'task.md');
  writeFileSync(taskFile, '---\nid: T-002\nallowed:\n  - src/\n---\nDo something.\n');

  const withRules = await measurePrompts({ root: repoWithEcc, files: [taskFile] });
  assert.ok(withRules.tasks[0].eccRulesChars > 0);
  assert.deepEqual(withRules.rulePacks, ['dart']);

  const withoutRules = await measurePrompts({ root: repoWithEcc, files: [taskFile], packs: [] });
  assert.equal(withoutRules.tasks[0].eccRulesChars, 0);
  assert.deepEqual(withoutRules.rulePacks, []);
  assert.equal(withoutRules.tasks[0].rulesTruncated, false);
});

test('measurePrompts: missing task file throws', async () => {
  const { dir } = makeRepo();
  const missingAbsolute = join(dir, 'non-existent-task.md');

  await assert.rejects(
    () => measurePrompts({ root: dir, files: [missingAbsolute] }),
    (err) => err.code === 'ENOENT' || /no such file/i.test(err.message)
  );

  await assert.rejects(
    () => measurePrompts({ root: dir, files: ['missing-relative.md'] }),
    (err) => err.code === 'ENOENT' || /no such file/i.test(err.message)
  );
});

test('measurePrompts: multiple task files and empty files error', async () => {
  const { dir } = makeRepo();
  const task1 = join(dir, 'task1.md');
  const task2 = join(dir, 'task2.md');
  writeFileSync(task1, '---\nid: T-1\nallowed:\n  - src/\n---\nFirst task.\n');
  writeFileSync(task2, '---\nid: T-2\nallowed:\n  - src/\n---\nSecond task.\n');

  const res = await measurePrompts({ root: dir, files: [task1, task2] });
  assert.equal(res.tasks.length, 2);
  assert.equal(res.tasks[0].file, task1);
  assert.equal(res.tasks[1].file, task2);
  assert.ok(res.tasks[0].promptBytes > 0);
  assert.ok(res.tasks[1].promptBytes > 0);

  await assert.rejects(
    () => measurePrompts({ root: dir, files: [] }),
    /at least one task file required/
  );
});

test('measure CLI: prompt subcommand, unknown subcommand, and error handling', () => {
  const { dir } = makeRepo();
  const taskFile = join(dir, 'task.md');
  writeFileSync(taskFile, '---\nid: T-CLI\nallowed:\n  - src/\n---\nCLI test task.\n');

  const okRun = spawnSync(process.execPath, ['scripts/measure.mjs', 'prompt', '--project', dir, taskFile], {
    encoding: 'utf8'
  });
  assert.equal(okRun.status, 0);
  const parsed = JSON.parse(okRun.stdout);
  assert.equal(parsed.kind, 'prompt-size');
  assert.equal(parsed.tasks[0].file, taskFile);
  assert.ok(parsed.tasks[0].promptBytes > 0);

  const unknownRun = spawnSync(process.execPath, ['scripts/measure.mjs', 'unknown'], {
    encoding: 'utf8'
  });
  assert.equal(unknownRun.status, 1);
  assert.match(unknownRun.stderr, /usage:/);

  const noFilesRun = spawnSync(process.execPath, ['scripts/measure.mjs', 'prompt'], {
    encoding: 'utf8'
  });
  assert.equal(noFilesRun.status, 1);
  assert.match(noFilesRun.stderr, /at least one task file required/);

  const missingRun = spawnSync(process.execPath, ['scripts/measure.mjs', 'prompt', '--project', dir, 'missing.md'], {
    encoding: 'utf8'
  });
  assert.equal(missingRun.status, 1);
  assert.match(missingRun.stderr, /measure:/);
});

test('reportRuns: empty and missing runs dir -> runs 0 per group, no unreadable', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'zc-empty-runs-'));
  const missingDir = join(tmpdir(), `zc-missing-${Date.now()}`);

  const res = reportRuns({ dirs: [emptyDir, missingDir] });
  assert.equal(res.kind, 'run-report');
  assert.deepEqual(res.unreadable, []);
  assert.equal(res.groups.all.runs, 0);
  assert.equal(res.groups.all.attempts, 0);
  assert.equal(res.groups.all.repairRuns, 0);
  assert.deepEqual(res.groups.all.statuses, {});
  assert.equal(res.groups.all.metrics.promptBytes.n, 0);
  assert.equal(res.groups.all.metrics.promptBytes.missing, 0);
  assert.equal(res.groups.all.metrics.promptBytes.min, null);
  assert.equal(res.groups.all.metrics.attemptsPerRun.n, 0);
  assert.equal(res.groups.all.metrics.attemptsPerRun.missing, 0);
  assert.equal(res.groups.all.metrics.verifyDurationMs.n, 0);
});

test('reportRuns: malformed JSON file and a JSON array file -> both in unreadable, report still produced', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'zc-bad-runs-'));
  const badJsonDir = join(runsDir, 'run-bad-json');
  const arrayJsonDir = join(runsDir, 'run-array');
  const validDir = join(runsDir, 'run-valid');
  mkdirSync(badJsonDir, { recursive: true });
  mkdirSync(arrayJsonDir, { recursive: true });
  mkdirSync(validDir, { recursive: true });

  const badJsonFile = join(badJsonDir, 'result.json');
  writeFileSync(badJsonFile, '{broken json');
  const arrayJsonFile = join(arrayJsonDir, 'result.json');
  writeFileSync(arrayJsonFile, JSON.stringify([1, 2, 3]));
  const validFile = join(validDir, 'result.json');
  writeFileSync(validFile, JSON.stringify({ runId: 'run-valid', status: 'OK', attempts: [] }));

  const res = reportRuns({ dirs: [runsDir] });
  assert.equal(res.kind, 'run-report');
  assert.equal(res.unreadable.length, 2);
  const unreadablePaths = res.unreadable.map((u) => u.path);
  assert.ok(unreadablePaths.includes(badJsonFile));
  assert.ok(unreadablePaths.includes(arrayJsonFile));
  for (const u of res.unreadable) {
    assert.ok(typeof u.error === 'string' && u.error.length > 0);
  }
  assert.equal(res.groups.all.runs, 1);
  assert.deepEqual(res.groups.all.statuses, { OK: 1 });
});

test('reportRuns: a result with attempts lacking metrics -> promptBytes.missing counts it, n excludes it, no zero in min', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'zc-missing-metrics-'));
  const run1Dir = join(runsDir, 'run1');
  mkdirSync(run1Dir, { recursive: true });
  writeFileSync(
    join(run1Dir, 'result.json'),
    JSON.stringify({
      runId: 'run1',
      status: 'OK',
      attempts: [
        {},
        { metrics: { promptBytes: 500 } }
      ]
    })
  );

  const res = reportRuns({ dirs: [runsDir] });
  const pb = res.groups.all.metrics.promptBytes;
  assert.equal(pb.n, 1);
  assert.equal(pb.missing, 1);
  assert.equal(pb.min, 500);
  assert.equal(pb.max, 500);
  assert.equal(pb.mean, 500);
  assert.equal(pb.median, 500);
  assert.notEqual(pb.min, 0);
});

test('reportRuns: representative valid results (two runs, one with repairOf, statuses OK and VERIFY_FAILED, usage present) -> correct counts, median/mean/min/max', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'zc-valid-runs-'));
  const run1Dir = join(runsDir, 'run-1');
  const run2Dir = join(runsDir, 'run-2');
  mkdirSync(run1Dir, { recursive: true });
  mkdirSync(run2Dir, { recursive: true });

  const run1 = {
    runId: 'run-1',
    status: 'OK',
    repairOf: null,
    verifyDurationMs: 120,
    attempts: [
      {
        durationMs: 1000,
        metrics: {
          promptBytes: 400,
          turns: 2,
          tools: { total: 4, failed: 0 },
          usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
        }
      }
    ]
  };

  const run2 = {
    runId: 'run-2',
    status: 'VERIFY_FAILED',
    repairOf: 'run-1',
    verifyDurationMs: 240,
    attempts: [
      {
        durationMs: 2000,
        metrics: {
          promptBytes: 600,
          turns: 4,
          tools: { total: 6, failed: 1 },
          usage: { input_tokens: 2000, output_tokens: 300, total_tokens: 2300 }
        }
      },
      {
        durationMs: 3000,
        metrics: {
          promptBytes: 800,
          turns: 6,
          tools: { total: 8, failed: 2 },
          usage: { input_tokens: 3000, output_tokens: 400, total_tokens: 3400 }
        }
      }
    ]
  };

  writeFileSync(join(run1Dir, 'result.json'), JSON.stringify(run1));
  writeFileSync(join(run2Dir, 'result.json'), JSON.stringify(run2));

  const res = reportRuns({ dirs: [runsDir] });
  const all = res.groups.all;

  assert.equal(all.runs, 2);
  assert.deepEqual(all.statuses, { OK: 1, VERIFY_FAILED: 1 });
  assert.equal(all.repairRuns, 1);
  assert.equal(all.attempts, 3);

  assert.deepEqual(all.metrics.attemptsPerRun, {
    n: 2,
    missing: 0,
    median: 1.5,
    mean: 1.5,
    min: 1,
    max: 2
  });

  assert.deepEqual(all.metrics.verifyDurationMs, {
    n: 2,
    missing: 0,
    median: 180,
    mean: 180,
    min: 120,
    max: 240
  });

  assert.deepEqual(all.metrics.promptBytes, {
    n: 3,
    missing: 0,
    median: 600,
    mean: 600,
    min: 400,
    max: 800
  });

  assert.deepEqual(all.metrics.turns, {
    n: 3,
    missing: 0,
    median: 4,
    mean: 4,
    min: 2,
    max: 6
  });

  assert.deepEqual(all.metrics.toolsTotal, {
    n: 3,
    missing: 0,
    median: 6,
    mean: 6,
    min: 4,
    max: 8
  });

  assert.deepEqual(all.metrics.toolsFailed, {
    n: 3,
    missing: 0,
    median: 1,
    mean: 1,
    min: 0,
    max: 2
  });

  assert.deepEqual(all.metrics.workerInputTokens, {
    n: 3,
    missing: 0,
    median: 2000,
    mean: 2000,
    min: 1000,
    max: 3000
  });

  assert.deepEqual(all.metrics.workerOutputTokens, {
    n: 3,
    missing: 0,
    median: 300,
    mean: 300,
    min: 200,
    max: 400
  });

  assert.deepEqual(all.metrics.workerTotalTokens, {
    n: 3,
    missing: 0,
    median: 2300,
    mean: 2300,
    min: 1200,
    max: 3400
  });

  assert.deepEqual(all.metrics.attemptDurationMs, {
    n: 3,
    missing: 0,
    median: 2000,
    mean: 2000,
    min: 1000,
    max: 3000
  });

  assert.deepEqual(res.notes, [
    'promptBytes is prompt size, not token usage.',
    'worker*Tokens are Gemini worker usage reported by agy; they say nothing about Claude (manager) token use.',
    'missing counts entries without that field; they are never counted as zero.'
  ]);
});

test('reportRuns: split puts runs into before/after/undated correctly, invalid split throws', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'zc-split-runs-'));
  const bDir = join(runsDir, 'run-before');
  const aDir = join(runsDir, 'run-after');
  const uDir = join(runsDir, 'run-undated');
  mkdirSync(bDir, { recursive: true });
  mkdirSync(aDir, { recursive: true });
  mkdirSync(uDir, { recursive: true });

  writeFileSync(
    join(bDir, 'result.json'),
    JSON.stringify({ runId: 'run-b', status: 'OK', startedAt: '2026-11-01T10:00:00.000Z', attempts: [] })
  );
  writeFileSync(
    join(aDir, 'result.json'),
    JSON.stringify({ runId: 'run-a', status: 'OK', startedAt: '2026-11-10T10:00:00.000Z', attempts: [] })
  );
  writeFileSync(
    join(uDir, 'result.json'),
    JSON.stringify({ runId: 'run-u', status: 'OK', startedAt: 'not-a-valid-date', attempts: [] })
  );

  const res = reportRuns({ dirs: [runsDir], split: '2026-11-05T00:00:00.000Z' });
  assert.equal(res.split, '2026-11-05T00:00:00.000Z');
  assert.equal(res.groups.before.runs, 1);
  assert.equal(res.groups.after.runs, 1);
  assert.equal(res.groups.undated.runs, 1);

  assert.throws(
    () => reportRuns({ dirs: [runsDir], split: 'invalid-date' }),
    /invalid split/i
  );
});

test('reportRuns: report is read-only: file mtimes and contents unchanged after reportRuns', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'zc-readonly-runs-'));
  const runDir = join(runsDir, 'run-1');
  mkdirSync(runDir, { recursive: true });
  const resultPath = join(runDir, 'result.json');
  const initialContent = JSON.stringify({ runId: 'run-1', status: 'OK', attempts: [] }, null, 2);
  writeFileSync(resultPath, initialContent);

  const beforeStat = statSync(resultPath);
  const beforeContent = readFileSync(resultPath, 'utf8');

  reportRuns({ dirs: [runsDir] });

  const afterStat = statSync(resultPath);
  const afterContent = readFileSync(resultPath, 'utf8');

  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(afterContent, beforeContent);
});

test('comparePromptSizes: deltas correct for paired files, different rulePacks/maxChars -> comparable false, wrong kind throws, unpaired listed', () => {
  assert.throws(
    () => comparePromptSizes({ kind: 'other' }, { kind: 'prompt-size' }),
    /prompt-size/
  );
  assert.throws(
    () => comparePromptSizes({ kind: 'prompt-size' }, { kind: 'other' }),
    /prompt-size/
  );

  const diffPacks = comparePromptSizes(
    { kind: 'prompt-size', rulePacks: ['dart'], maxChars: 1000, tasks: [] },
    { kind: 'prompt-size', rulePacks: ['typescript'], maxChars: 1000, tasks: [] }
  );
  assert.equal(diffPacks.kind, 'prompt-compare');
  assert.equal(diffPacks.comparable, false);
  assert.match(diffPacks.reason, /rulePacks differ/i);
  assert.deepEqual(diffPacks.tasks, []);

  const diffChars = comparePromptSizes(
    { kind: 'prompt-size', rulePacks: ['common'], maxChars: 1000, tasks: [] },
    { kind: 'prompt-size', rulePacks: ['common'], maxChars: 2000, tasks: [] }
  );
  assert.equal(diffChars.comparable, false);
  assert.match(diffChars.reason, /maxChars differ/i);
  assert.deepEqual(diffChars.tasks, []);

  const pre = {
    kind: 'prompt-size',
    commit: 'c11111',
    generatedAt: '2026-11-01T00:00:00.000Z',
    rulePacks: ['common'],
    maxChars: 50000,
    tasks: [
      { file: 'tasks/task1.md', promptBytes: 1000, eccRulesChars: 500 },
      { file: 'tasks/pre-only.md', promptBytes: 400, eccRulesChars: 500 }
    ]
  };

  const post = {
    kind: 'prompt-size',
    commit: 'c22222',
    generatedAt: '2026-11-02T00:00:00.000Z',
    rulePacks: ['common'],
    maxChars: 50000,
    tasks: [
      { file: 'tasks/task1.md', promptBytes: 1100, eccRulesChars: 520 },
      { file: 'tasks/post-only.md', promptBytes: 600, eccRulesChars: 520 }
    ]
  };

  const comp = comparePromptSizes(pre, post);
  assert.equal(comp.kind, 'prompt-compare');
  assert.equal(comp.comparable, true);
  assert.deepEqual(comp.pre, { commit: 'c11111', generatedAt: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(comp.post, { commit: 'c22222', generatedAt: '2026-11-02T00:00:00.000Z' });
  assert.equal(comp.tasks.length, 1);
  assert.deepEqual(comp.tasks[0], {
    file: 'tasks/task1.md',
    preBytes: 1000,
    postBytes: 1100,
    deltaBytes: 100,
    deltaPct: 10,
    preRulesChars: 500,
    postRulesChars: 520
  });
  assert.deepEqual(comp.unpaired.sort(), ['tasks/post-only.md', 'tasks/pre-only.md']);
});

test('measure CLI: runs and compare subcommands', () => {
  const runsHome = mkdtempSync(join(tmpdir(), 'zc-cli-runs-'));
  const run1Dir = join(runsHome, 'run-1');
  mkdirSync(run1Dir, { recursive: true });
  writeFileSync(
    join(run1Dir, 'result.json'),
    JSON.stringify({ runId: 'run-1', status: 'OK', attempts: [] })
  );

  const runsMissing = spawnSync(
    process.execPath,
    ['scripts/measure.mjs', 'runs', '--project', join(tmpdir(), 'non-existent-proj')],
    { encoding: 'utf8' }
  );
  assert.equal(runsMissing.status, 0);
  const parsedRunsMissing = JSON.parse(runsMissing.stdout);
  assert.equal(parsedRunsMissing.kind, 'run-report');
  assert.equal(parsedRunsMissing.groups.all.runs, 0);

  const preFile = join(runsHome, 'pre.json');
  const postFile = join(runsHome, 'post.json');
  const sizeData = {
    kind: 'prompt-size',
    rulePacks: ['common'],
    maxChars: 5000,
    tasks: [{ file: 't1.md', promptBytes: 100, eccRulesChars: 50 }]
  };
  writeFileSync(preFile, JSON.stringify(sizeData));
  writeFileSync(postFile, JSON.stringify({
    ...sizeData,
    tasks: [{ file: 't1.md', promptBytes: 150, eccRulesChars: 50 }]
  }));

  const compareCli = spawnSync(
    process.execPath,
    ['scripts/measure.mjs', 'compare', preFile, postFile],
    { encoding: 'utf8' }
  );
  assert.equal(compareCli.status, 0);
  const parsedComp = JSON.parse(compareCli.stdout);
  assert.equal(parsedComp.kind, 'prompt-compare');
  assert.equal(parsedComp.tasks[0].deltaBytes, 50);

  const compareMissing = spawnSync(
    process.execPath,
    ['scripts/measure.mjs', 'compare', preFile],
    { encoding: 'utf8' }
  );
  assert.equal(compareMissing.status, 1);
  assert.match(compareMissing.stderr, /compare requires two files/);
});
