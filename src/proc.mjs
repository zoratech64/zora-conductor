import { execFileSync, spawn } from 'node:child_process';

const CMD_META = /[&|<>^"%!\r\n]/;

/**
 * On Windows, npm/flutter/dart are .cmd launchers that Node cannot spawn
 * directly. They are run through cmd.exe only after every argument is checked
 * for cmd metacharacters, so a task cannot smuggle a second command in.
 */
export function resolveSpawn(command, args) {
  if (process.platform !== 'win32') return { command, args, verbatim: false };
  let exe = command;
  if (!/[\\/]/.test(command) && !/\.(exe|cmd|bat|com)$/i.test(command)) {
    try {
      const found = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      exe = found.find((p) => /\.(exe|com)$/i.test(p)) ?? found.find((p) => /\.(cmd|bat)$/i.test(p)) ?? command;
    } catch { /* leave as given; spawn will report ENOENT */ }
  }
  if (/\.(cmd|bat)$/i.test(exe)) {
    for (const part of [exe, ...args]) {
      if (CMD_META.test(part)) throw new Error(`argument not allowed for a .cmd launcher on Windows: ${part}`);
    }
    const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[exe, ...args].map(quote).join(' ')}"`],
      verbatim: true
    };
  }
  return { command: exe, args, verbatim: false };
}

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, 3000).unref();
}

/**
 * Run a process to completion. Resolves (never rejects) with
 * { code, signal, timedOut, stdout, stderr, error }.
 */
export function run(command, args = [], options = {}) {
  const { cwd, env, input, timeoutMs = 0, maxBytes = 8_000_000, onStdoutLine } = options;
  return new Promise((resolve) => {
    let spec;
    try {
      spec = resolveSpawn(command, args);
    } catch (error) {
      resolve({ code: -1, signal: null, timedOut: false, stdout: '', stderr: '', error: error.message });
      return;
    }
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim
      });
    } catch (error) {
      resolve({ code: -1, signal: null, timedOut: false, stdout: '', stderr: '', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let spawnError = '';
    const append = (current, chunk) => (current.length < maxBytes ? current + chunk : current);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      if (!onStdoutLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onStdoutLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => { /* child exited before reading input */ });
    child.on('error', (error) => { spawnError = error.message; });
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs)
      : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (onStdoutLine && pending) onStdoutLine(pending);
      resolve({ code: code ?? -1, signal, timedOut, stdout, stderr, error: spawnError });
    });
    child.stdin.end(input ?? undefined);
  });
}
