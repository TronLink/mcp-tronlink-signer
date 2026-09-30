// Tests for tx-parser.js — the on-chain token-metadata + transferFrom-ambiguity
// logic added in 0.1.5. tx-parser.js is a browser IIFE attaching window.TxParser;
// its decimals/symbol/kind helpers are closure-private, so we drive them through
// the public API (fetchTrc20Info / fetchTrc20AmountForCall / parseTransaction)
// with a mocked tronWeb + a minimal DOM, in a vm sandbox (same approach as
// wallet.detection.test.mjs). Run with: node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'tx-parser.js'), 'utf8');

// --- helpers (host context) -------------------------------------------------

// A 32-byte uint return word for triggerConstantContract.constant_result[0].
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
// ABI-encoded dynamic string: 32B offset + 32B length + utf8 data. decodeAbiString
// ignores the offset word and reads length from word[1], data from byte 64+.
const abiString = (s) => '0'.repeat(64) + word(s.length) + Buffer.from(s, 'utf8').toString('hex');
// A string whose declared length exceeds decodeAbiString's 128-byte cap.
const abiStringOverLong = () => '0'.repeat(64) + word(200) + 'aa'.repeat(64);

// Build a tronWeb mock. `responder(fnSelector, params)` returns the hex string
// that triggerConstantContract should put in constant_result[0] (or null/'' to
// simulate "no result"). decodeParams is for parseTransaction's calldata decode.
function makeTronWeb({ responder, decodeParams } = {}) {
  return {
    address: { fromHex: (h) => (typeof h === 'string' && h ? 'T_' + h : h) },
    defaultAddress: { base58: 'TCaller000000000000000000000000000' },
    transactionBuilder: {
      triggerConstantContract: async (_addr, fn, _opt, params) => {
        const hex = responder ? responder(fn, params) : null;
        return hex == null ? { constant_result: [] } : { constant_result: [hex] };
      },
    },
    utils: { abi: { decodeParams: decodeParams || (() => []) } },
  };
}

// Minimal detailsEl: rows are {key,label,value}; supports the two query forms
// tx-parser uses (all '.detail-row', and one by [data-row-key="X"]), plus
// '.label'/'.value' sub-queries with a live textContent.
function makeDetails(rows) {
  const nodes = rows.map((r) => {
    const label = { textContent: r.label };
    const value = { textContent: r.value };
    return {
      _key: r.key,
      querySelector(sel) {
        if (sel === '.label') return label;
        if (sel === '.value') return value;
        return null;
      },
      get label() { return label.textContent; },
      get value() { return value.textContent; },
    };
  });
  return {
    _rows: nodes,
    row(key) { return nodes.find((n) => n._key === key); },
    rowByLabel(label) { return nodes.find((n) => n.label === label); },
    querySelectorAll(sel) { return sel === '.detail-row' ? nodes : []; },
    querySelector(sel) {
      const m = sel.match(/data-row-key="([^"]+)"/);
      return m ? (nodes.find((n) => n._key === m[1]) || null) : null;
    },
  };
}

// Fresh vm sandbox with the mocked wallet. getTronWeb() returns `tw` everywhere
// (tx-parser uses it both for hex→base58 and for the constant-contract calls).
function load(tw) {
  const sandbox = {
    console,
    window: { TronWallet: { getTronWeb: () => tw, waitForWallet: async () => true } },
  };
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.TxParser;
}

const noStale = () => false;

// --- fetchTrc20Info: decimals/symbol via selector calls ---------------------

