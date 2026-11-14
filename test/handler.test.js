import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import DeviceHandler from '../src/helper/handler.js';
import Logger from '../src/helper/logger.js';
import { SourceHealth } from '../src/helper/source-health.js';
import { WriteTracker } from '../src/helper/write-tracker.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/zone-states.json', import.meta.url), 'utf8'));
// the zone loop also reads sensor data
const sensors = { insideTemperature: { celsius: 19.2, fahrenheit: 66.6 }, humidity: { percentage: 50 } };
const fx = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === 'note' ? v : { ...v, sensorDataPoints: sensors }]));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
Logger.init(quiet, false);

// persistStatus is fire-and-forget in the handler: wait until the file satisfies the check.
async function waitForStatus(storage, homeId, check) {
  let last;
  for (let i = 0; i < 100; i++) {
    try {
      last = JSON.parse(await readFile(join(storage, `tado-status-${homeId}.json`), 'utf8'));
      if (check(last)) return last;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`status file never satisfied the check: ${JSON.stringify(last)}`);
}

const dirs = [];
// the handler writes its status file fire-and-forget, so retry while a write is in flight
after(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

// A Central Switch accessory whose characteristic writes are recorded.
function centralSwitch(homeName) {
  const values = { On: true, Auto: 1, Manual: 0, Off: 0 };
  const writes = [];
  const service = {
    subtype: 'Central',
    getCharacteristic: (c) => ({ updateValue: (v) => { values[c] = v; writes.push([c, v]); } }),
  };
  const accessory = {
    displayName: `${homeName} Central Switch`,
    context: { config: { homeName, subtype: 'extra-centralswitch' } },
    services: [service],
    getServiceById: () => service,
    getService: () => undefined,
  };
  return { accessory, values, writes };
}

const api = {
  user: { storagePath: () => '' },
  hap: {
    Service: { Switch: 'Switch', Thermostat: 'Thermostat', HeaterCooler: 'HeaterCooler' },
    Characteristic: { On: 'On', AutoThermostats: 'Auto', ManualThermostats: 'Manual', OfflineThermostats: 'Off' },
  },
};

async function build(homeId, zoneStatesResponse, zoneCount = 2, overrides = {}) {
  const storage = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  dirs.push(storage);
  const homeName = `Home${homeId}`;
  const sw = centralSwitch(homeName);
  const config = {
    homeId, homeName, polling: 60, temperatureUnit: 'CELSIUS', presence: [], weather: {}, extras: {}, childLock: [],
    zones: Array.from({ length: zoneCount }, (_, i) => ({ id: i + 1, name: `Z${i + 1}`, type: 'HEATING', noBattery: true })),
    ...overrides,
  };
  const tado = {
    health: new SourceHealth(),
    writes: new WriteTracker(),
    getZones: async () => config.zones.map((z) => ({ id: z.id, name: z.name, type: 'HEATING', devices: [], openWindowDetection: { enabled: true } })),
    getZoneStates: async () => zoneStatesResponse,
  };
  const handler = DeviceHandler({ ...api, user: { storagePath: () => storage } }, [sw.accessory], config, tado, undefined);
  return { handler, sw, tado, storage };
}

const centralWrites = (sw) => sw.writes.filter((w) => Array.isArray(w));

test('complete zone states update the Central Switch', async () => {
  const { handler, sw } = await build(9001, { zoneStates: { 1: fx.auto, 2: fx.manual } });
  await handler.getStates();
  assert.ok(centralWrites(sw).length > 0);
  assert.equal(sw.values.On, true);
});

test('an empty zone-states response keeps the Central Switch value and marks the source stale', async () => {
  const { handler, sw, tado } = await build(9002, { zoneStates: {} });
  tado.health.recordSuccess();
  tado.health.beginCycle();
  await handler.getStates();
  assert.deepEqual(centralWrites(sw), []);
  assert.equal(tado.health.snapshot().sourceStatus, 'stale');
  assert.equal(tado.health.snapshot().reason, 'incomplete');
});

test('a missing zoneStates key behaves like an empty response', async () => {
  const { handler, sw } = await build(9003, {});
  await handler.getStates();
  assert.deepEqual(centralWrites(sw), []);
});

test('a partial response updates nothing on the Central Switch and does not throw', async () => {
  const { handler, sw, tado } = await build(9004, { zoneStates: { 1: fx.auto } });
  tado.health.recordSuccess();
  tado.health.beginCycle();
  await handler.getStates();
  assert.deepEqual(centralWrites(sw), []);
  assert.equal(tado.health.snapshot().sourceStatus, 'stale');
});

test('a zone entry without setting is treated as missing', async () => {
  const { handler, sw } = await build(9005, { zoneStates: { 1: fx.auto, 2: {} } });
  await handler.getStates();
  assert.deepEqual(centralWrites(sw), []);
});

test('after a partial response a complete one updates the switch again and clears stale', async () => {
  const response = { zoneStates: { 1: fx.auto } };
  const { handler, sw, tado } = await build(9006, response, 2);
  tado.health.recordSuccess();
  tado.health.beginCycle();
  await handler.getStates();
  assert.deepEqual(centralWrites(sw), []);
  response.zoneStates = { 1: fx.auto, 2: fx.manual };
  tado.health.beginCycle();
  await tado.getZones();
  await handler.getStates();
  assert.ok(centralWrites(sw).length > 0);
  tado.health.recordSuccess();
  assert.equal(tado.health.snapshot().sourceStatus, 'ok');
});

test('a poll writes tado-status-<home>.json atomically with stale reason and no temp files', async () => {
  const { handler, tado, storage } = await build(9007, { zoneStates: { 1: fx.boost, 2: fx.openWindow } });
  tado.health.recordSuccess();
  tado.health.beginCycle();
  await handler.getStates();
  const status = await waitForStatus(storage, 9007, (st) => st.zones['1']?.boost === true);
  assert.equal(status.zones['1'].boost, true);
  assert.equal(status.zones['2'].openWindow, true);
  assert.ok(!(await readdir(storage)).some((f) => f.endsWith('.tmp')));
});

test('zone polls confirm an accepted write', async () => {
  const { handler, tado } = await build(9008, { zoneStates: { 1: fx.manual, 2: fx.auto } });
  tado.writes.accepted('1', { power: 'ON', temperature: 19.5 });
  await handler.getStates();
  assert.equal(tado.writes.get('1').status, 'confirmed');
});

test('the poll timer is clamped below the 2^31 ms setTimeout limit', async (t) => {
  const delays = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    delays.push(ms);
    // never run the callbacks: only the requested delays matter
    return original(() => {}, 0, ...rest);
  });
  const { handler } = await build(9010, { zoneStates: {} }, 0, { polling: 10_000_000 });
  // polling is in seconds; this interval is far beyond 2^31 ms
  handler.initTasks();
  await new Promise((r) => original(r, 50));
  const pollDelays = delays.filter((d) => typeof d === 'number' && d > 1000);
  assert.ok(pollDelays.length > 0, 'a poll was scheduled');
  for (const d of pollDelays) assert.ok(d <= 2 ** 31 - 1, `delay ${d} exceeds the timer limit`);
});

