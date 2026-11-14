// Plain-data view of source health, boost, open window and write state. It is
// written next to the zone states file so a later conduit can publish it
// (sourceStatus, sourceTimestamp). It never contains credentials.
import { zoneFlags } from './zone-flags.js';

export function buildStatusSnapshot({ health, writes, zoneStates }) {
  const { sourceStatus, sourceTimestamp, reason } = health.snapshot();
  const written = writes.snapshot();
  const zones = {};
  for (const [id, state] of Object.entries(zoneStates ?? {})) {
    zones[id] = { ...zoneFlags(state), write: written[id] ?? null };
  }
  return { sourceStatus, sourceTimestamp, reason, zones };
}
