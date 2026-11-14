// A write that Tado answered with 2xx is only "accepted". It becomes
// "confirmed" when a later zone poll shows the requested state, and
// "unconfirmed" when that does not happen within the timeout.

const TEMPERATURE_TOLERANCE_C = 0.5;

function matches(expect, zoneState) {
  if (!zoneState) return false;
  if (expect.clear) return zoneState.overlayType === null;
  const power = zoneState.setting?.power;
  if (expect.power === 'OFF') return power === 'OFF';
  if (power !== 'ON') return false;
  if (typeof expect.temperature !== 'number') return true;
  const celsius = zoneState.setting?.temperature?.celsius;
  return typeof celsius === 'number' && Math.abs(celsius - expect.temperature) <= TEMPERATURE_TOLERANCE_C;
}

export class WriteTracker {
  constructor({ now = Date.now, confirmTimeoutMs = 2 * 60 * 1000 } = {}) {
    this._now = now;
    this._confirmTimeoutMs = confirmTimeoutMs;
    this._entries = new Map();
  }

  accepted(zoneId, expect) {
    const entry = { status: 'accepted', expect, acceptedAt: this._now(), confirmedAt: null };
    this._entries.set(String(zoneId), entry);
    return entry;
  }

  observe(zoneId, zoneState) {
    const entry = this._entries.get(String(zoneId));
    if (!entry || entry.status !== 'accepted') return [];
    if (matches(entry.expect, zoneState)) {
      entry.status = 'confirmed';
      entry.confirmedAt = this._now();
      return [{ zoneId: String(zoneId), from: 'accepted', to: 'confirmed' }];
    }
    if (this._now() - entry.acceptedAt > this._confirmTimeoutMs) {
      entry.status = 'unconfirmed';
      return [{ zoneId: String(zoneId), from: 'accepted', to: 'unconfirmed' }];
    }
    return [];
  }

  get(zoneId) {
    return this._entries.get(String(zoneId));
  }

  snapshot() {
    const out = {};
    for (const [zoneId, e] of this._entries) {
      out[zoneId] = {
        status: e.status,
        acceptedAt: new Date(e.acceptedAt).toISOString(),
        confirmedAt: e.confirmedAt === null ? null : new Date(e.confirmedAt).toISOString(),
      };
    }
    return out;
  }
}
