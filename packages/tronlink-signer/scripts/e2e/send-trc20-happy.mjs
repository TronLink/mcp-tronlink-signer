// LIVE happy-path e2e for send_trc20 under the fail-closed decimals rule. Sends
// 0.0001 USDD (18dp) with decimals OMITTED, so the SDK reads the contract's
// on-chain decimals() (18), builds 0.0001*1e18 = 1e14 raw, broadcasts, confirms.
// Proves option A didn't break the legitimate path. Approve both prompts.
// Run: node packages/tronlink-signer/scripts/e2e/send-trc20-happy.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'mcp-tronlink-signer', 'dist', 'cli.js');
const PORT = process.env.MCP_PORT || '38667';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
const USDD = 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4'; // 18dp on Nile

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
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-trc20-happy', version: '1' } }, 15000);
  note('notifications/initialized');
  console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  console.log(`\n>>> Browser tab should open. If not: http://127.0.0.1:${PORT}/`);
  console.log('>>> 1) Approve Connect.');
  console.log('>>> 2) On the Send TRC20 page (decimals OMITTED → auto-read):');
  console.log('>>>      Amount row should read "0.0001 USDD", Decimals row "18".');
  console.log('>>> 3) APPROVE — this really sends 0.0001 USDD on Nile.\n');

  const c = await rpc('tools/call', { name: 'connect_wallet', arguments: { network: 'nile' } });
  const owner = JSON.parse(text(c)).address;
  console.log('=== connect ===\n' + owner);

  // decimals OMITTED — the SDK must read on-chain decimals() (18) and proceed.
  const r = await rpc('tools/call', {
    name: 'send_trc20',
    arguments: { contractAddress: USDD, to: RECIP, amount: '0.0001', network: 'nile' },
  });
  const out = text(r);
  const isError = !!r.result?.isError;
  console.log('\n=== send_trc20 (USDD 18dp, decimals omitted → auto 18) ===\nisError=' + isError + '\n' + out.slice(0, 400));

  let ok = false;
  try { const j = JSON.parse(out); ok = !isError && !!(j.txId || j.txid); } catch { ok = false; }
  console.log('\n=== VERDICT: ' + (ok
    ? 'PASS — legitimate send broadcast+confirmed (txId present), fail-closed rule did not block it'
    : 'FAIL — expected a successful broadcast with a txId') + ' ===');
} catch (e) {
  console.log('\nFAIL —', e.message, '\n--- stderr ---\n', stderr.slice(-800));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
