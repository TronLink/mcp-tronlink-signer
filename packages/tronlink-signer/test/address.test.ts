// Tests for isTronAddress (src/address.ts) — the SDK-boundary address validator
// backing requireTronAddress() on sendTrx/sendTrc20/getBalance. Run with tsx so
// the TS source (and its tronweb import) loads directly: `node --import tsx --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTronAddress } from '../src/address.js';

// Real USDT-TRC20 mainnet contract — valid base58check checksum.
const VALID = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// Same charset + 34-char length, last char flipped → valid shape, BAD checksum.
const BAD_CHECKSUM = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u';

test('accepts a valid Tron base58 address (checksum verified)', () => {
  assert.equal(isTronAddress(VALID), true);
});

test('rejects a base58 string with the right shape but a wrong checksum', () => {
  // This is the case a plain regex (charset + length) would wrongly accept — the
  // whole reason validation goes through TronWeb.isAddress, not just a pattern.
  assert.equal(isTronAddress(BAD_CHECKSUM), false);
});

test('accepts 41-prefixed Tron hex', () => {
  assert.equal(isTronAddress('41' + 'a'.repeat(40)), true);
});

test('rejects 0x-prefixed EVM hex (TronWeb.isAddress does not accept it)', () => {
  // Documents the gap that schemas.ts compensates for with EVM_HEX_ADDR_RE:
  // an EVM verifyingContract is a valid address form but isTronAddress is false.
  assert.equal(isTronAddress('0x' + 'a'.repeat(40)), false);
});

test('rejects garbage, empty, and non-string inputs', () => {
  assert.equal(isTronAddress('evil-contract'), false);
  assert.equal(isTronAddress(''), false);
  assert.equal(isTronAddress('T' + '0'.repeat(33)), false); // '0' is not in the base58 alphabet
  // @ts-expect-error — exercising the typeof guard against non-string callers
  assert.equal(isTronAddress(null), false);
  // @ts-expect-error
  assert.equal(isTronAddress(123), false);
  // @ts-expect-error
  assert.equal(isTronAddress(undefined), false);
});
