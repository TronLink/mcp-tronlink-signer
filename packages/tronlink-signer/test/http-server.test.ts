// Tests for HttpServer's originGuard + body-parser wiring (src/http-server.ts).
//
// We boot a REAL server on an ephemeral loopback port and drive it with node:http
// (agent:false → one fresh, immediately-closed connection per request, so nothing
// keeps the test process alive). This exercises the actual express middleware
// stack: originGuard runs BEFORE express.json({limit:'2mb'}), and requireSession
// runs inside each route. Run with tsx: `node --import tsx --test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpServer } from '../src/http-server.js';
import { PendingStore } from '../src/pending-store.js';

let server: HttpServer;
let store: PendingStore;
let port: number;
let sessionId: string;
let broadcastedSeen: { id: string; info: { txId: string } } | null = null;
let walletChangedSeen: string | null = null;

before(async () => {
  store = new PendingStore();
  server = new HttpServer(store, '<html data-sid="{{SESSION_ID}}">page</html>', {
    'wallet.js': '/* wallet stub */',
  });
  server.onBroadcasted = (id, info) => { broadcastedSeen = { id, info: { txId: info.txId } }; };
  server.onWalletChanged = (reason) => { walletChangedSeen = reason; };
  // A fixed high port (not 0): the server records this.port from the port it
  // listened on and reuses it in originGuard's allowed-host set, so an ephemeral
  // 0 would leave originGuard checking against ":0". In the default (non-strict)
  // mode an in-use port silently falls back to +1, and getPort() reflects it.
  await server.start(45917);
  port = server.getPort();
  sessionId = server.getSessionId();
});

after(async () => {
  await server.stop();
});

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }
function request(opts: {
  method?: string; path?: string; headers?: Record<string, string>; body?: string | null;
}): Promise<Res> {
  const { method = 'GET', path = '/', headers = {}, body = null } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const validOrigin = () => `http://127.0.0.1:${port}`;
const jsonHeaders = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  origin: validOrigin(),
  ...extra,
});

test('GET on the loopback host with no Origin passes the guard (reaches the route)', async () => {
  const r = await request({ method: 'GET', path: '/api/health' });
  assert.equal(r.status, 200);
  assert.match(r.body, /"status":"ok"/);
});

