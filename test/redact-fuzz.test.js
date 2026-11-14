// Fuzzes the redactor: for a few fixed seeds, no run of 6+ characters of a
// generated secret may survive redact() or the Logger, across many log shapes
// (JSON, escaped JSON, URL-encoded JSON, single quoted, form and query strings,
// bearer headers, JWTs and objects). Adapted from the reviewer's fuzzer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/helper/redact.js';
import Logger from '../src/helper/logger.js';

Logger.init({ info() {}, warn() {}, error() {} }, false);

const CASES_PER_SEED = 4000;

function fuzz(startSeed, { quotesInSecrets }) {
  let seed = startSeed;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const AN = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const TOK = AN + '-._~';
  const WILD = AN + ' ,%\'\\}&=:;/+#' + (quotesInSecrets ? '"' : '');
  const gen = (cs, min = 10, max = 40) => { const n = min + Math.floor(rnd() * (max - min)); let s = ''; for (let i = 0; i < n; i++) s += pick(cs); return s; };
  const KEYS = ['access_token','accessToken','ACCESS-TOKEN','refresh_token','refreshToken','RefreshToken','id_token','idToken','device_code','deviceCode','client_secret','clientSecret','api_key','apiKey','api-key','password','Password','PASSWORD'];
  const b64u = (n) => gen(AN + '-_', n, n + 1);
  const formats = {
    json: (k, s) => JSON.stringify({ a: 1, [k]: s, b: 'x' }),
    jsonPretty: (k, s) => JSON.stringify({ a: 1, [k]: s, b: 'x' }, null, 2),
    jsonSpaced: (k, s) => `{ "${k}" :  ${JSON.stringify(s)} , "b": 1 }`,
    escapedJson: (k, s) => `body=${JSON.stringify(JSON.stringify({ [k]: s, z: 2 }))} end`,
    urlEncodedJson: (k, s) => `q=${encodeURIComponent(JSON.stringify({ [k]: s, z: 2 }))}&x=1`,
    singleQuoted: (k, s) => `{'${k}': '${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', 'b': 1}`,
    pyKwarg: (k, s) => `call(${k}='${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', x=1)`,
    formBody: (k, s) => `grant_type=refresh_token&${k}=${encodeURIComponent(s)}&client_id=abc`,
    query: (k, s) => `GET https://login.example/oauth2/token?client_id=x&${k}=${encodeURIComponent(s)}&scope=offline`,
    logLineMsg: (k, s) => `Failed: request {"${k}":${JSON.stringify(s)}} returned 400`,
  };
  const tokenFormats = {
    unquotedColon: (k, s) => `${k}: ${s} next`,
    unquotedEq: (k, s) => `${k}=${s}, other=1`,
    unquotedEqSpaced: (k, s) => `${k} = ${s} done`,
    bearer: (k, s) => `Authorization: Bearer ${s}`,
    bearerJson: (k, s) => JSON.stringify({ headers: { Authorization: `Bearer ${s}` } }),
    basic: (k, s) => `authorization: Basic ${Buffer.from(s).toString('base64')}`,
  };
  const jwtFormat = () => { const j = `eyJ${b64u(20)}.${b64u(40)}.${b64u(30)}`; return [j, pick([`token ${j} x`, `"x":"${j}"`, `foo=${j}&`, `(${j})`, `${j}`])]; };
  // any surviving run of 6+ secret characters contains a surviving 6-character window
  function leaks(secret, out) {
    for (let i = 0; i + 6 <= secret.length; i++) { const sub = secret.slice(i, i + 6); if (out.includes(sub)) return sub; }
    return null;
  }
  
  const fails = {};
  let total = 0;
  const record = (name, input, out, secret, sub) => { (fails[name] ??= []).push({ input, out, secret, sub }); };
  const check = (name, input, secret, candidates) => {
    for (const [via, out] of candidates) {
      total++;
      // ignore coincidental overlap with the surrounding (non-secret) template text
      const sub = leaks(secret, out);
      if (sub && !input.replace(secret, '').includes(sub)) record(name + '/' + via, input, out, secret, sub);
    }
  };
  const formatted = (x) => String(Logger.formatMessage(x, 'dev'));
  for (let iter = 0; iter < CASES_PER_SEED; iter++) {
    const k = pick(KEYS);
    for (const [name, f] of Object.entries(formats)) {
      const s = gen(WILD);
      if (!/[A-Za-z0-9]{6}/.test(s)) continue;
      const input = f(k, s);
      // the secret as it appears in the input (encoded forms) must not survive either
      const shown = [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s), JSON.stringify(JSON.stringify(s)).slice(3, -3)];
      for (const sh of new Set(shown)) check(name, input, sh, [['redact', redact(input)], ['logger', formatted(input)], ['loggerObj', formatted({ msg: input })]]);
    }
    for (const [name, f] of Object.entries(tokenFormats)) {
      const s = gen(TOK); const input = f(k, s);
      const sh = name === 'basic' ? Buffer.from(s).toString('base64') : s;
      check(name, input, sh, [['redact', redact(input)], ['logger', formatted(input)]]);
    }
    const [j, input] = jwtFormat(); check('jwt', input, j, [['redact', redact(input)], ['logger', formatted(input)]]);
    // object path
    const s = gen(WILD); const obj = { outer: { [k]: s, list: [{ [pick(['token','Authorization','x-api-key','clientSecret'])]: s }] } };
    check('object', JSON.stringify(obj), s, [['logger', formatted(obj)], ['redactJson', JSON.stringify(redact(obj))]]);
  }

  return { total, fails };
}

for (const seed of [777, 12345, 4242]) {
  for (const quotesInSecrets of [true, false]) {
    test(`no secret leaks through redaction (seed ${seed}, quotes in secrets: ${quotesInSecrets})`, () => {
      const { total, fails } = fuzz(seed, { quotesInSecrets });
      assert.ok(total > 100000, `ran ${total} checks`);
      const names = Object.keys(fails);
      assert.deepEqual(names, [], names.map((n) => `${n}: ${JSON.stringify(fails[n][0])}`).join('\n'));
    });
  }
}
