// MCP sign_transaction with a TRC20-transfer raw tx. Exercises the OTHER TRC20
// display path: the approval page parses the raw a9059cbb tx and formats the
// amount via fetchTrc20Info (decimals/symbol), distinct from send_trc20's path.
// Builds a USDD transfer (0.0001, 18dp) and signs+broadcasts it through MCP.
// Run: node packages/tronlink-signer/scripts/e2e/mcp-sign-trc20.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'mcp-tronlink-signer', 'dist', 'cli.js');
const PORT = process.env.MCP_PORT || '38664';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
const USDD = 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4';
const RAW_AMOUNT = '100000000000000'; // 0.0001 USDD * 10^18
const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });

const child = spawn('node', [CLI], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, TRON_NETWORK: 'nile', TRON_HTTP_PORT: PORT, TRON_HTTP_STRICT_PORT: '1' },
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });
let buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 290000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, timeoutMs);
  });
}
const note = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p || {} }) + '\n');
const text = (r) => (r.result && r.result.content && r.result.content.map((c) => c.text).join('\n')) || JSON.stringify(r.error || r.result);

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-sign-trc20', version: '1' } }, 15000);
  note('notifications/initialized');
  console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  console.log(`\n>>> Browser tab should open. If not: http://127.0.0.1:${PORT}/`);
  console.log('>>> Approve: Connect, then Sign Transaction (TRC20 transfer — Amount row should read "0.0001 USDD")\n');

  const c = await rpc('tools/call', { name: 'connect_wallet', arguments: { network: 'nile' } });
  const owner = JSON.parse(text(c)).address;
  console.log('=== connect ===\n' + owner);

  // Build a raw USDD transfer tx (a9059cbb), sign + broadcast via sign_transaction.
  const built = await tw.transactionBuilder.triggerSmartContract(
    USDD, 'transfer(address,uint256)', {},
    [{ type: 'address', value: RECIP }, { type: 'uint256', value: RAW_AMOUNT }],
    owner,
  );
  if (!built || !built.transaction) throw new Error('failed to build TRC20 transfer tx');
  const r = await rpc('tools/call', { name: 'sign_transaction', arguments: { transaction: built.transaction, broadcast: true, network: 'nile' } });
  console.log('\n=== sign_transaction (TRC20 transfer, broadcast) ===\nisError=' + !!r.result?.isError + '\n' + text(r).slice(0, 360));

  console.log('\n=== MCP SIGN_TRC20_TX E2E: DONE ===');
} catch (e) {
  console.log('\nFAIL —', e.message, '\n--- stderr ---\n', stderr.slice(-800));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
