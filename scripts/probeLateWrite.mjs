// Repeatable probe for late writes during and after verify. Run manually, not part of npm test.
import { acceptRun, dispatch } from '../src/dispatch.mjs';
import { addFake, git, makeHome, makeRepo, task } from '../test/helpers.mjs';

const DEFAULT_DELAYS = [0, 1, 2, 5, 10, 20, 60, 100, 200, 300, 450, 600];
const DEFAULT_REPEATS = 2;
const WAIT_MS = 900;

function parseList(str) {
  const nums = str
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  return nums.length > 0 ? nums : DEFAULT_DELAYS;
}

function parseCount(val) {
  const n = Number(val);
  return !Number.isNaN(n) && n > 0 ? n : DEFAULT_REPEATS;
}

function parseArgs(argv) {
  let delays = DEFAULT_DELAYS;
  let repeats = DEFAULT_REPEATS;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/probeLateWrite.mjs [delays] [repeats]');
      console.log('  delays   Comma-separated delays in ms (default: 0,1,2,5,10,20,60,100,200,300,450,600)');
      console.log('  repeats  Repeat count per delay (default: 2)');
      process.exit(0);
    }
    if (arg.startsWith('--delays=')) {
      delays = parseList(arg.slice(9));
    } else if (arg === '--delays' && i + 1 < argv.length) {
      delays = parseList(argv[++i]);
    } else if (arg.startsWith('--repeat=') || arg.startsWith('--repeats=')) {
      repeats = parseCount(arg.split('=')[1]);
    } else if ((arg === '--repeat' || arg === '--repeats') && i + 1 < argv.length) {
      repeats = parseCount(argv[++i]);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    delays = parseList(positional[0]);
  }
  if (positional.length > 1) {
    repeats = parseCount(positional[1]);
  }

  return { delays, repeats };
}

function makeLauncherScript(delay) {
  const childScript = delay > 0
    ? `setTimeout(() => { require('node:fs').writeFileSync('src/a.txt', 'EVIL'); }, ${delay});`
    : `require('node:fs').writeFileSync('src/a.txt', 'EVIL');`;

  return [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });`,
    'child.unref();',
    'process.exit(0);'
  ].join('\n');
}

function classifyOutcome({ result, accepted, acceptError, stagedContent }) {
  if (stagedContent.includes('EVIL') || accepted) {
    return 'FAIL';
  }
  if (result.status === 'OK' && result.verifyChanged?.includes('src/a.txt')) {
    return 'before-check';
  }
  if (
    result.status === 'OK' &&
    (!result.verifyChanged || !result.verifyChanged.includes('src/a.txt')) &&
    acceptError?.includes('ambiguous ownership')
  ) {
    return 'after-check';
  }
  return 'FAIL';
}

async function runTrial(delay) {
  makeHome();
  const { dir, config } = makeRepo({ verify: [] });
  addFake('g1', { mode: 'ok', write: { 'src/a.txt': 'a' } });

  const t = task('id: T-probe\nallowed:\n  - src/\n');
  t.meta.verify = [[process.execPath, '-e', makeLauncherScript(delay)]];

  const result = await dispatch({ root: dir, task: t, config });

  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  let accepted = false;
  let acceptError = null;
  try {
    acceptRun({ root: dir, runId: result.runId, config });
    accepted = true;
  } catch (err) {
    acceptError = err.message;
  }

  let stagedContent = '';
  try {
    stagedContent = git(dir, 'show', ':src/a.txt');
  } catch {
    stagedContent = '';
  }

  return classifyOutcome({ result, accepted, acceptError, stagedContent });
}

async function main() {
  const { delays, repeats } = parseArgs(process.argv.slice(2));
  const counts = { 'before-check': 0, 'after-check': 0, FAIL: 0 };

  for (const delay of delays) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      let classification = 'FAIL';
      try {
        classification = await runTrial(delay);
      } catch {
        classification = 'FAIL';
      }
      counts[classification] = (counts[classification] ?? 0) + 1;
      console.log(`delay ${delay}ms #${repeat}: ${classification}`);
    }
  }

  console.log('\ncounts:');
  console.log(`before-check: ${counts['before-check']}`);
  console.log(`after-check: ${counts['after-check']}`);
  console.log(`FAIL: ${counts['FAIL']}`);
  if (counts['before-check'] === 0) {
    console.log('note: window not reached');
  }

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
