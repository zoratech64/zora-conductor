import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as accounts from './accounts.mjs';
import { checkAccount, findAgy, hasTokenFile, isolationMode, loginAccount } from './agy.mjs';
import { parseArgs } from './args.mjs';
import { detectStack, loadConfig } from './config.mjs';
import { parseMinutes } from './limits.mjs';
import { dispatch, formatResult, getRun, listRuns, rejectRun } from './dispatch.mjs';
import * as G from './gitx.mjs';
import { configPath, stateRoot } from './paths.mjs';
import { run } from './proc.mjs';
import { loadEccRules } from './prompt.mjs';
import { DEFAULT_ASSET_BYTES, buildIndex, eccRoot, installFrom, installFromGit, loadAssets, parseSpec, readInstalled, searchIndex, validateCatalog } from './ecc.mjs';
import { parseTask, splitArgv } from './task.mjs';
import { TASK_TEMPLATE } from './template.mjs';

const HELP = `zc — Claude manages, Gemini workers implement (one at a time, in place)

Project (run inside the git repo):
  zc init                                 create .zc/ config for this project
  zc dispatch --task <file> [--json]      run one task on the next ready worker account
  zc dispatch --prompt "<text>" --allow <glob> [--verify "<cmd>"] [--ecc skill:<name>,agent:<name>] [--id <id>]
  zc dispatch --repair <runId> --task <file>   send feedback on top of a worker's uncommitted result
  zc reject [<runId>] [--force]           discard a worker's uncommitted result (saved first)
  zc runs                                 recent runs
  zc status                               accounts, cooldowns, latest run
  zc doctor                               check this machine and project
  zc ecc install|status|list|search|show  browse the whole ECC catalog and install it (workers can be given any asset)

Accounts (machine-global):
  zc account add <id> [--no-login]        create an isolated profile and sign in
  zc account login <id>                   sign in again
  zc account check [<id>]                 verify sign-in and read quota windows
  zc account list | reset <id> | remove <id>

Other:
  zc --version                            print the zora-conductor version

Dispatch exit codes: 0 done and verified | 1 failed/rejected/verify failed | 2 no capacity (all cooling) | 3 needs a human
Options: --project <dir>  --json  --dry-run  --minutes <n>`;

function projectRoot(opts) {
  const root = G.toplevel(resolve(opts.project ?? process.cwd()));
  if (!root) throw new Error('not inside a git repository');
  return root;
}

/** The installed zora-conductor version, read from this package's own package.json. */
function packageVersion() {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
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
  writeFileSync(join(root, '.zc', 'progress.md'), '# Progress log\n\nOne line per accepted task: date, task id, run id, commit.\n');
  writeFileSync(join(root, '.zc', 'tasks', 'TEMPLATE.md'), TASK_TEMPLATE);
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
  if (isolationMode() === 'none' && !hasTokenFile(account.profileDir)) {
    console.log(`zc: warning — isolation is off and no token file was found inside ${account.profileDir}. If agy keeps its login in the OS keyring, accounts may share one identity. See docs/ACCOUNTS.md.`);
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
  task.meta.ecc.push(...(opts.ecc ?? []).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean));
  task.meta.verify.push(...(opts.verify ?? []).map(splitArgv));
  if (opts.minutes !== undefined) task.meta.minutes = parseMinutes(opts.minutes === true ? '' : opts.minutes, '--minutes');
  if (opts.repair && !task.meta.allowed.length) {
    const prev = getRun(root, opts.repair);
    if (prev?.allowed) task.meta.allowed = [...prev.allowed]; // a repair inherits the original scope
  }
  return task;
}

