// Tests for wallet.js's method-agnostic connect (requestAccounts via ensureConnected):
// modern window.tron uses eth_requestAccounts, legacy window.tronLink uses
// tron_requestAccounts. Connect must try one and fall back to the other on an
// "Unknown method" response, but must NOT retry on a real user rejection.
// vm sandbox with a controllable provider. Run: node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'src', 'web', 'js', 'wallet.js'), 'utf8');

// getProvider() returns window.tron here (no announces, no tronLink). The
// provider has no .tronWeb so isConnected() is false -> ensureConnected calls
// requestAccounts. `respond(method)` returns the promise for each request.
function makeEnv(respond) {
  const calls = [];
  const provider = { isTronLink: true, request: ({ method }) => { calls.push(method); return respond(method); } };
  const win = { addEventListener() {}, dispatchEvent() { return true; }, tron: provider };
  const sandbox = {
    window: win, console,
    Event: class { constructor(t) { this.type = t; } },
    Date: { now: () => 1000 },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(SRC, sandbox);
  return { TW: win.TronWallet, calls };
}
const unknownMethod = () => Promise.reject(new Error('[commonRequest]: Unknown method called'));

test('connect falls back to eth_requestAccounts when tron_requestAccounts is unknown (modern window.tron)', async () => {
  const e = makeEnv((m) => (m === 'tron_requestAccounts' ? unknownMethod() : Promise.resolve({ code: 200 })));
  await e.TW.ensureConnected();
  assert.deepEqual(e.calls, ['tron_requestAccounts', 'eth_requestAccounts']);
});

test('connect uses tron_requestAccounts alone when supported (legacy window.tronLink-style)', async () => {
  const e = makeEnv((m) => (m === 'tron_requestAccounts' ? Promise.resolve({ code: 200 }) : Promise.reject(new Error('should not be called'))));
  await e.TW.ensureConnected();
  assert.deepEqual(e.calls, ['tron_requestAccounts']);
});

test('connect surfaces user rejection (code 4001) and does NOT try the other method', async () => {
  const e = makeEnv((m) => (m === 'tron_requestAccounts' ? Promise.resolve({ code: 4001 }) : Promise.resolve({ code: 200 })));
  await assert.rejects(e.TW.ensureConnected(), /rejected/i);
  assert.deepEqual(e.calls, ['tron_requestAccounts']);
});

test('connect surfaces an already-queued request (code 4000)', async () => {
  const e = makeEnv((m) => (m === 'tron_requestAccounts' ? Promise.resolve({ code: 4000 }) : Promise.resolve({ code: 200 })));
  await assert.rejects(e.TW.ensureConnected(), /already open/i);
  assert.deepEqual(e.calls, ['tron_requestAccounts']);
});

test('connect throws when neither method is supported', async () => {
  const e = makeEnv(() => unknownMethod());
  await assert.rejects(e.TW.ensureConnected(), /Unknown method/i);
  assert.deepEqual(e.calls, ['tron_requestAccounts', 'eth_requestAccounts']);
});
