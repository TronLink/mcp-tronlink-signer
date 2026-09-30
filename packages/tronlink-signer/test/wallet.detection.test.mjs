// Tests for the TronLink wallet-detection logic in src/web/js/wallet.js.
//
// wallet.js is a browser IIFE (no exports) that attaches window.TronWallet. We
// load its source into a fresh vm sandbox with a mock `window` and a manually
// advanced clock, so the rdns/name/global layering and the discovery grace
// window can be exercised deterministically without a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const WALLET_SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'wallet.js'), 'utf8');

// Fresh sandbox per test: each call re-runs the IIFE with isolated module state.
function makeEnv(globals = {}) {
  let now = 1000;
  const listeners = {};
  const win = {
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    tron: globals.tron,
    tronLink: globals.tronLink,
    tronWeb: globals.tronWeb,
  };
  const sandbox = {
    window: win,
    console,
    Event: class { constructor(type) { this.type = type; } },
    Date: { now: () => now },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(WALLET_SRC, sandbox);
  return {
    TW: win.TronWallet,
    announce: (detail) => win.dispatchEvent({ type: 'TIP6963:announceProvider', detail }),
    advance: (ms) => { now += ms; },
  };
}

const provId = (p) => (p ? p.id : null);
// Build a TIP-6963 announce detail.
const cand = (rdns, name, id, uuid) => ({ info: { rdns, name, uuid: uuid || id }, provider: { id } });

test('rdns match wins immediately, even inside the grace window', () => {
  const e = makeEnv();
  e.TW.discoverWallets();
  e.announce(cand('org.tronlink.www', 'TronLink', 'real'));
  assert.equal(provId(e.TW.getProvider()), 'real');
});

test('name-alike is held during grace; a later real rdns still wins', () => {
  const e = makeEnv();
  e.TW.discoverWallets();
  e.announce(cand('com.evil', 'TronLink Pro', 'rogue'));
  e.advance(100); // within the 400ms grace
  assert.equal(provId(e.TW.getProvider()), null, 'name-alike must not be picked during grace');
  e.announce(cand('org.tronlink.www', 'TronLink', 'real'));
  assert.equal(provId(e.TW.getProvider()), 'real');
});

test('name match is accepted only after the grace window when no rdns appears', () => {
  const e = makeEnv();
  e.TW.discoverWallets();
  e.announce(cand('x', 'TronLink', 'named'));
  e.advance(100);
  assert.equal(provId(e.TW.getProvider()), null);
  e.advance(400); // grace elapsed
  assert.equal(provId(e.TW.getProvider()), 'named');
});

test('grace restarts on every discovery (request long after page-load)', () => {
  const e = makeEnv();
  e.TW.discoverWallets();  // page init
  e.advance(5000);         // initial window long expired
  e.TW.discoverWallets();  // request-time discovery → fresh grace
  e.announce(cand('com.evil', 'TronLink!', 'rogue'));
  e.advance(50);
  assert.equal(provId(e.TW.getProvider()), null, 'fresh grace must hold the name-alike');
  e.announce(cand('org.tronlink.www', 'TronLink', 'real'));
  assert.equal(provId(e.TW.getProvider()), 'real');
});

test('global fallback prefers window.tronLink over window.tron', () => {
  const e = makeEnv({ tron: { id: 'tron-g' }, tronLink: { id: 'tronlink-g' } });
  e.TW.discoverWallets();
  e.advance(500);
  assert.equal(provId(e.TW.getProvider()), 'tronlink-g');
});

test('global fallback prefers an isTronLink-marked global', () => {
  const e = makeEnv({ tron: { id: 'tron-g', isTronLink: true }, tronLink: { id: 'tronlink-g' } });
  e.TW.discoverWallets();
  e.advance(500);
  assert.equal(provId(e.TW.getProvider()), 'tron-g');
});

test('legacy TronLink (window.tron only) is found alongside another TIP-6963 wallet', () => {
  const e = makeEnv({ tron: { id: 'old-tron' } });
  e.TW.discoverWallets();
  e.announce(cand('com.other', 'OtherWallet', 'other'));
  e.advance(500);
  assert.equal(provId(e.TW.getProvider()), 'old-tron');
});

test('pure legacy TronLink (no announces) resolves immediately, no grace wait', () => {
  const e = makeEnv({ tron: { id: 'old-tron' } });
  e.TW.discoverWallets();
  // no time advanced — still inside the grace window
  assert.equal(provId(e.TW.getProvider()), 'old-tron');
});

test('repeated re-announces do not break selection (dedup)', () => {
  const e = makeEnv();
  e.TW.discoverWallets();
  const real = cand('org.tronlink.www', 'TronLink', 'real');
  e.announce(real); e.announce(real);
  e.TW.discoverWallets();
  e.announce(real);
  assert.equal(provId(e.TW.getProvider()), 'real');
});
