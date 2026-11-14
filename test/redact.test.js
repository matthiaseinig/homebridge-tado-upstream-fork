import test from 'node:test';
import assert from 'node:assert/strict';
import Logger from '../src/helper/logger.js';
import { redact } from '../src/helper/redact.js';

test('redact masks bearer tokens in strings', () => {
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [redacted]');
});

test('redact masks secret keys in nested objects without mutating the input', () => {
  const input = { name: 'x', headers: { Authorization: 'Bearer zzz' }, body: { access_token: 'a', refresh_token: 'r', device_code: 'd', ok: 1 } };
  const out = redact(input);
  assert.equal(out.headers.Authorization, '[redacted]');
  assert.equal(out.body.access_token, '[redacted]');
  assert.equal(out.body.refresh_token, '[redacted]');
  assert.equal(out.body.device_code, '[redacted]');
  assert.equal(out.body.ok, 1);
  assert.equal(input.body.access_token, 'a');
});

test('redact masks token query/form fragments in strings', () => {
  assert.equal(redact('refresh_token=abc123&client_id=x'), 'refresh_token=[redacted]&client_id=x');
  assert.equal(redact('{"refresh_token":"abc123","a":1}'), '{"refresh_token":"[redacted]","a":1}');
});

test('redact handles cycles, null and primitives', () => {
  const a = { n: 1 };
  a.self = a;
  assert.doesNotThrow(() => redact(a));
  assert.equal(redact(null), null);
  assert.equal(redact(5), 5);
});

test('Logger never emits a token', () => {
  const lines = [];
  Logger.init({ info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }, true);
  Logger.error('API request failed', { headers: { Authorization: 'Bearer SECRETTOKEN' }, body: { refresh_token: 'SECRETREFRESH' } });
  Logger.warn('failed Bearer SECRETTOKEN2');
  Logger.debug({ access_token: 'SECRET3' });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotMatch(l, /SECRET/);
});

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

test('redact masks raw JWTs anywhere', () => {
  assert.doesNotMatch(redact(`failed with ${JWT} in message`), /eyJ/);
  assert.doesNotMatch(JSON.stringify(redact({ note: `x ${JWT}`, list: [JWT] })), /eyJ/);
});

test('redact masks camelCase and dashed token keys in objects', () => {
  const out = redact({ accessToken: 'a', refreshToken: 'b', deviceCode: 'c', 'x-api-key': 'd', idToken: 'e', clientSecret: 'f', fine: 'ok' });
  assert.deepEqual(Object.values(out).filter((v) => v !== 'ok'), Array(6).fill('[redacted]'));
  assert.equal(out.fine, 'ok');
});

test('redact masks escaped, URL-encoded, spaced and single-quoted forms', () => {
  const cases = [
    String.raw`{\"refresh_token\":\"SECRETX\"}`,
    '%7B%22refresh_token%22%3A%22SECRETX%22%7D',
    'refresh_token%3DSECRETX',
    'refresh_token = SECRETX',
    "{ 'refresh_token': 'SECRETX' }",
    '"accessToken":"SECRETX"',
    'client_secret=SECRETX&x=1',
  ];
  for (const c of cases) assert.doesNotMatch(redact(c), /SECRETX/, c);
});

test('redact masks Basic credentials and keeps normal text', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic [redacted]');
  assert.equal(redact('Polling Zones for Home'), 'Polling Zones for Home');
});

test('redact masks secrets inside Error messages and stacks', () => {
  const e = new Error(`bad refresh_token=SECRETX ${JWT}`);
  const out = redact(e);
  assert.doesNotMatch(out.message + out.stack, /SECRETX|eyJ/);
});
