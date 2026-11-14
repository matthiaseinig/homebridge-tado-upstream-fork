// Keeps credentials out of logs. Never mutates its input.

// Matched against the key lowercased with separators removed (accessToken, access_token, x-api-key).
const SECRET_KEY = /(token|secret|password|apikey|authorization|devicecode|usercode)$/;
const MASK = '[redacted]';

const KEY = '(?:(?:access|refresh|id)[_-]?token|device[_-]?code|user[_-]?code|client[_-]?secret|api[_-]?key|password)';
// quote forms: plain, single, escaped (\"), URL-encoded (%22 / %27)
const QUOTE = `(?:\\\\*["']|%22|%27)`;
const SEP = `${QUOTE}?\\s*(?:[:=]|%3A|%3D)\\s*${QUOTE}?`;
const KEY_VALUE = new RegExp(`(${KEY})(${SEP})([^"'\\\\&\\s,}%]+)`, 'gi');
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(text) {
  return text
    .replace(JWT, MASK)
    .replace(AUTH_SCHEME, `$1 ${MASK}`)
    .replace(KEY_VALUE, `$1$2${MASK}`);
}

function isSecretKey(key) {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ''));
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
    out[k] = isSecretKey(k) ? MASK : redact(v, seen);
  }
  return out;
}
