// Boost and open-window state for one entry of the zoneStates response.
// The Tado API has no boost flag. The app's Boost button sets a 25 C overlay
// that ends on a timer on a HEATING zone, so that combination is what we report
// as boost.

const BOOST_CELSIUS = 25;
const BOOST_TOLERANCE_C = 0.05;

export function zoneFlags(zoneState) {
  const flags = { boost: false, boostRemainingS: null, openWindow: false, openWindowRemainingS: null };
  if (!zoneState || typeof zoneState !== 'object') return flags;

  const termination = zoneState.overlay?.termination;
  const celsius = zoneState.setting?.temperature?.celsius;
  if (
    zoneState.overlayType &&
    zoneState.setting?.type === 'HEATING' &&
    (!zoneState.overlay?.setting?.type || zoneState.overlay.setting.type === 'HEATING') &&
    zoneState.setting.power === 'ON' &&
    termination?.type === 'TIMER' &&
    typeof celsius === 'number' &&
    Math.abs(celsius - BOOST_CELSIUS) <= BOOST_TOLERANCE_C
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
