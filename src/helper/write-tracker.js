// A write that Tado answered with 2xx is only "accepted". It becomes
// "confirmed" when a later poll shows the requested state, and "unconfirmed"
// when that does not happen within the timeout (checked on every observe and
// by sweep(), so it also happens when no poll arrives).
//
// Keys: a zone id for zone writes (observed with the zone state), or any other
// string such as "presence", "openWindow:<zone>" or "childLock:<serial>"
// (observed with a plain value, expected as { value }).

const TEMPERATURE_TOLERANCE_C = 0.5;

function matches(expect, observed) {
  if (observed === undefined || observed === null) return false;
  if (expect.value !== undefined) return observed === expect.value;
  if (expect.clear) return observed.overlayType === null;
  const power = observed.setting?.power;
  if (expect.power === 'OFF') return power === 'OFF';
  if (power !== 'ON') return false;
  if (typeof expect.temperature !== 'number') return true;
  const celsius = observed.setting?.temperature?.celsius;
  return typeof celsius === 'number' && Math.abs(celsius - expect.temperature) <= TEMPERATURE_TOLERANCE_C;
}

export class WriteTracker {
  constructor({ now = Date.now, confirmTimeoutMs = 2 * 60 * 1000 } = {}) {
    this._now = now;
    this._confirmTimeoutMs = confirmTimeoutMs;
    this._entries = new Map();
  }

  accepted(key, expect) {
    const entry = { status: 'accepted', expect, acceptedAt: this._now(), confirmedAt: null };
    this._entries.set(String(key), entry);
    return entry;
  }

  _expire(key, entry) {
    if (entry.status === 'accepted' && this._now() - entry.acceptedAt > this._confirmTimeoutMs) {
      entry.status = 'unconfirmed';
      return [{ zoneId: key, key, from: 'accepted', to: 'unconfirmed' }];
    }
    return [];
  }

  observe(key, observed) {
    key = String(key);
    const entry = this._entries.get(key);
    if (!entry || entry.status !== 'accepted') return [];
    if (matches(entry.expect, observed)) {
      entry.status = 'confirmed';
      entry.confirmedAt = this._now();
      return [{ zoneId: key, key, from: 'accepted', to: 'confirmed' }];
    }
    return this._expire(key, entry);
  }

  // Marks overdue accepted writes unconfirmed without needing a poll.
  sweep() {
    const out = [];
    for (const [key, entry] of this._entries) out.push(...this._expire(key, entry));
    return out;
  }

  get(key) {
    return this._entries.get(String(key));
  }

  snapshot() {
    this.sweep();
    const out = {};
    for (const [key, e] of this._entries) {
      out[key] = {
        status: e.status,
        acceptedAt: new Date(e.acceptedAt).toISOString(),
        confirmedAt: e.confirmedAt === null ? null : new Date(e.confirmedAt).toISOString(),
      };
    }
    return out;
  }
}
