import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as accounts from './accounts.mjs';
import { checkAccount, findAgy, hasTokenFile, loginAccount } from './agy.mjs';
import { parseArgs } from './args.mjs';
import { detectStack, loadConfig } from './config.mjs';
import { dispatch, formatResult, getRun, listRuns, rejectRun } from './dispatch.mjs';
import * as G from './gitx.mjs';
import { configPath, stateRoot } from './paths.mjs';
import { run } from './proc.mjs';
import { DEFAULT_PREFIX } from './prompt.mjs';
import { parseTask, splitArgv } from './task.mjs';

const HELP = `zc — Claude manages, Gemini workers implement (one at a time, in place)

Project (run inside the git repo):
  zc init                                 create .zc/ config for this project
  zc dispatch --task <file> [--json]      run one task on the next ready worker account
  zc dispatch --prompt "<text>" --allow <glob> [--verify "<cmd>"] [--id <id>]
  zc dispatch --repair <runId> --task <file>   send feedback on top of a worker's uncommitted result
  zc reject [<runId>] [--force]           discard a worker's uncommitted result (saved first)
  zc runs                                 recent runs
  zc status                               accounts, cooldowns, latest run
  zc doctor                               check this machine and project

Accounts (machine-global):
  zc account add <id> [--no-login]        create an isolated profile and sign in
  zc account login <id>                   sign in again
  zc account check [<id>]                 verify sign-in and read quota windows
  zc account list | reset <id> | remove <id>

Dispatch exit codes: 0 done and verified | 1 failed/rejected/verify failed | 2 no capacity (all cooling) | 3 needs a human
Options: --project <dir>  --json  --dry-run  --minutes <n>`;

function projectRoot(opts) {
  const root = G.toplevel(resolve(opts.project ?? process.cwd()));
  if (!root) throw new Error('not inside a git repository');
  return root;
}

const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');

function cmdInit(root) {
  const file = configPath(root);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const detected = detectStack(root);
  const config = {
    version: 1,
    verify: detected.verify,
    defaults: { onLimit: 'reset' },
    worker: { permissions: 'edit' },
    ecc: { path: '', rulePacks: detected.rulePacks }
  };
  mkdirSync(join(root, '.zc', 'tasks'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, '.zc', 'worker-prefix.md'), `${DEFAULT_PREFIX}\n`);
  writeFileSync(join(root, '.zc', 'progress.md'), '# Progress log\n\nOne line per accepted task: date, task id, run id, commit.\n');
  writeFileSync(join(root, '.zc', 'tasks', 'TEMPLATE.md'), [
    '---', 'id: T-001', 'title: Short name', 'allowed:', '  - src/example/', 'verify:', '  - npm test', 'minutes: 30', '---',
    'Objective: one sentence.', '', 'Files to create or change: ...', '', 'Acceptance tests: ...', '', 'Constraints: ...', ''
  ].join('\n'));
  console.log(`zc: initialised ${join(root, '.zc')} (detected: ${detected.stack})`);
  console.log('next: review .zc/config.json (verify commands, ecc.path), commit .zc/, then `zc account add <id>`.');
}

async function cmdAccount(argv) {
  const [sub, id, ...rest] = argv;
  const opts = parseArgs(rest, { bool: ['no-login'] });
  switch (sub) {
    case 'add': {
      if (!id) throw new Error('usage: zc account add <id>');
      const account = accounts.addAccount(id);
      console.log(`zc: created profile ${account.profileDir}`);
      if (opts['no-login']) return;
      await signIn(account);
      return;
    }
    case 'login': {
      const account = accounts.getAccount(id);
      if (!account) throw new Error(`unknown account "${id}"`);
      await signIn(account);
      return;
    }
    case 'check': {
      const targets = id ? [accounts.getAccount(id)].filter(Boolean) : accounts.listAccounts();
      if (!targets.length) throw new Error(id ? `unknown account "${id}"` : 'no accounts yet');
      for (const account of targets) await verifyAccount(account);
      return;
    }
    case 'list': return printAccounts();
    case 'reset':
      accounts.resetAccount(id);
      console.log(`zc: ${id} cleared; run \`zc account check ${id}\` to confirm it works`);
      return;
    case 'remove':
      accounts.removeAccount(id);
      console.log(`zc: removed ${id} (its profile folder was left on disk)`);
      return;
    default: throw new Error('usage: zc account add|login|check|list|reset|remove');
  }
}

