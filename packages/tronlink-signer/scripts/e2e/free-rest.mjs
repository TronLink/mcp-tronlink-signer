// Interactive e2e — FREE flows, round 2: real signTransaction (no broadcast) +
// the negative paths (chainId mismatch auto-reject, user reject, caller abort).
// Run: TRON_NETWORK=nile TRON_HTTP_PORT=38601 TRON_HTTP_STRICT_PORT=1 \
//   node packages/tronlink-signer/scripts/e2e/free-rest.mjs
import { TronSigner } from '../../dist/index.js';
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const NET = 'nile';
const NILE_CHAINID = 3448148188;
const MAINNET_CHAINID = 728126428;
const RECIP = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // a different valid address; broadcast=false → nothing moves
const PORT = process.env.TRON_HTTP_PORT || '38601';

const step = (tag, v) => console.log(`\n=== ${tag} ===\n` + JSON.stringify(v, null, 2));
const fail = (tag, m) => console.log(`\n=== ${tag} FAILED ===\n` + m);

const signer = new TronSigner();
await signer.start();
console.log(`\n>>> OPEN: http://127.0.0.1:${PORT}/\n`);

let addr;
try { addr = (await signer.connectWallet(NET)).address; step('connect', { addr }); }
catch (e) { fail('connect', e.message); await signer.stop(); process.exit(1); }

// 1. signTransaction (broadcast=false) — APPROVE
try {
  const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
  const tx = await tw.transactionBuilder.sendTrx(RECIP, 1, addr);
  const r = await signer.signTransaction(tx, NET, false);
  step('signTransaction(no-broadcast) PASS', {
    txID: r.signedTransaction?.txID,
    signed: Array.isArray(r.signedTransaction?.signature) && r.signedTransaction.signature.length > 0,
  });
} catch (e) { fail('signTransaction(no-broadcast)', e.message); }

// 2. signTypedData chainId MISMATCH — should AUTO-REJECT in the browser (no action)
try {
  const typedData = {
    domain: { name: 'E2E', version: '1', chainId: MAINNET_CHAINID }, // wrong chain
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'note', type: 'string' }] },
    primaryType: 'Mail',
    message: { note: 'x' },
  };
  await signer.signTypedData(typedData, NET);
  fail('signTypedData(mismatch)', 'expected a rejection but it resolved');
} catch (e) {
  if (/chainid mismatch/i.test(e.message)) step('signTypedData(mismatch) AUTO-REJECTED PASS', { err: e.message });
  else fail('signTypedData(mismatch)', 'rejected for the wrong reason: ' + e.message);
}

// 3. caller ABORT — programmatic, no user action (popup may flash then vanish)
try {
  const ac = new AbortController();
  const p = signer.signMessage('abort-test (no action needed)', NET, { signal: ac.signal });
  setTimeout(() => ac.abort(), 1500);
  await p;
  fail('abort', 'expected cancellation but it resolved');
} catch (e) {
  if (/CANCELLED_BY_CALLER/.test(e.message)) step('abort PASS', { err: e.message });
  else fail('abort', 'rejected for the wrong reason: ' + e.message);
}

// 4. user REJECT — please click Reject on this one
try {
  await signer.signMessage('PLEASE REJECT THIS IN TRONLINK', NET);
  fail('user-reject', 'expected a rejection but it resolved');
} catch (e) { step('user-reject PASS', { err: e.message }); }

console.log('\n=== FREE_REST: DONE ===');
await signer.stop();
process.exit(0);
