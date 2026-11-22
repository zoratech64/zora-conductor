import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { noHooksDir, statusEntries } from '../src/gitx.mjs';
import { makeHome, makeRepo } from './helpers.mjs';

const POSIX = process.platform !== 'win32';
const GITX = resolve(import.meta.dirname, '../src/gitx.mjs');

test('the hooks directory is created once and keeps its identity across calls', () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  const first = statSync(noHooksDir(dir));
  for (let i = 0; i < 20; i++) statusEntries(dir);
  const last = statSync(noHooksDir(dir));
  assert.equal(`${last.dev}:${last.ino}`, `${first.dev}:${first.ino}`, 'never removed and recreated');
  assert.deepEqual(readdirSync(noHooksDir(dir)), []);
  if (POSIX) assert.equal(last.mode & 0o022, 0, 'not writable by group or others');
});

test('8 concurrent processes on one project never see ENOENT or ENOTEMPTY', async () => {
  makeHome();
  const { dir } = makeRepo();
  const code = `import(${JSON.stringify(`file://${GITX.replace(/\\/g, '/')}`)}).then((g) => { for (let i = 0; i < 60; i++) g.statusEntries(${JSON.stringify(dir)}); });`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((done) => {
    let err = '';
    const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (status) => done({ status, err }));
  })));
  for (const r of runs) assert.deepEqual([r.status, r.err], [0, ''], r.err);
});

test('a planted plain file is removed before git runs; the directory itself stays', { skip: !POSIX && 'POSIX modes' }, () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  const before = statSync(noHooksDir(dir));
  writeFileSync(join(noHooksDir(dir), 'post-index-change'), '#!/bin/sh\nexit 0\n');
  statusEntries(dir);
  assert.deepEqual(readdirSync(noHooksDir(dir)), []);
  assert.equal(statSync(noHooksDir(dir)).ino, before.ino);
});

test('anything else in it fails closed and is left in place', { skip: !POSIX && 'POSIX modes' }, () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  const sub = join(noHooksDir(dir), 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'precious'), 'x');
  assert.throws(() => statusEntries(dir), (e) => e.code === 'ZC_NO_HOOKS_DIR' && /other than a plain file/.test(e.message));
  assert.equal(existsSync(join(sub, 'precious')), true, 'nothing was deleted recursively');
});

test('a symlink where the directory should be fails closed', { skip: !POSIX && 'symlinks' }, () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  const target = join(noHooksDir(dir), '..', 'elsewhere');
  mkdirSync(target);
  const link = noHooksDir(dir);
  // replace the empty directory with a link to another directory
  rmdirSync(link);
  symlinkSync(target, link);
  assert.throws(() => statusEntries(dir), (e) => e.code === 'ZC_NO_HOOKS_DIR' && /not a directory/.test(e.message));
});

test('an existing group-writable directory of ours is tightened', { skip: !POSIX && 'POSIX modes' }, () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  chmodSync(noHooksDir(dir), 0o775);
  statusEntries(dir);
  assert.equal(statSync(noHooksDir(dir)).mode & 0o777, 0o700);
});

test('8 processes cleaning the same planted files at once never abort', { skip: !POSIX && 'POSIX modes' }, async () => {
  makeHome();
  const { dir } = makeRepo();
  statusEntries(dir);
  const plant = () => { for (let i = 0; i < 30; i++) writeFileSync(join(noHooksDir(dir), `h${i}`), 'x'); };
  const code = `import(${JSON.stringify(`file://${GITX.replace(/\\/g, '/')}`)}).then((g) => g.statusEntries(${JSON.stringify(dir)}));`;
  for (let round = 0; round < 5; round++) {
    plant();
    const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((done) => {
      let err = '';
      const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (status) => done({ status, err }));
    })));
    for (const r of runs) assert.deepEqual([r.status, r.err], [0, ''], r.err);
  }
});
