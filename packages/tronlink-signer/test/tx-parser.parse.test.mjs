// Tests for tx-parser.js parsing + the remaining async lookups: the full
// parseTransaction contract-type switch, fromSun / getResourceName edges,
// swap-path decimals, fetchTrc10Info, fetchWithdrawAmount, and fetchContractCallAbi
// (which exercises formatArg for bool/string/tuple/array + canonicalType +
// selectorOf via a dynamically-fetched ABI). vm sandbox, no browser. node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'tx-parser.js'), 'utf8');

// --- DOM mock (supports both updateRowByLabel/Key and createElement append) --
function makeRow(key, label, value) {
  const l = { textContent: label }, v = { textContent: value };
  const row = {
    _key: key, className: '', parentNode: null,
    setAttribute(k, val) { if (k === 'data-row-key') this._key = val; },
    set innerHTML(_h) {}, // spans are served by querySelector below regardless
    querySelector(sel) { return sel === '.label' ? l : sel === '.value' ? v : null; },
    get label() { return l.textContent; },
    get value() { return v.textContent; },
  };
  return row;
}
function makeContainer(initialRows = []) {
  const nodes = initialRows.map((r) => makeRow(r.key, r.label, r.value));
  const c = {
    _nodes: nodes,
    appendChild(n) { n.parentNode = c; nodes.push(n); },
    removeChild(n) { const i = nodes.indexOf(n); if (i >= 0) nodes.splice(i, 1); },
    querySelectorAll(sel) { return sel === '.detail-row' ? nodes : []; },
    querySelector(sel) { const m = sel.match(/data-row-key="([^"]+)"/); return m ? (nodes.find((n) => n._key === m[1]) || null) : null; },
    row(key) { return nodes.find((n) => n._key === key); },
    rowByLabel(label) { return nodes.find((n) => n.label === label); },
  };
  nodes.forEach((n) => (n.parentNode = c));
  return c;
}

function load(tw, { fetchImpl } = {}) {
  const sandbox = {
    console, setTimeout, clearTimeout, fetch: fetchImpl,
    document: { createElement: () => makeRow('', '', '') },
    window: { TronWallet: { getTronWeb: () => tw, waitForWallet: async () => true } },
  };
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.TxParser;
}

const fromHexTw = () => ({ address: { fromHex: (h) => (typeof h === 'string' && h ? 'T_' + h : h) } });
const tx = (type, value) => ({ raw_data: { contract: [{ type, parameter: { value } }] } });
const noStale = () => false;

// --- parseTransaction: the contract-type switch -----------------------------

test('TransferContract -> TRX amount via fromSun', () => {
  const P = load(fromHexTw());
  const info = P.parseTransaction(tx('TransferContract', { owner_address: '41aa', to_address: '41bb', amount: 1500000 }));
  assert.equal(info.label, 'Transfer TRX');
  // Array.from rebuilds in the host realm — vm-created arrays have a different
  // Array.prototype, which deepStrictEqual treats as unequal even when values match.
  assert.deepEqual(Array.from(info.details, (d) => [d.l, d.v]), [['From', 'T_41aa'], ['To', 'T_41bb'], ['Amount', '1.5 TRX']]);
});

test('fromSun edges: zero / empty / undefined all read as 0 TRX; sub-unit keeps precision', () => {
  const P = load(fromHexTw());
  const amt = (a) => P.parseTransaction(tx('TransferContract', { amount: a })).details.find((d) => d.l === 'Amount').v;
  assert.equal(amt(0), '0 TRX');
  assert.equal(amt(''), '0 TRX');
  assert.equal(amt(undefined), '0 TRX');
  assert.equal(amt(1), '0.000001 TRX');
  assert.equal(amt('1000000000000'), '1000000 TRX');
});

test('TransferAssetContract -> _trc10 set, amount deferred to Loading...', () => {
  const P = load(fromHexTw());
  const info = P.parseTransaction(tx('TransferAssetContract', { owner_address: '41aa', to_address: '41bb', asset_name: '31303031', amount: '5' }));
  assert.equal(info.label, 'Transfer TRC10 Asset');
  assert.equal(info._trc10.rawAmount, '5');
  assert.equal(info.details.find((d) => d.l === 'Amount').v, 'Loading...');
});

