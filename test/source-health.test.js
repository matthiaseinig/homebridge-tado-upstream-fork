import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, retryAfterMs, MAX_RETRY_AFTER_MS, SourceHealth } from '../src/helper/source-health.js';

const httpError = (statusCode, headers = {}) => Object.assign(new Error(`HTTP ${statusCode}`), { response: { statusCode, headers } });

test('classifyError maps HTTP and network failures', () => {
  assert.equal(classifyError(httpError(429)), 'rate_limited');
  assert.equal(classifyError(httpError(401)), 'token_rejected');
  assert.equal(classifyError(httpError(403)), 'forbidden');
  assert.equal(classifyError(httpError(503)), 'offline');
  assert.equal(classifyError(httpError(404)), 'client');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'offline');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'offline');
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'offline');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'TADO_AUTH_REQUIRED' })), 'auth_expired');
  assert.equal(classifyError(new Error('boom')), 'error');
});

test('classifyError looks through error.cause', () => {
  const inner = httpError(429);
  assert.equal(classifyError(new Error('wrapped', { cause: inner })), 'rate_limited');
});

test('retryAfterMs parses seconds and http dates', () => {
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': '30' })), 30000);
  const now = Date.parse('2026-11-14T10:00:00Z');
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': 'Sat, 14 Nov 2026 10:01:00 GMT' }), now), 60000);
  assert.equal(retryAfterMs(httpError(429, {})), undefined);
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': 'garbage' })), undefined);
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': '-5' })), undefined);
});

test('SourceHealth starts pending with no timestamp', () => {
  const h = new SourceHealth({ now: () => 1000 });
  assert.deepEqual(h.snapshot(), { sourceStatus: 'pending', sourceTimestamp: null, reason: null, stale: false });
});

test('success is ok and stamps sourceTimestamp', () => {
  let t = Date.parse('2026-11-14T10:00:00Z');
  const h = new SourceHealth({ now: () => t });
  const change = h.recordSuccess();
  assert.equal(change.changed, true);
  const s = h.snapshot();
  assert.equal(s.sourceStatus, 'ok');
  assert.equal(s.sourceTimestamp, '2026-11-14T10:00:00.000Z');
  assert.equal(s.stale, false);
  assert.equal(h.recordSuccess().changed, false);
});

test('outage after success is stale (never off) and keeps the last good timestamp', () => {
  let t = Date.parse('2026-11-14T10:00:00Z');
  const h = new SourceHealth({ now: () => t });
  h.recordSuccess();
  t += 60000;
  const change = h.recordFailure(httpError(503));
  assert.deepEqual([change.changed, change.from, change.to], [true, 'ok', 'stale']);
  const s = h.snapshot();
  assert.equal(s.sourceStatus, 'stale');
  assert.equal(s.reason, 'offline');
  assert.equal(s.sourceTimestamp, '2026-11-14T10:00:00.000Z');
  assert.equal(s.stale, true);
});

test('token expiry reports stale with reason auth_expired', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordSuccess();
  h.recordFailure(Object.assign(new Error('x'), { code: 'TADO_AUTH_REQUIRED' }));
  assert.equal(h.snapshot().reason, 'auth_expired');
  assert.equal(h.snapshot().sourceStatus, 'stale');
});

test('failure before any success stays pending with a reason', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordFailure(httpError(503));
  const s = h.snapshot();
  assert.equal(s.sourceStatus, 'pending');
  assert.equal(s.reason, 'offline');
  assert.equal(s.sourceTimestamp, null);
});

test('client errors (404) do not degrade health', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordSuccess();
  const change = h.recordFailure(httpError(404));
  assert.equal(change.changed, false);
  assert.equal(h.snapshot().sourceStatus, 'ok');
});

test('ok becomes stale when the last success is older than staleAfterMs', () => {
  let t = 0;
  const h = new SourceHealth({ now: () => t, staleAfterMs: 120000 });
  h.recordSuccess();
  t = 119000;
  assert.equal(h.snapshot().sourceStatus, 'ok');
  t = 121000;
  const s = h.snapshot();
  assert.equal(s.sourceStatus, 'stale');
  assert.equal(s.reason, 'overdue');
});

