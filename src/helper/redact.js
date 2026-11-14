// Keeps credentials out of logs. Never mutates its input.
//
// Strings are scanned structurally, not with one regex: after a secret key and
// its separator the value is masked up to its real end, so spaces, commas,
// percent signs and escaped quotes inside a quoted secret cannot leak a tail.

// Matched against the key lowercased with separators removed (accessToken, access_token, x-api-key).
const SECRET_KEY = /(token|secret|password|apikey|authorization|devicecode|usercode|setcookie|cookie|session|sessionid|sid)$/;
const MASK = '[redacted]';

const KEY = /(?:(?:access|refresh|id)[_-]?token|token|device[_-]?code|user[_-]?code|client[_-]?secret|secret|api[_-]?key|password|authorization|set-cookie|cookie|session[_-]?id|session|sid)/gi;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SCHEME_WORD = /^(?:Bearer|Basic|Digest)\b/i;

const WS = /\s/;
const WORD_END = /[&\s,}]/;
// An unquoted credential runs to the next "&", newline or "key=" (or the end of
// the text). Values may contain spaces, so this over-masks rather than leaks.
const CREDENTIAL_END = /&|[\r\n]|\s[A-Za-z_][\w.-]*=/;

// Reads a quote token at i: a run of escapes ("\" or "%5C") followed by " or '
// (plain or %22/%27), a backtick, or &quot;. k is the escape run length.
function readQuote(text, i) {
  const c = text[i];
  if (c === '`') return { kind: 'bt', len: 1, k: 0, close: '`' };
  if (text.startsWith('&quot;', i)) return { kind: 'ent', len: 6, k: 0, close: '&quot;' };
  let j = i;
  let k = 0;
  let esc = null;
  for (;;) {
    if (text[j] === '\\' && esc !== '%5C') { esc = '\\'; j += 1; k += 1; } else if (text.slice(j, j + 3).toUpperCase() === '%5C' && esc !== '\\') { esc = '%5C'; j += 3; k += 1; } else break;
  }
  const q = text[j];
  if (q === '"' || q === "'") return { kind: 'q', ch: q, k, esc, len: j + 1 - i, close: q };
  const enc = text.slice(j, j + 3).toUpperCase();
  if (enc === '%22' || enc === '%27') return { kind: 'q', ch: enc, k, esc, len: j + 3 - i, close: enc };
  return null;
}

// A run of r escapes before a quote closes a value opened with k escapes when
// r = k modulo twice the escaping level (k is 2^L - 1 for JSON nested L deep).
function closes(r, k) {
  if (((k + 1) & k) !== 0) return r === k;
  return r % (2 * (k + 1)) === k;
}

// Index just past the closing delimiter's start: returns { valueEnd, end } or null.
function findClose(text, from, q) {
  if (q.kind !== 'q') {
    const at = text.indexOf(q.close, from);
    return at < 0 ? null : { valueEnd: at, end: at + q.close.length };
  }
  let i = from;
  while (i < text.length) {
    let r = 0;
    let j = i;
    const escToken = q.ch.length === 3 ? '%5C' : '\\';
    while (text.slice(j, j + escToken.length).toUpperCase() === escToken) { r += 1; j += escToken.length; }
    if (text.slice(j, j + q.close.length).toUpperCase() === q.close.toUpperCase()) {
      if (closes(r, q.k)) return { valueEnd: i, end: j + q.close.length };
      i = j + q.close.length;
      continue;
    }
    i = r > 0 ? j : i + 1;
  }
  return null;
}

function wordEnd(text, from) {
  let i = from;
  while (i < text.length && !WORD_END.test(text[i])) i += 1;
  return i;
}

function credentialEnd(text, from) {
  const m = CREDENTIAL_END.exec(text.slice(from));
  return m ? from + m.index : text.length;
}

function skipSpace(text, i) {
  while (i < text.length && WS.test(text[i])) i += 1;
  return i;
}

function redactSecrets(text) {
  let out = '';
  let last = 0;
  KEY.lastIndex = 0;
  let m;
  while ((m = KEY.exec(text)) !== null) {
    let i = m.index + m[0].length;
    const keyIsAuth = m[0].toLowerCase() === 'authorization';
    // optional closing quote of the key
    const closeQ = readQuote(text, i);
    if (closeQ) i += closeQ.len;
    i = skipSpace(text, i);
    let sepLen = 0;
    let eq = false;
    if (text[i] === ':' || text[i] === '=') { sepLen = 1; eq = text[i] === '='; } else if (/^%3[AD]/i.test(text.slice(i, i + 3))) { sepLen = 3; eq = text.slice(i, i + 3).toUpperCase() === '%3D'; }
    if (!sepLen) { KEY.lastIndex = m.index + 1; continue; }
    i = skipSpace(text, i + sepLen);
    if (keyIsAuth && SCHEME_WORD.test(text.slice(i))) { KEY.lastIndex = i; continue; }

    const open = readQuote(text, i);
    let start = i;
    let end = credentialEnd(text, i);
    let tail = end;
    if (open) {
      const found = findClose(text, i + open.len, open);
      if (!found) {
        // unterminated quote (truncated log line): fail closed, mask to the end
        start = i + open.len;
        tail = text.length;
        end = text.length;
      } else {
        // quoted: keep the delimiters, mask what is between them
        const qStart = i + open.len;
        const glued = found.end < text.length && !/[\s&,})\]]/.test(text[found.end]);
        if (eq && glued) {
          start = i; // form/query style: characters follow the closing quote directly, mask them too
          // credentialEnd(i) can stop inside the quoted value (at & or key=); never end before the quote
          end = Math.max(found.end, credentialEnd(text, found.end));
          tail = end;
        } else {
          start = qStart;
          tail = found.valueEnd;
          end = found.end;
        }
      }
    }
    // Plain words such as "refreshing token: HTTP 503" are not secrets: for the
    // bare words token and secret an unquoted value must look like a credential.
    if (!open && /^(?:token|secret)$/i.test(m[0]) && wordEnd(text, start) - start < 8) { KEY.lastIndex = m.index + 1; continue; }
    out += text.slice(last, start) + MASK;
    last = tail;
    KEY.lastIndex = Math.max(end, tail);
  }
  return out + text.slice(last);
}

function redactString(text) {
  return redactSecrets(text.replace(JWT, MASK).replace(AUTH_SCHEME, `$1 ${MASK}`));
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
