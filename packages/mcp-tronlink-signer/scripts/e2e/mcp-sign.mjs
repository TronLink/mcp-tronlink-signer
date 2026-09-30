// MCP signing e2e: drive the real signing tools through the MCP protocol. The
// server opens the browser; the user approves each prompt in TronLink. Covers
// connect_wallet / sign_message / sign_typed_data / send_trx / send_trc20 — i.e.
// the full MCP -> SDK -> browser -> TronLink -> result path.
// Run: node packages/mcp-tronlink-signer/scripts/e2e/mcp-sign.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');
const PORT = process.env.MCP_PORT || '38661';
const RECIP = 'TTPC7Gb5i4VHT5NZPjn9kAGdhSEA3xRKAC';
const USDD = 'TZ78R2E6ejfFhxq8hxrmuqT6hGBxjHQbo4';
const NILE_CHAINID = 3448148188;

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
const step = async (label, name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  console.log(`\n=== ${label} ===\nisError=${!!r.result?.isError}\n${text(r).slice(0, 400)}`);
};

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-sign', version: '1' } }, 15000);
  note('notifications/initialized');
  console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  console.log(`\n>>> A browser tab should open. If not, open: http://127.0.0.1:${PORT}/`);
  console.log('>>> Approve in order: Connect, Sign Message, Sign Typed Data, Send 0.001 TRX, Send 0.0001 USDD\n');

  await step('connect_wallet', 'connect_wallet', { network: 'nile' });
  await step('sign_message', 'sign_message', { message: 'mcp e2e sign @ ' + new Date().toISOString(), network: 'nile' });
  await step('sign_typed_data', 'sign_typed_data', {
    typedData: {
      domain: { name: 'E2E', version: '1', chainId: NILE_CHAINID },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'note', type: 'string' }] },
      primaryType: 'Mail', message: { note: 'mcp hello' },
    }, network: 'nile',
  });
  await step('send_trx', 'send_trx', { to: RECIP, amount: '0.001', network: 'nile' });
  await step('send_trc20 (auto 18dp)', 'send_trc20', { contractAddress: USDD, to: RECIP, amount: '0.0001', network: 'nile' });

  console.log('\n=== MCP SIGN E2E: DONE ===');
} catch (e) {
  console.log('\nMCP SIGN E2E: FAIL —', e.message, '\n--- stderr ---\n', stderr.slice(-800));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
