// Interactive e2e — BROADCAST flows (cost a tiny amount of test TRX/USDD on Nile).
// Drives the built SDK; user approves in TronLink. Covers sendTrx,
// signTransaction(broadcast), sendTrc20 (auto-detect + explicit decimals),
// onBroadcasted callback, confirm polling, and a user-reject re-test (last step).
// Run: TRON_NETWORK=nile TRON_HTTP_PORT=38602 TRON_HTTP_STRICT_PORT=1 \
//   node packages/tronlink-signer/scripts/e2e/broadcast.mjs
import { TronSigner } from '../../dist/index.js';
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const NET = 'nile';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
const USDD = 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4'; // 18 decimals
const PORT = process.env.TRON_HTTP_PORT || '38602';

const step = (tag, v) => console.log(`\n=== ${tag} ===\n` + JSON.stringify(v, null, 2));
const fail = (tag, m) => console.log(`\n=== ${tag} FAILED ===\n` + m);
const onB = (label) => (i) => console.log(`  [onBroadcasted] ${label} txId=${i.txId}`);

const signer = new TronSigner();
await signer.start();
console.log(`\n>>> OPEN: http://127.0.0.1:${PORT}/\n`);

let addr;
try { addr = (await signer.connectWallet(NET)).address; step('connect', { addr }); }
catch (e) { fail('connect', e.message); await signer.stop(); process.exit(1); }

// 1. sendTrx (APPROVE) — 0.001 TRX -> RECIP, with confirm + onBroadcasted
try {
  const r = await signer.sendTrx(RECIP, '0.001', NET, { onBroadcasted: onB('sendTrx') });
  step('sendTrx PASS', r);
} catch (e) { fail('sendTrx', e.message); }

// 2. signTransaction(broadcast=true) (APPROVE) — build 0.001 TRX -> RECIP
try {
  const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
  const tx = await tw.transactionBuilder.sendTrx(RECIP, 1000, addr); // 1000 sun = 0.001 TRX
  const r = await signer.signTransaction(tx, NET, true, { onBroadcasted: onB('signTx') });
  step('signTransaction(broadcast) PASS', { txId: r.txId, status: r.status, error: r.error, signed: !!r.signedTransaction });
} catch (e) { fail('signTransaction(broadcast)', e.message); }

// 3. sendTrc20 AUTO-DETECT decimals (APPROVE) — 0.0001 USDD (18dp) -> RECIP
try {
  const r = await signer.sendTrc20(USDD, RECIP, '0.0001', undefined, NET, { onBroadcasted: onB('trc20-auto') });
  step('sendTrc20(auto-detect 18dp) PASS', r);
} catch (e) { fail('sendTrc20(auto-detect 18dp)', e.message); }

// 4. sendTrc20 EXPLICIT decimals=18 (APPROVE)
try {
  const r = await signer.sendTrc20(USDD, RECIP, '0.0001', 18, NET, { onBroadcasted: onB('trc20-explicit') });
  step('sendTrc20(explicit 18) PASS', r);
} catch (e) { fail('sendTrc20(explicit 18)', e.message); }

// 5. user REJECT re-test (REJECT this one in TronLink) — 0.001 TRX
try {
  await signer.sendTrx(RECIP, '0.001', NET);
  fail('user-reject', 'expected a rejection but it resolved (did you Approve instead of Reject?)');
} catch (e) {
  if (/USER_REJECTED|reject|declin|cancel/i.test(e.message)) step('user-reject PASS', { err: e.message });
  else fail('user-reject', 'rejected for the wrong reason: ' + e.message);
}

console.log('\n=== BROADCAST: DONE ===');
await signer.stop();
process.exit(0);
