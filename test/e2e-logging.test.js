// End to end: real Tado API object (fake HTTP), real handler, real Logger. The
// plugin's own readable messages must reach the log verbatim, while credentials
// never do.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Tado from '../src/tado/tado-api.js';
import DeviceHandler from '../src/helper/handler.js';
import Logger from '../src/helper/logger.js';

const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { response: { statusCode, headers: {}, body: {} } });
const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))));

function fakeHttp(handler) {
  const run = async (url, options = {}) => ({ statusCode: 200, body: await handler(url, options) });
  const http = (url, options) => run(url, options);
  http.post = (url, options) => run(url, { ...options, method: 'POST' });
  return http;
}

async function newTado(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  dirs.push(dir);
  const clock = { t: Date.parse('2026-11-14T10:00:00Z') };
  const tado = new Tado('Test', { username: 'user@example.invalid' }, dir, false, {
    http: fakeHttp(handler),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
  });
  return { tado, dir, clock, tokenFile: join(dir, `.tado-token-${tado.hashedUsername}.json`) };
}

function captureLog() {
  const lines = [];
  Logger.init({ info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }, true);
  return lines;
}
const restoreLog = () => Logger.init({ info() {}, warn() {}, error() {} }, false);

const SIGN_IN_AGAIN = 'Tado authorization is required. Open the plugin settings in Homebridge to sign in again.';

test('login cooldown: the sign-in-again text reaches the log verbatim through the real handler', async () => {
  const lines = captureLog();
  try {
    const { tado } = await newTado((url) => {
      if (url.endsWith('/device_authorize')) return { device_code: 'DEVICECODESECRET123456', verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=ABCD-1234' };
      if (url.endsWith('/oauth2/token')) throw httpError(400);
      return {};
    });
    // first call runs the device login to its end and starts the cooldown
    await assert.rejects(() => tado.apiCall('/api/v2/me'));
    lines.length = 0;

    const storage = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
    dirs.push(storage);
    const config = {
      homeId: 7001, homeName: 'E2E', polling: 60, temperatureUnit: 'CELSIUS', presence: [], weather: {}, extras: {}, childLock: [],
      zones: [{ id: 1, name: 'Z1', type: 'HEATING', noBattery: true }],
    };
    const api = { user: { storagePath: () => storage }, hap: { Service: {}, Characteristic: {} } };
    const handler = DeviceHandler(api, [], config, tado, undefined);
    tado.health.beginCycle();
    await handler.getStates();

    const failure = lines.find((l) => l.includes('Failed to update zones'));
    assert.ok(failure, JSON.stringify(lines));
    assert.ok(failure.includes(SIGN_IN_AGAIN), `message was masked: ${failure}`);
    assert.doesNotMatch(failure, /\[redacted\]/);
    for (const l of lines) assert.doesNotMatch(l, /DEVICECODESECRET/);
    assert.equal(tado.health.snapshot().reason, 'auth_expired');
  } finally {
    restoreLog();
  }
});

test('the device login URL with its user_code is logged readable, the device_code is not', async () => {
  const lines = captureLog();
  try {
    const { tado } = await newTado((url) => {
      if (url.endsWith('/device_authorize')) return { device_code: 'DEVICECODESECRET123456', verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=ABCD-1234' };
      throw httpError(400);
    });
    await assert.rejects(() => tado.apiCall('/api/v2/me'));
    assert.ok(lines.some((l) => l.includes('user_code=ABCD-1234')), JSON.stringify(lines));
    for (const l of lines) assert.doesNotMatch(l, /DEVICECODESECRET/);
  } finally {
    restoreLog();
  }
});

for (const code of ['EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_GOT_REQUEST_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
  test(`token refresh failure reason ${code} is logged readable`, async () => {
    const lines = captureLog();
    try {
      const { tado, tokenFile } = await newTado((url) => {
        if (url.endsWith('/oauth2/token')) throw Object.assign(new Error(`boom refresh_token LEAKYSECRET0123456789`), { code });
        return {};
      });
      await writeFile(tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
      await assert.rejects(() => tado.apiCall('/api/v2/me'), (e) => e.message === `Access token request failed (reason: ${code})`);
      assert.ok(lines.some((l) => l === `Token refresh failed (reason: ${code})`), JSON.stringify(lines));
      for (const l of lines) assert.doesNotMatch(l, /LEAKYSECRET/);
    } finally {
      restoreLog();
    }
  });
}

test('an error without status or code is logged as "unexpected error"', async () => {
  const lines = captureLog();
  try {
    const { tado, tokenFile } = await newTado((url) => {
      if (url.endsWith('/oauth2/token')) throw new Error('weird LEAKYSECRET0123456789');
      return {};
    });
    await writeFile(tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
    await assert.rejects(() => tado.apiCall('/api/v2/me'), (e) => e.message === 'Access token request failed (reason: unexpected error)');
    assert.ok(lines.some((l) => l === 'Token refresh failed (reason: unexpected error)'), JSON.stringify(lines));
    for (const l of lines) assert.doesNotMatch(l, /LEAKYSECRET/);
  } finally {
    restoreLog();
  }
});

test('handler feature names match the names the real Tado API reports for the calls they make', async () => {
  const handlerSource = readFileSync(new URL('../src/helper/handler.js', import.meta.url), 'utf8');
  const names = [...handlerSource.matchAll(/optionalUpdate\('(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['devices', 'presence', 'presenceLock', 'runningTime', 'weather']);

  // the call each optional update makes, through the real Tado object
  const calls = {
    presence: (t) => t.getMobileDevices(1),
    weather: (t) => t.getWeather(1),
    runningTime: (t) => t.getRunningTime(1, 'day', '2026-01-01', '2026-01-02'),
    presenceLock: (t) => t.getState(1),
    devices: (t) => t.getDevices(1),
  };
  for (const name of names) {
    assert.ok(calls[name], `no call mapped for ${name}`);
    const { tado, tokenFile } = await newTado((url) => {
      if (url.endsWith('/oauth2/token')) return { access_token: 'AT', refresh_token: 'RT' };
      throw httpError(503);
    });
    await writeFile(tokenFile, JSON.stringify({ refresh_token: 'RT1' }));
    tado.health.beginCycle();
    await assert.rejects(() => calls[name](tado));
    const features = tado.health.featureSnapshot();
    assert.deepEqual(Object.keys(features), [name], `${name} call reported ${Object.keys(features)}`);
    assert.equal(features[name].stale, true);
    assert.equal(tado.health.snapshot().sourceStatus, 'pending', 'core health untouched by an optional call');
    assert.equal(tado.health.featureReady(name), false);
  }
});
