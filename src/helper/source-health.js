// Tracks whether the Tado cloud is currently reachable and when the data we
// hold was last confirmed. A failure never turns the held values into "off":
// the status becomes "stale" and the last good sourceTimestamp is kept.

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);

export function classifyError(error, depth = 0) {
  if (!error || depth > 5) return 'error';
  const status = error.response?.statusCode;
  if (error.code === 'TADO_AUTH_REQUIRED') return 'auth_expired';
  if (status === 429) return 'rate_limited';
  // The server rejected the access token; a refresh may fix it, so this is not
  // an expired login. A 403 is a permission problem, not an expired login.
  if (status === 401) return 'token_rejected';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'offline';
  if (status >= 400) return 'client';
  if (NETWORK_CODES.has(error.code) || error.name === 'TimeoutError') return 'offline';
  if (error.cause) return classifyError(error.cause, depth + 1);
  return 'error';
}

// Longest Retry-After we honour; also keeps setTimeout far from its 2^31 limit.
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

function capRetryAfter(ms) {
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export function retryAfterMs(error, now = Date.now(), depth = 0) {
  const raw = error?.response?.headers?.['retry-after'];
  if (raw === undefined || raw === null || raw === '') {
    return error?.cause && depth < 5 ? retryAfterMs(error.cause, now, depth + 1) : undefined;
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return capRetryAfter(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? capRetryAfter(delta) : undefined;
}

export class SourceHealth {
  constructor({ now = Date.now, staleAfterMs = 10 * 60 * 1000, baseBackoffMs = 30 * 1000, maxBackoffMs = 10 * 60 * 1000 } = {}) {
    this._now = now;
    this._staleAfterMs = staleAfterMs;
    this._baseBackoffMs = baseBackoffMs;
    this._maxBackoffMs = maxBackoffMs;
    this._lastSuccess = null;
    this._reason = null;
    this._failures = 0;
    this._retryAfterMs = undefined;
    this._cycle = 0;
    this._failureCycle = -1;
    this._reported = { status: 'pending', reason: null };
    this._features = new Map();
  }

  // Optional features (weather, presence, running time, child lock) have their
  // own failure count, backoff and stale flag; they never back off the core zone
  // polling or mark the zones stale.
  _feature(name) {
    if (!this._features.has(name)) {
      this._features.set(name, { lastSuccess: null, reason: null, failures: 0, failureCycle: -1, retryAfterMs: undefined, nextAt: 0 });
    }
    return this._features.get(name);
  }

  recordFeatureSuccess(name) {
    const f = this._feature(name);
    f.lastSuccess = this._now();
    f.reason = null;
    f.failures = 0;
    f.retryAfterMs = undefined;
    f.nextAt = 0;
  }

  recordFeatureFailure(name, error) {
    const f = this._feature(name);
    const kind = classifyError(error);
    if (kind === 'client') return;
    f.reason = kind;
    if (f.failureCycle !== this._cycle) f.failures += 1;
    f.failureCycle = this._cycle;
    f.retryAfterMs = kind === 'rate_limited' ? retryAfterMs(error, this._now()) : undefined;
    f.nextAt = this._now() + this._backoffFor(kind, f.failures, f.retryAfterMs);
  }

  // false while a failing optional feature is backing off
  featureReady(name) {
    return this._now() >= this._feature(name).nextAt;
  }

  featureSnapshot() {
    const out = {};
    for (const [name, f] of this._features) {
      out[name] = {
        stale: f.reason !== null,
        reason: f.reason,
        sourceTimestamp: f.lastSuccess === null ? null : new Date(f.lastSuccess).toISOString(),
      };
    }
    return out;
  }

  _backoffFor(reason, failures, retryAfter) {
    if (!failures) return 0;
    if (retryAfter !== undefined) return capRetryAfter(retryAfter);
    if (reason === 'auth_expired') return this._maxBackoffMs;
    // One rejected access token is retried at the normal interval (the token
    // was dropped, so the next poll refreshes it); backoff starts after that.
    const n = reason === 'token_rejected' ? failures - 1 : failures;
    if (n < 1) return 0;
    return Math.min(this._maxBackoffMs, this._baseBackoffMs * 2 ** (n - 1));
  }

  // Call once at the start of every poll cycle. A cycle counts as failed when
  // any call in it failed; backoff counts consecutive failed cycles, and only a
  // fully successful cycle resets it, because one poll makes several calls.
  beginCycle() {
    if (this._failureCycle !== this._cycle) this._failures = 0;
    this._cycle += 1;
  }

  _status() {
    if (this._lastSuccess === null) return 'pending';
    if (this._reason) return 'stale';
    if (this._now() - this._lastSuccess > this._staleAfterMs) return 'stale';
    return 'ok';
  }

  _transition(before) {
    const after = this._status();
    return { changed: before !== after, from: before, to: after, reason: this._reason };
  }

  recordSuccess() {
    const before = this._status();
    this._lastSuccess = this._now();
    // Within a cycle that already saw a failure the data is still incomplete.
    // The failure count is not reset here (beginCycle does that), so a success
    // earlier in a failing cycle cannot hide the failure.
    if (this._failureCycle !== this._cycle) {
      this._reason = null;
      this._retryAfterMs = undefined;
    }
    return this._transition(before);
  }

  // Call once at the end of a poll cycle. Reports a change only against the
  // state reported at the end of the previous cycle, so calls that succeed and
  // fail inside one cycle never show up as a flip.
  endCycle() {
    if (this._failureCycle !== this._cycle) this._failures = 0; // fully successful cycle
    const status = this._status();
    const reason = status === 'stale' && !this._reason ? 'overdue' : this._reason;
    const from = this._reported.status;
    const changed = from !== status || this._reported.reason !== reason;
    this._reported = { status, reason };
    return { changed, from, to: status, reason };
  }

  recordFailure(error) {
    const before = this._status();
    const kind = classifyError(error);
    // A 4xx such as 404 proves the cloud answered; it says nothing about health.
    if (kind === 'client') return { changed: false, from: before, to: before, reason: this._reason };
    this._reason = kind;
    if (this._failureCycle !== this._cycle) this._failures += 1;
    this._failureCycle = this._cycle;
    this._retryAfterMs = kind === 'rate_limited' ? retryAfterMs(error, this._now()) : undefined;
    return this._transition(before);
  }

  // Mark the held data stale without counting a failure (no backoff), for
  // example when a response was incomplete.
  markStale(reason) {
    const before = this._status();
    this._reason = reason;
    this._failureCycle = this._cycle;
    return this._transition(before);
  }

  backoffMs() {
    return this._backoffFor(this._reason, this._failures, this._retryAfterMs);
  }

  nextDelayMs(intervalMs) {
    return Math.max(intervalMs, this.backoffMs());
  }

  snapshot() {
    let status = this._status();
    let reason = this._reason;
    if (status === 'stale' && !reason) reason = 'overdue';
    return {
      sourceStatus: status,
      sourceTimestamp: this._lastSuccess === null ? null : new Date(this._lastSuccess).toISOString(),
      reason,
      stale: status === 'stale',
    };
  }
}
