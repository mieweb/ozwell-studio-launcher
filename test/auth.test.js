/** Forward-auth trust model: proxy allow-list, identity headers, groups. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the config this module reads before importing it (test files run in
// their own process; real env vars beat .env).
process.env.ALLOWED_PROXIES = '10.0.0.5, 192.168.0.0/16';
process.env.USER_HEADER = 'Remote-User';
process.env.USER_GROUP_HEADER = 'X-Forwarded-Groups';
process.env.AUTHORIZED_GROUPS = 'studio-users, admins';

const { authenticate, isOpenPath } = await import('../src/auth.js');

const goodHeaders = { 'remote-user': 'alice', 'x-forwarded-groups': 'studio-users' };

test('trusts an allow-listed proxy address', () => {
  assert.deepEqual(authenticate('10.0.0.5', goodHeaders), { username: 'alice' });
});

test('trusts an address inside an allow-listed CIDR', () => {
  assert.deepEqual(authenticate('192.168.7.9', goodHeaders), { username: 'alice' });
});

test('normalizes IPv4-mapped IPv6 peers', () => {
  assert.deepEqual(authenticate('::ffff:10.0.0.5', goodHeaders), { username: 'alice' });
});

test('rejects peers outside the allow-list with 403', () => {
  const { denied } = authenticate('203.0.113.9', goodHeaders);
  assert.equal(denied.code, 403);
});

test('rejects a missing username header with 401', () => {
  const { denied } = authenticate('10.0.0.5', { 'x-forwarded-groups': 'studio-users' });
  assert.equal(denied.code, 401);
});

test('rejects users outside the authorized groups with 403', () => {
  const { denied } = authenticate('10.0.0.5', {
    'remote-user': 'mallory',
    'x-forwarded-groups': 'interlopers',
  });
  assert.equal(denied.code, 403);
});

test('accepts any authorized group from a comma-separated header', () => {
  const headers = { 'remote-user': 'bob', 'x-forwarded-groups': 'interlopers, admins' };
  assert.deepEqual(authenticate('10.0.0.5', headers), { username: 'bob' });
});

test('accepts repeated group header values (array form)', () => {
  const headers = { 'remote-user': 'bob', 'x-forwarded-groups': ['interlopers', 'admins'] };
  assert.deepEqual(authenticate('10.0.0.5', headers), { username: 'bob' });
});

test('trims whitespace from the username', () => {
  const headers = { ...goodHeaders, 'remote-user': ' alice ' };
  assert.deepEqual(authenticate('10.0.0.5', headers), { username: 'alice' });
});

test('isOpenPath: liveness probe and static assets skip auth, the rest does not', () => {
  assert.equal(isOpenPath('/healthz'), true);
  assert.equal(isOpenPath('/assets/index-abc123.js'), true);
  assert.equal(isOpenPath('/favicon.png'), true);
  assert.equal(isOpenPath('/'), false);
  assert.equal(isOpenPath('/api/v1/studios'), false);
});