test('status file keeps a missing zone last entry flagged stale', async () => {
  const response = { zoneStates: { 1: fx.boost, 2: fx.openWindow } };
  const { handler, storage } = await build(9011, response);
  await handler.getStates();
  response.zoneStates = { 1: fx.boost };
  await handler.getStates();
  const status = await waitForStatus(storage, 9011, (st) => st.zones['2']?.stale === true);
  assert.equal(status.zones['1'].stale, false);
  assert.equal(status.zones['2'].stale, true);
  assert.equal(status.zones['2'].openWindow, true, 'last known entry retained');
});

test('an empty response keeps every zone entry and marks them stale', async () => {
  const response = { zoneStates: { 1: fx.boost, 2: fx.manual } };
  const { handler, storage } = await build(9012, response);
  await handler.getStates();
  response.zoneStates = {};
  await handler.getStates();
  const status = await waitForStatus(storage, 9012, (st) => st.zones['1']?.stale === true && st.zones['2']?.stale === true);
  assert.deepEqual(Object.keys(status.zones).sort(), ['1', '2']);
  assert.equal(status.zones['1'].boost, true);
  assert.ok(status.zones['1'].stale && status.zones['2'].stale);
});

test('turning open window mode off confirms on openWindow cleared, not on openWindowDetected', async () => {
  const detectedOnly = { ...fx.auto, openWindow: null, openWindowDetected: true };
  const { handler, tado } = await build(9013, { zoneStates: { 1: detectedOnly, 2: fx.auto } });
  tado.writes.accepted('openWindow:1', { value: false });
  await handler.getStates();
  assert.equal(tado.writes.get('openWindow:1').status, 'confirmed', 'mode is off even though the sensor still detects an open window');

  const active = { ...fx.openWindow };
  const second = await build(9014, { zoneStates: { 1: active, 2: fx.auto } });
  second.tado.writes.accepted('openWindow:1', { value: false });
  await second.handler.getStates();
  assert.equal(second.tado.writes.get('openWindow:1').status, 'accepted', 'mode still active');

  const third = await build(9015, { zoneStates: { 1: active, 2: fx.auto } });
  third.tado.writes.accepted('openWindow:1', { value: true });
  await third.handler.getStates();
  assert.equal(third.tado.writes.get('openWindow:1').status, 'confirmed');
});

test('health changes are logged once per poll cycle, with no per-call flapping', async (t) => {
  const lines = [];
  Logger.init({ info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error() {}, debug() {} }, false);
  const scheduled = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    if (ms > 1000) scheduled.push(fn);
    return original(() => {}, 0);
  });
  try {
    const response = { zoneStates: { 1: fx.auto } }; // zone 2 missing: incomplete every poll
    const { handler, tado } = await build(9016, response, 2);
    // every call succeeds, like the real API layer reporting into health
    const getZones = tado.getZones;
    tado.getZones = async () => { tado.health.recordSuccess(); return getZones(); };
    const getZoneStates = tado.getZoneStates;
    tado.getZoneStates = async () => { tado.health.recordSuccess(); return getZoneStates(); };

    handler.initTasks();
    await new Promise((r) => original(r, 50));
    for (let i = 0; i < 3; i++) {
      const next = scheduled.shift();
      await next();
    }
    const stale = lines.filter((l) => l.includes('stale (incomplete)'));
    assert.equal(stale.length, 1, `stale logged once, got: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter((l) => l.includes('reachable again')).length, 0);

    response.zoneStates = { 1: fx.auto, 2: fx.manual };
    await scheduled.shift()();
    assert.equal(lines.filter((l) => l.includes('reachable again')).length, 1);
    await scheduled.shift()();
    assert.equal(lines.filter((l) => l.includes('reachable again')).length, 1, 'no repeat while healthy');
  } finally {
    Logger.init(quiet, false);
  }
});
