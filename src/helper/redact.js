// Keeps credentials out of logs. Never mutates its input.

const SECRET_KEYS = /^(access_token|refresh_token|device_code|id_token|authorization|password|client_secret|token)$/i;
const MASK = '[redacted]';

function redactString(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${MASK}`)
    .replace(/((?:access_token|refresh_token|device_code|id_token|client_secret|password)=)[^&\s"']+/gi, `$1${MASK}`)
    .replace(/("(?:access_token|refresh_token|device_code|id_token|client_secret|password)"\s*:\s*")[^"]*(")/gi, `$1${MASK}$2`);
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Error) {
    const copy = new Error(redactString(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactString(value.stack) : value.stack;
    return copy;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? MASK : redact(v, seen);
  }
  return out;
}
