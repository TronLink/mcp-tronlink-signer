// Boundary tests for the zod input schemas (src/schemas.ts) — the MCP strict
// boundary for tool arguments. Run with tsx: `node --import tsx --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SendTrxSchema,
  SendTrc20Schema,
  SignMessageSchema,
  SignTypedDataSchema,
  ConnectWalletSchema,
  GetBalanceSchema,
} from '../src/schemas.js';

const VALID = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  assert.equal(schema.safeParse(v).success, true, `expected pass: ${JSON.stringify(v)}`);
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  assert.equal(schema.safeParse(v).success, false, `expected fail: ${JSON.stringify(v)}`);

test('SendTrx.to: base58 regex at the boundary', () => {
  ok(SendTrxSchema, { to: VALID, amount: 1 });
  bad(SendTrxSchema, { to: 'nope', amount: 1 });
  bad(SendTrxSchema, { to: VALID.slice(0, 33), amount: 1 });       // 33 chars
  bad(SendTrxSchema, { to: VALID + 'x', amount: 1 });              // 35 chars
  bad(SendTrxSchema, { to: 'A' + VALID.slice(1), amount: 1 });     // wrong leading char
  bad(SendTrxSchema, { to: 'T' + '0'.repeat(33), amount: 1 });     // '0' not in base58 alphabet
});

test('SendTrx.amount: number must be positive; string must match the decimal regex', () => {
  ok(SendTrxSchema, { to: VALID, amount: 1.5 });
  ok(SendTrxSchema, { to: VALID, amount: '1.5' });
  bad(SendTrxSchema, { to: VALID, amount: 0 });        // number 0 fails .positive()
  bad(SendTrxSchema, { to: VALID, amount: -1 });
  bad(SendTrxSchema, { to: VALID, amount: '1.' });
  bad(SendTrxSchema, { to: VALID, amount: '.5' });
  bad(SendTrxSchema, { to: VALID, amount: '1e3' });
  bad(SendTrxSchema, { to: VALID, amount: 'abc' });
  bad(SendTrxSchema, { to: VALID, amount: '' });
});

test('SendTrx.amount: the number-vs-string asymmetry — "0" string passes the schema', () => {
  // Documented quirk: number 0 is rejected by .positive(), but the string "0"
  // satisfies /^\d+(\.\d+)?$/, so it passes the SCHEMA and is caught later by
  // actions.js ("TRX amount is zero"). This test pins that intentional gap.
  ok(SendTrxSchema, { to: VALID, amount: '0' });
  bad(SendTrxSchema, { to: VALID, amount: 0 });
});

test('SendTrc20: amount is any string (validated downstream); decimals is int 0..18', () => {
  ok(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1.5' });
  ok(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: 'whatever' }); // shape-only here
  bad(SendTrc20Schema, { contractAddress: VALID, to: VALID });                    // amount required
  ok(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: 0 });
  ok(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: 18 });
  bad(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: 19 });
  bad(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: -1 });
  bad(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: 1.5 });
  bad(SendTrc20Schema, { contractAddress: VALID, to: VALID, amount: '1', decimals: '6' });
  bad(SendTrc20Schema, { contractAddress: 'bad', to: VALID, amount: '1' });
});

test('network enum is optional but constrained', () => {
  ok(SendTrxSchema, { to: VALID, amount: 1, network: 'mainnet' });
  ok(SendTrxSchema, { to: VALID, amount: 1, network: 'nile' });
  ok(SendTrxSchema, { to: VALID, amount: 1, network: 'shasta' });
  ok(SendTrxSchema, { to: VALID, amount: 1 });                     // omitted
  bad(SendTrxSchema, { to: VALID, amount: 1, network: 'ropsten' });
});

test('SignMessage / SignTypedData / Connect / GetBalance basic shapes', () => {
  ok(SignMessageSchema, { message: 'hello' });
  bad(SignMessageSchema, { message: 123 });
  ok(SignTypedDataSchema, { typedData: { domain: {}, types: {}, primaryType: 'X', message: {} } });
  bad(SignTypedDataSchema, { typedData: 'not-an-object' });
  ok(ConnectWalletSchema, {});
  ok(ConnectWalletSchema, { network: 'nile' });
  ok(GetBalanceSchema, { address: VALID });
  bad(GetBalanceSchema, {});                                        // address required
});
