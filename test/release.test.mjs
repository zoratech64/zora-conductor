import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SEMVER, checkVersions } from '../scripts/check-versions.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'zc.mjs');
const SCRIPT = join(ROOT, 'scripts', 'check-versions.mjs');
const packageVersion = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** A temp folder with the three version files, each set to the given version. */
function fixture({ pkg, plugin, market, marketPlugins } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-versions-'));
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zora-conductor', version: pkg }));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'zc', version: plugin }));
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'zora-conductor',
    plugins: marketPlugins ?? [{ name: 'zc', source: './', version: market }]
  }));
  return dir;
}

const runZc = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('zc --version prints the package version and exits 0', () => {
  const r = runZc(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), packageVersion());
});

test('existing CLI behaviour is unchanged: help still works, unknown commands still fail', () => {
  const help = runZc(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /zc --version/);
  assert.match(help.stdout, /zc dispatch --task/);
  const unknown = runZc(['--not-a-command']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command "--not-a-command"/);
});

test('the repository itself passes the version check', () => {
  const result = checkVersions(ROOT);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.version, packageVersion());
});

test('matching versions pass, including pre-release versions', () => {
  for (const v of ['0.1.7', '0.2.0-alpha.1', '1.0.0-rc.2', '2.10.3']) {
    const result = checkVersions(fixture({ pkg: v, plugin: v, market: v }));
    assert.equal(result.ok, true, `${v}: ${result.problems.join('; ')}`);
    assert.equal(result.version, v);
  }
});

test('a mismatch in any one of the three files fails and names every file and version', () => {
  const cases = [
    { pkg: '0.2.0', plugin: '0.1.7', market: '0.1.7' },
    { pkg: '0.1.7', plugin: '0.2.0', market: '0.1.7' },
    { pkg: '0.1.7', plugin: '0.1.7', market: '0.2.0' }
  ];
  for (const c of cases) {
    const result = checkVersions(fixture(c));
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /versions differ: package\.json = .*, \.claude-plugin\/plugin\.json = .*, \.claude-plugin\/marketplace\.json = /);
  }
});

test('pre-release versions must match exactly', () => {
  const result = checkVersions(fixture({ pkg: '0.2.0-alpha.1', plugin: '0.2.0-alpha.1', market: '0.2.0-alpha.2' }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /0\.2\.0-alpha\.2/);
  const noPre = checkVersions(fixture({ pkg: '0.2.0-alpha.1', plugin: '0.2.0', market: '0.2.0-alpha.1' }));
  assert.equal(noPre.ok, false);
});

test('missing or invalid versions fail with a clear message', () => {
  assert.match(checkVersions(fixture({ pkg: '0.2', plugin: '0.2', market: '0.2' })).problems.join(), /not a valid version/);
  assert.match(checkVersions(fixture({ pkg: 'v0.2.0', plugin: 'v0.2.0', market: 'v0.2.0' })).problems.join(), /not a valid version/);
  assert.match(checkVersions(fixture({ plugin: '0.1.7', market: '0.1.7' })).problems.join(), /package\.json has no version/);
  assert.match(checkVersions(fixture({ pkg: '0.1.7', plugin: '0.1.7', marketPlugins: [{ name: 'other', version: '0.1.7' }] })).problems.join(), /marketplace\.json has no plugin named "zc"/);
});

test('a missing file and a file that is not valid JSON fail with a clear message', () => {
  const missing = fixture({ pkg: '0.1.7', plugin: '0.1.7', market: '0.1.7' });
  rmSync(join(missing, '.claude-plugin', 'marketplace.json'));
  assert.match(checkVersions(missing).problems.join(), /cannot read \.claude-plugin\/marketplace\.json: ENOENT/);
  const broken = fixture({ pkg: '0.1.7', plugin: '0.1.7', market: '0.1.7' });
  writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), '{ not json');
  assert.match(checkVersions(broken).problems.join(), /\.claude-plugin\/plugin\.json is not valid JSON/);
});

