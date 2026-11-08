import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as accounts from '../src/accounts.mjs';
import { agyRunArgs, parseAgyOutput, parseUsage } from '../src/agy.mjs';
import { parseArgs } from '../src/args.mjs';
import { classify, parseResetHint } from '../src/classify.mjs';
import { globToRegExp, isForbidden, matches, partitionByScope } from '../src/scope.mjs';
import { parseTask, splitArgv } from '../src/task.mjs';
import { makeHome } from './helpers.mjs';

test('globs: directories, **, *, and bare directory names', () => {
  assert.ok(matches('lib/features/auth/login.dart', ['lib/features/auth/']));
  assert.ok(matches('lib/features/auth/login.dart', ['lib/features/auth']));
  assert.ok(matches('a/b/c.ts', ['**/*.ts']));
  assert.ok(matches('c.ts', ['**/*.ts']));
  assert.ok(!matches('a/b/c.js', ['**/*.ts']));
  assert.ok(!matches('src/deep/x.ts', ['src/*.ts']));
  assert.ok(matches('src\\win\\x.ts', ['src/win/']));
  assert.ok(!matches('lib/features/authentic/x.dart', ['lib/features/auth']));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
});

test('forbidden paths cannot be allowed, but templates can', () => {
  for (const p of ['.env', 'config/.env.production', 'keys/server.pem', '.git/config', 'a/id_rsa', '.zc/config.json']) {
    assert.ok(isForbidden(p), p);
  }
  assert.ok(!isForbidden('.env.example'));
  assert.ok(!isForbidden('lib/main.dart'));
  const r = partitionByScope(['src/a', '.env', 'x/y'], ['src/', '.env']);
  assert.deepEqual(r, { forbidden: ['.env'], outOfScope: ['x/y'] });
});

test('splitArgv: quotes, no operators', () => {
  assert.deepEqual(splitArgv('flutter test --name "my test" \'a b\''), ['flutter', 'test', '--name', 'my test', 'a b']);
  assert.deepEqual(splitArgv('npm  run   build'), ['npm', 'run', 'build']);
  assert.deepEqual(splitArgv('echo a && rm -rf x'), ['echo', 'a', '&&', 'rm', '-rf', 'x']); // passed as plain args, never a shell
  assert.throws(() => splitArgv('echo "oops'), /unterminated/);
});

test('task files: front matter lists, scalars, inline lists', () => {
  const t = parseTask('---\nid: T 7!\ntitle: "Login screen"\nallowed:\n  - lib/a/\n  - lib/b/\nverify:\n  - dart analyze\n  - flutter test test/a\nminutes: 20\n---\n\nBody here\n');
  assert.equal(t.meta.id, 'T-7-');
  assert.equal(t.meta.title, 'Login screen');
  assert.deepEqual(t.meta.allowed, ['lib/a/', 'lib/b/']);
  assert.deepEqual(t.meta.verify, [['dart', 'analyze'], ['flutter', 'test', 'test/a']]);
  assert.equal(t.meta.minutes, 20);
  assert.equal(t.body, 'Body here');
  assert.deepEqual(parseTask('---\nallowed: [a/, b/]\n---\nx').meta.allowed, ['a/', 'b/']);
  assert.equal(parseTask('no front matter', { fallbackId: 'F' }).meta.id, 'F');
});

test('classify: each failure kind, and ordinary text is not a failure', () => {
  assert.equal(classify('403 SUBSCRIPTION_REQUIRED'), 'license');
  assert.equal(classify('User location is not supported for the API use.'), 'location');
  assert.equal(classify('Authentication required'), 'auth');
  assert.equal(classify('RESOURCE_EXHAUSTED: quota exceeded'), 'quota');
  assert.equal(classify('HTTP 429 Too Many Requests'), 'quota');
  assert.equal(classify('Internal error encountered'), 'server');
  assert.equal(classify('TypeError: x is not a function'), null);
  // A license problem that also mentions location must be treated as a license problem.
  assert.equal(classify('SUBSCRIPTION_REQUIRED ... location'), 'license');
});

