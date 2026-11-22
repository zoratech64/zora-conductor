// Child process for test/concurrency.test.mjs: loops acquire/release on shared keys.
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openRegistry } from '../src/registry.mjs';

const [dir, heldDir, cyclesText, keysText, tag] = process.argv.slice(2);
const cycles = Number(cyclesText);
const keys = Number(keysText);
mkdirSync(heldDir, { recursive: true });
const reg = openRegistry({ dir });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let done = 0;
let duplicates = 0;
let attempts = 0;
while (done < cycles) {
  const key = `k${(done + Number(tag)) % keys}`;
  const runId = `${tag}-${done}-${attempts}`;
  attempts++;
  const got = reg.acquireLease({ key, kind: 'account', runId, projectKey: 'p', stateRoot: '/s', zcVersion: 'x', ownerPid: process.pid, ownerStart: 1, ownerBoot: 'b' });
  if (!got.acquired) { sleep(1); continue; }
  const marker = join(heldDir, key);
  try { closeSync(openSync(marker, 'wx')); } catch { duplicates++; }
  sleep(0);
  try { unlinkSync(marker); } catch { /* duplicate path */ }
  if (!reg.releaseLease(key, runId)) duplicates++;
  done++;
}
reg.close();
process.stdout.write(JSON.stringify({ done, duplicates, attempts }));
