import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatch, effectiveVerify } from '../src/dispatch.mjs';
import { FAIL, addFake, makeHome, makeRepo, task } from './helpers.mjs';

const PASS = [process.execPath, '-e', 'process.exit(0)'];
const PASS2 = [process.execPath, '-e', 'process.exit(0) // distinct PASS'];

test('effectiveVerify: project only when task verify is empty', () => {
  const project = [['npm', 'test']];
  const effective = effectiveVerify(project, []);
  assert.deepEqual(effective, [['npm', 'test']]);
  assert.notEqual(effective, project);
});

test('effectiveVerify: task adds after project in order', () => {
  const project = [['cmd1', 'arg1'], ['cmd2']];
  const taskVerify = [['cmd3'], ['cmd4', 'arg4']];
  const effective = effectiveVerify(project, taskVerify);
  assert.deepEqual(effective, [['cmd1', 'arg1'], ['cmd2'], ['cmd3'], ['cmd4', 'arg4']]);
});

test('effectiveVerify: exact duplicates deduped, keeping first occurrence and task order', () => {
  const project = [['cmd1', 'arg'], ['cmd2']];
  const taskVerify = [['cmd1', 'arg'], ['cmd3'], ['cmd3'], ['cmd2']];
  const effective = effectiveVerify(project, taskVerify);
  assert.deepEqual(effective, [['cmd1', 'arg'], ['cmd2'], ['cmd3']]);
});

test('effectiveVerify: [["npm","test"]] and [["npm test"]] are not duplicates and both are kept', () => {
  const effective = effectiveVerify([['npm', 'test']], [['npm test']]);
  assert.deepEqual(effective, [['npm', 'test'], ['npm test']]);
});

test('effectiveVerify: empty or missing task list returns project list as a new array', () => {
  const project = [['npm', 'test']];
  const effectiveEmpty = effectiveVerify(project, []);
  assert.deepEqual(effectiveEmpty, [['npm', 'test']]);
  assert.notEqual(effectiveEmpty, project);

  const effectiveUndefined = effectiveVerify(project, undefined);
  assert.deepEqual(effectiveUndefined, [['npm', 'test']]);
  assert.notEqual(effectiveUndefined, project);
});

test('effectiveVerify: inputs not mutated', () => {
  const pCmd = ['cmd1'];
  const tCmd = ['cmd2'];
  const project = Object.freeze([Object.freeze(pCmd)]);
  const taskVerify = Object.freeze([Object.freeze(tCmd)]);
  const effective = effectiveVerify(project, taskVerify);
  assert.deepEqual(effective, [['cmd1'], ['cmd2']]);
  assert.equal(project.length, 1);
  assert.equal(taskVerify.length, 1);
});

test('dispatch with project verify [FAIL] and task passing command: VERIFY_FAILED, FAIL in result.verify, verifyPlan lists both', async () => {
  makeHome();
  const { dir, config } = makeRepo({ verify: [FAIL] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok' } });
  const t = task('id: T-VG1\nallowed:\n  - src/');
  t.meta.verify = [PASS];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'VERIFY_FAILED');
  assert.equal(r.verify.length, 1);
  assert.equal(r.verify[0].cmd, FAIL.join(' '));
  assert.equal(r.verify[0].ok, false);
  assert.deepEqual(r.verifyPlan, [FAIL.join(' '), PASS.join(' ')]);
});

test('dispatch with project [PASS] and task [FAIL]: VERIFY_FAILED, task check still runs, failure propagates', async () => {
  makeHome();
  const { dir, config } = makeRepo({ verify: [PASS] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok' } });
  const t = task('id: T-VG2\nallowed:\n  - src/');
  t.meta.verify = [FAIL];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'VERIFY_FAILED');
  assert.equal(r.verify.length, 2);
  assert.equal(r.verify[0].cmd, PASS.join(' '));
  assert.equal(r.verify[0].ok, true);
  assert.equal(r.verify[1].cmd, FAIL.join(' '));
  assert.equal(r.verify[1].ok, false);
  assert.deepEqual(r.verifyPlan, [PASS.join(' '), FAIL.join(' ')]);
});

test('dispatch with project [PASS] and task [second distinct PASS]: OK and both appear in result.verify', async () => {
  makeHome();
  const { dir, config } = makeRepo({ verify: [PASS] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'ok' } });
  const t = task('id: T-VG3\nallowed:\n  - src/');
  t.meta.verify = [PASS2];
  const r = await dispatch({ root: dir, task: t, config });
  assert.equal(r.status, 'OK');
  assert.equal(r.verify.length, 2);
  assert.equal(r.verify[0].cmd, PASS.join(' '));
  assert.equal(r.verify[0].ok, true);
  assert.equal(r.verify[1].cmd, PASS2.join(' '));
  assert.equal(r.verify[1].ok, true);
  assert.deepEqual(r.verifyPlan, [PASS.join(' '), PASS2.join(' ')]);
});

test('dry-run prompt for a task with its own verify lists the project command under "Completion gates"', async () => {
  const { dir, config } = makeRepo({ verify: [PASS] });
  const t = task('id: T-VG4\nallowed:\n  - src/');
  t.meta.verify = [PASS2];
  const r = await dispatch({ root: dir, task: t, config, dryRun: true });
  assert.equal(r.status, 'DRY_RUN');
  assert.match(r.prompt, /Completion gates/);
  assert.match(r.prompt, new RegExp(PASS.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.prompt, new RegExp(PASS2.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
