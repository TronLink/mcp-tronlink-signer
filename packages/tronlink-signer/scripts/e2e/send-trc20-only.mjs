// Single send_trc20 to inspect the approval-page amount/decimals DISPLAY.
// You can just look at the page and Reject (no spend) — we only care about how
// it renders. Amount/contract overridable via argv.
// Run: TRON_NETWORK=nile TRON_HTTP_PORT=38670 TRON_HTTP_STRICT_PORT=1 \
//   node packages/tronlink-signer/scripts/e2e/send-trc20-only.mjs [amount] [contract]
import { TronSigner } from '../../dist/index.js';

const NET = 'nile';
const PORT = process.env.TRON_HTTP_PORT || '38670';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
const AMOUNT = process.argv[2] || '0.0001';
const USDD = process.argv[3] || 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4';

const signer = new TronSigner();
await signer.start();
console.log(`\n>>> OPEN: http://127.0.0.1:${PORT}/   (look at Amount/Decimals rows; Reject = no spend)`);
console.log(`>>> send_trc20: contract=${USDD} to=${RECIP} amount=${AMOUNT} (decimals auto-detect)\n`);
try {
  const r = await signer.sendTrc20(USDD, RECIP, AMOUNT, undefined, NET);
  console.log('RESULT:', JSON.stringify(r));
} catch (e) {
  console.log('REJECTED/ERROR:', e.message);
}
await signer.stop();
process.exit(0);
