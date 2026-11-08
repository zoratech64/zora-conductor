import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './proc.mjs';

/** agy launch spec: a .mjs/.js override (used by tests) runs through node. */
function launchSpec(path) {
  return /\.(mjs|cjs|js)$/i.test(path)
    ? { command: process.execPath, prefix: [path] }
    : { command: path, prefix: [] };
}

function candidatePaths() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (process.platform === 'win32') {
    const roots = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramData', 'APPDATA']
      .map((name) => process.env[name]).filter(Boolean);
    const paths = roots.flatMap((r) => [resolve(r, 'agy', 'bin', 'agy.exe'), resolve(r, 'Programs', 'agy', 'bin', 'agy.exe')]);
    if (home) paths.push(resolve(home, 'scoop', 'apps', 'agy', 'current', 'bin', 'agy.exe'));
    return paths;
  }
  return [
    home && resolve(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy', '/usr/bin/agy', '/opt/antigravity/bin/agy',
    home && resolve(home, 'bin', 'agy')
  ].filter(Boolean);
}

export function findAgy() {
  if (process.env.ZC_AGY) return launchSpec(process.env.ZC_AGY);
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    const found = execFileSync(lookup, ['agy'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (found) return launchSpec(found);
  } catch { /* fall through to known install locations */ }
  const known = candidatePaths().find((p) => existsSync(p));
  if (known) return launchSpec(known);
  throw new Error(
    'could not find the Antigravity CLI (agy). Install it from https://antigravity.google/docs/cli/install/ ' +
    'or set ZC_AGY to the executable path.'
  );
}

/**
 * One account = one isolated profile directory. File-based credential storage
 * keeps each account's OAuth token inside its own --gemini_dir instead of the
 * shared OS keyring (which would make every account the same identity).
 */
export function agyEnv() {
  return { ...process.env, NO_COLOR: '1', GEMINI_FORCE_FILE_STORAGE: 'true' };
}


/**
 * Linux account isolation. agy keeps its OAuth login in the desktop keyring (Secret Service on the
 * user's D-Bus session), so every --gemini_dir profile ends up as the same Google account. Each
 * account therefore runs inside its own private D-Bus session with its own HOME and runtime
 * folder; the keyring it talks to is then private to that account.
 * ZC_ISOLATION=none turns this off. Windows and macOS are unchanged.
 */
let dbusRunPath;
function dbusRun() {
  if (dbusRunPath === undefined) {
    try { dbusRunPath = execFileSync('which', ['dbus-run-session'], { encoding: 'utf8' }).trim() || null; }
    catch { dbusRunPath = null; }
  }
  return dbusRunPath;
}

export function isolationMode(platform = process.platform, env = process.env) {
  const wanted = (env.ZC_ISOLATION ?? 'auto').toLowerCase();
  if (wanted === 'none' || platform !== 'linux') return 'none';
  return 'dbus';
}

/** Build the final command line and environment for one agy call of one account. */
export function launchPlan(account, spec, args, { mode = isolationMode(), baseEnv = agyEnv() } = {}) {
  if (mode !== 'dbus') return { command: spec.command, args, env: baseEnv, isolated: false };
  const runner = dbusRun();
  if (!runner) {
    throw new Error(
      'account isolation needs dbus-run-session (Ubuntu: sudo apt install dbus). ' +
      'Without it every agy profile shares one keyring login. Set ZC_ISOLATION=none to skip this check at your own risk.'
    );
  }
  const home = join(account.profileDir, 'home');
  const runtime = join(account.profileDir, 'run');
  for (const dir of [home, runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  const env = { ...baseEnv, HOME: home, XDG_RUNTIME_DIR: runtime };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'GNOME_KEYRING_CONTROL',
    'SSH_AUTH_SOCK', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[name];
  return { command: runner, args: ['--', spec.command, ...args], env, isolated: true };
}

const PERMISSION_ARGS = {
  read: ['--mode', 'plan'],
  edit: ['--mode', 'accept-edits'],
  all: ['--dangerously-skip-permissions']
};

export function agyRunArgs({ profileDir, model, effort, workspace, permissions = 'edit', timeoutSec }) {
  const args = [
    '--gemini_dir', profileDir,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--print-timeout', `${timeoutSec}s`,
    // Fresh project per run: avoids agy's first-write race observed by Pirun (agy 1.1.21).
    '--new-project'
  ];
  if (model && model !== 'auto') args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (workspace) args.push('--add-dir', workspace);
  args.push(...(PERMISSION_ARGS[permissions] ?? PERMISSION_ARGS.edit));
  return args;
}

const PERMISSION_DENIAL = /permission check failed|cannot prompt|auto-denied/i;

const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Digest agy's stream-json output (plus any stray stderr lines) into one record. */
export function parseAgyOutput(text) {
  const out = {
    status: '', response: '', error: '', softErrors: [], tools: [],
    permissionAsks: [], turns: 0, conversationId: '', usage: null
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (/authentication required|error|failed|invalid|denied|unsupported|exceeded/i.test(line)) {
        out.softErrors.push(line.trim().slice(0, 300));
      }
      continue;
    }
    if (!isRecord(event)) continue;
    if (typeof event.conversation_id === 'string') out.conversationId = event.conversation_id;
    if (event.event === 'step_update' && isRecord(event.step_update)) {
      const step = event.step_update;
      if (step.step_type === 'tool' && (step.state === 'DONE' || step.state === 'ERROR')) {
        const info = isRecord(step.tool_info) ? step.tool_info : {};
        const failed = Boolean(info.error);
        out.tools.push({ name: String(step.tool_name ?? info.name ?? 'tool'), failed });
        const message = isRecord(info.error) && typeof info.error.message === 'string' ? info.error.message : '';
        if (PERMISSION_DENIAL.test(message)) out.permissionAsks.push(String(step.tool_name ?? 'tool'));
      }
    }
    if (event.event === 'result' && isRecord(event.result)) {
      const r = event.result;
      out.status = String(r.status ?? '');
      out.turns = Number(r.num_turns ?? out.turns);
      if (typeof r.conversation_id === 'string') out.conversationId = r.conversation_id;
      if (typeof r.response === 'string') out.response = r.response.trim();
      if (typeof r.error === 'string') out.error = r.error.trim().slice(0, 600);
      if (isRecord(r.usage)) out.usage = r.usage;
    }
  }
  return out;
}

/**
 * Run one worker task on one account. The prompt travels on stdin, never argv
 * (no quoting problems, no length limit on Windows).
 */
export async function runAgy({ account, prompt, cwd, timeoutSec, permissions, model, effort }) {
  const spec = findAgy();
  const args = [
    ...spec.prefix,
    ...agyRunArgs({ profileDir: account.profileDir, model, effort, workspace: cwd, permissions, timeoutSec: timeoutSec + 120 })
  ];
  const input = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
  const plan = launchPlan(account, spec, args);
  const result = await run(plan.command, plan.args, { cwd, env: plan.env, input, timeoutMs: timeoutSec * 1000 });
  return { ...result, parsed: parseAgyOutput(`${result.stdout}\n${result.stderr}`) };
}

/** `agy -p /usage` rows: <model group>\t<label> Limit Remaining\t<percent>%\t<reset ISO>. */
export function parseUsage(text) {
  const limits = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 4) continue;
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(parts[2]);
    if (!percent || Number.isNaN(Date.parse(parts[3]))) continue;
    limits.push({
      models: parts[0],
      window: parts[1].replace(/\s*limit\s*remaining\s*$/i, '').trim().toLowerCase(),
      remainingPercent: Number(percent[1]),
      resetsAt: parts[3]
    });
  }
  return limits;
}

