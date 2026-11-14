import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import got from 'got';

test('the test setup blocks real network access', async () => {
  assert.throws(() => net.connect(80, '127.0.0.1'), /blocked in tests/);
  await assert.rejects(() => fetch('https://example.invalid/'), /blocked in tests/);
  await assert.rejects(() => got('http://127.0.0.1:9/', { retry: { limit: 0 }, timeout: { request: 500 } }));
});
