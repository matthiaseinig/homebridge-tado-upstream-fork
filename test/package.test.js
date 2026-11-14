import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('engines cover Homebridge 1.8 and 2 and current Node lines', () => {
  assert.equal(pkg.engines.homebridge, '^1.8.0 || ^2.0.0');
  assert.equal(pkg.engines.node, '^22.12.0 || ^24 || ^26');
});

test('the handler uses Service.Battery, not the removed BatteryService alias', () => {
  const handler = readFileSync(new URL('../src/helper/handler.js', import.meta.url), 'utf8');
  assert.doesNotMatch(handler, /BatteryService/);
  assert.match(handler, /Service\.Battery\b/);
});
