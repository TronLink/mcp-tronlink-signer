// Tests for app.js — the Approve-button identify-gating on ambiguous transferFrom
// and the cross-cycle stale-timer fix. app.js is the top-level SPA controller IIFE
// (no exports); we load it into a vm with a mock DOM + mocked window.TronWallet /
// TxParser / fetch, and drive it through the real poll -> switchTo -> handleRequest
// -> runAsyncLookups chain. Timers are controlled with node:test mock.timers.
// Run: node --import tsx --test  (mjs runs fine under the tsx loader too).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'app.js'), 'utf8');
const IDENTIFY_TIMEOUT_MS = 8000;

// --- minimal DOM element mock ----------------------------------------------
function matchAll(children, sel) {
  const keyM = sel.match(/data-row-key="([^"]+)"/);
  const cls = sel.startsWith('.') ? sel.slice(1).split('[')[0] : null;
  return children.filter((c) => {
    if (keyM) return c._attrs['data-row-key'] === keyM[1];
    if (cls) return String(c.className || '').split(/\s+/).includes(cls);
    return false;
  });
}
function makeEl(tag = 'div') {
  return {
    tagName: tag, _children: [], _listeners: {}, _attrs: {}, __html: '',
    textContent: '', className: '', disabled: false, style: {}, parentNode: null,
    get innerHTML() { return this.__html; },
    set innerHTML(v) { this.__html = v; if (v === '') this._children = []; },
    addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
    append(...kids) { kids.forEach((k) => { k.parentNode = this; this._children.push(k); }); },
    appendChild(k) { k.parentNode = this; this._children.push(k); return k; },
    removeChild(k) { const i = this._children.indexOf(k); if (i >= 0) this._children.splice(i, 1); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    querySelector(sel) { return matchAll(this._children, sel)[0] || null; },
    querySelectorAll(sel) { return matchAll(this._children, sel); },
    click() { (this._listeners.click || []).forEach((fn) => fn()); },
  };
}

const IDS = ['status', 'details', 'typeBadge', 'networkBadge', 'tabBar', 'buttonGroup', 'retryGroup', 'retryBtn', 'approveBtn', 'rejectBtn'];

// A sign_transaction request. kind 'transferFrom' -> ambiguous (gated); else plain.
const req = (id, kind, createdAt) => ({
  id, type: 'sign_transaction', network: 'nile', createdAt,
  data: { transaction: { __kind: kind } }, networkConfig: { fullHost: 'x' },
});

function setup(requests) {
  const els = {};
  IDS.forEach((id) => (els[id] = makeEl()));
  els.approveBtn.textContent = 'Approve';
  const meta = { getAttribute: () => 'test-session', setAttribute() {} };

  const deferreds = [];
  const nextProbe = () => { let res; const p = new Promise((r) => (res = r)); deferreds.push({ promise: p, resolve: res }); return p; };

  const TxParser = {
    parseTransaction: (tx) => tx && tx.__kind === 'transferFrom'
      ? { type: 'sign_transaction', label: 'Contract Call: transferFrom',
          details: [{ l: 'amount or tokenId', v: '1000', k: 'arg-2' }],
          _contractCall: { resolved: true, ambiguousKind: true, selector: '23b872dd', tokenAmounts: [{ argIndex: 2 }], rawArgs: ['a', 'b', 1000n], contractHex: '41c' } }
      : { type: 'sign_transaction', label: 'Transfer TRX', details: [{ l: 'To', v: 'Tx', k: 'to' }] },
    fetchTrc20AmountForCall: () => nextProbe(),
    fetchTrc10Info() {}, fetchTrc20Info() {}, fetchWithdrawAmount() {}, fetchContractCallAbi() {},
  };
  const TronWallet = {
    setOnWalletChanged() {}, discoverWallets() {},
    waitForWallet: async () => true,
    getProviderDetail: () => ({ info: { name: 'TronLink' } }),
    ensureWalletReady: async () => {}, ensureConnected: async () => {},
    getAddress: () => 'TEHc', getCurrentNetwork: () => 'nile',
  };
  const TronActions = { execute: async () => ({}) };

  const fetchMock = async (url) => {
    const body =
      url.indexOf('/api/pending') === 0 || url.indexOf('/api/pending?') >= 0 || url.startsWith('/api/pending')
        ? { requests }
        : { ok: true };
    return { status: 200, ok: true, json: async () => body, text: async () => '<html></html>' };
  };

  const win = { TronWallet, TxParser, TronActions };
  const document = {
    getElementById: (id) => els[id],
    querySelector: (sel) => (sel.indexOf('meta') >= 0 ? meta : null),
    createElement: (tag) => makeEl(tag),
  };
  const sandbox = {
    window: win, document, console, fetch: fetchMock, Date, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {} },
  };
  vm.runInNewContext(SRC, sandbox);
  return { els, deferreds };
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('ambiguous transferFrom: Approve is disabled until the identify probe resolves', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { els, deferreds } = setup([req('A', 'transferFrom', 1)]);
    await flush();
    assert.equal(els.approveBtn.disabled, true, 'gated while identifying');
    assert.equal(els.approveBtn.textContent, 'Identifying token…');
    assert.equal(deferreds.length, 1);
    deferreds[0].resolve();
    await flush();
    assert.equal(els.approveBtn.disabled, false, 'released after probe');
    assert.equal(els.approveBtn.textContent, 'Approve');
  } finally { mock.timers.reset(); }
});