async function cmdDispatch(argv) {
  const opts = parseArgs(argv, { bool: ['json', 'dry-run'], multi: ['allow', 'verify', 'ecc'] });
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


const parseEccArgs = (rest) => parseArgs(rest, { bool: ['json'] });

/**
 * ECC commands work outside a project too, so a missing project or missing .zc/config.json falls back to
 * defaults. A config that exists but is broken (bad JSON, bad values, unreadable) is an error, never hidden.
 */
function eccConfig(root) {
  if (!root || !existsSync(configPath(root))) return { ecc: { path: '', assetMaxBytes: DEFAULT_ASSET_BYTES } };
  return loadConfig(root);
}

async function cmdEcc(argv) {
  const [sub, ...rest] = argv;
  const opts = parseEccArgs(rest);
  const config = eccConfig(G.toplevel(resolve(opts.project ?? process.cwd())));
  switch (sub) {
    case 'install': {
      let out;
      if (opts.from) {
        out = installFrom(resolve(opts.from));
      } else {
        console.log('zc: downloading ECC from GitHub ...');
        out = await installFromGit({ ref: opts.ref ? String(opts.ref) : '' });
      }
      console.log(`zc: installed ECC ${out.version}${out.resolvedCommit ? ` (${out.resolvedCommit.slice(0, 12)})` : ''} into ${out.target}`);
      console.log(`zc: ${out.skills} skills, ${out.agents} agents, ${out.commands} commands, ${out.rules} rule files`);
      console.log(`zc: tracking: ${out.tracking}`);
      for (const w of out.warnings.slice(0, 5)) console.log(`zc: warning: ${w}`);
      if (out.source === 'git' && !/pinned commit|^tag /.test(out.tracking)) console.log('zc: tip: pass --ref <tag or commit> to make this install reproducible.');
      return;
    }
    case 'status': {
      const ecc = eccRoot(config);
      const index = buildIndex(ecc.dir);
      const n = (k) => index.filter((e) => e.kind === k).length;
      console.log(`zc: ECC source: ${ecc.source} (${ecc.dir})`);
      console.log(`zc: ${n('skill')} skills, ${n('agent')} agents, ${n('command')} commands, ${n('rule')} rule files`);
      if (ecc.source === 'installed') {
        const rec = readInstalled();
        if (rec) {
          console.log(`zc: version ${rec.version}, commit ${rec.resolvedCommit || 'n/a'}, from ${rec.origin}, installed ${rec.installedAt}`);
          console.log(`zc: tracking: ${rec.tracking}`);
          if (/moving|unpinned/.test(rec.tracking)) console.log('zc: warning: this install is not reproducible; reinstall with --ref <tag or commit> and note it.');
        } else console.log('zc: warning: no INSTALLED.json record; reinstall with `zc ecc install` to record where this came from.');
      }
      const v = validateCatalog(ecc.dir, { deep: true });
      for (const w of v.warnings.slice(0, 10)) console.log(`zc: warning: ${w}`);
      if (!ecc.complete) console.log('zc: only rules are available. Run `zc ecc install` to get the full catalog.');
      if (!v.ok && ecc.complete) throw new Error(`ECC validation failed:\n${v.errors.slice(0, 10).map((e) => `  - ${e}`).join('\n')}`);
      return;
    }
    case 'list': case 'search': {
      const index = buildIndex(eccRoot(config).dir);
      const kind = opts.kind ? parseSpec(`${opts.kind}:x`).kind : undefined;
      const words = [...opts._, ...(opts.filter ? String(opts.filter).split(/\s+/) : [])];
      const limit = Number(opts.limit ?? (sub === 'search' ? 15 : 1000));
      const hits = sub === 'search' || words.length ? searchIndex(index, words, { kind, limit }) : index.filter((e) => !kind || e.kind === kind).slice(0, limit);
      if (opts.json) { console.log(JSON.stringify(hits, null, 2)); return; }
      for (const e of hits) console.log(`${e.kind}:${e.name}  (${e.bytes} bytes)\n    ${e.description.slice(0, 160)}`);
      if (!hits.length) console.log('zc: nothing matched');
      return;
    }
    case 'show': {
      if (!opts._[0]) throw new Error('usage: zc ecc show <skill|agent|command|rules>:<name>');
      console.log(loadAssets(eccRoot(config).dir, [opts._[0]], { maxBytes: config.ecc.assetMaxBytes ?? DEFAULT_ASSET_BYTES }).map((x) => x.text).join('\n\n'));
      return;
    }
    default:
      throw new Error('usage: zc ecc install [--from <ecc checkout>] [--ref <tag>] | status | list [--kind skill|agent|command|rule] | search <words> | show <kind>:<name>');
  }
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
  if (isolationMode() === 'dbus') {
    const dbus = await run('which', ['dbus-run-session']);
    add('account isolation (dbus-run-session)', dbus.code === 0, dbus.stdout.trim(), 'sudo apt install dbus  (each account needs its own private D-Bus session)');
  } else if (process.platform === 'linux') {
    add('account isolation', false, 'ZC_ISOLATION=none', 'unset ZC_ISOLATION so accounts do not share one keyring login', 'warn');
  }
  const claude = await run(lookup, ['claude']);
  add('claude (Claude Code)', claude.code === 0, claude.stdout.trim().split(/\r?\n/)[0] ?? '', 'install Claude Code and sign in');
  const list = accounts.listAccounts();
  add('worker accounts ready', list.some((a) => a.status === 'ready'), `${list.filter((a) => a.status === 'ready').length}/${list.length} ready`, 'zc account add <id>');
  const root = G.toplevel(resolve(opts.project ?? process.cwd()));
  if (root) {
    try {
      const config = loadConfig(root);
      add('.zc/config.json', true, root);
      try {
        const ecc = eccRoot(config);
        const v = validateCatalog(ecc.dir, { deep: ecc.complete });
        if (ecc.complete) {
          add('ECC catalog (skills, agents, commands)', v.ok, `${ecc.source}: ${v.counts.skills} skills, ${v.counts.agents} agents, ${v.counts.commands} commands`, v.errors.slice(0, 3).join('; '), 'warn');
        } else {
          add('ECC catalog (skills, agents, commands)', false, 'only the bundled rules are available', 'run `zc ecc install` so workers can be given any skill, agent or command', 'warn');
        }
        for (const w of v.warnings.slice(0, 3)) add('ECC warning', false, w, '', 'warn');
        if (config.ecc.rulePacks.length) {
          loadEccRules(config);
          add('ECC rules for workers', true, `${ecc.source} (${ecc.dir})`);
        }
      } catch (error) {
        add('ECC setup', false, '', error.message, 'warn');
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
      case '--version': console.log(packageVersion()); return 0;
      case 'init': cmdInit(projectRoot(parseArgs(rest))); return 0;
      case 'account': await cmdAccount(rest); return 0;
      case 'dispatch': return await cmdDispatch(rest);
      case 'doctor': return await cmdDoctor(rest);
      case 'ecc': await cmdEcc(rest); return 0;
      case 'reject': {
        const opts = parseArgs(rest, { bool: ['force'] });
        const out = rejectRun({ root: projectRoot(opts), runId: opts._[0], force: Boolean(opts.force) });
        if (out.conflicts.length) {
          console.log(`zc: PARTIAL rollback of run ${out.runId}: restored ${out.restored.length} file(s); left ${out.conflicts.length} alone:`);
          for (const c of out.conflicts) console.log(`  ${c.path} - ${c.reason}`);
          return 3;
        }
        console.log(`zc: ${out.rolledBack ? `discarded ${out.restored.length} file(s)` : 'nothing discarded'} (run ${out.runId})${out.note ? ` - ${out.note}` : ''}`);
        return 0;
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
