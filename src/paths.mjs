import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/**
 * Machine-global state: accounts, login profiles, run records. Kept outside
 * every project so the clean-checkout guard never sees it and credentials
 * can never be committed by accident.
 */
export function stateRoot() {
  if (process.env.ZC_HOME) return process.env.ZC_HOME;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'zora-conductor');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'zora-conductor');
}

export const accountsFile = () => join(stateRoot(), 'accounts.json');
export const profileDirFor = (id) => join(stateRoot(), 'profiles', id);

export function projectKey(root) {
  const full = resolve(root);
  const normalized = process.platform === 'win32' ? full.toLowerCase() : full;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  const name = basename(full).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'project';
  return `${name}-${hash}`;
}

export const projectState = (root) => join(stateRoot(), 'projects', projectKey(root));
export const runsDir = (root) => join(projectState(root), 'runs');
export const lockFile = (root) => join(projectState(root), 'dispatch.lock');
export const configPath = (root) => join(root, '.zc', 'config.json');