test('TRC20 amount: 18-decimals token formats correctly (the USDD-on-Nile case)', async () => {
  const tw = makeTronWeb({ responder: (fn) => fn === 'decimals()' ? word(18) : abiString('USDD') });
  const TxParser = load(tw);
  const details = makeDetails([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await TxParser.fetchTrc20Info({ contractHex: '41' + 'cc'.repeat(20), rawAmount: '1000000000000000000' }, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '1 USDD');
});

test('TRC20 amount: 6-decimals token with fractional part', async () => {
  const tw = makeTronWeb({ responder: (fn) => fn === 'decimals()' ? word(6) : abiString('USDT') });
  const TxParser = load(tw);
  const details = makeDetails([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await TxParser.fetchTrc20Info({ contractHex: '41' + 'cc'.repeat(20), rawAmount: '1500000' }, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '1.5 USDT');
});

test('TRC20 amount: no decimals() → explicit "raw", never a silent default of 6', async () => {
  const tw = makeTronWeb({ responder: () => null }); // contract returns nothing
  const TxParser = load(tw);
  const details = makeDetails([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await TxParser.fetchTrc20Info({ contractHex: '41' + 'cc'.repeat(20), rawAmount: '123456' }, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '123456 (raw — decimals unavailable)');
});

test('TRC20 amount: decimals out of range (>18) is rejected → raw', async () => {
  const tw = makeTronWeb({ responder: (fn) => fn === 'decimals()' ? word(30) : '' });
  const TxParser = load(tw);
  const details = makeDetails([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await TxParser.fetchTrc20Info({ contractHex: '41' + 'cc'.repeat(20), rawAmount: '42' }, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '42 (raw — decimals unavailable)');
});

test('TRC20 amount: an over-long symbol is dropped (decodeAbiString 128B cap), amount still shows', async () => {
  const tw = makeTronWeb({ responder: (fn) => fn === 'decimals()' ? word(6) : abiStringOverLong() });
  const TxParser = load(tw);
  const details = makeDetails([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await TxParser.fetchTrc20Info({ contractHex: '41' + 'cc'.repeat(20), rawAmount: '2000000' }, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '2'); // no symbol suffix
});

// --- fetchSendTrc20Display: annotate the send_trc20 approval rows ------------

test('send_trc20 display: resolves symbol + real decimals when auto-detecting', async () => {
  const tw = makeTronWeb({ responder: (fn) => (fn === 'decimals()' ? word(18) : abiString('USDD')) });
  const TxParser = load(tw);
  const details = makeDetails([
    { key: 'amt', label: 'Amount', value: '0.0001' },
    { key: 'dec', label: 'Decimals', value: 'auto-detect from contract' },
  ]);
  // base58 contract address (starts with 'T') — must be passed through, not hex-decoded
  await TxParser.fetchSendTrc20Display('TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4', '0.0001', undefined, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '0.0001 USDD');
  assert.equal(details.rowByLabel('Decimals').value, '18');
});

test('send_trc20 display: caller-pinned decimals row is left untouched', async () => {
  const tw = makeTronWeb({ responder: (fn) => (fn === 'decimals()' ? word(6) : abiString('USDT')) });
  const TxParser = load(tw);
  const details = makeDetails([
    { key: 'amt', label: 'Amount', value: '1.5' },
    { key: 'dec', label: 'Decimals', value: '6' },
  ]);
  await TxParser.fetchSendTrc20Display('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '1.5', 6, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '1.5 USDT');   // symbol still annotated
  assert.equal(details.rowByLabel('Decimals').value, '6');        // unchanged (caller pinned)
});

test('send_trc20 display: caller-pinned decimals that disagrees with the contract is flagged', async () => {
  const tw = makeTronWeb({ responder: (fn) => (fn === 'decimals()' ? word(6) : abiString('USDT')) });
  const TxParser = load(tw);
  const details = makeDetails([
    { key: 'amt', label: 'Amount', value: '1.5' },
    { key: 'dec', label: 'Decimals', value: '18' },
  ]);
  await TxParser.fetchSendTrc20Display('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '1.5', 18, details, noStale);
  assert.match(details.rowByLabel('Decimals').value, /18.*contract reports 6/); // conflict surfaced
  assert.match(details.rowByLabel('Amount').value, /mismatch/);                  // amount no longer reassuring
});

test('send_trc20 display: no decimals() result keeps the static placeholder', async () => {
  const tw = makeTronWeb({ responder: () => null });
  const TxParser = load(tw);
  const details = makeDetails([
    { key: 'amt', label: 'Amount', value: '1' },
    { key: 'dec', label: 'Decimals', value: 'auto-detect from contract' },
  ]);
  await TxParser.fetchSendTrc20Display('TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4', '1', undefined, details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '1');
  assert.equal(details.rowByLabel('Decimals').value, 'auto-detect from contract');
});

// --- fetchTrc20AmountForCall: detectTokenKind + transferFrom narrowing -------

function transferFromCc(tokenId) {
  return {
    tokenAmounts: [{ argIndex: 2 }],
    rawArgs: ['41aa', '41bb', tokenId],
    contractHex: '41' + 'cc'.repeat(20),
    selector: '23b872dd',
    ambiguousKind: true,
  };
}
const ambiguousRows = () => makeDetails([
  { key: 'arg-2', label: 'amount or tokenId', value: '1000000' },
  { key: 'type', label: 'Type', value: 'Contract Call: transferFrom' },
]);

test('transferFrom on a TRC20: narrows label to "amount" and formats the value', async () => {
  const tw = makeTronWeb({ responder: (fn) => fn === 'decimals()' ? word(6) : abiString('USDC') });
  const TxParser = load(tw);
  const details = ambiguousRows();
  await TxParser.fetchTrc20AmountForCall(transferFromCc(1000000n), details, noStale);
  assert.equal(details.row('arg-2').label, 'amount');
  assert.equal(details.row('arg-2').value, '1 USDC');
  assert.equal(details.rowByLabel('Type').value, 'Contract Call: transferFrom'); // unchanged
});

test('transferFrom on a TRC721: narrows label to "tokenId" and flags NFT Transfer', async () => {
  // decimals() returns nothing → fall back to supportsInterface(0x80ac58cd)=1.
  const tw = makeTronWeb({ responder: (fn) => fn === 'supportsInterface(bytes4)' ? word(1) : null });
  const TxParser = load(tw);
  const details = ambiguousRows();
  await TxParser.fetchTrc20AmountForCall(transferFromCc(42n), details, noStale);
  assert.equal(details.row('arg-2').label, 'tokenId');
  assert.equal(details.row('arg-2').value, '1000000'); // raw value left as-is
  assert.equal(details.rowByLabel('Type').value, 'NFT Transfer');
});

test('transferFrom on an unknown contract: label stays ambiguous, no NFT flag', async () => {
  // No decimals(), supportsInterface returns 0 → kind 'unknown'.
  const tw = makeTronWeb({ responder: (fn) => fn === 'supportsInterface(bytes4)' ? word(0) : null });
  const TxParser = load(tw);
  const details = ambiguousRows();
  await TxParser.fetchTrc20AmountForCall(transferFromCc(7n), details, noStale);
  assert.equal(details.row('arg-2').label, 'amount or tokenId');
  assert.equal(details.rowByLabel('Type').value, 'Contract Call: transferFrom');
});

// --- parseTransaction: the up-front ambiguity labeling -----------------------

test('parseTransaction labels transferFrom arg #2 as "amount or tokenId" and sets ambiguousKind', () => {
  const tw = makeTronWeb({ decodeParams: () => ['41aa', '41bb', 1000n] });
  const TxParser = load(tw);
  const info = TxParser.parseTransaction({
    raw_data: { contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        owner_address: '41' + 'aa'.repeat(20),
        contract_address: '41' + 'cc'.repeat(20),
        data: '23b872dd' + '00'.repeat(96),
      } },
    }] },
  });
  assert.equal(info.label, 'Contract Call: transferFrom');
  const arg2 = info.details.find((d) => d.k === 'arg-2');
  assert.equal(arg2.l, 'amount or tokenId');
  assert.equal(info._contractCall.ambiguousKind, true);
  assert.equal(info._contractCall.selector, '23b872dd');
});

test('parseTransaction does NOT mark a non-transferFrom method (approve) as ambiguous', () => {
  const tw = makeTronWeb({ decodeParams: () => ['41spender', 5000n] });
  const TxParser = load(tw);
  const info = TxParser.parseTransaction({
    raw_data: { contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        owner_address: '41' + 'aa'.repeat(20),
        contract_address: '41' + 'cc'.repeat(20),
        data: '095ea7b3' + '00'.repeat(64),
      } },
    }] },
  });
  assert.equal(info.label, 'Contract Call: approve');
  assert.equal(info._contractCall.ambiguousKind, false);
  assert.ok(!info.details.some((d) => d.l === 'amount or tokenId'));
});

test('parseTransaction fast-path: a9059cbb transfer extracts rawAmount as a decimal string', () => {
  const TxParser = load(makeTronWeb());
  const amountHex = word(5);
  const info = TxParser.parseTransaction({
    raw_data: { contract: [{
      type: 'TriggerSmartContract',
      parameter: { value: {
        owner_address: '41' + 'aa'.repeat(20),
        contract_address: '41' + 'cc'.repeat(20),
        data: 'a9059cbb' + '0'.repeat(24) + 'bb'.repeat(20) + amountHex,
      } },
    }] },
  });
  assert.equal(info.label, 'TRC20 Transfer');
  assert.equal(info._trc20.rawAmount, '5');
});