test('rejects a non-loopback Host header (DNS-rebinding defense)', async () => {
  const r = await request({ method: 'GET', path: '/', headers: { host: 'evil.com' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /Forbidden host/);
});

test('a write with no Origin/Referer is rejected before the route', async () => {
  const r = await request({ method: 'POST', path: '/api/heartbeat', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  assert.match(r.body, /Origin required/);
});

test('a write with a cross-origin Origin is rejected', async () => {
  const r = await request({
    method: 'POST', path: '/api/heartbeat',
    headers: { 'content-type': 'application/json', origin: 'http://evil.com' }, body: '{}',
  });
  assert.equal(r.status, 403);
  assert.match(r.body, /Forbidden origin/);
});

test('origin-valid but session-missing reaches the route, then 410 (guard passed, auth failed)', async () => {
  const r = await request({ method: 'POST', path: '/api/heartbeat', headers: jsonHeaders(), body: '{}' });
  assert.equal(r.status, 410);
  assert.match(r.body, /Session expired/);
});

test('origin-valid + valid session + small body → 200', async () => {
  const r = await request({
    method: 'POST', path: '/api/heartbeat',
    headers: jsonHeaders({ 'x-session-id': sessionId }), body: '{}',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
});

test('a 120KB JSON body is accepted (regression: > express 100KB default, < 2mb)', async () => {
  // A signed contract-deploy / large-data tx easily exceeds 100KB; before the
  // limit was raised this 413'd and hung /api/complete until the 5-min timeout.
  const body = JSON.stringify({ blob: 'x'.repeat(120 * 1024) });
  const r = await request({
    method: 'POST', path: '/api/heartbeat',
    headers: jsonHeaders({ 'x-session-id': sessionId }), body,
  });
  assert.equal(r.status, 200);
});

test('a body over the 2mb limit is rejected with 413', async () => {
  const body = JSON.stringify({ blob: 'x'.repeat(2.1 * 1024 * 1024) });
  const r = await request({
    method: 'POST', path: '/api/heartbeat',
    headers: jsonHeaders({ 'x-session-id': sessionId }), body,
  });
  assert.equal(r.status, 413);
});

test('the session id is never exposed via a GET endpoint', async () => {
  // It is baked into the HTML server-side only; a local process that can read it
  // could forge approvals. Spot-check the obvious read surfaces.
  for (const path of ['/api/health', '/api/debug', '/js/wallet.js']) {
    const r = await request({ method: 'GET', path });
    assert.ok(!r.body.includes(sessionId), `${path} leaked the session id`);
  }
});

// --- route coverage ---------------------------------------------------------

const authGet = (path: string) => request({ method: 'GET', path, headers: { 'x-session-id': sessionId } });
const authPost = (path: string, body: string) =>
  request({ method: 'POST', path, headers: jsonHeaders({ 'x-session-id': sessionId }), body });

test('GET /api/pending requires a session (no header -> 410)', async () => {
  const r = await request({ method: 'GET', path: '/api/pending' });
  assert.equal(r.status, 410);
});

test('GET /api/pending lists created requests with resolved networkConfig', async () => {
  store.clearAll('reset');
  const { id, promise } = store.create('connect', {}, 'nile');
  promise.catch(() => {});
  const r = await authGet('/api/pending');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].id, id);
  assert.equal(body.requests[0].networkConfig.fullHost, 'https://nile.trongrid.io');
  store.reject(id, 'cleanup');
});

test('GET /api/pending/next: 404 when the store is empty', async () => {
  store.clearAll('reset');
  const r = await authGet('/api/pending/next');
  assert.equal(r.status, 404);
});

test('GET /api/pending/:id: 404 for an unknown id', async () => {
  const r = await authGet('/api/pending/does-not-exist');
  assert.equal(r.status, 404);
});

test('POST /api/complete/:id (success) resolves the pending promise', async () => {
  const { id, promise } = store.create('sign_message', {}, 'mainnet');
  const r = await authPost('/api/complete/' + id, JSON.stringify({ success: true, result: { signature: '0xabc' } }));
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
  assert.deepEqual(await promise, { signature: '0xabc' });
});

test('POST /api/complete/:id (failure) rejects the pending promise', async () => {
  const { id, promise } = store.create('sign_message', {}, 'mainnet');
  const rejected = assert.rejects(promise, /USER_REJECTED/);
  const r = await authPost('/api/complete/' + id, JSON.stringify({ success: false, error: 'USER_REJECTED' }));
  assert.equal(r.status, 200);
  await rejected;
});

test('POST /api/complete/:id on an unknown id -> 404', async () => {
  const r = await authPost('/api/complete/nope', JSON.stringify({ success: true, result: {} }));
  assert.equal(r.status, 404);
});

test('POST /api/broadcasted/:id requires a txId (400 without)', async () => {
  const r = await authPost('/api/broadcasted/x', JSON.stringify({}));
  assert.equal(r.status, 400);
  assert.match(r.body, /txId required/);
});

test('POST /api/broadcasted/:id with a txId fires onBroadcasted', async () => {
  broadcastedSeen = null;
  const r = await authPost('/api/broadcasted/req-1', JSON.stringify({ txId: 'deadbeef' }));
  assert.equal(r.status, 200);
  assert.equal(broadcastedSeen?.id, 'req-1');
  assert.equal(broadcastedSeen?.info.txId, 'deadbeef');
});

test('POST /api/wallet-changed clears the store and fires onWalletChanged', async () => {
  walletChangedSeen = null;
  store.create('connect', {}, 'mainnet').promise.catch(() => {});
  const r = await authPost('/api/wallet-changed', JSON.stringify({ reason: 'account' }));
  assert.equal(r.status, 200);
  assert.equal(walletChangedSeen, 'account');
  assert.equal(store.size(), 0);
});

test('GET /api/debug returns the pending count (session required)', async () => {
  store.clearAll('reset');
  store.create('connect', {}, 'mainnet').promise.catch(() => {});
  const r = await authGet('/api/debug');
  assert.equal(r.status, 200);
  assert.match(r.body, /"pendingCount":1/);
  store.clearAll('reset');
});

test('GET /js/:name serves a known file as JS and 404s an unknown one', async () => {
  const okRes = await request({ method: 'GET', path: '/js/wallet.js' });
  assert.equal(okRes.status, 200);
  assert.match(okRes.body, /wallet stub/);
  assert.match(String(okRes.headers['content-type']), /javascript/);
  const missing = await request({ method: 'GET', path: '/js/nope.js' });
  assert.equal(missing.status, 404);
});

test('GET / injects the per-process session id and sets a strict CSP', async () => {
  const r = await request({ method: 'GET', path: '/' });
  assert.equal(r.status, 200);
  assert.match(r.body, new RegExp('data-sid="' + sessionId + '"'));
  assert.ok(!r.body.includes('{{SESSION_ID}}'), 'template token must be substituted');
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.match(String(r.headers['x-content-type-options']), /nosniff/);
});

test('/api/* responses carry no-store cache headers', async () => {
  const r = await request({ method: 'GET', path: '/api/health' });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['cache-control']), /no-store/);
});
