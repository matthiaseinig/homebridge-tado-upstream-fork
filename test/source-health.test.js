import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, retryAfterMs, SourceHealth } from '../src/helper/source-health.js';

const httpError = (statusCode, headers = {}) => Object.assign(new Error(`HTTP ${statusCode}`), { response: { statusCode, headers } });

test('classifyError maps HTTP and network failures', () => {
  assert.equal(classifyError(httpError(429)), 'rate_limited');
  assert.equal(classifyError(httpError(401)), 'auth_expired');
  assert.equal(classifyError(httpError(403)), 'auth_expired');
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
  const change = h.recordSuccess();
  assert.deepEqual([change.from, change.to], ['stale', 'ok']);
  assert.equal(h.snapshot().reason, null);
});

test('backoffMs grows exponentially, is capped, and honours Retry-After', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  assert.equal(h.backoffMs(), 0);
  h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 30000);
  h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 60000);
  for (let i = 0; i < 10; i++) h.recordFailure(httpError(503));
  assert.equal(h.backoffMs(), 600000);
  h.recordFailure(httpError(429, { 'retry-after': '900' }));
  assert.equal(h.backoffMs(), 900000);
  h.recordSuccess();
  assert.equal(h.backoffMs(), 0);
});

test('auth_expired backs off to the cap so polling does not hammer the login endpoint', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  h.recordFailure(Object.assign(new Error('x'), { code: 'TADO_AUTH_REQUIRED' }));
  assert.equal(h.backoffMs(), 600000);
});

test('nextDelayMs never polls faster than the configured interval or the backoff', () => {
  const h = new SourceHealth({ now: () => 5, baseBackoffMs: 30000, maxBackoffMs: 600000 });
  assert.equal(h.nextDelayMs(60000), 60000);
  h.recordFailure(httpError(503));
  assert.equal(h.nextDelayMs(60000), 60000);
  h.recordFailure(httpError(503));
  h.recordFailure(httpError(503));
  assert.equal(h.nextDelayMs(60000), 120000);
});
