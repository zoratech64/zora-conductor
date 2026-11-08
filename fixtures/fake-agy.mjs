#!/usr/bin/env node
// Test double for the Antigravity CLI. Behaviour comes from <gemini_dir>/scenario.json so each
// fake account can act differently:
//   { mode: ok|quota|auth|license|location|server|slow|permission, write: {path: content},
//     partial: true (write files, then fail), failTimes: N (misbehave N times, then succeed),
//     commit: true (also git commit, to simulate a worker moving HEAD), signedOut: true (/usage fails),
//     chmod: {path: octal-mode} (change permissions, e.g. make a folder unreadable) }
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('fake-agy 0.0.0'); process.exit(0); }
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const dir = val('--gemini_dir');
mkdirSync(dir, { recursive: true });
const scenarioFile = join(dir, 'scenario.json');
const scenario = existsSync(scenarioFile) ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : { mode: 'ok' };

const pIndex = argv.indexOf('-p');
if (pIndex >= 0 && argv[pIndex + 1] === '/usage') {
  if (scenario.signedOut) { console.error('Authentication required. Please sign in.'); process.exit(1); }
  console.log('Gemini Models\tFive Hour Limit Remaining\t80%\t2099-01-01T00:00:00Z');
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input.trim().split('\n')[0]).message.content;
writeFileSync(join(dir, 'last-prompt.txt'), prompt);
appendFileSync(join(dir, 'calls.log'), 'call\n');
const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).length;
writeFileSync(join(dir, 'last-args.json'), JSON.stringify(argv));

const cwd = val('--add-dir') ?? process.cwd();
const emit = (obj) => console.log(JSON.stringify(obj));
const writeFiles = () => {
  for (const path of scenario.delete ?? []) rmSync(join(cwd, path), { force: true });
  for (const [path, content] of Object.entries(scenario.write ?? {})) {
    const full = join(cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [path, mode] of Object.entries(scenario.chmod ?? {})) chmodSync(join(cwd, path), Number.parseInt(mode, 8));
};
const failResult = (message) => {
  emit({ event: 'result', result: { status: 'ERROR', error: message, num_turns: 1 } });
  process.exit(1);
};

let mode = scenario.mode ?? 'ok';
if (mode !== 'ok' && calls > (scenario.failTimes ?? Infinity)) mode = 'ok';

if (mode === 'ok' || scenario.partial) writeFiles();

switch (mode) {
  case 'quota': failResult('RESOURCE_EXHAUSTED: quota exceeded. Please try again in 30 minutes.'); break;
  case 'license': failResult('403 SUBSCRIPTION_REQUIRED: you do not have a valid license of this product'); break;
  case 'location': failResult('User location is not supported for the API use.'); break;
  case 'server': failResult('Internal error encountered'); break;
  case 'auth': console.error('Authentication required. Please sign in.'); process.exit(1); break;
  case 'slow': await new Promise((resolve) => setTimeout(resolve, 60_000)); break;
  case 'denied-empty':
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' }, error: { message: 'permission check failed for unsandboxed "ls -la": user denied permission to run command' } } } });
    emit({ event: 'result', result: { status: 'SUCCESS', response: '', num_turns: 1, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    process.exit(0);
    break;
  case 'permission':
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed: headless mode cannot prompt' } } } });
    emit({ event: 'result', result: { status: 'CANCELED', response: '', num_turns: 1 } });
    process.exit(0);
    break;
  default: {
    if (scenario.commit) {
      execFileSync('git', ['add', '-A'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', 'worker commit'], { cwd });
    }
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_to_file', tool_info: {} } });
    emit({ event: 'result', result: { status: 'SUCCESS', response: scenario.response ?? 'done: implemented the task', num_turns: 2, conversation_id: 'c1', usage: { input_tokens: 10, output_tokens: 5 } } });
  }
}
