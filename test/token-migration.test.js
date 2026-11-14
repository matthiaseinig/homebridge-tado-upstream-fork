import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Tado from '../src/tado/tado-api.js';
import Logger from '../src/helper/logger.js';

const USERNAME = 'owner@example.invalid';
const legacyName = (u) => `.tado-token-${createHash('sha256').update(u).digest('hex').slice(0, 16)}.json`;
const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { response: { statusCode, headers: {}, body: {} } });
const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function setup(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  dirs.push(dir);
  const calls = [];
  const run = async (url, options = {}) => { calls.push({ url, options }); return { statusCode: 200, body: await handler(url, options) }; };
  const http = (url, options) => run(url, options);
  http.post = (url, options) => run(url, { ...options, method: 'POST' });
  const tado = new Tado('Test', { username: USERNAME }, dir, false, { http, now: () => 1_700_000_000_000, sleep: async () => {} });
  const current = join(dir, `.tado-token-${tado.hashedUsername}.json`);
  const legacy = join(dir, legacyName(USERNAME));
  return { tado, dir, calls, current, legacy };
}

const refreshOk = (url, o) => {
  if (url.endsWith('/oauth2/token') && o.form?.grant_type === 'refresh_token') return { access_token: 'AT-NEW', refresh_token: 'RT-NEW' };
  return { ok: true };
};

test('the legacy name differs from the current short-hash name (guards the fixture)', async () => {
  const s = await setup(refreshOk);
  assert.notEqual(s.current, s.legacy);
  assert.match(s.legacy, /\.tado-token-[0-9a-f]{16}\.json$/);
});

test('a login saved under the legacy sha256-16 name is used without a device login', async () => {
  const s = await setup(refreshOk);
  await writeFile(s.legacy, JSON.stringify({ access_token: 'old', refresh_token: 'RT-LEGACY' }));
  await s.tado.apiCall('/api/v2/me');
  assert.equal(s.calls.some((c) => c.url.endsWith('/device_authorize')), false, 'no device login');
  const refresh = s.calls.find((c) => c.options.form?.grant_type === 'refresh_token');
  assert.equal(refresh.options.form.refresh_token, 'RT-LEGACY');
});

test('after a successful refresh the new name is written (0600, atomic) and the legacy file is removed', async () => {
  const s = await setup(refreshOk);
  await writeFile(s.legacy, JSON.stringify({ access_token: 'old', refresh_token: 'RT-LEGACY' }));
  await s.tado.apiCall('/api/v2/me');
  assert.deepEqual(JSON.parse(await readFile(s.current, 'utf8')), { access_token: 'AT-NEW', refresh_token: 'RT-NEW' });
  assert.equal((await stat(s.current)).mode & 0o777, 0o600);
  const files = await readdir(s.dir);
  assert.ok(!files.includes(legacyName(USERNAME)), 'legacy file removed after success');
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no temp file left');
});

test('the legacy file is kept while the refresh has not succeeded (outage)', async () => {
  const s = await setup((url) => { if (url.endsWith('/oauth2/token')) throw httpError(503); return {}; });
  await writeFile(s.legacy, JSON.stringify({ refresh_token: 'RT-LEGACY' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.equal(JSON.parse(await readFile(s.legacy, 'utf8')).refresh_token, 'RT-LEGACY');
  assert.equal((await readdir(s.dir)).includes(`.tado-token-${s.tado.hashedUsername}.json`), false);
  assert.equal(s.calls.some((c) => c.url.endsWith('/device_authorize')), false);
});

test('the current name wins when both files exist, and the legacy file is left alone', async () => {
  const s = await setup(refreshOk);
  await writeFile(s.current, JSON.stringify({ refresh_token: 'RT-CURRENT' }));
  await writeFile(s.legacy, JSON.stringify({ refresh_token: 'RT-LEGACY' }));
  await s.tado.apiCall('/api/v2/me');
  const refresh = s.calls.find((c) => c.options.form?.grant_type === 'refresh_token');
  assert.equal(refresh.options.form.refresh_token, 'RT-CURRENT');
  assert.ok((await readdir(s.dir)).includes(legacyName(USERNAME)));
});

test('an unreadable current file falls back to the legacy file', async () => {
  const s = await setup(refreshOk);
  await writeFile(s.current, 'not json');
  await writeFile(s.legacy, JSON.stringify({ refresh_token: 'RT-LEGACY' }));
  await s.tado.apiCall('/api/v2/me');
  const refresh = s.calls.find((c) => c.options.form?.grant_type === 'refresh_token');
  assert.equal(refresh.options.form.refresh_token, 'RT-LEGACY');
  assert.equal(JSON.parse(await readFile(s.current, 'utf8')).refresh_token, 'RT-NEW');
});

test('a rejected legacy refresh token falls back to device login and keeps the legacy file until a new login succeeds', async () => {
  const s = await setup((url, o) => {
    if (url.endsWith('/device_authorize')) return { device_code: 'DC', verification_uri_complete: 'https://login.example.invalid/x' };
    if (url.endsWith('/oauth2/token')) { if (o.form.grant_type === 'refresh_token') throw httpError(400); throw httpError(400); }
    return {};
  });
  await writeFile(s.legacy, JSON.stringify({ refresh_token: 'RT-DEAD' }));
  await assert.rejects(() => s.tado.apiCall('/api/v2/me'));
  assert.ok((await readdir(s.dir)).includes(legacyName(USERNAME)), 'legacy file kept: no new login succeeded');
});

test('migration and legacy pickup never log tokens or the username', async () => {
  const lines = [];
  Logger.init({ info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }, true);
  try {
    const s = await setup(refreshOk);
    await writeFile(s.legacy, JSON.stringify({ refresh_token: 'RT-LEGACY-SECRET-0123456789' }));
    await s.tado.apiCall('/api/v2/me');
    assert.ok(lines.some((l) => l.includes('Migrated the login')), JSON.stringify(lines));
    for (const l of lines) {
      assert.doesNotMatch(l, /RT-LEGACY-SECRET|RT-NEW|AT-NEW|owner@example/);
    }
  } finally {
    Logger.init({ info() {}, warn() {}, error() {} }, false);
  }
});

test('an external token file username keeps working and has no legacy paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  dirs.push(dir);
  const tado = new Tado('Test', { username: '/some/where/tokens.json' }, dir, false, { http: () => { throw new Error('unused'); } });
  assert.deepEqual(tado._legacyTokenFilePaths, []);
});
