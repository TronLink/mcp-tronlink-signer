// LIVE e2e for the send_trc20 decimals-trust backstop (A+B). Calls send_trc20 on
// the 18dp USDD token but pins decimals:6 (wrong). Expected:
//   B (display): the approval page Decimals row reads "6 ⚠ contract reports 18"
//                and the Amount row gets "— ⚠ decimals mismatch".
//   A (execute): even if the human APPROVES, the SDK reads on-chain decimals()
//                (18 ≠ 6) and refuses to build the tx — the tool returns
//                isError=true with a "Provided decimals (6) disagrees …" message.
// Approve the prompt anyway (to exercise the backstop), don't reject it.
// Run: node packages/tronlink-signer/scripts/e2e/send-trc20-decimals-mismatch.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'mcp-tronlink-signer', 'dist', 'cli.js');
const PORT = process.env.MCP_PORT || '38665';
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
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-decimals-mismatch', version: '1' } }, 15000);
  note('notifications/initialized');
  console.log(`server ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
  console.log(`\n>>> Browser tab should open. If not: http://127.0.0.1:${PORT}/`);
  console.log('>>> 1) Approve Connect.');
  console.log('>>> 2) On the Send TRC20 page, CHECK the warning:');
  console.log('>>>      Decimals row should read  "6 ⚠ contract reports 18"');
  console.log('>>>      Amount row should read    "0.0001 USDD — ⚠ decimals mismatch"');
  console.log('>>> 3) APPROVE it anyway (do NOT reject) — the SDK must still refuse.\n');

  const c = await rpc('tools/call', { name: 'connect_wallet', arguments: { network: 'nile' } });
  const owner = JSON.parse(text(c)).address;
  console.log('=== connect ===\n' + owner);

  // 18dp USDD, but pin the WRONG decimals (6). Approve in the browser.
  const r = await rpc('tools/call', {
    name: 'send_trc20',
    arguments: { contractAddress: USDD, to: RECIP, amount: '0.0001', decimals: 6, network: 'nile' },
  });
  const out = text(r);
  const isError = !!r.result?.isError;
  console.log('\n=== send_trc20 (USDD 18dp, pinned decimals:6) ===\nisError=' + isError + '\n' + out.slice(0, 400));

  const refused = isError && /disagrees|decimals/i.test(out);
  console.log('\n=== VERDICT: ' + (refused
    ? 'PASS — backstop refused the mismatched tx (no funds moved)'
    : 'FAIL — expected the SDK to refuse on decimals mismatch') + ' ===');
} catch (e) {
  console.log('\nFAIL —', e.message, '\n--- stderr ---\n', stderr.slice(-800));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
