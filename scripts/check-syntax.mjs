// Syntax-check every source file without running it.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dirs = ['bin', 'src', 'test', 'fixtures', 'scripts'];
let failed = 0;
for (const dir of dirs) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.mjs')); } catch { continue; }
  for (const name of names) {
    const r = spawnSync(process.execPath, ['--check', join(dir, name)], { encoding: 'utf8' });
    if (r.status !== 0) { failed++; console.error(`${dir}/${name}\n${r.stderr}`); }
  }
}
console.log(failed ? `${failed} file(s) failed` : 'syntax ok');
process.exitCode = failed ? 1 : 0;