test('recovery returns to ok and clears the reason', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordSuccess();
  h.recordFailure(httpError(503));
  h.beginCycle();
  const change = h.recordSuccess();
  assert.deepEqual([change.from, change.to], ['stale', 'ok']);
  assert.equal(h.snapshot().reason, null);
});

test('backoffMs grows exponentially per failing poll cycle, is capped, and honours Retry-After', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  assert.equal(h.backoffMs(), 0);
  h.beginCycle();
  h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 30000);
  h.beginCycle();
  h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 60000);
  for (let i = 0; i < 10; i++) { h.beginCycle(); h.recordFailure(httpError(503)); }
  assert.equal(h.backoffMs(), 600000);
  h.beginCycle();
  h.recordFailure(httpError(429, { 'retry-after': '600' }));
  assert.equal(h.backoffMs(), 600000);
  h.beginCycle();
  h.recordSuccess();
  h.endCycle();
  assert.equal(h.backoffMs(), 0);
});

test('several failed calls in one poll cycle count as one failure', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.beginCycle();
  for (let i = 0; i < 6; i++) h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 30000);
  h.beginCycle();
  h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 60000);
});

test('a success earlier or later in a failing cycle never resets the backoff or the stale reason', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.recordSuccess();
  // cycle 1: failure then success
  h.beginCycle();
  h.recordFailure(httpError(503));
  h.recordSuccess();
  h.endCycle();
  assert.equal(h.snapshot().sourceStatus, 'stale');
  assert.equal(h.backoffMs(), 30000);
  // cycle 2: success first, then failure (the old code reset the count here)
  h.beginCycle();
  h.recordSuccess();
  h.recordFailure(httpError(503));
  h.endCycle();
  assert.equal(h.backoffMs(), 60000);
  // cycle 3: success first, then failure again
  h.beginCycle();
  h.recordSuccess();
  h.recordFailure(httpError(503));
  h.endCycle();
  assert.equal(h.backoffMs(), 120000);
  // cycle 4: fully successful
  h.beginCycle();
  h.recordSuccess();
  h.recordSuccess();
  h.endCycle();
  assert.equal(h.snapshot().sourceStatus, 'ok');
  assert.equal(h.backoffMs(), 0);
});

test('endCycle reports a change only against the previous cycle, not per call', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.beginCycle();
  h.recordSuccess();
  assert.deepEqual(h.endCycle(), { changed: true, from: 'pending', to: 'ok', reason: null });
  // cycle with success then failure: stale at the end
  h.beginCycle();
  h.recordSuccess();
  h.recordFailure(httpError(503));
  assert.deepEqual(h.endCycle(), { changed: true, from: 'ok', to: 'stale', reason: 'offline' });
  // two more cycles that start with a success and then fail again: no flip reported
  for (let i = 0; i < 2; i++) {
    h.beginCycle();
    h.recordSuccess();
    h.recordFailure(httpError(503));
    assert.equal(h.endCycle().changed, false);
  }
  // fully healthy cycle: reachable again, once
  h.beginCycle();
  h.recordSuccess();
  const back = h.endCycle();
  assert.deepEqual([back.changed, back.from, back.to], [true, 'stale', 'ok']);
  h.beginCycle();
  h.recordSuccess();
  assert.equal(h.endCycle().changed, false);
});

test('a persistently incomplete response does not flap between ok and stale', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.beginCycle();
  h.recordSuccess();
  h.endCycle();
  let flips = 0;
  for (let i = 0; i < 5; i++) {
    h.beginCycle();
    h.recordSuccess();
    h.recordSuccess();
    h.markStale('incomplete');
    if (h.endCycle().changed) flips += 1;
  }
  assert.equal(flips, 1, 'only the first move to stale is reported');
});

test('a single rejected access token (401) does not jump to the maximum backoff', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.recordSuccess();
  h.beginCycle();
  h.recordFailure(httpError(401));
  assert.equal(h.snapshot().reason, 'token_rejected');
  assert.equal(h.backoffMs(), 0, 'retried at the normal interval after the token was dropped');
  h.beginCycle();
  h.recordFailure(httpError(401));
  assert.equal(h.backoffMs(), 30000);
});