async function signIn(account) {
  console.log(`zc: signing in "${account.id}". Sign in with the Google account meant for THIS worker, then exit agy.`);
  const result = await loginAccount(account);
  if (result.error) throw new Error(result.error);
  await verifyAccount(account);
}

async function verifyAccount(account) {
  const r = await checkAccount(account);
  if (r.ok) {
    accounts.updateAccount(account.id, {
      status: account.status === 'blocked' ? 'blocked' : 'ready',
      usage: r.limits, checkedAt: new Date().toISOString()
    });
    const low = r.limits.length ? Math.min(...r.limits.map((l) => l.remainingPercent)) : null;
    console.log(`zc: ${account.id} OK${low === null ? '' : ` (lowest quota window: ${low}% left)`}`);
  } else {
    accounts.updateAccount(account.id, { status: 'needs-login', holdReason: r.text.slice(0, 200) });
    console.log(`zc: ${account.id} NOT signed in — ${r.error || r.text || 'no output'}`);
  }
  if (!hasTokenFile(account.profileDir)) {
    console.log(`zc: warning — no token file found inside ${account.profileDir}. If this agy version stores credentials in the OS keyring, accounts may share one identity. See docs/ACCOUNTS.md before adding more.`);
  }
}

function printAccounts() {
  const list = accounts.listAccounts();
  if (!list.length) return console.log('zc: no accounts. Add one with `zc account add <id>`.');
  const now = Date.now();
  const current = accounts.currentId();
  for (const a of list) {
    const hold = (a.cooldownUntil || 0) > now ? ` cooling until ${fmtTime(a.cooldownUntil)} (${a.holdReason})` : a.holdReason && a.status !== 'ready' ? ` (${a.holdReason})` : '';
    const low = a.usage?.length ? ` quota>=${Math.min(...a.usage.map((l) => l.remainingPercent))}%` : '';
    console.log(`${a.id === current ? '*' : ' '} ${a.id.padEnd(14)} ${a.status.padEnd(12)}${low}${hold}`);
  }
}

function readTask(opts, root) {
  let task;
  if (opts.task) {
    task = parseTask(readFileSync(resolve(opts.task), 'utf8'), { fallbackId: basename(opts.task).replace(/\.\w+$/, '') });
  } else if (opts.prompt) {
    task = parseTask(`---\nid: ${opts.id ?? 'adhoc'}\n---\n${opts.prompt}`, { fallbackId: 'adhoc' });
  } else throw new Error('give --task <file> or --prompt "<text>"');
  task.meta.allowed.push(...(opts.allow ?? []));
  task.meta.verify.push(...(opts.verify ?? []).map(splitArgv));
  if (opts.minutes) task.meta.minutes = Number(opts.minutes);
  if (opts.repair && !task.meta.allowed.length) {
    const prev = getRun(root, opts.repair);
    if (prev?.allowed) task.meta.allowed = [...prev.allowed]; // a repair inherits the original scope
  }
  return task;
}

async function cmdDispatch(argv) {
  const opts = parseArgs(argv, { bool: ['json', 'dry-run'], multi: ['allow', 'verify'] });
  const root = projectRoot(opts);
  const config = loadConfig(root);
  const task = readTask(opts, root);
  const result = await dispatch({
    root, task, config, repairOf: opts.repair ?? null, dryRun: Boolean(opts['dry-run']),
    log: (line) => console.error(`zc: ${line}`)
  });
  if (result.status === 'DRY_RUN') {
    console.log(result.prompt);
    return 0;
  }
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result.exitCode;
}

