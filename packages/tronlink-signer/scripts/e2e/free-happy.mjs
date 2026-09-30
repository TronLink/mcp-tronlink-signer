// Interactive e2e — FREE flows (no on-chain cost). Drives the built SDK; the
// user approves each prompt in TronLink. One browser tab (isPageAlive keeps
// subsequent requests in the same tab). Run:
//   TRON_NETWORK=nile TRON_HTTP_PORT=38600 TRON_HTTP_STRICT_PORT=1 \
//     node packages/tronlink-signer/scripts/e2e/free-happy.mjs
import { TronSigner } from '../../dist/index.js';
// tronweb resolves from this package's node_modules (direct dep).
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const NET = 'nile';
const NILE_CHAINID = 3448148188;
const PORT = process.env.TRON_HTTP_PORT || '38600';

const step = (tag, v) => console.log(`\n=== STEP ${tag} ===\n` + JSON.stringify(v, null, 2));
const fail = (tag, e) => console.log(`\n=== STEP ${tag} FAILED ===\n` + (e && e.message ? e.message : e));

const signer = new TronSigner();
await signer.start();
console.log(`\n>>> OPEN THIS IN YOUR TRONLINK BROWSER:  http://127.0.0.1:${PORT}/\n`);

let addr;
try {
  const w = await signer.connectWallet(NET);
  addr = w.address;
  step('connect', w);
} catch (e) {
  fail('connect', e);
  await signer.stop();
  process.exit(1);
}

try { step('getBalance', await signer.getBalance(addr, NET)); } catch (e) { fail('getBalance', e); }

try {
  const r = await signer.signMessage(`e2e free-happy @ ${new Date().toISOString()}`, NET);
  step('signMessage', { signature: r.signature, len: r.signature?.length });
} catch (e) { fail('signMessage', e); }

try {
  const typedData = {
    domain: { name: 'E2E', version: '1', chainId: NILE_CHAINID },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Mail: [{ name: 'note', type: 'string' }],
    },
    primaryType: 'Mail',
    message: { note: 'hello from e2e' },
  };
  const r = await signer.signTypedData(typedData, NET);
  step('signTypedData(valid chainId)', { signature: r.signature });
} catch (e) { fail('signTypedData(valid chainId)', e); }

try {
  // Build a tiny self-transfer (1 sun) and SIGN ONLY (broadcast=false → no cost).
  const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
  const tx = await tw.transactionBuilder.sendTrx(addr, 1, addr);
  const r = await signer.signTransaction(tx, NET, false);
  step('signTransaction(no-broadcast)', {
    txID: r.signedTransaction?.txID,
    signed: Array.isArray(r.signedTransaction?.signature) && r.signedTransaction.signature.length > 0,
  });
} catch (e) { fail('signTransaction(no-broadcast)', e); }

console.log('\n=== FREE_HAPPY: DONE ===');
await signer.stop();
process.exit(0);
