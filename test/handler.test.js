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

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

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

async function build(homeId, zoneStatesResponse, zoneCount = 2) {
  const storage = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  dirs.push(storage);
  const homeName = `Home${homeId}`;
  const sw = centralSwitch(homeName);
  const config = {
    homeId, homeName, polling: 60, temperatureUnit: 'CELSIUS', presence: [], weather: {}, extras: {}, childLock: [],
    zones: Array.from({ length: zoneCount }, (_, i) => ({ id: i + 1, name: `Z${i + 1}`, type: 'HEATING', noBattery: true })),
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
  await new Promise((r) => setTimeout(r, 50));
  const status = JSON.parse(await readFile(join(storage, 'tado-status-9007.json'), 'utf8'));
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
