// Reports registry transaction latency. Informational: run by hand, never a CI pass/fail.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry } from '../src/registry.mjs';

const dir = join(mkdtempSync(join(tmpdir(), 'zc-measure-')), 'registry');
const reg = openRegistry({ dir });
const samples = [];
const N = Number(process.argv[2] ?? 500);
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  reg.acquireLease({ key: 'k', kind: 'account', runId: `r${i}`, ownerPid: process.pid });
  reg.releaseLease('k', `r${i}`);
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
reg.close();
samples.sort((a, b) => a - b);
const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(2);
console.log(JSON.stringify({ cycles: N, unit: 'ms per acquire+release', p50: at(0.5), p99: at(0.99), max: at(1) }));
