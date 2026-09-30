// Probe: how does triggerConstantContract('decimals()') behave across the three
// cases we must tell apart for the decimals backstop?
//   1. a real token (USDD, 18dp)      → expect constant_result has a value
//   2. an EOA / no-decimals() contract → expect empty result OR a revert flag (NOT a thrown network error)
//   3. an unreachable node             → expect a THROWN error (transient failure)
// If (2) and (3) are distinguishable, we can fail-closed on transient while still
// honoring the override for genuinely-non-standard tokens.
// Run: node packages/tronlink-signer/scripts/e2e/probe-decimals-readfail.mjs
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const OWNER = 'TEHcUS1jdmA9yCtfh1bdrPgSk5ukRddbPr';
const USDD = 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4'; // 18dp token
const EOA = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';  // plain account, no decimals()

async function probe(label, host, contract) {
  const tw = new TronWeb({ fullHost: host });
  try {
    const res = await tw.transactionBuilder.triggerConstantContract(contract, 'decimals()', {}, [], OWNER);
    const cr = res && res.constant_result;
    console.log(`\n[${label}]`);
    console.log('  threw?           no');
    console.log('  result.result    =', JSON.stringify(res && res.result));
    console.log('  constant_result  =', JSON.stringify(cr));
    console.log('  first[0]         =', cr && cr[0] ? cr[0] : '(none)');
  } catch (e) {
    console.log(`\n[${label}]`);
    console.log('  threw?           YES ->', (e && e.message ? e.message : String(e)).slice(0, 160));
  }
}

await probe('1. USDD (real 18dp)', 'https://nile.trongrid.io', USDD);
await probe('2. EOA / no decimals()', 'https://nile.trongrid.io', EOA);
await probe('3. unreachable node', 'http://127.0.0.1:1', USDD);
console.log('\nDONE');
process.exit(0);
