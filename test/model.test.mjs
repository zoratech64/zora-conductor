import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODEL, loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { addFake, makeHome, makeRepo, task } from './helpers.mjs';

const FAST = { capacityWaitSeconds: [0.05, 0.05], networkWaitSeconds: [0.05, 0.05] };
const scoped = () => task('id: T-1\nallowed:\n  - src/\n');
const modelArg = (account) => {
  const args = JSON.parse(readFileSync(join(account.profileDir, 'last-args.json'), 'utf8'));
  const i = args.indexOf('--model');
  return i < 0 ? null : args[i + 1];
};

test('default model is gemini-4-hydrogen-medium, also for configs that never named a model', () => {
  assert.equal(DEFAULT_MODEL, 'gemini-4-hydrogen-medium');
  const { config } = makeRepo({ worker: { permissions: 'edit' } });
  assert.equal(config.worker.model, DEFAULT_MODEL);
  assert.equal(makeRepo().config.worker.model, DEFAULT_MODEL);
});

test('configured model overrides are kept, including "" and "auto"', () => {
  assert.equal(makeRepo({ worker: { model: 'gemini-3.8-flash-high' } }).config.worker.model, 'gemini-3.8-flash-high');
  assert.equal(makeRepo({ worker: { model: '' } }).config.worker.model, '');
  assert.equal(makeRepo({ worker: { model: 'auto' } }).config.worker.model, 'auto');
});

test('every attempt, retry and fallback account runs the default model', async () => {
  makeHome();
  const { dir, config } = makeRepo({ defaults: { ...FAST, maxAttempts: 3 } });
  const g1 = addFake('g1', { mode: 'capacity', failTimes: 1, write: { 'src/a.txt': 'a' } });
  const r = await dispatch({ root: dir, task: scoped(), config });
  assert.equal(r.status, 'OK');
  assert.equal(r.attempts.length, 2, 'the capacity retry ran');
  assert.equal(modelArg(g1), DEFAULT_MODEL);
});

test('a configured model wins over the default', async () => {
  makeHome();
  const { dir, config } = makeRepo({ worker: { model: 'gemini-4-hydrogen-high' } });
  const g1 = addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });
  assert.equal((await dispatch({ root: dir, task: scoped(), config })).status, 'OK');
  assert.equal(modelArg(g1), 'gemini-4-hydrogen-high');
  assert.equal(loadConfig(dir).worker.model, 'gemini-4-hydrogen-high');
});
