import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zoneFlags } from '../src/helper/zone-flags.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/zone-states.json', import.meta.url), 'utf8'));

test('auto zone has no boost and no open window', () => {
  assert.deepEqual(zoneFlags(fx.auto), { boost: false, boostRemainingS: null, openWindow: false, openWindowRemainingS: null });
});

test('manual overlay is not a boost', () => {
  assert.equal(zoneFlags(fx.manual).boost, false);
});

test('25 C timer overlay is a boost with remaining time', () => {
  const f = zoneFlags(fx.boost);
  assert.equal(f.boost, true);
  assert.equal(f.boostRemainingS, 1260);
});

test('an ordinary timer overlay below boost temperature is not a boost', () => {
  assert.equal(zoneFlags(fx.timerNotBoost).boost, false);
});

test('open window is reported with remaining time', () => {
  const f = zoneFlags(fx.openWindow);
  assert.equal(f.openWindow, true);
  assert.equal(f.openWindowRemainingS, 600);
});

test('openWindowDetected alone counts as open window', () => {
  assert.equal(zoneFlags({ ...fx.auto, openWindowDetected: true }).openWindow, true);
});

test('missing or malformed zone state yields all-false flags without throwing', () => {
  const none = { boost: false, boostRemainingS: null, openWindow: false, openWindowRemainingS: null };
  assert.deepEqual(zoneFlags(undefined), none);
  assert.deepEqual(zoneFlags({}), none);
  assert.deepEqual(zoneFlags({ overlay: { termination: null }, setting: null }), none);
});
