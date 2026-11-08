import assert from 'node:assert/strict';
import { rmSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { main } from '../src/cli.mjs';
import {
  buildIndex, eccRoot, formatAssets, installFrom, installFromGit, installedEccDir, loadAssets, parseMarkdown, parseSpec,
  readInstalled, recoverInterrupted, validateCatalog
} from '../src/ecc.mjs';
import { loadEccRules } from '../src/prompt.mjs';
import { run } from '../src/proc.mjs';
import { fakeEcc, git, makeHome, makeRepo } from './helpers.mjs';

const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const leftovers = () => readdirSync(dirname(installedEccDir())).filter((n) => n.startsWith('.ecc-'));
const noEnv = () => { delete process.env.ZC_ECC_PATH; delete process.env.ZC_ECC_URL; };

test('one validator: missing/empty/symlinked required folders are errors, rules are optional', () => {
  const ok = fakeEcc();
  assert.equal(validateCatalog(ok, { deep: true }).ok, true);
  assert.deepEqual(validateCatalog(ok).counts, { skills: 2, agents: 1, commands: 1, rules: 3 });

  const rulesOnly = mkdtempSync(join(tmpdir(), 'zc-v-'));
  put(rulesOnly, 'rules/common/a.md', 'x');
  const v = validateCatalog(rulesOnly);
  assert.equal(v.ok, false);
  assert.ok(['skills', 'agents', 'commands'].every((d) => v.errors.some((e) => e.startsWith(`${d}/`))));

  const noRules = fakeEcc();
  put(noRules, 'rules/common/base.md', 'x');
  const bare = mkdtempSync(join(tmpdir(), 'zc-v-'));
  for (const d of ['skills/s/SKILL.md', 'agents/a.md', 'commands/c.md']) put(bare, d, 'body');
  assert.equal(validateCatalog(bare).ok, true, 'rules/ may be absent');

  const emptySkills = mkdtempSync(join(tmpdir(), 'zc-v-'));
  mkdirSync(join(emptySkills, 'skills'));
  put(emptySkills, 'agents/a.md', 'b'); put(emptySkills, 'commands/c.md', 'b');
  assert.match(validateCatalog(emptySkills).errors.join(), /skills\/ has no skill/);

  const rulesFile = fakeEcc();
  renameSync(join(rulesFile, 'rules'), join(rulesFile, 'r2'));
  writeFileSync(join(rulesFile, 'rules'), 'not a folder');
  assert.match(validateCatalog(rulesFile).errors.join(), /rules must be a folder/);
});

test('symlinks are rejected, as a folder and as a file', () => {
  const linkedDir = fakeEcc();
  const real = mkdtempSync(join(tmpdir(), 'zc-real-'));
  put(real, 'x.md', 'body');
  renameSync(join(linkedDir, 'agents'), join(linkedDir, 'agents-real'));
  symlinkSync(real, join(linkedDir, 'agents'));
  assert.match(validateCatalog(linkedDir).errors.join(), /agents\/ is a symlink/);

  const linkedFile = fakeEcc();
  symlinkSync(join(real, 'x.md'), join(linkedFile, 'agents', 'evil.md'));
  assert.match(validateCatalog(linkedFile).errors.join(), /evil\.md is a symlink/);
  assert.throws(() => installFrom(linkedFile), /not a usable ECC checkout/);
});

test('deep validation: empty assets and broken front matter are errors; a name mismatch only warns', () => {
  const dir = fakeEcc();
  put(dir, 'skills/empty/SKILL.md', '---\nname: empty\ndescription: d\n---\n');
  put(dir, 'skills/broken/SKILL.md', '---\nname: broken\ndescription: never closed\nbody');
  put(dir, 'skills/flow/SKILL.md', '---\nname: flow\ndescription: [a, b]\n---\nbody');
  const v = validateCatalog(dir, { deep: true });
  assert.match(v.errors.join('\n'), /skills\/empty\/SKILL.md: empty/);
  assert.match(v.errors.join('\n'), /skills\/broken\/SKILL.md: front matter is not closed/);
  assert.match(v.errors.join('\n'), /skills\/flow\/SKILL.md: description: a list or map/);
  const mism = fakeEcc();
  put(mism, 'skills/flutter-magic/SKILL.md', '---\nname: other-name\ndescription: d\n---\nbody');
  const w = validateCatalog(mism, { deep: true });
  assert.equal(w.ok, true);
  assert.match(w.warnings.join(), /differs from "flutter-magic"/);
});

test('front matter: quoted, block (> and |) and continued descriptions are all read', () => {
  const md = (fm) => parseMarkdown(`---\n${fm}\n---\nBODY`);
  assert.equal(md('name: x\ndescription: "He said \\"hi\\""').meta.description, 'He said "hi"');
  assert.equal(md("description: 'it''s fine'").meta.description, "it's fine");
  assert.equal(md('description: >\n  first line\n  second line\nname: x').meta.description, 'first line second line');
  assert.equal(md('description: |\n  line one\n  line two\nname: x').meta.description, 'line one\nline two');
  assert.equal(md('description: >-\n  folded\n  text').meta.description, 'folded text');
  assert.equal(md('description: plain start\n  and continues').meta.description, 'plain start and continues');
  assert.equal(md('description: has # comment').meta.description, 'has');
  assert.deepEqual(md('description: "open').errors, ['description: unterminated quote']);
  assert.match(md('description: {a: 1}').errors[0], /list or map/);
  assert.equal(md('tools: [Read, Bash]').errors.length, 0, 'flow lists are fine for other keys');
  assert.equal(parseMarkdown('---\r\nname: crlf\r\n---\r\nB').meta.name, 'crlf');
  assert.equal(parseMarkdown('﻿---\nname: bom\n---\nB').meta.name, 'bom');
  assert.deepEqual(buildIndex(fakeEcc()).find((e) => e.name === 'flutter-magic').description, 'Widget tricks for Flutter apps');
});

test('references: empty, unsupported, traversal and bad names are rejected; rule: and rules: both work', () => {
  for (const bad of ['', '   ', 'skill:', 'skill:   ', 'widget:x', 'skill:../x', 'skill:a/b', 'skill:a b', 'rules:a/b/c', 'skill:.hidden', null, 'plain']) {
    assert.throws(() => parseSpec(bad), /ECC/, String(bad));
  }
  assert.deepEqual(parseSpec('rule:dart/style'), { kind: 'rule', name: 'dart/style' });
  assert.deepEqual(parseSpec('rules:dart'), { kind: 'rule', name: 'dart' });
  assert.equal(loadAssets(fakeEcc(), ['rule:dart/style'])[0].text.includes('RULE-BODY'), true);
});

test('asset loading: by path, byte limit names the asset, symlinks refused, other broken files are not read', () => {
  const dir = fakeEcc();
  put(dir, 'skills/huge/SKILL.md', `---\nname: huge\ndescription: d\n---\n${'x'.repeat(5000)}`);
  assert.throws(() => loadAssets(dir, ['skill:huge'], { maxBytes: 1000 }), /skills\/huge\/SKILL.md is \d+ bytes, over the 1000 byte limit/);
  put(dir, 'skills/bad/SKILL.md', '---\nname: bad\nnever closed');
  assert.equal(loadAssets(dir, ['skill:flutter-magic'])[0].text.includes('SKILL-BODY-FLUTTER'), true, 'an unrelated broken asset does not matter');
  assert.throws(() => loadAssets(dir, ['skill:bad']), /not closed/);
  const real = join(mkdtempSync(join(tmpdir(), 'zc-real-')), 'x.md');
  writeFileSync(real, 'secret');
  symlinkSync(real, join(dir, 'agents', 'link.md'));
  assert.throws(() => loadAssets(dir, ['agent:link']), /not a regular file/);
  assert.throws(() => loadAssets(dir, ['skill:flutter-magik']), /did you mean skill:flutter-magic/);
});

test('guidance over the character budget lists what was left out instead of cutting it', () => {
  const dir = fakeEcc();
  const sections = loadAssets(dir, ['skill:flutter-magic', 'skill:nest-magic', 'agent:flutter-reviewer']);
  const first = sections[0].text.length + 2;
  const out = formatAssets(sections, first + 5);
  assert.match(out, /SKILL-BODY-FLUTTER/);
  assert.doesNotMatch(out, /SKILL-BODY-NEST/);
  assert.match(out, /omitted.*skill:nest-magic, agent:flutter-reviewer/);
});

test('eccRoot: a chosen folder that is incomplete is an error, never a silent fallback', () => {
  makeHome(); noEnv();
  const partial = mkdtempSync(join(tmpdir(), 'zc-partial-'));
  put(partial, 'rules/common/a.md', 'x');
  assert.throws(() => eccRoot({ ecc: { path: partial } }), /ECC folder \(configured/);
  process.env.ZC_ECC_PATH = partial;
  assert.throws(() => eccRoot({ ecc: { path: '' } }), /ECC folder \(ZC_ECC_PATH/);
  noEnv();
  installFrom(fakeEcc());
  assert.equal(eccRoot({ ecc: { path: '' } }).source, 'installed');
  rmSync(join(installedEccDir(), 'agents'), { recursive: true });
  assert.throws(() => eccRoot({ ecc: { path: '' } }), /Run `zc ecc install` again/);
});


test('eccRoot precedence: project setting, then ZC_ECC_PATH, then installed, then bundled', () => {
  makeHome(); noEnv();
  const a = fakeEcc(); const b = fakeEcc();
  assert.equal(eccRoot({ ecc: { path: '' } }).source, 'bundled');
  installFrom(fakeEcc());
  assert.equal(eccRoot({ ecc: { path: '' } }).source, 'installed');
  process.env.ZC_ECC_PATH = b;
  assert.deepEqual([eccRoot({ ecc: { path: '' } }).source, eccRoot({ ecc: { path: '' } }).dir], ['ZC_ECC_PATH', b]);
  assert.deepEqual([eccRoot({ ecc: { path: a } }).source, eccRoot({ ecc: { path: a } }).dir], ['configured', a]);
  noEnv();
});

test('a relative ecc.path means relative to the project, wherever zc is started', () => {
  makeHome(); noEnv();
  const { dir } = makeRepo();
  const inside = join(dir, 'vendor-ecc');
  mkdirSync(inside);
  for (const n of ['skills', 'agents', 'commands']) put(inside, `${n}/${n === 'skills' ? 's/SKILL.md' : 'x.md'}`, 'body');
  writeFileSync(join(dir, '.zc/config.json'), JSON.stringify({ version: 1, verify: [], ecc: { path: 'vendor-ecc' } }));
  process.chdir(tmpdir());
  const config = loadConfig(dir);
  assert.equal(config.ecc.path, inside);
  assert.equal(eccRoot(config).dir, inside);
  process.chdir(dir);
});

test('install is atomic: a bad new source, a failed copy and a failed swap all keep the old install', () => {
  makeHome(); noEnv();
  installFrom(fakeEcc());
  const before = JSON.stringify(buildIndex(installedEccDir()));
  const bad = fakeEcc();
  put(bad, 'agents/empty.md', '');
  assert.throws(() => installFrom(bad), /not a usable ECC checkout/);
  assert.throws(() => installFrom(fakeEcc(), {}, { afterCopy: () => { throw new Error('disk full'); } }), /disk full/);
  assert.throws(() => installFrom(fakeEcc(), {}, { beforePromote: () => { throw new Error('rename failed'); } }), /rename failed/);
  assert.equal(JSON.stringify(buildIndex(installedEccDir())), before);
  assert.deepEqual(leftovers(), [], 'no staging or backup folders remain');
  assert.equal(validateCatalog(installedEccDir(), { deep: true }).ok, true);
});

test('install on top of an existing install replaces it and leaves no backup', () => {
  makeHome(); noEnv();
  installFrom(fakeEcc());
  const next = fakeEcc();
  put(next, 'skills/brand-new/SKILL.md', '---\nname: brand-new\ndescription: d\n---\nbody');
  const out = installFrom(next);
  assert.equal(out.skills, 3);
  assert.deepEqual(leftovers().filter((n) => n.startsWith('.ecc-old') || n.startsWith('.ecc-new')), []);
});

test('an interrupted swap is recovered: the previous install comes back', () => {
  makeHome(); noEnv();
  installFrom(fakeEcc());
  renameSync(installedEccDir(), join(dirname(installedEccDir()), '.ecc-old-123'));
  assert.equal(existsSync(installedEccDir()), false);
  assert.equal(recoverInterrupted(), true);
  assert.equal(eccRoot({ ecc: { path: '' } }).source, 'installed');
});

test('local install records its provenance', () => {
  makeHome(); noEnv();
  const src = fakeEcc();
  const out = installFrom(src);
  const rec = readInstalled();
  assert.equal(rec.source, 'local');
  assert.equal(rec.origin, src);
  assert.equal(rec.tracking, 'local copy');
  assert.equal(rec.version, '9.9.9');
  assert.deepEqual(rec.counts, { skills: 2, agents: 1, commands: 1, rules: 3 });
  assert.equal(out.version, '9.9.9');
});

/** A real git repo holding a fake ECC, used as the "remote". */
function remote() {
  const dir = fakeEcc();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'tag', 'v1');
  const first = git(dir, 'rev-parse', 'HEAD').trim();
  put(dir, 'skills/later/SKILL.md', '---\nname: later\ndescription: d\n---\nbody');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'two');
  return { url: dir, first, second: git(dir, 'rev-parse', 'HEAD').trim() };
}

test('git install records the full commit and what it tracks: tag, pinned commit, moving branch, unpinned', async () => {
  makeHome(); noEnv();
  const { url, first, second } = remote();
  const tag = await installFromGit({ url, ref: 'v1' });
  assert.match(tag.tracking, /^tag v1/);
  assert.equal(readInstalled().resolvedCommit, first);
  assert.equal(readInstalled().resolvedCommit.length, 40);
  assert.equal(tag.skills, 2);
  const pinned = await installFromGit({ url, ref: first });
  assert.equal(pinned.tracking, 'pinned commit');
  assert.equal(readInstalled().resolvedCommit, first);
  const branch = await installFromGit({ url, ref: 'main' });
  assert.match(branch.tracking, /moving/);
  assert.equal(readInstalled().resolvedCommit, second);
  const open = await installFromGit({ url });
  assert.match(open.tracking, /unpinned/);
  assert.equal(open.skills, 3);
});

test('status says when an install is not reproducible', async () => {
  makeHome(); noEnv();
  const { url } = remote();
  process.env.ZC_ECC_URL = url;
  const lines = [];
  const log = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(await main(['ecc', 'install']), 0);
    assert.equal(await main(['ecc', 'status', '--project', tmpdir()]), 0);
  } finally { console.log = log; noEnv(); }
  assert.match(lines.join('\n'), /tracking: unpinned/);
  assert.match(lines.join('\n'), /not reproducible/);
});

