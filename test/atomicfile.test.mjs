import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { sweepTemp, writeFileAtomic, writeJsonAtomic } from '../src/atomicfile.mjs';

const POSIX = process.platform !== 'win32';
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'zc-atomic-')));
const MODULE = new URL('../src/atomicfile.mjs', import.meta.url).href;
const POINTS = ['before-write', 'after-write', 'before-fsync', 'before-rename', 'after-rename'];

test('writes a new file (0600), creating parent directories', { skip: !POSIX && 'POSIX modes' }, () => {
  const file = join(tmp(), 'a', 'b', 'x.json');
  writeFileAtomic(file, 'hello');
  assert.equal(readFileSync(file, 'utf8'), 'hello');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('an explicit mode is applied exactly, even under a restrictive umask', { skip: !POSIX && 'POSIX modes' }, () => {
  const old = process.umask(0o077);
  try {
    const dir = tmp();
    writeFileAtomic(join(dir, 'a'), 'x', { mode: 0o664 });
    assert.equal(statSync(join(dir, 'a')).mode & 0o777, 0o664);
    writeFileAtomic(join(dir, 'a'), 'y');
    assert.equal(statSync(join(dir, 'a')).mode & 0o777, 0o664, 'rewrite keeps the group bit');
  } finally { process.umask(old); }
});

test('a successful write sweeps old temp files of dead writers', () => {
  const dir = tmp();
  const stale = join(dir, 'x.json.999999997.old.tmp');
  writeFileSync(stale, 'partial');
  const past = new Date(Date.now() - 3600_000);
  utimesSync(stale, past, past);
  writeFileAtomic(join(dir, 'x.json'), '{}');
  assert.equal(existsSync(stale), false);
});

test('replacing a file keeps its mode', { skip: !POSIX && 'POSIX modes' }, () => {
  const file = join(tmp(), 'x');
  writeFileSync(file, 'old');
  chmodSync(file, 0o640);
  writeFileAtomic(file, 'new');
  assert.equal(readFileSync(file, 'utf8'), 'new');
  assert.equal(statSync(file).mode & 0o777, 0o640);
});

test('a throwing fault point at any stage leaves the old complete file and no temp file', () => {
  for (const point of POINTS.slice(0, 4)) {
    const file = join(tmp(), 'x');
    writeFileSync(file, 'old');
    assert.throws(() => writeFileAtomic(file, 'new', { fault: (p) => { if (p === point) throw new Error(`fault ${p}`); } }), /fault/);
    assert.equal(readFileSync(file, 'utf8'), 'old', point);
    assert.deepEqual(readdirSync(join(file, '..')), ['x'], `${point} leaves no temp file`);
  }
});

test('a fault after the rename leaves the new complete file', () => {
  const file = join(tmp(), 'x');
  writeFileSync(file, 'old');
  assert.throws(() => writeFileAtomic(file, 'new', { fault: (p) => { if (p === 'after-rename') throw new Error('late'); } }), /late/);
  assert.equal(readFileSync(file, 'utf8'), 'new');
});

test('a process killed at each fault point leaves either the old or the new complete file', { skip: !POSIX && 'POSIX signals' }, () => {
  for (const point of POINTS) {
    const dir = tmp();
    const file = join(dir, 'x.json');
    writeFileSync(file, JSON.stringify({ v: 'old' }));
    const code = `import { writeFileAtomic } from ${JSON.stringify(MODULE)};
      writeFileAtomic(${JSON.stringify(file)}, JSON.stringify({ v: 'new', pad: 'x'.repeat(100000) }),
        { fault: (p) => { if (p === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL'); } });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code]);
    assert.equal(r.signal, 'SIGKILL', point);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.v, point === 'after-rename' ? 'new' : 'old', point);
  }
});

test('leftover temp files of dead writers are ignored by readers and swept', () => {
  const dir = tmp();
  const file = join(dir, 'x.json');
  writeFileSync(file, '{"ok":true}');
  writeFileSync(join(dir, 'x.json.999999999.abcd.tmp'), 'partial');
  writeFileSync(join(dir, 'x.json.notanumber.tmp'), 'junk');
  writeFileSync(join(dir, 'other.txt'), 'keep');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true });
  const removed = sweepTemp(file, { minAgeMs: 0 });
  assert.deepEqual(removed, ['x.json.999999999.abcd.tmp']);
  assert.deepEqual(readdirSync(dir).sort(), ['other.txt', 'x.json', 'x.json.notanumber.tmp']);
  writeFileSync(join(dir, `x.json.${process.pid}.live.tmp`), 'mine');
  assert.deepEqual(sweepTemp(file, { minAgeMs: 0 }), [], 'a live writer temp file is never swept');
  writeFileSync(join(dir, 'x.json.999999998.fresh.tmp'), 'new');
  assert.deepEqual(sweepTemp(file), [], 'a young temp file is kept even when its pid looks dead');
  assert.deepEqual(sweepTemp(join(dir, 'missing', 'y.json')), [], 'missing directory is not an error');
});

test('writeJsonAtomic writes pretty JSON with a trailing newline', () => {
  const file = join(tmp(), 'x.json');
  writeJsonAtomic(file, { a: 1 });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
});

test('write failure (target is a directory) leaves no temp file behind', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'x'));
  assert.throws(() => writeFileAtomic(join(dir, 'x'), 'data'));
  assert.deepEqual(readdirSync(dir), ['x']);
});

test('concurrent writers never interleave: every read is one writer\'s complete payload', { timeout: 120000 }, async () => {
  const dir = tmp();
  const file = join(dir, 'shared.json');
  writeFileSync(file, JSON.stringify({ w: -1, body: '' }));
  const writer = (id) => `import { writeJsonAtomic } from ${JSON.stringify(MODULE)};
    for (let i = 0; i < 60; i++) writeJsonAtomic(${JSON.stringify(file)}, { w: ${id}, i, body: String(${id}).repeat(200000) });`;
  const children = [1, 2, 3, 4].map((id) => new Promise((done, fail) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', writer(id)], { stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? done() : fail(new Error(`writer ${id} exit ${code}`))));
  }));
  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM') continue; // Windows: file briefly locked by the rename
        throw error;
      }
      if (parsed.w > 0) assert.equal(parsed.body, String(parsed.w).repeat(200000), 'payload is one writer\'s own bytes');
      reads++;
      await new Promise((r) => setImmediate(r));
    }
  })();
  await Promise.all(children);
  stop = true;
  await reader;
  assert.ok(reads > 0);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files remain');
  assert.equal(existsSync(file), true);
});

test('defaultMode applies to new files only; mode forces; undefined JSON is refused', { skip: !POSIX && 'POSIX modes' }, () => {
  const dir = tmp();
  const f = join(dir, 'c.json');
  writeJsonAtomic(f, { a: 1 }, { defaultMode: 0o644 });
  assert.equal(statSync(f).mode & 0o777, 0o644);
  chmodSync(f, 0o600);
  writeJsonAtomic(f, { a: 2 }, { defaultMode: 0o644 });
  assert.equal(statSync(f).mode & 0o777, 0o600, 'existing mode kept');
  chmodSync(f, 0o644);
  writeJsonAtomic(f, { a: 3 }, { mode: 0o600 });
  assert.equal(statSync(f).mode & 0o777, 0o600, 'forced mode wins');
  assert.throws(() => writeJsonAtomic(f, undefined), TypeError);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).a, 3);
});