/** Non-model call used to confirm an account is signed in and read its quota windows. */
export async function checkAccount(account) {
  const spec = findAgy();
  const args = [...spec.prefix, '--gemini_dir', account.profileDir, '-p', '/usage'];
  const plan = launchPlan(account, spec, args);
  const result = await run(plan.command, plan.args, { env: plan.env, timeoutMs: 60_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  const limits = parseUsage(text);
  const authFailed = /authentication required|please (?:sign|log) ?in|not authenticated/i.test(text);
  return { ok: result.code === 0 && !authFailed, authFailed, limits, text: text.trim().slice(0, 400), error: result.error };
}

/** Interactive sign-in: hands the terminal to agy, with this account's isolated profile. */
export function loginAccount(account) {
  const spec = findAgy();
  return new Promise((resolveLogin) => {
    let plan;
    try { plan = launchPlan(account, spec, [...spec.prefix, '--gemini_dir', account.profileDir]); }
    catch (error) { resolveLogin({ code: -1, error: error.message }); return; }
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', env: plan.env, windowsHide: false });
    child.on('error', (error) => resolveLogin({ code: -1, error: error.message }));
    child.on('close', (code) => resolveLogin({ code }));
  });
}

/** Where agy keeps the OAuth token when file storage is honoured (agy 1.1.21; version-sensitive). */
export const tokenFile = (profileDir) => join(profileDir, 'antigravity-cli', 'antigravity-oauth-token');
export const hasTokenFile = (profileDir) => existsSync(tokenFile(profileDir));
