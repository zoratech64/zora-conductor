import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { groupAlive, isAlive, processIdentity, scanProfileUsers } from '../src/procid.mjs';

const LINUX = process.platform === 'linux';
const linuxOnly = LINUX ? {} : { skip: 'needs /proc (Linux)' };
const posixOnly = process.platform === 'win32' ? { skip: 'POSIX symlinks and paths' } : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** Child that prints "ready" then idles; options pass through to spawn. */
function idler(options = {}, code = 'console.log("ready"); setInterval(() => {}, 1000)') {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], ...options });
  const ready = new Promise((resolve) => child.stdout.once('data', resolve));
  return { child, ready };
}

function stop(child) {
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
}

/** Minimal fake /proc entry. `fd` and `cwd` are symlink targets. */
function fakeProc(root, pid, { stat, environ = '', cmdline = '', cwd = '/', fds = [], bootId, uid = process.getuid?.() ?? 0 } = {}) {
  const dir = join(root, String(pid));
  mkdirSync(join(dir, 'fd'), { recursive: true });
  writeFileSync(join(dir, 'stat'), stat ?? `${pid} (agy) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0`);
  writeFileSync(join(dir, 'status'), `Name:\tagy\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(dir, 'environ'), environ);
  writeFileSync(join(dir, 'cmdline'), cmdline);
  symlinkSync(cwd, join(dir, 'cwd'));
  fds.forEach((target, i) => symlinkSync(target, join(dir, 'fd', String(i))));
  if (bootId) {
    mkdirSync(join(root, 'sys', 'kernel', 'random'), { recursive: true });
    writeFileSync(join(root, 'sys', 'kernel', 'random', 'boot_id'), `${bootId}\n`);
  }
  return dir;
}

test('processIdentity: own process has start ticks, boot id and uid', linuxOnly, () => {
  const id = processIdentity(process.pid);
  assert.equal(id.pid, process.pid);
  assert.equal(id.identity, 'linux-proc');
  assert.ok(Number.isInteger(id.startTicks) && id.startTicks > 0);
  assert.match(id.bootId, /^[0-9a-f-]{36}$/);
  assert.equal(id.uid, process.getuid());
  assert.ok(isAlive(id));
});

test('isAlive: pid reused with a different start time is dead', linuxOnly, () => {
  const id = processIdentity(process.pid);
  assert.equal(isAlive({ ...id, startTicks: id.startTicks + 1 }), false);
});

test('isAlive: changed boot id is dead', linuxOnly, () => {
  const id = processIdentity(process.pid);
  assert.equal(isAlive({ ...id, bootId: '00000000-0000-0000-0000-000000000000' }), false);
});

test('isAlive: exited process is dead, even before it is reaped (zombie)', linuxOnly, async () => {
  const { child, ready } = idler();
  await ready;
  const id = processIdentity(child.pid);
  assert.ok(isAlive(id));
  process.kill(child.pid, 'SIGKILL');
  await waitFor(() => !isAlive(id), 'child to count as dead');
  const after = processIdentity(child.pid);
  assert.ok(after === null || after.state === 'Z');
});

test('processIdentity: missing pid gives null', linuxOnly, () => {
  const sync = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(processIdentity(sync.pid), null);
});

test('non-Linux platform reports pid-only identity and an unknown scan', () => {
  const id = processIdentity(process.pid, { platform: 'win32' });
  assert.deepEqual(id, { pid: process.pid, identity: 'pid-only' });
  assert.ok(isAlive(id, { platform: 'win32' }));
  assert.deepEqual(scanProfileUsers(tmpdir(), { platform: 'darwin' }),
    { verdict: 'unknown', identity: 'pid-only', pids: [], unreadable: [] });
  assert.equal(groupAlive(1, { platform: 'win32' }).verdict, 'unknown');
});

test('groupAlive: live group found, dead group none', linuxOnly, async () => {
  const { child, ready } = idler({ detached: true });
  await ready;
  assert.deepEqual(groupAlive(child.pid), { verdict: 'found', pids: [child.pid] });
  process.kill(-child.pid, 'SIGKILL');
  await waitFor(() => groupAlive(child.pid).verdict === 'none', 'group to vanish');
});

test('scanProfileUsers: real process with the profile HOME is found', linuxOnly, async () => {
  const profile = tmp('zc-prof-');
  const { child, ready } = idler({ env: { ...process.env, HOME: join(profile, 'home') } });
  try {
    await ready;
    const r = scanProfileUsers(profile);
    assert.equal(r.verdict, 'found');
    assert.ok(r.pids.includes(child.pid));
  } finally { stop(child); rmSync(profile, { recursive: true, force: true }); }
});

test('scanProfileUsers: setsid-escaped grandchild that keeps the profile HOME is found', linuxOnly, async () => {
  const profile = tmp('zc-prof-');
  const grandchildCode = 'console.log("ready"); setInterval(() => {}, 1000)';
  const parentCode = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    g.stdout.once('data', () => { console.log(g.pid); process.exit(0); });`;
  const parent = spawn(process.execPath, ['-e', parentCode], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, HOME: join(profile, 'home') }
  });
  let grandchildPid = 0;
  try {
    grandchildPid = Number(await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(String(d).trim()))));
    await waitFor(() => processIdentity(parent.pid) === null || processIdentity(parent.pid).state === 'Z', 'parent exit');
    assert.notEqual(groupAlive(parent.pid).verdict, 'found', 'grandchild left the parent group');
    const r = scanProfileUsers(profile);
    assert.equal(r.verdict, 'found');
    assert.ok(r.pids.includes(grandchildPid));
  } finally {
    if (grandchildPid) stop({ pid: grandchildPid });
    stop(parent);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('scanProfileUsers: cleared env and argv but an open fd under the profile is found', linuxOnly, async () => {
  const profile = tmp('zc-prof-');
  const file = join(profile, 'held.log');
  writeFileSync(file, 'x');
  const code = `require('node:fs').openSync(${JSON.stringify(file)}, 'r'); process.chdir('/'); console.log('ready'); setInterval(() => {}, 1000)`;
  const { child, ready } = idler({ env: { PATH: process.env.PATH } }, code);
  try {
    await ready;
    const r = scanProfileUsers(profile);
    assert.equal(r.verdict, 'found');
    assert.ok(r.pids.includes(child.pid));
  } finally { stop(child); rmSync(profile, { recursive: true, force: true }); }
});

test('scanProfileUsers: cleared env, no fd, cwd under the profile is found', linuxOnly, async () => {
  const profile = tmp('zc-prof-');
  const { child, ready } = idler({ env: { PATH: process.env.PATH }, cwd: profile });
  try {
    await ready;
    const r = scanProfileUsers(profile);
    assert.equal(r.verdict, 'found');
    assert.ok(r.pids.includes(child.pid));
  } finally { stop(child); rmSync(profile, { recursive: true, force: true }); }
});

test('scanProfileUsers: unrelated live processes give none', linuxOnly, async () => {
  const profile = tmp('zc-prof-');
  const other = tmp('zc-other-');
  const { child, ready } = idler({ env: { ...process.env, HOME: other }, cwd: other });
  try {
    await ready;
    const r = scanProfileUsers(profile);
    assert.notEqual(r.verdict, 'found');
    assert.ok(!r.pids.includes(child.pid));
  } finally { stop(child); rmSync(profile, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('scanProfileUsers (fake /proc): argv --gemini_dir matches, both spellings', () => {
  const root = tmp('zc-proc-');
  const profile = '/data/profiles/g1';
  fakeProc(root, 101, { cmdline: ['agy', '--gemini_dir', profile, '-p'].join('\0') });
  fakeProc(root, 102, { cmdline: ['agy', `--gemini_dir=${profile}/`].join('\0') });
  fakeProc(root, 103, { cmdline: ['agy', '--gemini_dir', '/data/profiles/g10'].join('\0') });
  const r = scanProfileUsers(profile, { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.equal(r.verdict, 'found');
  assert.deepEqual(r.pids.sort(), [101, 102]);
});

test('scanProfileUsers (fake /proc): sibling profile with a common prefix does not match', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 201, { environ: 'HOME=/data/profiles/g10/home\0', cwd: '/data/profiles/g10' });
  const r = scanProfileUsers('/data/profiles/g1', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.deepEqual(r, { verdict: 'none', identity: 'linux-proc', pids: [], unreadable: [] });
});

test('scanProfileUsers (fake /proc): unreadable entry makes the verdict unknown, never none', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 301, {});
  const dir = fakeProc(root, 302, {});
  rmSync(join(dir, 'environ'));
  mkdirSync(join(dir, 'environ')); // reading a directory fails with EISDIR, like EACCES for dumpable=0
  const r = scanProfileUsers('/data/profiles/g1', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.equal(r.verdict, 'unknown');
  assert.deepEqual(r.pids, []);
  assert.deepEqual(r.unreadable, [302]);
});

test('scanProfileUsers (fake /proc): found wins over unknown', () => {
  const root = tmp('zc-proc-');
  const dir = fakeProc(root, 401, {});
  rmSync(join(dir, 'environ'));
  mkdirSync(join(dir, 'environ'));
  fakeProc(root, 402, { environ: 'HOME=/data/profiles/g1/home\0' });
  const r = scanProfileUsers('/data/profiles/g1', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.equal(r.verdict, 'found');
  assert.deepEqual(r.pids, [402]);
});

test('scanProfileUsers (fake /proc): zombies and the scanner itself are ignored', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 501, { stat: '501 (agy) Z 1 501 501 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0', environ: 'HOME=/data/profiles/g1/home\0' });
  fakeProc(root, 502, { environ: 'HOME=/data/profiles/g1/home\0' });
  const r = scanProfileUsers('/data/profiles/g1', { procRoot: root, platform: 'linux', selfPid: 502 });
  assert.equal(r.verdict, 'none');
});

test('processIdentity (fake /proc): comm with spaces and parens still parses start ticks', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 601, {
    stat: '601 (we ird) name)) S 1 601 601 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 77777 0 0',
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  });
  const id = processIdentity(601, { procRoot: root, platform: 'linux' });
  assert.equal(id.startTicks, 77777);
  assert.equal(id.bootId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

test('isAlive (fake /proc): zombie of the same process is dead', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 701, { bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
  const id = processIdentity(701, { procRoot: root, platform: 'linux' });
  assert.ok(isAlive(id, { procRoot: root, platform: 'linux' }));
  writeFileSync(join(root, '701', 'stat'), '701 (agy) Z 1 701 701 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0');
  assert.equal(isAlive(id, { procRoot: root, platform: 'linux' }), false);
});

function unreadableOldProcess(root, startTicks) {
  const dir = fakeProc(root, 801, {
    stat: `801 (systemd) S 1 801 801 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0`,
    bootId: 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  });
  rmSync(join(dir, 'environ'));
  mkdirSync(join(dir, 'environ'));
}

test('scanProfileUsers (fake /proc): unreadable process older than the worker cannot be its descendant', () => {
  const root = tmp('zc-proc-');
  unreadableOldProcess(root, 5000);
  const base = { procRoot: root, platform: 'linux', selfPid: 0 };
  const boot = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  assert.equal(scanProfileUsers('/p/g1', { ...base, startedAfter: { startTicks: 6000, bootId: boot } }).verdict, 'none');
  // equal or newer start time: it could be a descendant, so stay unknown
  assert.equal(scanProfileUsers('/p/g1', { ...base, startedAfter: { startTicks: 5000, bootId: boot } }).verdict, 'unknown');
  assert.equal(scanProfileUsers('/p/g1', { ...base, startedAfter: { startTicks: 4000, bootId: boot } }).verdict, 'unknown');
  // start ticks from another boot are not comparable
  assert.equal(scanProfileUsers('/p/g1', { ...base, startedAfter: { startTicks: 6000, bootId: 'other-boot' } }).verdict, 'unknown');
  assert.equal(scanProfileUsers('/p/g1', base).verdict, 'unknown');
});

test('scanProfileUsers (fake /proc): readable old process using the profile is still found', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 901, { environ: 'HOME=/p/g1/home\0', bootId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' });
  const r = scanProfileUsers('/p/g1', {
    procRoot: root, platform: 'linux', selfPid: 0, startedAfter: { startTicks: 9000, bootId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }
  });
  assert.equal(r.verdict, 'found');
});

test('scanProfileUsers (fake /proc): unreadable same-user process is unknown even if /proc/<pid> is root-owned; foreign user is skipped', () => {
  const root = tmp('zc-proc-');
  for (const [pid, uid] of [[1001, process.getuid?.() ?? 0], [1002, ((process.getuid?.() ?? 0) + 1)]]) {
    const dir = fakeProc(root, pid, { uid });
    rmSync(join(dir, 'environ'));
    mkdirSync(join(dir, 'environ'));
  }
  const r = scanProfileUsers('/p/g1', { procRoot: root, platform: 'linux', selfPid: 0, uid: process.getuid?.() ?? 0 });
  assert.deepEqual(r.unreadable, [1001]);
});

test('scanProfileUsers (fake /proc): XDG_RUNTIME_DIR, trailing slash and non-ASCII profile paths match', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 1101, { environ: 'XDG_RUNTIME_DIR=/p/g1/run\0' });
  fakeProc(root, 1102, { environ: 'HOME=/p/prof\u00e9/home\0' });
  fakeProc(root, 1103, { cmdline: ['agy', '--gemini_dir', '/p/prof\u00e9'].join('\0') });
  const a = scanProfileUsers('/p/g1/', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.deepEqual(a.pids, [1101]);
  const b = scanProfileUsers('/p/prof\u00e9', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.deepEqual(b.pids.sort(), [1102, 1103]);
});

test('scanProfileUsers (fake /proc): symlinked profile dir resolves to its real path; deleted suffix still matches', posixOnly, () => {
  const root = tmp('zc-proc-');
  const real = realpathSync(tmp('zc-real-'));
  const link = join(tmp('zc-link-'), 'g1');
  symlinkSync(real, link);
  fakeProc(root, 1201, { cwd: real });
  fakeProc(root, 1202, { fds: [`${real}/x.log (deleted)`] });
  const r = scanProfileUsers(link, { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.deepEqual(r.pids.sort(), [1201, 1202]);
});

test('scanProfileUsers (fake /proc): process that vanishes mid-scan is clear', () => {
  const root = tmp('zc-proc-');
  const dir = fakeProc(root, 1301, {});
  rmSync(join(dir, 'environ')); // ENOENT, as when the process exits between reads
  const r = scanProfileUsers('/p/g1', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.equal(r.verdict, 'none');
});

test('scanProfileUsers (fake /proc): zombie leader with a live thread holding the profile is found', () => {
  const root = tmp('zc-proc-');
  const dir = fakeProc(root, 1401, {
    stat: '1401 (agy) Z 1 1401 1401 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0', environ: 'HOME=/p/g1/home\0'
  });
  mkdirSync(join(dir, 'task', '1402'), { recursive: true });
  writeFileSync(join(dir, 'task', '1402', 'stat'), '1402 (agy) S 1 1401 1401 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0');
  assert.deepEqual(scanProfileUsers('/p/g1', { procRoot: root, platform: 'linux', selfPid: 0 }).pids, [1401]);
});

test('groupAlive (fake /proc): unreadable entry unknown, zombie-only group none, corrupt stat unknown', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 1501, { stat: '1501 (agy) Z 1 1501 1501 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0' });
  assert.equal(groupAlive(1501, { procRoot: root, platform: 'linux' }).verdict, 'none');
  writeFileSync(join(root, '1501', 'stat'), 'garbage');
  assert.equal(groupAlive(1501, { procRoot: root, platform: 'linux' }).verdict, 'unknown');
  assert.equal(groupAlive(1501, { procRoot: join(root, 'missing'), platform: 'linux' }).verdict, 'unknown');
});

test('invalid pids are rejected and a vanished process is dead, not an error', () => {
  assert.throws(() => processIdentity(0), TypeError);
  assert.throws(() => groupAlive(-1), TypeError);
  const root = tmp('zc-proc-');
  const dir = fakeProc(root, 1601, { bootId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' });
  const id = processIdentity(1601, { procRoot: root, platform: 'linux' });
  rmSync(join(dir, 'status'));
  assert.equal(isAlive(id, { procRoot: root, platform: 'linux' }), false);
});

test('input validation: bad ids, uid, startedAfter, profileDir and a procfs that cannot see us', () => {
  assert.throws(() => isAlive({ pid: 5 }), TypeError);
  assert.throws(() => isAlive({ pid: 5, identity: 'linux-proc', startTicks: 'x', bootId: 'b' }), TypeError);
  assert.throws(() => isAlive(null), TypeError);
  const root = tmp('zc-proc-');
  const base = { procRoot: root, platform: 'linux', selfPid: 0 };
  assert.throws(() => scanProfileUsers('/p/g1', { ...base, uid: '1000' }), TypeError);
  assert.throws(() => scanProfileUsers('/p/g1', { ...base, startedAfter: { startTicks: Infinity, bootId: 'x' } }), TypeError);
  assert.throws(() => scanProfileUsers('/', base), TypeError);
  assert.throws(() => scanProfileUsers('', base), TypeError);
  assert.equal(scanProfileUsers('/p/g1', { ...base, selfPid: 4242 }).verdict, 'unknown');
});

test('malformed stat and status fields are errors, not zeros; dotted env paths still match', () => {
  const root = tmp('zc-proc-');
  fakeProc(root, 1701, { stat: '1701 (agy) S  1701 0 0 0' });
  assert.equal(groupAlive(1701, { procRoot: root, platform: 'linux' }).verdict, 'unknown');
  fakeProc(root, 1702, { environ: 'HOME=/p/x/../g1/./home\0' });
  const r = scanProfileUsers('/p/g1', { procRoot: root, platform: 'linux', selfPid: 0 });
  assert.ok(r.pids.includes(1702));
});
