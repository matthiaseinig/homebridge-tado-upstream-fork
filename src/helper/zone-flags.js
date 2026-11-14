// Boost and open-window state for one entry of the zoneStates response.
// The Tado API has no boost flag. The app's Boost button sets a 25 C overlay
// that ends on a timer, so that combination is what we report as boost.

const BOOST_MIN_CELSIUS = 25;

export function zoneFlags(zoneState) {
  const flags = { boost: false, boostRemainingS: null, openWindow: false, openWindowRemainingS: null };
  if (!zoneState || typeof zoneState !== 'object') return flags;

  const termination = zoneState.overlay?.termination;
  const celsius = zoneState.setting?.temperature?.celsius;
  if (
    zoneState.overlayType &&
    zoneState.setting?.power === 'ON' &&
    termination?.type === 'TIMER' &&
    typeof celsius === 'number' &&
    celsius >= BOOST_MIN_CELSIUS
  ) {
    flags.boost = true;
    flags.boostRemainingS = termination.remainingTimeInSeconds ?? null;
  }

  if (zoneState.openWindow || zoneState.openWindowDetected) {
    flags.openWindow = true;
    flags.openWindowRemainingS = zoneState.openWindow?.remainingTimeInSeconds ?? null;
  }
  return flags;
}
