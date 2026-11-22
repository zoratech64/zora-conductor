import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs the test suite with TMPDIR pointing at one per-run directory, then
 * removes it. Fixtures a test forgets to delete cannot pile up in the shared
 * temp dir (a full /tmp once stopped every command on this machine).
 * Extra arguments are passed to `node --test`; the exit code is forwarded.
 */
const root = mkdtempSync(join(realpathSync(tmpdir()), 'zc-run-'));
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };
const args = ['--test', ...(process.argv.length > 2 ? process.argv.slice(2) : ['test/*.test.mjs'])];

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) {
    process.stderr.write(`could not remove ${root}: ${error.message}\n`);
  }
}

const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
// The child shares our process group, so a terminal Ctrl-C reaches it directly.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); cleanup(); process.exit(1); });
child.on('close', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1));
});
