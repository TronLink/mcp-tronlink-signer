// Tests for loadConfig (src/config.ts) — env-var parsing + validation.
// Run with tsx: `node --import tsx --test`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, NETWORKS, DEFAULT_HTTP_PORT } from '../src/config.js';

const KEYS = ['TRON_NETWORK', 'TRON_HTTP_PORT', 'TRON_API_KEY'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('defaults: mainnet + DEFAULT_HTTP_PORT + no apiKey', () => {
  const cfg = loadConfig();
  assert.equal(cfg.network, 'mainnet');
  assert.equal(cfg.httpPort, DEFAULT_HTTP_PORT);
  assert.equal(cfg.apiKey, undefined);
});

test('TRON_NETWORK: each valid value is accepted; an invalid one throws', () => {
  for (const net of Object.keys(NETWORKS)) {
    process.env.TRON_NETWORK = net;
    assert.equal(loadConfig().network, net);
  }
  process.env.TRON_NETWORK = 'ropsten';
  assert.throws(() => loadConfig(), /Invalid TRON_NETWORK/);
});

test('TRON_HTTP_PORT: empty falls back to default; valid is used', () => {
  process.env.TRON_HTTP_PORT = '';
  assert.equal(loadConfig().httpPort, DEFAULT_HTTP_PORT);
  process.env.TRON_HTTP_PORT = '8080';
  assert.equal(loadConfig().httpPort, 8080);
  process.env.TRON_HTTP_PORT = '65535';
  assert.equal(loadConfig().httpPort, 65535);
  process.env.TRON_HTTP_PORT = '1';
  assert.equal(loadConfig().httpPort, 1);
});

test('TRON_HTTP_PORT: out-of-range / non-integer / non-numeric throw', () => {
  for (const bad of ['0', '-1', '65536', '99999', '80.5', 'abc', 'NaN']) {
    process.env.TRON_HTTP_PORT = bad;
    assert.throws(() => loadConfig(), /Invalid TRON_HTTP_PORT/, `should reject ${bad}`);
  }
});

test('TRON_API_KEY passes through', () => {
  process.env.TRON_API_KEY = 'secret-key';
  assert.equal(loadConfig().apiKey, 'secret-key');
});
