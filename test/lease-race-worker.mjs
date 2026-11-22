// Child process for test/concurrency.test.mjs: tries to take one project lease once, reports, and holds it until stdin closes.
import { acquireProjectLease } from '../src/lease-project.mjs';

const [root, runId] = process.argv.slice(2);
const deps = process.platform === 'linux' ? { platform: 'linux', isolation: 'dbus' } : {};
let release = null;
try {
  release = acquireProjectLease({ root, runId, deps });
  process.stdout.write('won\n');
} catch {
  process.stdout.write('lost\n');
}
process.stdin.resume();
process.stdin.on('end', () => { try { release?.(); } catch { /* exiting */ } process.exit(0); });