test('a 403 is a forbidden reason with normal exponential backoff, not an expired login', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.beginCycle();
  h.recordFailure(httpError(403));
  assert.equal(h.snapshot().reason, 'forbidden');
  assert.equal(h.backoffMs(), 30000);
});

test('Retry-After is capped at 15 minutes (seconds and dates)', () => {
  assert.equal(MAX_RETRY_AFTER_MS, 900000);
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': '999999999' })), 900000);
  const now = Date.parse('2026-11-14T10:00:00Z');
  assert.equal(retryAfterMs(httpError(429, { 'retry-after': 'Sun, 14 Nov 2027 10:00:00 GMT' }), now), 900000);
  const h = new SourceHealth({ now: () => 5 });
  h.beginCycle();
  h.recordFailure(httpError(429, { 'retry-after': '86400' }));
  assert.equal(h.backoffMs(), 900000);
  assert.ok(h.nextDelayMs(60000) < 2 ** 31 - 1);
});

test('markStale flags held data stale without adding backoff', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordSuccess();
  h.beginCycle();
  h.markStale('incomplete');
  h.recordSuccess();
  assert.equal(h.snapshot().sourceStatus, 'stale');
  assert.equal(h.snapshot().reason, 'incomplete');
  assert.equal(h.backoffMs(), 0);
  h.beginCycle();
  h.recordSuccess();
  assert.equal(h.snapshot().sourceStatus, 'ok');
});

test('auth_expired backs off to the cap so polling does not hammer the login endpoint', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.recordFailure(Object.assign(new Error('x'), { code: 'TADO_AUTH_REQUIRED' }));
  assert.equal(h.backoffMs(), 600000);
});

test('nextDelayMs never polls faster than the configured interval or the backoff', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  assert.equal(h.nextDelayMs(60000), 60000);
  h.beginCycle();
  h.recordFailure(httpError(503));
  assert.equal(h.nextDelayMs(60000), 60000);
  h.beginCycle();
  h.recordFailure(httpError(503));
  h.beginCycle();
  h.recordFailure(httpError(503));
  assert.equal(h.nextDelayMs(60000), 120000);
});

test('a failing optional feature backs off on its own and never touches core health', () => {
  let t = 0;
  const h = new SourceHealth({ now: () => t, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.beginCycle();
  h.recordSuccess();
  h.endCycle();
  for (let i = 0; i < 4; i++) {
    h.beginCycle();
    h.recordSuccess();
    h.recordFeatureFailure('weather', httpError(503));
    h.recordFeatureFailure('weather', httpError(503));
    const change = h.endCycle();
    assert.equal(change.changed, false);
    assert.equal(h.snapshot().sourceStatus, 'ok');
    assert.equal(h.backoffMs(), 0);
    assert.equal(h.nextDelayMs(60000), 60000);
  }
  assert.equal(h.featureSnapshot().weather.stale, true);
  assert.equal(h.featureSnapshot().weather.reason, 'offline');
});

test('feature backoff grows per failing cycle, blocks until due, and clears on success', () => {
  let t = 1000;
  const h = new SourceHealth({ now: () => t, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  assert.equal(h.featureReady('weather'), true);
  h.beginCycle();
  h.recordFeatureFailure('weather', httpError(503));
  assert.equal(h.featureReady('weather'), false);
  t += 29000;
  assert.equal(h.featureReady('weather'), false);
  t += 2000;
  assert.equal(h.featureReady('weather'), true);
  h.beginCycle();
  h.recordFeatureFailure('weather', httpError(503));
  t += 31000;
  assert.equal(h.featureReady('weather'), false, 'second failing cycle waits 60 s');
  t += 30000;
  assert.equal(h.featureReady('weather'), true);
  h.recordFeatureSuccess('weather');
  assert.equal(h.featureSnapshot().weather.stale, false);
  assert.equal(h.featureReady('other'), true, 'features are independent');
});

test('a 404 on an optional feature is not a failure', () => {
  const h = new SourceHealth({ now: () => 5 });
  h.recordFeatureFailure('weather', httpError(404));
  assert.equal(h.featureReady('weather'), true);
  assert.equal(h.featureSnapshot().weather?.stale ?? false, false);
});
