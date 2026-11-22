import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as accounts from '../src/accounts.mjs';
import { ATTEST_PHRASE, attestationText, normalizeLabel, requireAttestation } from '../src/attest.mjs';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'zc.mjs');

function zc(home, args, input) {
  const env = { ...process.env, ZC_HOME: home, ZC_ISOLATION: 'none' };
  delete env.ZC_AGY;
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input });
}

const freshHome = () => mkdtempSync(join(tmpdir(), 'zc-attest-'));

test('normalizeLabel: trims, case-folds, collapses spaces; rejects empty, long and control characters', () => {
  assert.equal(normalizeLabel('  Work  Account '), 'work account');
  assert.equal(normalizeLabel('ÄBC'), 'äbc');
  assert.throws(() => normalizeLabel('   '), /label/);
  assert.throws(() => normalizeLabel('x'.repeat(65)), /label/);
  assert.throws(() => normalizeLabel('a\u0007b'), /label/);
  assert.throws(() => normalizeLabel(undefined), /label/);
  assert.equal(normalizeLabel('ＡＬＩＣＥ'), 'alice', 'fullwidth lookalikes fold to the same label');
  for (const sneaky of ['al\u200bice', 'ali\u202ece']) assert.throws(() => normalizeLabel(sneaky), /label/, JSON.stringify(sneaky));
});

test('attestation text says plainly that ZC cannot verify the claim', () => {
  const text = attestationText('g1', 'Alpha');
  assert.match(text, /cannot be verified/);
  assert.match(text, /one-google-account-per-profile/);
  assert.match(text, /quota/);
});

test('requireAttestation: flag needs a label; flag with label passes; no flag and no tty fails', async () => {
  const noTty = { isTTY: false, ask: async () => { throw new Error('must not prompt'); } };
  await assert.rejects(requireAttestation('g1', { 'confirm-unique-google-account': true }, noTty), /--label/);
  await assert.rejects(requireAttestation('g1', { label: 'a' }, noTty), /--confirm-unique-google-account/);
  assert.equal((await requireAttestation('g1', { label: ' A ', 'confirm-unique-google-account': true }, noTty)).label, 'A');
});

test('requireAttestation: interactive needs the exact typed phrase', async () => {
  const typed = (answer) => ({ isTTY: true, print: () => {}, ask: async () => answer });
  await assert.rejects(requireAttestation('g1', { label: 'a' }, typed('yes')), /phrase/);
  await assert.rejects(requireAttestation('g1', { label: 'a' }, typed('ONE-GOOGLE-ACCOUNT-PER-PROFILE')), /phrase/);
  const ok = await requireAttestation('g1', { label: 'a' }, typed(ATTEST_PHRASE));
  assert.equal(ok.label, 'a');
  await assert.rejects(requireAttestation('g1', {}, typed(ATTEST_PHRASE)), /--label/);
});

test('zc account add without --label or confirmation fails and writes nothing', () => {
  const home = freshHome();
  const cases = [
    ['account', 'add', 'g1', '--no-login'],
    ['account', 'add', 'g1', '--no-login', '--label', 'alpha'],
    ['account', 'add', 'g1', '--no-login', '--confirm-unique-google-account']
  ];
  for (const args of cases) {
    const r = zc(home, args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.equal(existsSync(join(home, 'accounts.json')), false, args.join(' '));
  }
  assert.deepEqual(readdirSync(home), []);
});

test('zc account add with label and flag attests, and list shows the label', () => {
  const home = freshHome();
  const r = zc(home, ['account', 'add', 'g1', '--no-login', '--label', 'Alpha', '--confirm-unique-google-account']);
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(home, 'accounts.json'), 'utf8'));
  assert.equal(saved.accounts.g1.identity.label, 'Alpha');
  assert.equal(saved.accounts.g1.identity.method, 'manual');
  assert.ok(Date.parse(saved.accounts.g1.identity.attestedAt) > 0);
  const list = zc(home, ['account', 'list']);
  assert.match(list.stdout, /g1/);
  assert.match(list.stdout, /attested: Alpha/);
  assert.equal(statSync(join(home, 'accounts.json')).isFile(), true);
});

