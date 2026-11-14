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

test('quoted secrets are masked up to the closing quote (spaces, commas, percent signs)', () => {
  assert.equal(redact('password: "my pass, 1%"'), 'password: "[redacted]"');
  assert.equal(redact("password='my pass, 1%' next"), "password='[redacted]' next");
  assert.equal(redact('{"password":"a b, c % d","user":"x"}'), '{"password":"[redacted]","user":"x"}');
  assert.equal(redact('{"refresh_token":"abc def","a":1}'), '{"refresh_token":"[redacted]","a":1}');
});

test('escaped quotes inside and around a secret do not end the mask early', () => {
  assert.doesNotMatch(redact('{"password":"ab\\"TAILX, c"}'), /TAILX/);
  const escaped = String.raw`{\"password\":\"my pass, TAILX%\",\"user\":\"x\"}`;
  const out = redact(escaped);
  assert.doesNotMatch(out, /TAILX|my pass/);
  assert.match(out, /user/);
});

test('URL-encoded JSON treats %22 and %27 as delimiters', () => {
  const enc = '%7B%22password%22%3A%22my%20pass%2C%201%25TAILX%22%2C%22user%22%3A%22x%22%7D';
  const out = redact(enc);
  assert.doesNotMatch(out, /TAILX|my%20pass/);
  assert.match(out, /%22user%22%3A%22x%22/);
  assert.doesNotMatch(redact('%27password%27%3A%27a%20TAILX%27'), /TAILX/);
});

test('unquoted values stop at ampersand, whitespace, comma or brace', () => {
  assert.equal(redact('password=SECRETX&user=bob'), 'password=[redacted]&user=bob');
  assert.equal(redact('password=SECRETX, user=bob'), 'password=[redacted], user=bob');
  assert.equal(redact('{password: SECRETX}'), '{password: [redacted]}');
});

test('redact is idempotent', () => {
  const once = redact('{"password":"a b","refresh_token":"x"} refresh_token=y');
  assert.equal(redact(once), once);
});
