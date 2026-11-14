import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WriteTracker } from '../src/helper/write-tracker.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/zone-states.json', import.meta.url), 'utf8'));

test('a write is accepted first, never confirmed until a poll shows it', () => {
  const w = new WriteTracker({ now: () => 0 });
  const e = w.accepted('1', { power: 'ON', temperature: 19.5 });
  assert.equal(e.status, 'accepted');
  assert.equal(w.get('1').status, 'accepted');
});

test('observing a matching zone state confirms the write', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { power: 'ON', temperature: 19.5 });
  const t = w.observe('1', fx.manual);
  assert.deepEqual(t.map((x) => [x.from, x.to]), [['accepted', 'confirmed']]);
  assert.equal(w.get('1').status, 'confirmed');
});

test('a non-matching state keeps the write accepted', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { power: 'ON', temperature: 23 });
  assert.deepEqual(w.observe('1', fx.manual), []);
  assert.equal(w.get('1').status, 'accepted');
});

test('temperature matches within half a degree', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { power: 'ON', temperature: 19.8 });
  assert.equal(w.observe('1', fx.manual).length, 1);
});

test('power OFF is confirmed by setting.power OFF', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { power: 'OFF' });
  assert.equal(w.observe('1', fx.off).length, 1);
});

test('clearing the overlay is confirmed when overlayType is null', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { clear: true });
  assert.equal(w.observe('1', fx.manual).length, 0);
  assert.equal(w.observe('1', fx.auto).length, 1);
});

test('an unconfirmed write turns unconfirmed after the timeout', () => {
  let t = 0;
  const w = new WriteTracker({ now: () => t, confirmTimeoutMs: 120000 });
  w.accepted('1', { power: 'ON', temperature: 23 });
  t = 119000;
  assert.deepEqual(w.observe('1', fx.manual), []);
  t = 121000;
  const tr = w.observe('1', fx.manual);
  assert.deepEqual(tr.map((x) => x.to), ['unconfirmed']);
  assert.equal(w.get('1').status, 'unconfirmed');
});

test('a new write supersedes a pending one for the same zone', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('1', { power: 'ON', temperature: 23 });
  w.accepted('1', { power: 'ON', temperature: 19.5 });
  assert.equal(w.observe('1', fx.manual).length, 1);
});

test('observe for an unknown zone or a settled write is a no-op', () => {
  const w = new WriteTracker({ now: () => 0 });
  assert.deepEqual(w.observe('9', fx.manual), []);
  w.accepted('1', { clear: true });
  w.observe('1', fx.auto);
  assert.deepEqual(w.observe('1', fx.auto), []);
});

test('snapshot lists status per zone with timestamps', () => {
  const w = new WriteTracker({ now: () => Date.parse('2026-11-14T10:00:00Z') });
  w.accepted('1', { clear: true });
  assert.deepEqual(w.snapshot(), { 1: { status: 'accepted', acceptedAt: '2026-11-14T10:00:00.000Z', confirmedAt: null } });
});

test('an accepted write turns unconfirmed on sweep without any poll', () => {
  let t = 0;
  const w = new WriteTracker({ now: () => t, confirmTimeoutMs: 1000 });
  w.accepted('1', { clear: true });
  assert.deepEqual(w.sweep(), []);
  t = 1500;
  assert.deepEqual(w.sweep().map((x) => x.to), ['unconfirmed']);
  assert.equal(w.snapshot()['1'].status, 'unconfirmed');
});

test('snapshot itself expires overdue writes', () => {
  let t = 0;
  const w = new WriteTracker({ now: () => t, confirmTimeoutMs: 1000 });
  w.accepted('presence', { value: 'AWAY' });
  t = 2000;
  assert.equal(w.snapshot().presence.status, 'unconfirmed');
});

test('value writes (presence, child lock, open window) confirm on a matching observation', () => {
  const w = new WriteTracker({ now: () => 0 });
  w.accepted('presence', { value: 'AWAY' });
  w.accepted('childLock:RU1', { value: true });
  w.accepted('openWindow:3', { value: false });
  assert.deepEqual(w.observe('presence', 'HOME'), []);
  assert.equal(w.observe('presence', 'AWAY').length, 1);
  assert.equal(w.observe('childLock:RU1', true).length, 1);
  assert.equal(w.observe('openWindow:3', false).length, 1);
});
