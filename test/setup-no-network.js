// Loaded with `node --import` before every test file: any attempt to open a
// socket or use fetch fails loudly, so tests can never reach the Tado cloud.
import net from 'node:net';

net.Socket.prototype.connect = function blockedConnect() {
  throw new Error('network access is blocked in tests; inject the HTTP client');
};
globalThis.fetch = () => Promise.reject(new Error('network access is blocked in tests'));
