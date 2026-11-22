// Reports (never gates by itself): registry lease latency and the throughput of two projects dispatched at
// once against the fake agy, relative to the same two dispatched one after the other.
// Targets from the validation plan: p99 acquire+release well under 100 ms, two-project speedup >= 1.8x.
// Run: node scripts/measure-concurrency.mjs [cycles] [holdMs]
// --check exits 1 only past generous CI thresholds (p99 500 ms, speedup 1.3x); the targets themselves are reported, not enforced.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { openRegistry } from '../src/registry.mjs';
import { addFake, makeHome, makeRepo } from '../test/helpers.mjs'; // isolates state into temp dirs

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const check = process.argv.includes('--check');
const CYCLES = Number(args[0] ?? 300);
const HOLD_MS = Number(args[1] ?? 800);
const DRIVER = resolve(import.meta.dirname, '../test/dispatch-driver.mjs');

function latency() {
  makeHome();
  const reg = openRegistry();
  const samples = [];
  for (let i = 0; i < CYCLES; i++) {
    const t0 = process.hrtime.bigint();
    reg.acquireLease({ key: 'k', kind: 'account', runId: `r${i}`, ownerPid: process.pid });
    reg.releaseLease('k', `r${i}`);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  reg.close();
  samples.sort((a, b) => a - b);
  const at = (p) => Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(2));
  return { cycles: CYCLES, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1) };
}

const drive = (dir) => new Promise((done) => {
  const child = spawn(process.execPath, [DRIVER, dir], { env: process.env, stdio: 'ignore' });
  child.on('exit', (code) => done(code));
});

async function throughput() {
  makeHome();
  for (const id of ['g1', 'g2']) addFake(id, { mode: 'ok', write: { 'src/a.txt': '1' }, holdMs: HOLD_MS });
  const a = makeRepo().dir;
  const b = makeRepo().dir;
  const t0 = Date.now();
  await drive(a);
  await drive(b);
  const sequentialMs = Date.now() - t0;
  const c = makeRepo().dir;
  const d = makeRepo().dir;
  const t1 = Date.now();
  await Promise.all([drive(c), drive(d)]);
  const parallelMs = Date.now() - t1;
  return { holdMs: HOLD_MS, sequentialMs, parallelMs, speedup: Number((sequentialMs / parallelMs).toFixed(2)) };
}

const lat = latency();
const thr = await throughput();
const report = { latency: lat, throughput: thr, targets: { p99Ms: 100, speedup: 1.8 }, met: { p99: lat.p99Ms <= 100, speedup: thr.speedup >= 1.8 } };
console.log(JSON.stringify(report, null, 2));
if (check && !(lat.p99Ms <= 500 && thr.speedup >= 1.3)) process.exit(1);
