import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStatusSnapshot } from '../src/helper/status-snapshot.js';
import { SourceHealth } from '../src/helper/source-health.js';
import { WriteTracker } from '../src/helper/write-tracker.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/zone-states.json', import.meta.url), 'utf8'));

test('snapshot combines source status, zone flags and write state', () => {
  const now = () => Date.parse('2026-11-14T10:00:00Z');
  const health = new SourceHealth({ now });
  health.recordSuccess();
  const writes = new WriteTracker({ now });
  writes.accepted('2', { clear: true });
  const snap = buildStatusSnapshot({ health, writes, zoneStates: { 1: fx.boost, 2: fx.openWindow } });
  assert.deepEqual(snap, {
    sourceStatus: 'ok',
    sourceTimestamp: '2026-11-14T10:00:00.000Z',
    reason: null,
    zones: {
      1: { boost: true, boostRemainingS: 1260, openWindow: false, openWindowRemainingS: null, write: null },
      2: { boost: false, boostRemainingS: null, openWindow: true, openWindowRemainingS: 600, write: { status: 'accepted', acceptedAt: '2026-11-14T10:00:00.000Z', confirmedAt: null } },
    },
  });
});

test('snapshot contains no token-like fields', () => {
  const health = new SourceHealth();
  const text = JSON.stringify(buildStatusSnapshot({ health, writes: new WriteTracker(), zoneStates: {} }));
  assert.doesNotMatch(text, /token|password|authorization/i);
});
