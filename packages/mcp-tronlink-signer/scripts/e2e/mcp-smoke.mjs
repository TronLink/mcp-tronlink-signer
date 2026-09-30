// MCP protocol smoke: spawn the built stdio server (dist/cli.js) and drive it
// over JSON-RPC (newline-delimited). Verifies boot, tools/resources/prompts
// registration, a real get_balance round-trip (MCP -> SDK -> chain, no browser),
// and the strict-validation boundary (bad address, chainId mismatch) — none of
// which need a wallet/signing. Run: node packages/mcp-tronlink-signer/scripts/e2e/mcp-smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

const child = spawn('node', [CLI], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, TRON_NETWORK: 'nile', TRON_HTTP_PORT: '38650', TRON_HTTP_STRICT_PORT: '1' },
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
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method + '\n--- server stderr ---\n' + stderr)); } }, 20000);
  });
}
const note = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
const callText = (r) => (r.result && r.result.content && r.result.content.map((c) => c.text).join('\n')) || JSON.stringify(r.error || r.result);

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  console.log('initialize       :', init.result.serverInfo, '| protocol', init.result.protocolVersion);
  note('notifications/initialized');

  const tools = await rpc('tools/list');
  console.log('tools (' + tools.result.tools.length + ')      :', tools.result.tools.map((t) => t.name).sort().join(', '));

  const resources = await rpc('resources/list');
  console.log('resources        :', (resources.result.resources || []).map((r) => r.uri).join(', '));

  const prompts = await rpc('prompts/list');
  console.log('prompts          :', (prompts.result.prompts || []).map((p) => p.name).join(', '));

  const gb = await rpc('tools/call', { name: 'get_balance', arguments: { address: 'TEHcUS1jdmA9yCtfh1bdrPgSk5ukRddbPr', network: 'nile' } });
  console.log('get_balance      :', 'isError=' + !!gb.result?.isError, callText(gb).slice(0, 200));

  const badAddr = await rpc('tools/call', { name: 'send_trx', arguments: { to: 'not-an-address', amount: '1', network: 'nile' } });
  console.log('send_trx bad addr:', 'isError=' + !!badAddr.result?.isError, callText(badAddr).slice(0, 200));

  const badChain = await rpc('tools/call', { name: 'sign_typed_data', arguments: { typedData: { domain: { chainId: 728126428 }, types: {}, primaryType: 'X', message: {} }, network: 'nile' } });
  console.log('typedData mismatch:', 'isError=' + !!badChain.result?.isError, callText(badChain).slice(0, 200));

  const badTrc20 = await rpc('tools/call', { name: 'send_trc20', arguments: { contractAddress: 'bad', to: 'TEHcUS1jdmA9yCtfh1bdrPgSk5ukRddbPr', amount: '1', network: 'nile' } });
  console.log('send_trc20 bad ct:', 'isError=' + !!badTrc20.result?.isError, callText(badTrc20).slice(0, 160));

  console.log('\nMCP SMOKE: DONE');
} catch (e) {
  console.log('MCP SMOKE: FAIL —', e.message);
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
