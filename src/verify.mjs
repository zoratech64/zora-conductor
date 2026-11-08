import { run } from './proc.mjs';

const tail = (text, lines = 30) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

/** Run the project's verification commands (argv arrays, no shell); stop at the first failure. */
export async function runVerify(root, commands, { timeoutMs }) {
  const results = [];
  for (const argv of commands) {
    const [command, ...args] = argv;
    const r = await run(command, args, { cwd: root, env: process.env, timeoutMs });
    const ok = r.code === 0 && !r.timedOut && !r.error;
    results.push({
      cmd: argv.join(' '),
      ok,
      code: r.code,
      timedOut: r.timedOut,
      tail: tail(`${r.error ? `${r.error}\n` : ''}${r.stdout}\n${r.stderr}`)
    });
    if (!ok) break;
  }
  return results;
}
