// Child for test/concurrency.test.mjs: dispatch one task, retrying while every account is busy.
import { dispatch } from '../src/dispatch.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseTask } from '../src/task.mjs';

const [root, ...flags] = process.argv.slice(2);
const task = parseTask('---\nid: T-1\nallowed:\n  - src/\n---\nDo it.');
let result;
let busy = 0;
for (;;) {
  result = await dispatch({ root, task, config: loadConfig(root) });
  if (result.status !== 'NO_CAPACITY' || !['all-reserved', 'max-projects'].includes(result.reason)) break;
  busy++;
  await new Promise((r) => setTimeout(r, 40));
}
process.stdout.write(JSON.stringify({ status: result.status, account: result.account, busy, reason: result.reason, nextAction: result.nextAction, orphan: result.orphan, signal: result.signal }));
if (flags.includes('--exit-code')) process.exitCode = result.exitCode;