test('duplicate normalized label is refused on add and on attest; own label can be re-attested', () => {
  const home = freshHome();
  const flags = ['--confirm-unique-google-account'];
  assert.equal(zc(home, ['account', 'add', 'g1', '--no-login', '--label', 'Alpha', ...flags]).status, 0);
  const dup = zc(home, ['account', 'add', 'g2', '--no-login', '--label', '  ALPHA ', ...flags]);
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /already attested/);
  const saved = JSON.parse(readFileSync(join(home, 'accounts.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.accounts), ['g1']);
  assert.equal(zc(home, ['account', 'add', 'g2', '--no-login', '--label', 'Beta', ...flags]).status, 0);
  const clash = zc(home, ['account', 'attest', 'g2', '--label', 'alpha', ...flags]);
  assert.notEqual(clash.status, 0);
  assert.equal(zc(home, ['account', 'attest', 'g1', '--label', 'ALPHA', ...flags]).status, 0);
  assert.equal(zc(home, ['account', 'attest', 'g2', '--label', 'Gamma', ...flags]).status, 0);
});

test('zc account attest: unknown id, missing label and wrong typed phrase all fail without changes', () => {
  const home = freshHome();
  assert.equal(zc(home, ['account', 'add', 'g1', '--no-login', '--label', 'a', '--confirm-unique-google-account']).status, 0);
  const before = readFileSync(join(home, 'accounts.json'), 'utf8');
  assert.notEqual(zc(home, ['account', 'attest', 'nope', '--label', 'x', '--confirm-unique-google-account']).status, 0);
  assert.notEqual(zc(home, ['account', 'attest', 'g1', '--confirm-unique-google-account']).status, 0);
  assert.notEqual(zc(home, ['account', 'attest', 'g1', '--label', 'b']).status, 0);
  assert.equal(readFileSync(join(home, 'accounts.json'), 'utf8'), before);
});

test('legacy accounts without identity read as unattested and are never auto-filled', () => {
  const home = freshHome();
  process.env.ZC_HOME = home;
  accounts.addAccount('g1');
  assert.equal(accounts.getAccount('g1').identity ?? null, null);
  assert.deepEqual(accounts.attestationStatus(accounts.getAccount('g1'), accounts.listAccounts()), 'unattested');
  accounts.attestAccount('g1', 'Alpha');
  accounts.addAccount('g2');
  accounts.attestAccount('g2', 'Beta');
  assert.equal(accounts.attestationStatus(accounts.getAccount('g2'), accounts.listAccounts()), 'attested');
  // hand-edited duplicate label: both sides report duplicate-label
  accounts.updateAccount('g2', { identity: { label: ' alpha ', attestedAt: new Date().toISOString(), method: 'manual' } });
  assert.equal(accounts.attestationStatus(accounts.getAccount('g2'), accounts.listAccounts()), 'duplicate-label');
  assert.equal(accounts.attestationStatus(accounts.getAccount('g1'), accounts.listAccounts()), 'duplicate-label');
  accounts.updateAccount('g2', { identity: { label: '', method: 'manual' } });
  assert.equal(accounts.attestationStatus(accounts.getAccount('g2'), accounts.listAccounts()), 'unattested');
});

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.(mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []);
}

test('source guard: no src code names the oauth token or installation_id files', () => {
  const offenders = sourceFiles(resolve(import.meta.dirname, '..', 'src'))
    .filter((f) => /oauth-token|installation_id/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('agy probe: only help/changelog against a temp HOME exposes no identity command', (t) => {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8' });
  if (which.status !== 0) return t.skip('agy not installed');
  const home = mkdtempSync(join(tmpdir(), 'zc-agyprobe-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const help = spawnSync('agy', ['--help'], { env, encoding: 'utf8', timeout: 30000 });
  const text = `${help.stdout}${help.stderr}`;
  for (const sub of ['whoami', 'account', 'auth', 'status']) {
    assert.doesNotMatch(text, new RegExp(`^\\s+${sub}\\b`, 'm'), `agy now has a "${sub}" command: record it as a B2 follow-up`);
  }
});
