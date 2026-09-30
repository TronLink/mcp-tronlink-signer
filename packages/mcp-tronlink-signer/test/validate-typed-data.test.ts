// Tests for validateTypedDataDomain (src/schemas.ts) — the strict EIP-712 domain
// check on the MCP sign_typed_data path. Run with tsx so the TS source is loaded
// directly (no build step): `node --import tsx --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTypedDataDomain } from '../src/schemas.js';

const MAINNET = 728126428;
const NILE = 3448148188;
const VC_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';      // real USDT-TRC20 contract (valid checksum)
const VC_BAD_CHECKSUM = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'; // same shape, last char changed → bad checksum

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ok = (td: Record<string, unknown>, net: any = 'mainnet') =>
  assert.doesNotThrow(() => validateTypedDataDomain(td, net));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const throws = (td: Record<string, unknown>, net: any = 'mainnet') =>
  assert.throws(() => validateTypedDataDomain(td, net));

test('chainId is optional: omitted / null / no-domain are chain-agnostic and allowed', () => {
  ok({ domain: {} });
  ok({ domain: { chainId: null } });
  ok({ types: {} });          // no domain at all
  ok({});                     // empty typedData
});

test('chainId, when present, must equal the target network', () => {
  ok({ domain: { chainId: MAINNET } });
  ok({ domain: { chainId: String(MAINNET) } });   // numeric string accepted
  ok({ domain: { chainId: NILE } }, 'nile');
  throws({ domain: { chainId: NILE } });           // nile id on mainnet → reject
  throws({ domain: { chainId: MAINNET } }, 'nile');
});

test('chainId, when present, must be an integer', () => {
  throws({ domain: { chainId: 'abc' } });
  throws({ domain: { chainId: 728126428.5 } });
  throws({ domain: { chainId: true } });
  throws({ domain: { chainId: '' } });             // empty string → 0 → mismatch
});

test('verifyingContract, when present, must be a recognizable address', () => {
  ok({ domain: { chainId: MAINNET, verifyingContract: VC_BASE58 } });        // Tron base58
  ok({ domain: { chainId: MAINNET, verifyingContract: '0x' + 'a'.repeat(40) } }); // EVM hex
  ok({ domain: { chainId: MAINNET, verifyingContract: '41' + 'a'.repeat(40) } }); // Tron hex
  ok({ domain: { chainId: MAINNET, verifyingContract: '' } });               // empty == absent
  throws({ domain: { chainId: MAINNET, verifyingContract: 'evil-contract' } });
  throws({ domain: { chainId: MAINNET, verifyingContract: 123 } });
});

test('verifyingContract is validated independently of chainId (chain-agnostic + bad vc → reject)', () => {
  ok({ domain: { verifyingContract: VC_BASE58 } });          // no chainId, valid vc
  throws({ domain: { verifyingContract: 'evil-contract' } }); // no chainId, bad vc
});

test('verifyingContract base58 must pass the checksum, not just the shape', () => {
  ok({ domain: { chainId: MAINNET, verifyingContract: VC_BASE58 } });
  // VC_BAD_CHECKSUM has a valid base58 charset and 34-char length (passes a plain
  // regex) but a wrong base58check checksum — must be rejected.
  throws({ domain: { chainId: MAINNET, verifyingContract: VC_BAD_CHECKSUM } });
});