test('Freeze / Unfreeze v2 with resource names', () => {
  const P = load(fromHexTw());
  const f = P.parseTransaction(tx('FreezeBalanceV2Contract', { owner_address: '41aa', frozen_balance: 2000000, resource: 1 }));
  assert.equal(f.label, 'Stake TRX (Freeze v2)');
  assert.deepEqual(f.details.find((d) => d.l === 'Amount').v, '2 TRX');
  assert.equal(f.details.find((d) => d.l === 'Resource').v, 'Energy');
  const u = P.parseTransaction(tx('UnfreezeBalanceV2Contract', { owner_address: '41aa', unfreeze_balance: 3000000, resource: 0 }));
  assert.equal(u.label, 'Unstake TRX (Unfreeze v2)');
  assert.equal(u.details.find((d) => d.l === 'Resource').v, 'Bandwidth');
});

test('DelegateResource: lock period rendered in days; >=1 day vs <1 day', () => {
  const P = load(fromHexTw());
  const day = P.parseTransaction(tx('DelegateResourceContract', { owner_address: '41a', receiver_address: '41b', balance: 1000000, resource: 1, lock: true, lock_period: 28800 }));
  assert.equal(day.details.find((d) => d.l === 'Lock').v, 'Yes');
  assert.equal(day.details.find((d) => d.l === 'Lock Period').v, '1 days'); // 28800*3s = 86400s = 1 day
  const hr = P.parseTransaction(tx('DelegateResourceContract', { owner_address: '41a', receiver_address: '41b', balance: 1000000, lock: true, lock_period: 1200 }));
  assert.equal(hr.details.find((d) => d.l === 'Lock Period').v, '1 hours'); // 1200*3s = 3600s = 1h
});

test('Vote / Withdraw / Deploy / Account / Cancel / unknown-type branches', () => {
  const P = load(fromHexTw());
  const vote = P.parseTransaction(tx('VoteWitnessContract', { owner_address: '41a', votes: [{ vote_address: '41sr', vote_count: 7 }] }));
  assert.equal(vote.label, 'Vote for SR');
  assert.match(vote.details.find((d) => d.l === 'SR #1').v, /T_41sr \(7\)/);

  assert.equal(P.parseTransaction(tx('WithdrawBalanceContract', { owner_address: '41a' })).label, 'Claim Rewards');
  const wd = P.parseTransaction(tx('WithdrawExpireUnfreezeContract', { owner_address: '41a' }));
  assert.equal(wd._withdrawOwner, 'T_41a');
  assert.equal(wd.details.find((d) => d.l === 'Amount').v, 'Loading...');

  assert.equal(P.parseTransaction(tx('CreateSmartContract', { owner_address: '41a', new_contract: { name: 'MyC' } })).details.find((d) => d.l === 'Name').v, 'MyC');
  assert.equal(P.parseTransaction(tx('AccountUpdateContract', { owner_address: '41a', account_name: 'bob' })).details.find((d) => d.l === 'Name').v, 'bob');
  assert.equal(P.parseTransaction(tx('CancelAllUnfreezeV2Contract', { owner_address: '41a' })).label, 'Cancel All Pending Unstake');
  // Unknown type -> default branch shows Owner
  const unk = P.parseTransaction(tx('SomeFutureContract', { owner_address: '41a' }));
  assert.equal(unk.details[0].l, 'Owner');
  assert.equal(unk.details[0].v, 'T_41a');
});

test('TriggerSmartContract with an unknown selector -> deferred ABI lookup', () => {
  const P = load(fromHexTw());
  const info = P.parseTransaction(tx('TriggerSmartContract', { owner_address: '41a', contract_address: '41c', data: 'deadbeef0011' }));
  assert.equal(info.label, 'Contract Call');
  assert.equal(info._contractCall.resolved, false);
  assert.equal(info._contractCall.selector, 'deadbeef');
  assert.match(info.details.find((d) => d.k === 'method').v, /Loading ABI/);
});

// --- swap-path decimals (tokenAddressForAmount: pathArgIndex first/last) -----