test('temporary clones are removed on every failure path, and the old install survives', async () => {
  makeHome(); noEnv();
  installFrom(fakeEcc());
  const before = JSON.stringify(buildIndex(installedEccDir()));
  const seen = [];
  const spy = (fail) => async (cmd, args, opts) => {
    const temp = opts.cwd ?? args[args.length - 1];
    if (!seen.includes(temp)) seen.push(temp);
    return fail(cmd, args, opts) ?? run(cmd, args, opts);
  };
  const { url } = remote();
  // 1. download fails
  await assert.rejects(installFromGit({ url: join(tmpdir(), 'no-such-repo'), run: spy(() => undefined) }), /could not download ECC/);
  // 2. download works, rev-parse fails
  await assert.rejects(installFromGit({ url, run: spy((c, a) => (a[0] === 'rev-parse' ? { code: 1, stderr: 'boom', stdout: '' } : undefined)) }), /rev-parse failed/);
  // 3. download works, but the checkout is not ECC
  const notEcc = mkdtempSync(join(tmpdir(), 'zc-notecc-'));
  git(notEcc, 'init', '-q', '-b', 'main'); git(notEcc, 'config', 'user.email', 't@e.com'); git(notEcc, 'config', 'user.name', 'T');
  writeFileSync(join(notEcc, 'README.md'), 'x'); git(notEcc, 'add', '-A'); git(notEcc, 'commit', '-q', '-m', 'x');
  await assert.rejects(installFromGit({ url: notEcc, run: spy(() => undefined) }), /not a usable ECC checkout/);
  // 4. a commit id the server does not have
  await assert.rejects(installFromGit({ url, ref: 'deadbeefdeadbeef', run: spy(() => undefined) }), /could not download ECC/);
  assert.ok(seen.length >= 4);
  for (const t of seen) assert.equal(existsSync(t), false, `temp ${t} was left behind`);
  assert.equal(JSON.stringify(buildIndex(installedEccDir())), before);
  assert.deepEqual(leftovers(), []);
});