test('reset hints: relative and absolute', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  assert.equal(parseResetHint('please try again in 30 minutes', now), now + 30 * 60_000);
  assert.equal(parseResetHint('retry after 2 hours', now), now + 2 * 3_600_000);
  assert.equal(parseResetHint('resets at 2026-11-08T15:00:00Z', now), Date.UTC(2026, 10, 8, 15));
  assert.equal(parseResetHint('quota exceeded', now), null);
  assert.equal(parseResetHint('resets at 2020-01-01T00:00:00Z', now), null);
});

test('agy output: success, error result, stray stderr, permission denial', () => {
  const ok = parseAgyOutput([
    '{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_name":"write_to_file","tool_info":{}}}',
    '{"event":"result","result":{"status":"SUCCESS","response":" done ","num_turns":3,"conversation_id":"c9"}}'
  ].join('\n'));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(ok.response, 'done');
  assert.equal(ok.tools.length, 1);
  assert.equal(ok.conversationId, 'c9');

  const bad = parseAgyOutput('{"event":"result","result":{"status":"ERROR","error":"quota exceeded"}}\nAuthentication required');
  assert.equal(bad.error, 'quota exceeded');
  assert.deepEqual(bad.softErrors, ['Authentication required']);

  const denied = parseAgyOutput('{"event":"step_update","step_update":{"step_type":"tool","state":"ERROR","tool_name":"run_command","tool_info":{"error":{"message":"headless mode cannot prompt"}}}}');
  assert.deepEqual(denied.permissionAsks, ['run_command']);
});

test('agy arguments: isolated profile, prompt on stdin, permission modes', () => {
  const args = agyRunArgs({ profileDir: '/p/g1', workspace: '/w', timeoutSec: 60, model: 'm', effort: 'high' });
  assert.deepEqual(args.slice(0, 2), ['--gemini_dir', '/p/g1']);
  assert.ok(args.includes('--new-project') && args.includes('accept-edits') && !args.includes('-p'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(agyRunArgs({ profileDir: 'x', timeoutSec: 1, permissions: 'all' }).includes('--dangerously-skip-permissions'));
  assert.ok(agyRunArgs({ profileDir: 'x', timeoutSec: 1, permissions: 'read' }).includes('plan'));
});

test('usage table parsing', () => {
  const limits = parseUsage('Gemini Models\tFive Hour Limit Remaining\t42%\t2026-11-08T17:00:00Z\nnoise line\nGemini Models\tWeekly Limit Remaining\t90.5%\t2026-11-15T00:00:00Z');
  assert.equal(limits.length, 2);
  assert.deepEqual([limits[0].window, limits[0].remainingPercent], ['five hour', 42]);
});

test('args parser', () => {
  const o = parseArgs(['--task', 't.md', '--allow', 'a', '--allow=b', '--json', 'pos'], { bool: ['json'], multi: ['allow'] });
  assert.equal(o.task, 't.md');
  assert.deepEqual(o.allow, ['a', 'b']);
  assert.equal(o.json, true);
  assert.deepEqual(o._, ['pos']);
  assert.throws(() => parseArgs(['--task']), /needs a value/);
});

test('accounts: sticky pick, LRU fallback, cooldown, blocked, next-available', () => {
  makeHome();
  for (const id of ['a', 'b', 'c']) accounts.addAccount(id);
  assert.equal(accounts.pickNext(), null, 'accounts start as needs-login');
  for (const id of ['a', 'b', 'c']) accounts.resetAccount(id);
  assert.equal(accounts.pickNext().id, 'a');
  accounts.markUsed('b');
  assert.equal(accounts.pickNext().id, 'b', 'sticks with the current account');
  const now = Date.now();
  accounts.cooldown('b', now + 60_000, 'quota');
  assert.equal(accounts.pickNext().id, 'a', 'least recently used among the rest');
  accounts.setStatus('a', 'blocked', 'license');
  assert.equal(accounts.pickNext().id, 'c');
  accounts.cooldown('c', now + 30_000, 'quota');
  assert.equal(accounts.pickNext(), null);
  assert.equal(accounts.nextAvailableAt(now), now + 30_000);
  assert.throws(() => accounts.addAccount('a'), /already exists/);
  assert.throws(() => accounts.addAccount('bad id'), /must be/);
});