test('identify timeout: Approve is released with an NFT-caution warning', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { els } = setup([req('A', 'transferFrom', 1)]);
    await flush();
    assert.equal(els.approveBtn.disabled, true);
    mock.timers.tick(IDENTIFY_TIMEOUT_MS);
    await flush();
    assert.equal(els.approveBtn.disabled, false, 'released on timeout');
    assert.match(els.status.textContent, /Could not confirm token type/);
  } finally { mock.timers.reset(); }
});

test('non-ambiguous request: Approve is enabled, never gated', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { els, deferreds } = setup([req('A', 'trx', 1)]);
    await flush();
    assert.equal(els.approveBtn.disabled, false);
    assert.equal(deferreds.length, 0, 'no identify probe for a plain transfer');
  } finally { mock.timers.reset(); }
});

test('RACE FIX: a stale identify cycle cannot re-enable Approve after switch away + back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { els, deferreds } = setup([req('A', 'transferFrom', 1), req('B', 'trx', 2)]);
    await flush();
    // Auto-selected A (oldest) -> gated; cycle-1 identify probe = deferreds[0].
    assert.equal(els.approveBtn.disabled, true, 'A gated initially');

    assert.equal(els.tabBar._children.length, 2, 'tab bar shows both requests');
    els.tabBar._children[1].click();          // switch to B
    await flush();
    assert.equal(els.approveBtn.disabled, false, 'B (plain) is enabled');

    els.tabBar._children[0].click();          // switch back to A -> fresh cycle; probe = deferreds[1]
    await flush();
    assert.equal(els.approveBtn.disabled, true, 'A re-gated on a fresh cycle');
    assert.equal(deferreds.length, 2, 'one probe per A viewing; B made none');

    // Resolve the STALE cycle-1 probe. Pre-fix this re-enabled Approve (and could
    // flash the "network slow" warning) on the still-pending fresh cycle.
    deferreds[0].resolve();
    await flush();
    assert.equal(els.approveBtn.disabled, true, 'stale probe must NOT re-enable Approve');
    assert.doesNotMatch(els.status.textContent, /Could not confirm token type/, 'no spurious warning');

    // The current cycle still releases normally when ITS probe resolves.
    deferreds[1].resolve();
    await flush();
    assert.equal(els.approveBtn.disabled, false, 'fresh cycle releases on its own probe');
  } finally { mock.timers.reset(); }
});