test('ecc commands: a broken project config is reported; a missing one or no project falls back to defaults', async () => {
  makeHome(); noEnv();
  installFrom(fakeEcc());
  const { dir } = makeRepo();
  const quiet = async (args) => {
    const log = console.log; const err = console.error; console.log = () => {}; console.error = (m) => lines.push(String(m));
    const lines = [];
    try { return { code: await main(args), lines }; } finally { console.log = log; console.error = err; }
  };
  assert.equal((await quiet(['ecc', 'status', '--project', dir])).code, 0);
  writeFileSync(join(dir, '.zc/config.json'), '{ not json');
  const broken = await quiet(['ecc', 'status', '--project', dir]);
  assert.notEqual(broken.code, 0, 'a corrupt config must not be hidden');
  writeFileSync(join(dir, '.zc/config.json'), JSON.stringify({ version: 1, defaults: { minutes: -5 } }));
  assert.notEqual((await quiet(['ecc', 'list', '--project', dir])).code, 0);
  rmSyncQuiet(join(dir, '.zc/config.json'));
  assert.equal((await quiet(['ecc', 'status', '--project', dir])).code, 0, 'no config: defaults');
  assert.equal((await quiet(['ecc', 'status', '--project', mkdtempSync(join(tmpdir(), 'zc-nogit-'))])).code, 0, 'no project: defaults');
});
const rmSyncQuiet = (p) => rmSync(p, { force: true });

