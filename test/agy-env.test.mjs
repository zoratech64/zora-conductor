import test from 'node:test';
import assert from 'node:assert/strict';
import { agyEnv } from '../src/agy.mjs';

test('win32 and darwin get the SSH hints that make agy use file token storage', () => {
  for (const platform of ['win32', 'darwin']) {
    const env = agyEnv(platform, {});
    assert.equal(env.GEMINI_FORCE_FILE_STORAGE, 'true');
    assert.ok(env.SSH_CLIENT);
    assert.ok(env.SSH_CONNECTION);
  }
});

test('linux relies on the private D-Bus session, not SSH hints', () => {
  const env = agyEnv('linux', {});
  assert.equal(env.SSH_CLIENT, undefined);
  assert.equal(env.SSH_CONNECTION, undefined);
});

test('ZC_ISOLATION=none and existing SSH values are respected', () => {
  assert.equal(agyEnv('win32', { ZC_ISOLATION: 'none' }).SSH_CLIENT, undefined);
  assert.equal(agyEnv('win32', { SSH_CLIENT: 'a b c' }).SSH_CLIENT, 'a b c');
});
