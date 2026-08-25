import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LoginLimiter,
  hashPassword,
  readCookie,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/auth.js';

test('password hash verifies only the right password', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('Correct horse', stored), false);
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword('correct horse', 'garbage'), false);
});

test('hashing the same password twice uses a fresh salt', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('session token round-trips and expires', () => {
  const token = signSession('secret', 1000, 0);
  assert.equal(verifySession('secret', token, 500), true);
  assert.equal(verifySession('secret', token, 1001), false);
});

test('session token is rejected under a different secret or tampering', () => {
  const token = signSession('secret', 1000, 0);
  assert.equal(verifySession('other', token, 500), false);
  assert.equal(verifySession('secret', `${token}x`, 500), false);
  assert.equal(verifySession('secret', 'nonsense', 500), false);
  assert.equal(verifySession('secret', null, 500), false);
});

test('readCookie picks the named cookie only', () => {
  const header = 'theme=dark; hd_session=abc.def; other=1';
  assert.equal(readCookie(header, 'hd_session'), 'abc.def');
  assert.equal(readCookie(header, 'missing'), null);
  assert.equal(readCookie(undefined, 'hd_session'), null);
});

test('limiter locks out after the attempt budget and resets on success', () => {
  const limiter = new LoginLimiter({ maxAttempts: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.retryAfter('ip', 0), 0);
    limiter.fail('ip', 0);
  }
  assert.ok(limiter.retryAfter('ip', 0) > 0);
  assert.equal(limiter.retryAfter('ip', 1001), 0, 'window expires');

  limiter.fail('ip', 2000);
  limiter.reset('ip');
  assert.equal(limiter.retryAfter('ip', 2000), 0);
});
