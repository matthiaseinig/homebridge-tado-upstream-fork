// Quoted secrets that contain the characters which end unquoted values
// (ampersand, space, comma, equals, semicolon) must be masked completely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/helper/redact.js';

const AN = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SPECIAL = ' &,=;:/+#%';
const KEYS = ['session', 'sid', 'password', 'refresh_token', 'client_secret', 'api_key', 'Cookie', 'set-cookie', 'sessionId'];

function makeRng(start) {
  let seed = start;
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

function leaks(secret, out, template) {
  for (let i = 0; i + 6 <= secret.length; i++) {
    const sub = secret.slice(i, i + 6);
    if (out.includes(sub) && !template.includes(sub)) return sub;
  }
  return null;
}

for (const seed of [11, 4242, 90210]) {
  test(`quoted secrets containing & space = , ; are fully masked (seed ${seed})`, () => {
    const rnd = makeRng(seed);
    const pick = (s) => s[Math.floor(rnd() * s.length)];
    const gen = () => { let t = ''; const n = 12 + Math.floor(rnd() * 24); for (let i = 0; i < n; i++) t += rnd() < 0.35 ? pick(SPECIAL) : pick(AN); return t; };
    const failures = [];
    for (let n = 0; n < 4000; n++) {
      const k = pick(KEYS);
      const s = gen();
      if (!/[A-Za-z0-9]{6}/.test(s)) continue;
      const forms = [
        `${k}="${s}";`,
        `${k}='${s}';`,
        `${k}="${s}"; Path=/`,
        `${k}='${s}' next=1`,
        `call(${k}="${s}", x=1)`,
        `Cookie: a=1; ${k}="${s}"; b=2`,
        `${k}: "${s}"`,
        `{"${k}":"${s}","z":1}`,
        `${k}="${s}"glued&x=1`,
      ];
      for (const input of forms) {
        const out = redact(input);
        const sub = leaks(s, out, input.replace(s, ''));
        if (sub) failures.push({ input, out, sub });
      }
    }
    assert.deepEqual(failures.slice(0, 3), []);
  });
}
