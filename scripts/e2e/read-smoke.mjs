// Read-only e2e smoke: no browser, no signing. Verifies the SDK boots, the HTTP
// server binds, the Nile node is reachable, and tronweb 6.3.0's getBalance works.
// Run: TRON_NETWORK=nile TRON_HTTP_PORT=3386 node scripts/e2e/read-smoke.mjs [addr]
import { TronSigner } from '../../packages/tronlink-signer/dist/index.js';

const addr = process.argv[2] || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // any valid base58
const net = process.env.TRON_NETWORK || 'nile';

const signer = new TronSigner();
console.log('config:', signer.getConfig());
await signer.start();
try {
  const bal = await signer.getBalance(addr, net);
  console.log('getBalance(%s, %s) ->', addr, net, bal);
  // also prove the bad-address guard rejects (no network hit)
  try { await signer.getBalance('not-an-address', net); console.log('GUARD: FAIL (did not throw)'); }
  catch (e) { console.log('GUARD ok:', e.message); }
  console.log('SMOKE: PASS');
} catch (e) {
  console.log('SMOKE: FAIL', e.message);
} finally {
  await signer.stop();
}
