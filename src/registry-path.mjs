import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Where the machine-wide registry lives. Fixed per user and deliberately NOT
 * derived from ZC_HOME or XDG_STATE_HOME: two state roots on one machine must
 * still meet in the same registry, or their leases would not exclude each other.
 *
 * ZC_TEST_REGISTRY_DIR exists only so tests never touch the real registry. It is
 * refused unless ZC_TESTING=1 and the path is absolute: a stray export would split
 * the registry and defeat the lease guarantee.
 */
export function registryDir({ dir, env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (dir) return dir;
  if (env.ZC_TEST_REGISTRY_DIR) {
    if (env.ZC_TESTING !== '1' || !isAbsolute(env.ZC_TEST_REGISTRY_DIR)) {
      throw new Error('ZC_TEST_REGISTRY_DIR needs ZC_TESTING=1 and an absolute path; it splits the registry and defeats account leases. Unset it.');
    }
    return env.ZC_TEST_REGISTRY_DIR;
  }
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'zora-conductor-registry');
  return join(home, '.local', 'state', 'zora-conductor-registry');
}

// statfs f_type values of network filesystems (Linux). SQLite locking is not reliable on them.
const NETWORK_TYPES = new Map([
  [0x6969, 'nfs'], [0x517b, 'smb'], [0xff534d42, 'cifs'], [0x5346414f, 'afs'],
  [0x00c36400, 'ceph'], [0x01021997, '9p'], [0x73757245, 'coda'], [0x0bd00bd0, 'lustre']
]);

/** Name of the network filesystem holding `path`, or null when local or not detectable here. */
export function networkFsType(path, { platform = process.platform, statfs = statfsSync } = {}) {
  if (platform !== 'linux') return null;
  try {
    return NETWORK_TYPES.get(Number(statfs(path).type)) ?? null;
  } catch { return null; }
}