test('config validation: bad references and out-of-range limits fail at load time', () => {
  assert.throws(() => makeRepo({ ecc: { assets: ['skill:'] } }), /ecc.assets/);
  assert.throws(() => makeRepo({ ecc: { assets: ['gadget:x'] } }), /unsupported ECC kind/);
  assert.throws(() => makeRepo({ ecc: { assets: [42] } }), /ecc.assets/);
  assert.throws(() => makeRepo({ ecc: { assetMaxChars: 5 } }), /assetMaxChars/);
  assert.throws(() => makeRepo({ ecc: { assetMaxBytes: 1e12 } }), /assetMaxBytes/);
  assert.throws(() => makeRepo({ ecc: { maxChars: 'lots' } }), /maxChars/);
  assert.throws(() => makeRepo({ ecc: { rulePacks: ['../etc'] } }), /rulePacks/);
  assert.ok(makeRepo({ ecc: { assets: ['skill:x', 'rules:dart'] } }).config);
});

test('a configured rule pack that does not exist is an error, not silence', () => {
  makeHome(); noEnv();
  const { config } = makeRepo({ ecc: { rulePacks: ['common', 'cobol'] } });
  assert.throws(() => loadEccRules(config), /rule pack "cobol".*Available: common, dart, typescript/);
});
