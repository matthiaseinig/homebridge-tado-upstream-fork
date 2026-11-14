import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Tado from '../src/tado/tado-api.js';

const httpError = (statusCode, headers = {}) => Object.assign(new Error(`HTTP ${statusCode}`), { response: { statusCode, headers, body: {} } });

// Fake got: records calls, answers by URL suffix from a handler(url, options) -> body | throws.
function fakeHttp(handler) {
  const calls = [];
  const run = async (url, options = {}) => {
    calls.push({ url, options });
    return { statusCode: 200, body: await handler(url, options) };
  };
  const http = (url, options) => run(url, options);
  http.post = (url, options) => run(url, { ...options, method: 'POST' });
  http.calls = calls;
  return http;
}

const tempDirs = [];
after(() => Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }))));

async function setup(handler, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  tempDirs.push(dir);
  const http = fakeHttp(handler);
  const clock = { t: Date.parse('2026-11-14T10:00:00Z') };
  const sleeps = [];
  const tado = new Tado('Test', { username: 'user@example.invalid' }, dir, false, {
    http,
    now: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    ...extra,
  });
  const tokenFile = join(dir, `.tado-token-${tado.hashedUsername}.json`);
  return { tado, http, dir, tokenFile, clock, sleeps, done: () => rm(dir, { recursive: true, force: true }) };
}

const tokenOk = { access_token: 'AT1', refresh_token: 'RT2' };

test('apiCall success marks the source ok and stamps sourceTimestamp', async () => {
  const s = await setup((url) => (url.endsWith('/oauth2/token') ? tokenOk : { ok: true }));
  await writeFile(s.tokenFile, JSON.stringify({ access_token: 'old', refresh_token: 'RT1' }));
  await s.tado.apiCall('/api/v2/me');
  const snap = s.tado.health.snapshot();
  assert.equal(snap.sourceStatus, 'ok');
  assert.equal(snap.sourceTimestamp, '2026-11-14T10:00:00.000Z');
  await s.done();
});

test('a cloud outage after success shows stale, with the last good timestamp', async () => {
  let down = false;
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (down) throw httpError(503);
    return { ok: true };
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await s.tado.apiCall('/api/v2/me');
  down = true;
  s.clock.t += 60000;
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  const snap = s.tado.health.snapshot();
  assert.equal(snap.sourceStatus, 'stale');
  assert.equal(snap.reason, 'offline');
  assert.equal(snap.sourceTimestamp, '2026-11-14T10:00:00.000Z');
  await s.done();
});

test('a transient refresh failure keeps the refresh token and does not start device login', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) throw httpError(503);
    throw new Error(`unexpected ${url}`);
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(s.http.calls.some((c) => c.url.endsWith('/device_authorize')), false);
  assert.equal(JSON.parse(await readFile(s.tokenFile, 'utf8')).refresh_token, 'RT1');
  assert.equal(s.tado.health.snapshot().reason, 'offline');
  await s.done();
});

test('a rate limited refresh is classified rate_limited and honours Retry-After', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) throw httpError(429, { 'retry-after': '120' });
    return {};
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(s.tado.health.snapshot().reason, 'rate_limited');
  assert.equal(s.tado.health.backoffMs(), 120000);
  await s.done();
});

test('a rejected refresh token (400 invalid_grant) falls back to device login', async () => {
  let pollCount = 0;
  const s = await setup((url, o) => {
    if (url.endsWith('/device_authorize')) return { device_code: 'DC', verification_uri_complete: 'https://login.example.invalid/x' };
    if (url.endsWith('/oauth2/token')) {
      if (o.form.grant_type === 'refresh_token') throw httpError(400);
      pollCount += 1;
      if (pollCount < 2) throw httpError(400);
      return tokenOk;
    }
    return { email: 'user@example.invalid' };
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await s.tado.apiCall('/api/v2/me');
  assert.equal(s.http.calls.some((c) => c.url.endsWith('/device_authorize')), true);
  assert.equal(JSON.parse(await readFile(s.tokenFile, 'utf8')).refresh_token, 'RT2');
  await s.done();
});

test('an expired device login reports auth_expired and enters a cooldown with no new device_authorize', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/device_authorize')) return { device_code: 'DC', verification_uri_complete: 'https://login.example.invalid/x' };
    if (url.endsWith('/oauth2/token')) throw httpError(400);
    return {};
  });
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  const authorizeCalls = () => s.http.calls.filter((c) => c.url.endsWith('/device_authorize')).length;
  assert.equal(authorizeCalls(), 1);
  assert.equal(s.tado.health.snapshot().reason, 'auth_expired');
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'), (e) => e.code === 'TADO_AUTH_REQUIRED' || e.cause?.code === 'TADO_AUTH_REQUIRED');
  assert.equal(authorizeCalls(), 1);
  s.clock.t += 11 * 60 * 1000;
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(authorizeCalls(), 2);
  await s.done();
});

test('a 401 from the API after a valid token is auth_expired and drops the cached access token', async () => {
  let n = 0;
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return { access_token: `AT${++n}`, refresh_token: 'RTX' };
    throw httpError(401);
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(s.tado.health.snapshot().reason, 'auth_expired');
  s.clock.t += 1000;
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(n, 2, 'token was refreshed again instead of reusing the rejected one');
  await s.done();
});

test('successful overlay writes are accepted, not confirmed', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (url.endsWith('/state')) return { setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20 } } };
    return {};
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await s.tado.setZoneOverlay(1, 7, 'ON', 22, 'MANUAL', 'CELSIUS');
  assert.equal(s.tado.writes.get('7').status, 'accepted');
  assert.deepEqual(s.tado.writes.get('7').expect, { power: 'ON', temperature: 22 });
  await s.tado.clearZoneOverlay(1, 8);
  assert.deepEqual(s.tado.writes.get('8').expect, { clear: true });
  await s.done();
});

test('a failed write is not recorded as accepted', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (url.endsWith('/state')) return { setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20 } } };
    throw httpError(500);
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.setZoneOverlay(1, 7, 'ON', 22, 'MANUAL', 'CELSIUS'));
  assert.equal(s.tado.writes.get('7'), undefined);
  await s.done();
});

test('Fahrenheit writes are tracked in Celsius', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (url.endsWith('/state')) return { setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20 } } };
    return {};
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await s.tado.setZoneOverlay(1, 7, 'ON', 68, 'MANUAL', 'FAHRENHEIT');
  assert.equal(s.tado.writes.get('7').expect.temperature, 20);
  await s.done();
});
