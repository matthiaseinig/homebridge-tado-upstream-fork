// Keeps credentials out of logs. Never mutates its input.

// Matched against the key lowercased with separators removed (accessToken, access_token, x-api-key).
const SECRET_KEY = /(token|secret|password|apikey|authorization|devicecode|usercode)$/;
const MASK = '[redacted]';

const KEY = '(?:(?:access|refresh|id)[_-]?token|device[_-]?code|user[_-]?code|client[_-]?secret|api[_-]?key|password)';
// Each pattern keeps the key, separator and opening quote (group 1) and masks the
// value up to its matching closing quote, so spaces, commas and % inside a quoted
// secret cannot end the mask early. Order matters: quoted forms before unquoted.
const NAMED_AFTER_KEY = '(?:\\\\*["\']|%22|%27)?\\s*';
const ENC_SEP = `${NAMED_AFTER_KEY}(?:[:=]|%3A|%3D)\\s*`;
const PATTERNS = [
  // URL-encoded quotes: ...%22password%22%3A%22VALUE%22...
  new RegExp(`(${KEY}${ENC_SEP}(?:%22|%27))(?:(?!%22|%27).)*`, 'gi'),
  // escaped quotes: \"password\":\"VALUE\"
  new RegExp(`(${KEY}\\\\*["']?\\s*[:=]\\s*\\\\")(?:(?!\\\\").)*`, 'gi'),
  // double quotes, honouring \" inside the value
  new RegExp(`(${KEY}["']?\\s*[:=]\\s*")(?:[^"\\\\]|\\\\.)*`, 'gi'),
  // single quotes
  new RegExp(`(${KEY}["']?\\s*[:=]\\s*')(?:[^'\\\\]|\\\\.)*`, 'gi'),
  // unquoted: up to & whitespace , or }
  new RegExp(`(${KEY}${ENC_SEP})(?!["'\\\\]|%22|%27)[^&\\s,}]+`, 'gi'),
];
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(text) {
  let out = text.replace(JWT, MASK).replace(AUTH_SCHEME, `$1 ${MASK}`);
  for (const pattern of PATTERNS) out = out.replace(pattern, `$1${MASK}`);
  return out;
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