async function cmdDoctor(argv) {
  const opts = parseArgs(argv);
  const checks = [];
  const add = (name, ok, detail = '', fix = '', level = 'fail') => checks.push({ name, ok, detail, fix, level });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node >= 22', nodeMajor >= 22, process.version, 'install Node.js 22 or newer');
  const gitv = await run('git', ['--version']);
  add('git', gitv.code === 0, gitv.stdout.trim(), 'install git');
  let agyOk = false;
  try {
    const spec = findAgy();
    const v = await run(spec.command, [...spec.prefix, '--version'], { timeoutMs: 15_000 });
    agyOk = true;
    add('agy (Antigravity CLI)', true, (v.stdout || v.stderr).trim().split('\n')[0] || 'found');
  } catch (error) {
    add('agy (Antigravity CLI)', false, '', error.message);
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const claude = await run(lookup, ['claude']);
  add('claude (Claude Code)', claude.code === 0, claude.stdout.trim().split(/\r?\n/)[0] ?? '', 'install Claude Code and sign in');
  const list = accounts.listAccounts();
  add('worker accounts ready', list.some((a) => a.status === 'ready'), `${list.filter((a) => a.status === 'ready').length}/${list.length} ready`, 'zc account add <id>');
  const root = G.toplevel(resolve(opts.project ?? process.cwd()));
  if (root) {
    try {
      const config = loadConfig(root);
      add('.zc/config.json', true, root);
      const eccPath = config.ecc.path || process.env.ZC_ECC_PATH;
      if (config.ecc.rulePacks.length) {
        add('ECC rules for workers', Boolean(eccPath && existsSync(join(eccPath, 'rules'))), eccPath || 'ecc.path not set', 'set ecc.path in .zc/config.json to a checkout of ECC (workers get no hooks; rules travel in the prompt)', 'warn');
      }
    } catch (error) {
      add('.zc/config.json', false, '', error.message);
    }
  } else add('git repository', false, '', 'run inside a project (or pass --project)');
  console.log(`state: ${stateRoot()}   platform: ${process.platform}`);
  for (const c of checks) {
    const tag = c.ok ? 'ok  ' : c.level === 'warn' ? 'warn' : 'FAIL';
    console.log(`${tag} ${c.name}${c.detail ? ` — ${c.detail}` : ''}${!c.ok && c.fix ? `\n       fix: ${c.fix}` : ''}`);
  }
  console.log('note: confirm the ECC plugin is installed in Claude Code with `/plugin list` (zc cannot see inside Claude Code).');
  return checks.every((c) => c.ok || c.level === 'warn') ? 0 : 1;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
      case 'init': cmdInit(projectRoot(parseArgs(rest))); return 0;
      case 'account': await cmdAccount(rest); return 0;
      case 'dispatch': return await cmdDispatch(rest);
      case 'doctor': return await cmdDoctor(rest);
      case 'reject': {
        const opts = parseArgs(rest, { bool: ['force'] });
        const out = rejectRun({ root: projectRoot(opts), runId: opts._[0], force: Boolean(opts.force) });
        console.log(`zc: ${out.rolledBack ? 'discarded' : 'nothing discarded'} (run ${out.runId})${out.note ? ` — ${out.note}` : ''}`);
        return out.stuck?.length ? 3 : 0;
      }
      case 'runs': {
        for (const r of listRuns(projectRoot(parseArgs(rest)), 15)) console.log(`${r.runId}  ${r.status.padEnd(15)} ${r.taskId}  ${r.account ?? '-'}`);
        return 0;
      }
      case 'status': {
        const opts = parseArgs(rest);
        printAccounts();
        const root = G.toplevel(resolve(opts.project ?? process.cwd()));
        const last = root ? listRuns(root, 1)[0] : null;
        if (last) console.log(`\nlatest run: ${last.runId} ${last.status} (${last.taskId})`);
        return 0;
      }
      default:
        console.error(`zc: unknown command "${command}"\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    console.error(`zc: ${error.message}`);
    return 3;
  }
}
