// MCP sign_transaction e2e — the one signing tool skipped earlier (it needs a
// pre-built raw tx). Lives under tronlink-signer/scripts so it can import tronweb
// to build the tx; spawns the MCP server's dist/cli.js and drives it over JSON-RPC.
// Covers sign_transaction broadcast=false (sign only) and broadcast=true (sign +
// broadcast + confirm). Run: node packages/tronlink-signer/scripts/e2e/mcp-sign-tx.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'tronweb';
const TronWeb = pkg.TronWeb || pkg.default || pkg;

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'mcp-tronlink-signer', 'dist', 'cli.js');
const PORT = process.env.MCP_PORT || '38662';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
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
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-sign-tx', version: '1' } }, 15000);
  note('notifications/initialized');
  console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  console.log(`\n>>> Browser tab should open. If not: http://127.0.0.1:${PORT}/`);
  console.log('>>> Approve in order: Connect, Sign Transaction (no broadcast), Sign Transaction (broadcast)\n');

  // connect to get the owner address (tx owner must be the signer account)
  const c = await rpc('tools/call', { name: 'connect_wallet', arguments: { network: 'nile' } });
  const owner = JSON.parse(text(c)).address;
  console.log('=== connect ===\n' + owner);

  // sign_transaction broadcast=false
  const tx1 = await tw.transactionBuilder.sendTrx(RECIP, 1000, owner); // 0.001 TRX
  const r1 = await rpc('tools/call', { name: 'sign_transaction', arguments: { transaction: tx1, broadcast: false, network: 'nile' } });
  console.log('\n=== sign_transaction (broadcast=false) ===\nisError=' + !!r1.result?.isError + '\n' + text(r1).slice(0, 300));

  // sign_transaction broadcast=true (fresh tx so ref block is current)
  const tx2 = await tw.transactionBuilder.sendTrx(RECIP, 1000, owner);
  const r2 = await rpc('tools/call', { name: 'sign_transaction', arguments: { transaction: tx2, broadcast: true, network: 'nile' } });
  console.log('\n=== sign_transaction (broadcast=true) ===\nisError=' + !!r2.result?.isError + '\n' + text(r2).slice(0, 300));

  console.log('\n=== MCP SIGN_TX E2E: DONE ===');
} catch (e) {
  console.log('\nMCP SIGN_TX E2E: FAIL —', e.message, '\n--- stderr ---\n', stderr.slice(-800));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