test('swap decimals resolve per path token (amountIn uses path[0], amountOut uses path[last])', async () => {
  // swapExactTokensForTokens 38ed1739: tokenAmounts use path[first]/path[last].
  const TOKEN_IN = '41' + 'a1'.repeat(20), TOKEN_OUT = '41' + 'b2'.repeat(20);
  const decimalsByAddr = { [TOKEN_IN]: 6, [TOKEN_OUT]: 18 };
  const tw = {
    address: { fromHex: (h) => 'T_' + h },
    defaultAddress: { base58: 'TCaller' },
    transactionBuilder: {
      triggerConstantContract: async (addr, fn) => {
        // addr here is base58 (fromHexAddress applied). Map back by suffix.
        if (fn !== 'decimals()') return { constant_result: [] };
        const hex = Object.keys(decimalsByAddr).find((k) => addr.includes(k));
        return { constant_result: [BigInt(decimalsByAddr[hex] ?? 0).toString(16).padStart(64, '0')] };
      },
    },
  };
  const P = load(tw);
  const details = makeContainer([
    { key: 'arg-0', label: 'amountIn', value: '1000000' },
    { key: 'arg-1', label: 'amountOutMin', value: '5000000000000000000' },
  ]);
  const cc = {
    selector: '38ed1739',
    contractHex: '41router',
    rawArgs: [1000000n, 5000000000000000000n, [TOKEN_IN, TOKEN_OUT], 'Tto', 0n],
    tokenAmounts: [
      { argIndex: 0, pathArgIndex: 2, pathPosition: 'first' },
      { argIndex: 1, pathArgIndex: 2, pathPosition: 'last' },
    ],
  };
  await P.fetchTrc20AmountForCall(cc, details, noStale);
  assert.equal(details.row('arg-0').value, '1'); // 1e6 @ 6dp
  assert.equal(details.row('arg-1').value, '5'); // 5e18 @ 18dp
});

// --- fetchTrc10Info (mock fetch) --------------------------------------------

test('fetchTrc10Info formats by precision and decodes a hex-encoded name', async () => {
  const tw = fromHexTw();
  const fetchImpl = async () => ({
    json: async () => ({ precision: 6, abbr: Buffer.from('TKN', 'utf8').toString('hex') }),
  });
  const P = load(tw, { fetchImpl });
  const details = makeContainer([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await P.fetchTrc10Info({ assetName: '31303031', rawAmount: '12345' }, details, 'https://node', noStale);
  assert.equal(details.rowByLabel('Amount').value, '0.012345 TKN');
});

// --- fetchWithdrawAmount (mock getAccount) ----------------------------------

test('fetchWithdrawAmount sums only expired unfrozenV2 entries', async () => {
  const tw = {
    ...fromHexTw(),
    trx: {
      getAccount: async () => ({
        unfrozenV2: [
          { unfreeze_amount: 1000000, unfreeze_expire_time: 1 },                 // expired
          { unfreeze_amount: 2000000, unfreeze_expire_time: 9999999999999 },     // not yet
        ],
      }),
    },
  };
  const P = load(tw);
  const details = makeContainer([{ key: 'amt', label: 'Amount', value: 'Loading...' }]);
  await P.fetchWithdrawAmount('Towner', details, noStale);
  assert.equal(details.rowByLabel('Amount').value, '1 TRX');
});

// --- fetchContractCallAbi: dynamic ABI decode (formatArg + canonicalType) ----

test('fetchContractCallAbi decodes a fetched ABI and formats bool/string/tuple', async () => {
  const SELECTOR = 'deadbeef';
  const tw = {
    address: { fromHex: (h) => 'T_' + h },
    sha3: undefined,
    utils: {
      abi: { decodeParams: () => [true, 'hello', { a: '41aa', b: 5n }] },
      ethersUtils: {
        toUtf8Bytes: (s) => s,
        // Return a hash whose first 4 bytes equal SELECTOR so selectorOf matches.
        keccak256: () => '0x' + SELECTOR + '0'.repeat(56),
      },
    },
    trx: {
      getContract: async () => ({
        abi: { entrys: [{
          type: 'Function', name: 'doThing',
          inputs: [
            { name: 'flag', type: 'bool' },
            { name: 'note', type: 'string' },
            { name: 'pair', type: 'tuple', components: [{ name: 'a', type: 'address' }, { name: 'b', type: 'uint256' }] },
          ],
        }] },
      }),
    },
  };
  const P = load(tw);
  const details = makeContainer([
    { key: 'method', label: 'Method', value: '0x' + SELECTOR + ' · Loading ABI…' },
    { key: 'data', label: 'Data', value: '0x...' },
  ]);
  await P.fetchContractCallAbi({ contractHex: '41c', selector: SELECTOR, argsHex: '00', resolved: false }, details, noStale);
  assert.equal(details.row('method').value, 'doThing');
  assert.equal(details.row('data'), undefined, 'the placeholder Data row should be removed');
  assert.equal(details.row('arg-0').value, 'true');                  // bool
  assert.equal(details.row('arg-1').value, 'hello');                 // string
  assert.match(details.row('arg-2').value, /\{a: T_41aa, b: 5\}/);   // tuple via canonicalType
});
