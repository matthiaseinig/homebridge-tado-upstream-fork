import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/helper/safe-error.js';

test('describeError gives status, code or a fixed phrase and never the error text', () => {
  const secret = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
  assert.equal(describeError(Object.assign(new Error(`bad ${secret}`), { response: { statusCode: 503 } })), 'HTTP 503');
  assert.equal(describeError(Object.assign(new Error(`bad ${secret}`), { code: 'ENOTFOUND' })), 'ENOTFOUND');
  assert.equal(describeError(Object.assign(new Error(`bad ${secret}`), { name: 'TimeoutError' })), 'timeout');
  assert.equal(describeError(new Error('wrap', { cause: Object.assign(new Error(secret), { response: { statusCode: 429 } }) })), 'HTTP 429');
  assert.equal(describeError(new SyntaxError(`Unexpected token 'x', "${secret}" is not valid JSON`)), 'unexpected error');
  assert.equal(describeError(undefined), 'unexpected error');
  assert.equal(describeError(Object.assign(new Error('Tado authorization is required.'), { code: 'TADO_AUTH_REQUIRED' })), 'Tado authorization is required.');
});
