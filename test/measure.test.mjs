import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/dispatch.mjs';
import { head } from '../src/gitx.mjs';
import { parseTask } from '../src/task.mjs';
import { measurePrompts } from '../scripts/measure.mjs';
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
