// Plain-data view of source health, boost, open window and write state. It is
// written next to the zone states file so a later conduit can publish it
// (sourceStatus, sourceTimestamp). It never contains credentials.
import { zoneFlags } from './zone-flags.js';

// staleZones: ids whose state was missing from the latest response; their entry
// is the last known one, flagged stale.
export function buildStatusSnapshot({ health, writes, zoneStates, staleZones = [] }) {
  const { sourceStatus, sourceTimestamp, reason, stale } = health.snapshot();
  const missing = new Set([...staleZones].map(String));
  const written = writes.snapshot();
  const zones = {};
  for (const [id, state] of Object.entries(zoneStates ?? {})) {
    zones[id] = { ...zoneFlags(state), write: written[id] ?? null, stale: stale || missing.has(id) };
  }
  return { sourceStatus, sourceTimestamp, reason, zones };
}
