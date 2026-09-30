// Read-only probe of the user-specified TRC20 on Nile (no browser, no signing).
// Confirms address validity, reads decimals/symbol, and the owner's token balance.
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const C = process.argv[2] || 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4';
const OWNER = process.argv[3] || 'TEHcUS1jdmA9yCtfh1bdrPgSk5ukRddbPr';
const RECIP = process.argv[4] || 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';

const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
console.log('valid:', { contract: TronWeb.isAddress(C), owner: TronWeb.isAddress(OWNER), recip: TronWeb.isAddress(RECIP) });

const call = async (sel, params = []) => {
  const r = await tw.transactionBuilder.triggerConstantContract(C, sel, {}, params, OWNER);
  return r && r.constant_result && r.constant_result[0];
};
const decodeAbiStr = (hex) => {
  if (!hex || hex.length < 128) return '';
  const len = parseInt(hex.slice(64, 128), 16);
  let s = '';
  for (let i = 0; i < len * 2; i += 2) s += String.fromCharCode(parseInt(hex.slice(128 + i, 130 + i), 16));
  return s;
};

try {
  const decHex = await call('decimals()');
  const decimals = decHex ? parseInt(decHex, 16) : null;
  const symHex = await call('symbol()').catch(() => null);
  const balHex = await call('balanceOf(address)', [{ type: 'address', value: OWNER }]).catch(() => null);
  const balRaw = balHex ? BigInt('0x' + balHex) : null;
  console.log(JSON.stringify({
    decimals,
    symbol: symHex ? decodeAbiStr(symHex) : null,
    ownerBalanceRaw: balRaw ? balRaw.toString() : null,
    ownerBalanceHuman: (balRaw != null && decimals != null) ? (Number(balRaw) / 10 ** decimals).toString() : null,
  }, null, 2));
} catch (e) {
  console.log('PROBE ERROR:', e.message);
}