test('valid JSON with an unexpected structure is reported, never a crash', () => {
  const withFile = (rel, text) => {
    const dir = fixture({ pkg: '0.1.7', plugin: '0.1.7', market: '0.1.7' });
    writeFileSync(join(dir, rel), text);
    return checkVersions(dir);
  };
  for (const [text, kind] of [['null', 'null'], ['[]', 'an array'], ['[1,2]', 'an array'], ['"0.1.7"', 'a string'], ['42', 'a number'], ['true', 'a boolean']]) {
    for (const rel of ['package.json', join('.claude-plugin', 'plugin.json'), join('.claude-plugin', 'marketplace.json')]) {
      let result;
      assert.doesNotThrow(() => { result = withFile(rel, text); }, `${rel} = ${text}`);
      assert.equal(result.ok, false);
      assert.match(result.problems.join(), new RegExp(`must contain a JSON object, found ${kind}`), `${rel} = ${text}`);
    }
  }
  for (const version of [7, null, true, ['0.1.7'], { v: 1 }, '']) {
    const result = withFile('package.json', JSON.stringify({ version }));
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /package\.json version must be a non-empty string/, JSON.stringify(version));
  }
  for (const plugins of [null, 'zc', 5, { name: 'zc', version: '0.1.7' }]) {
    const result = withFile(join('.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins }));
    assert.equal(result.ok, false);
    assert.match(result.problems.join(), /"plugins" must be an array/, JSON.stringify(plugins));
  }
  const odd = withFile(join('.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [null, 5, 'zc', [], { name: 'zc', version: '0.1.7' }] }));
  assert.equal(odd.ok, true, 'odd entries are skipped; the real zc entry is found');
});

test('only the documented formats are accepted: X.Y.Z, X.Y.Z-alpha.N, X.Y.Z-beta.N, X.Y.Z-rc.N', () => {
  const accepted = ['1.2.3', '1.2.3-alpha.0', '1.2.3-alpha.1', '1.2.3-beta.2', '1.2.3-rc.10', '0.0.0', '0.1.7', '0.2.0-alpha.1', '1.0.0-rc.2', '10.20.30-beta.0'];
  const rejected = [
    // required examples
    '1.2.3-pre.1', '1.2.3-alpha', '1.2.3-alpha.01', '1.2.3-01', '1.2.3-foo.1', '1.2.3-alpha.1.extra',
    // other SemVer pre-release forms the project does not use
    '1.2.3-0', '1.2.3-0a', '1.2.3-x-1', '1.2.3--', '10.20.30-beta-2.x', '1.2.3-Alpha.1', '1.2.3-RC.1', '1.2.3-alpha-1', '1.2.3-alpha.-1', '1.2.3-alpha.1a', '1.2.3-rc', '1.2.3-beta.',
    // malformed core versions and build metadata
    '', '1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3+build', '1.2.3-alpha.1+build', '1.2.3-alpha..1', ' 1.2.3', '1.2.3 '
  ];
  for (const ok of accepted) assert.ok(SEMVER.test(ok), `should accept ${ok}`);
  for (const bad of rejected) assert.ok(!SEMVER.test(bad), `should reject ${JSON.stringify(bad)}`);
});

test('the full check accepts the documented examples and rejects the others, naming the expected formats', () => {
  for (const v of ['1.2.3', '1.2.3-alpha.0', '1.2.3-alpha.1', '1.2.3-beta.2', '1.2.3-rc.10']) {
    const result = checkVersions(fixture({ pkg: v, plugin: v, market: v }));
    assert.equal(result.ok, true, `${v}: ${result.problems.join('; ')}`);
    assert.equal(result.version, v);
  }
  for (const v of ['1.2.3-pre.1', '1.2.3-alpha', '1.2.3-alpha.01', '1.2.3-01', '1.2.3-foo.1', '1.2.3-alpha.1.extra']) {
    const result = checkVersions(fixture({ pkg: v, plugin: v, market: v }));
    assert.equal(result.ok, false, v);
    assert.equal(result.problems.length, 3, `each of the three files is reported for ${v}`);
    for (const p of result.problems) {
      assert.match(p, /is not a valid version \(expected X\.Y\.Z, X\.Y\.Z-alpha\.N, X\.Y\.Z-beta\.N or X\.Y\.Z-rc\.N\)/, v);
    }
  }
});

test('numeric pre-release identifiers with leading zeros are rejected', () => {
  for (const bad of ['1.2.3-01', '1.2.3-00', '1.2.3-alpha.01', '0.2.0-alpha.007', '1.0.0-rc.1.02']) {
    assert.ok(!SEMVER.test(bad), bad);
    const result = checkVersions(fixture({ pkg: bad, plugin: bad, market: bad }));
    assert.equal(result.ok, false, bad);
    assert.match(result.problems.join(), /not a valid version/, bad);
  }
});

test('the check script exits 1 on a mismatch and 0 when versions match (as used by npm run check)', () => {
  const bad = spawnSync(process.execPath, [SCRIPT, fixture({ pkg: '0.2.0', plugin: '0.1.7', market: '0.1.7' })], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /version check: versions differ/);
  const good = spawnSync(process.execPath, [SCRIPT, fixture({ pkg: '0.2.0-alpha.1', plugin: '0.2.0-alpha.1', market: '0.2.0-alpha.1' })], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /versions ok \(0\.2\.0-alpha\.1\)/);
});
