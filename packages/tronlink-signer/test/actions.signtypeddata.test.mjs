// Tests for the sign_typed_data branch of actions.js — specifically the
// browser-side chainId validation hardened in 0.1.5 (NaN/garbage now rejected;
// omitted/null still allowed as chain-agnostic). actions.js is a browser IIFE
// attaching window.TronActions; we run it in a vm sandbox with a mocked
// window.TronWallet + tronWeb, and inspect what reaches tronWeb.trx._signTypedData.
// Run with: node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'actions.js'), 'utf8');

const MAINNET = 728126428;
const NILE = 3448148188;
const SHASTA = 2494104990;

function makeEnv({ currentNetwork = 'mainnet' } = {}) {
  let captured = null;
  const tw = {
    trx: {
      _signTypedData: (domain, types, message) => { captured = { domain, types, message }; return 'SIG'; },
    },
  };
  const sandbox = {
    console, TextDecoder, setTimeout, clearTimeout,
    window: {
      TronWallet: {
        ensureConnected: async () => {},
        getTronWeb: () => tw,
        getCurrentNetwork: () => currentNetwork,
      },
    },
  };
  vm.runInNewContext(SRC, sandbox);
  return { execute: sandbox.window.TronActions.execute, captured: () => captured };
}

// Build a sign_typed_data request. `domain` is spliced in verbatim so callers can
// omit chainId, pass null, a string, garbage, etc.
function req(domain) {
  return {
    type: 'sign_typed_data',
    data: {
      typedData: {
        primaryType: 'Mail',
        domain,
        types: {
          EIP712Domain: [{ name: 'name', type: 'string' }],
          Mail: [{ name: 'x', type: 'string' }],
        },
        message: { x: 'hi' },
      },
    },
  };
}

test('matching chainId signs; EIP712Domain is stripped from the types passed on', async () => {
  const env = makeEnv();
  const out = await env.execute(req({ chainId: MAINNET }), {});
  assert.equal(out.signature, 'SIG');
  assert.equal(env.captured().domain.chainId, MAINNET);
  assert.equal(env.captured().types.EIP712Domain, undefined);
  assert.ok(env.captured().types.Mail);
});

test('omitted chainId is allowed (chain-agnostic) and reaches the wallet', async () => {
  const env = makeEnv();
  const out = await env.execute(req({}), {});
  assert.equal(out.signature, 'SIG');
});

test('null chainId is allowed (chain-agnostic)', async () => {
  const env = makeEnv();
  const out = await env.execute(req({ chainId: null }), {});
  assert.equal(out.signature, 'SIG');
});

test('a numeric-string chainId that matches is accepted (Number coercion)', async () => {
  const env = makeEnv();
  const out = await env.execute(req({ chainId: String(MAINNET) }), {});
  assert.equal(out.signature, 'SIG');
});

test('a non-finite chainId (garbage) is rejected — does not reach the wallet', async () => {
  const env = makeEnv();
  await assert.rejects(env.execute(req({ chainId: 'abc' }), {}), /finite number/);
  assert.equal(env.captured(), null);
});

test('a mismatched chainId is rejected', async () => {
  const env = makeEnv(); // mainnet wallet
  await assert.rejects(env.execute(req({ chainId: NILE }), {}), /chainId mismatch/);
});

test('empty-string chainId coerces to 0 and is rejected as a mismatch', async () => {
  const env = makeEnv();
  await assert.rejects(env.execute(req({ chainId: '' }), {}), /chainId mismatch/);
});

test('chainId is validated against the active network (shasta accepts shasta id)', async () => {
  const env = makeEnv({ currentNetwork: 'shasta' });
  const out = await env.execute(req({ chainId: SHASTA }), {});
  assert.equal(out.signature, 'SIG');
});

test('missing primaryType is rejected before any chainId logic', async () => {
  const env = makeEnv();
  const r = req({ chainId: MAINNET });
  delete r.data.typedData.primaryType;
  await assert.rejects(env.execute(r, {}), /primaryType is required/);
});

test('a primaryType absent from types is rejected', async () => {
  const env = makeEnv();
  const r = req({ chainId: MAINNET });
  r.data.typedData.primaryType = 'Nope';
  await assert.rejects(env.execute(r, {}), /not found in typedData\.types/);
});
