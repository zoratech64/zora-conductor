// Check that the CLI package and the Claude plugin declare the same version, so one git tag
// always identifies one compatible CLI + plugin release. Run by `npm run check`.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The only version formats this project releases (see docs/RELEASING.md):
//   X.Y.Z, X.Y.Z-alpha.N, X.Y.Z-beta.N, X.Y.Z-rc.N
// X, Y, Z and N are non-negative integers without leading zeros (0 itself is allowed).
// Other SemVer pre-release forms and build metadata ("+...") are intentionally rejected.
const NUM = '(?:0|[1-9]\\d*)';

/** A version in one of the four documented formats. */
export const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(?:alpha|beta|rc)\\.${NUM})?$`);

const FORMATS = 'X.Y.Z, X.Y.Z-alpha.N, X.Y.Z-beta.N or X.Y.Z-rc.N';

const PLUGIN_NAME = 'zc';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readVersionFile(root, rel, pick) {
  const file = join(root, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { file: rel, version: null, problem: `cannot read ${rel}: ${error.code ?? error.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { file: rel, version: null, problem: `${rel} is not valid JSON: ${error.message}` };
  }
  if (!isPlainObject(data)) {
    const kind = data === null ? 'null' : Array.isArray(data) ? 'an array' : `a ${typeof data}`;
    return { file: rel, version: null, problem: `${rel} must contain a JSON object, found ${kind}` };
  }
  const found = pick(data);
  if (found.problem) return { file: rel, version: null, problem: found.problem };
  const { version } = found;
  if (version === undefined) return { file: rel, version: null, problem: `${rel} has no version` };
  if (typeof version !== 'string' || !version) return { file: rel, version: null, problem: `${rel} version must be a non-empty string, found ${JSON.stringify(version)}` };
  if (!SEMVER.test(version)) return { file: rel, version, problem: `${rel} version "${version}" is not a valid version (expected ${FORMATS})` };
  return { file: rel, version, problem: null };
}

/** The zc plugin entry in marketplace.json, or a clear problem when the structure is unexpected. */
function marketplaceVersion(data) {
  if (!Array.isArray(data.plugins)) return { problem: '.claude-plugin/marketplace.json "plugins" must be an array' };
  const plugin = data.plugins.find((p) => isPlainObject(p) && p.name === PLUGIN_NAME);
  if (!plugin) return { problem: `.claude-plugin/marketplace.json has no plugin named "${PLUGIN_NAME}"` };
  return { version: plugin.version };
}

/**
 * Compare the three declared versions. Returns { ok, version, entries, problems }:
 * `version` is the shared version when ok, `entries` lists each file and what it declares.
 */
export function checkVersions(root) {
  const entries = [
    readVersionFile(root, 'package.json', (d) => ({ version: d.version })),
    readVersionFile(root, '.claude-plugin/plugin.json', (d) => ({ version: d.version })),
    readVersionFile(root, '.claude-plugin/marketplace.json', marketplaceVersion)
  ];
  const problems = entries.filter((e) => e.problem).map((e) => e.problem);
  const versions = [...new Set(entries.filter((e) => !e.problem).map((e) => e.version))];
  if (!problems.length && versions.length > 1) {
    problems.push(`versions differ: ${entries.map((e) => `${e.file} = ${e.version}`).join(', ')}`);
  }
  return { ok: problems.length === 0, version: problems.length ? null : versions[0], entries, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const result = checkVersions(root);
  if (result.ok) {
    console.log(`versions ok (${result.version})`);
  } else {
    for (const p of result.problems) console.error(`version check: ${p}`);
    process.exitCode = 1;
  }
}
