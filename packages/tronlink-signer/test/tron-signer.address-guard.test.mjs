// Integration test for requireTronAddress wiring on TronSigner
// (src/tron-signer.ts). Imports the BUILT package (the constructor inlines the
// browser assets via tsup, which raw node/tsx can't load from src), and asserts
// that sendTrx/sendTrc20/getBalance reject a bad address synchronously — before
// any pending request is created or the browser is opened. Locks the 0-migration
// promise: valid addresses are unaffected; only malformed ones fail fast & clear.
//
// Skipped automatically if dist/ isn't built (root `pnpm test` builds first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist', 'index.js');
const hasDist = existsSync(DIST);

const BAD = 'not-a-tron-address';
const GOOD_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const GOOD_TO = 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC';

test('sendTrx rejects a malformed `to` before touching the network', { skip: !hasDist }, async () => {
  const { TronSigner } = await import(DIST);
  const signer = new TronSigner();
  await assert.rejects(signer.sendTrx(BAD, 1), /Invalid Tron address for to/);
});

test('sendTrc20 rejects a malformed contractAddress and a malformed `to`', { skip: !hasDist }, async () => {
  const { TronSigner } = await import(DIST);
  const signer = new TronSigner();
  await assert.rejects(signer.sendTrc20(BAD, GOOD_TO, '1'), /Invalid Tron address for contractAddress/);
  await assert.rejects(signer.sendTrc20(GOOD_CONTRACT, BAD, '1'), /Invalid Tron address for to/);
});

test('getBalance rejects a malformed address before the RPC call', { skip: !hasDist }, async () => {
  const { TronSigner } = await import(DIST);
  const signer = new TronSigner();
  await assert.rejects(signer.getBalance(BAD), /Invalid Tron address for address/);
});

test('the exported isTronAddress agrees with the guard on these inputs', { skip: !hasDist }, async () => {
  const { isTronAddress } = await import(DIST);
  assert.equal(isTronAddress(BAD), false);
  assert.equal(isTronAddress(GOOD_CONTRACT), true);
  assert.equal(isTronAddress(GOOD_TO), true);
});
