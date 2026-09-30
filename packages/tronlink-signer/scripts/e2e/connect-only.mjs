// Connect-only repro driver against the locally-built SDK, to capture the real
// account-request error. NOTE: on a connection failure the approval page shows
// the error + a Retry button but does NOT reject the SDK promise — so this
// process will just keep waiting. Read the on-screen red box (now includes the
// error code) or the browser devtools console line "[ensureWalletReady] ...".
import { TronSigner } from '../../dist/index.js';

const PORT = process.env.TRON_HTTP_PORT || '38603';
const signer = new TronSigner();
await signer.start();
console.log(`\n>>> OPEN: http://127.0.0.1:${PORT}/   (watch the error box / devtools console)\n`);
try {
  const w = await signer.connectWallet('nile');
  console.log('CONNECT OK:', JSON.stringify(w));
} catch (e) {
  console.log('CONNECT REJECTED:', e.message);
}
await signer.stop();
process.exit(0);
