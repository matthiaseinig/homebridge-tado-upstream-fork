import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Tado from '../src/tado/tado-api.js';
import Logger from '../src/helper/logger.js';

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

test('a 401 from the API after a valid token is token_rejected and drops the cached access token', async () => {
  let n = 0;
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return { access_token: `AT${++n}`, refresh_token: 'RTX' };
    throw httpError(401);
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(s.tado.health.snapshot().reason, 'token_rejected');
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

async function okSetup() {
  const s = await setup((url) => (url.endsWith('/oauth2/token') ? tokenOk : {}));
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  return s;
}

test('switchAll and resumeShedule track a write per zone', async () => {
  const s = await okSetup();
  await s.tado.switchAll(1, [{ id: 3, power: 'OFF' }, { id: 4, power: 'ON', maxTempInCelsius: 25 }]);
  assert.deepEqual(s.tado.writes.get('3').expect, { power: 'OFF' });
  assert.deepEqual(s.tado.writes.get('4').expect, { power: 'ON', temperature: 25 });
  await s.tado.resumeShedule(1, [3, 5]);
  assert.deepEqual(s.tado.writes.get('3').expect, { clear: true });
  assert.deepEqual(s.tado.writes.get('5').expect, { clear: true });
  await s.done();
});

test('open window, presence lock and child lock writes are tracked', async () => {
  const s = await okSetup();
  await s.tado.setOpenWindowMode(1, 9, true);
  assert.deepEqual(s.tado.writes.get('openWindow:9').expect, { value: true });
  await s.tado.setPresenceLock(1, 'away');
  assert.deepEqual(s.tado.writes.get('presence').expect, { value: 'AWAY' });
  await s.tado.setChildLock('RU123', true);
  assert.deepEqual(s.tado.writes.get('childLock:RU123').expect, { value: true });
  await s.done();
});

test('failed presence lock write is not tracked', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    throw httpError(500);
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  await assert.rejects(() => s.tado.setPresenceLock(1, 'HOME'));
  assert.equal(s.tado.writes.get('presence'), undefined);
  await s.done();
});

test('a persistently failing optional call does not back off or stale the core data', async () => {
  let weatherDown = true;
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (url.endsWith('/weather')) { if (weatherDown) throw httpError(503); return {}; }
    return { ok: true };
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  for (let i = 0; i < 4; i++) {
    s.tado.health.beginCycle();
    await s.tado.getZones(1);
    await s.tado.getZoneStates(1);
    await assert.rejects(() => s.tado.getWeather(1));
    s.tado.health.endCycle();
  }
  assert.equal(s.tado.health.snapshot().sourceStatus, 'ok');
  assert.equal(s.tado.health.backoffMs(), 0);
  assert.equal(s.tado.health.featureSnapshot().weather.stale, true);
  assert.equal(s.tado.health.featureReady('weather'), false);
  weatherDown = false;
  s.clock.t += 11 * 60 * 1000;
  s.tado.health.beginCycle();
  await s.tado.getWeather(1);
  assert.equal(s.tado.health.featureSnapshot().weather.stale, false);
  await s.done();
});

test('core call failures still drive staleness and backoff', async () => {
  const s = await setup((url) => {
    if (url.endsWith('/oauth2/token')) return tokenOk;
    if (url.endsWith('/zoneStates')) throw httpError(503);
    return { ok: true };
  });
  await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
  s.tado.health.beginCycle();
  await s.tado.getZones(1);
  await assert.rejects(() => s.tado.getZoneStates(1));
  assert.equal(s.tado.health.snapshot().reason, 'offline');
  assert.equal(s.tado.health.backoffMs(), 30000);
  await s.done();
});

test('call classes: running time, presence, devices and weather are optional; writes do not affect health', async () => {
  const s = await setup((url) => (url.endsWith('/oauth2/token') ? tokenOk : {}));
  const c = (path, method = 'GET', minder) => s.tado._callClass(path, method, minder);
  assert.deepEqual(c('/api/v2/homes/1/zoneStates'), { kind: 'core' });
  assert.deepEqual(c('/api/v2/homes/1/zones'), { kind: 'core' });
  assert.deepEqual(c('/api/v2/me'), { kind: 'core' });
  assert.deepEqual(c('/api/v2/homes/1'), { kind: 'core' });
  assert.deepEqual(c('/v1/homes/1/runningTimes', 'GET', 'https://minder.tado.com'), { kind: 'feature', name: 'runningTime' });
  assert.deepEqual(c('/api/v2/homes/1/weather'), { kind: 'feature', name: 'weather' });
  assert.deepEqual(c('/api/v2/homes/1/mobileDevices'), { kind: 'feature', name: 'presence' });
  assert.deepEqual(c('/api/v2/homes/1/state'), { kind: 'feature', name: 'presenceLock' });
  assert.deepEqual(c('/api/v2/homes/1/devices'), { kind: 'feature', name: 'devices' });
  assert.deepEqual(c('/api/v2/homes/1/zones/3/state'), { kind: 'none' });
  assert.deepEqual(c('/api/v2/homes/1/zones/3/overlay', 'PUT'), { kind: 'none' });
  await s.done();
});

test('token log lines never contain error text that could quote a token', async () => {
  const lines = [];
  Logger.init({ info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }, true);
  try {
    const leaky = 'LEAKYSECRET0123456789abcdef';
    const s = await setup((url) => {
      if (url.endsWith('/oauth2/token')) throw Object.assign(new Error(`refresh_token ${leaky} rejected`), { response: { statusCode: 503, headers: {}, body: {} } });
      return {};
    });
    await writeFile(s.tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
    await assert.rejects(() => s.tado.apiCall('/api/v2/me'), (e) => !e.message.includes(leaky));
    assert.ok(lines.some((l) => l.includes('Token refresh failed (reason: HTTP 503)')));
    for (const l of lines) assert.doesNotMatch(l, /LEAKYSECRET/);
    await s.done();

    // a corrupt token file: JSON.parse quotes the file content in its message
    const bad = await setup(() => ({}), {});
    await writeFile(bad.tokenFile, `{"refresh_token": "${leaky}" oops`);
    lines.length = 0;
    await assert.rejects(() => bad.tado.apiCall('/api/v2/me').catch((e) => { throw e; }), () => true).catch(() => {});
    assert.ok(lines.some((l) => l.includes('Failed to load from internal file') && l.includes('unexpected error')), JSON.stringify(lines));
    for (const l of lines) assert.doesNotMatch(l, /LEAKYSECRET/);
    await bad.done();
  } finally {
    Logger.init({ info() {}, warn() {}, error() {} }, false);
  }
});
