// Tests for PendingStore (src/pending-store.ts) — the in-memory request registry
// with a 5-minute timeout. The timeout is driven with node:test's mock.timers so
// we never actually wait. Run with tsx: `node --import tsx --test`.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PendingStore } from '../src/pending-store.js';
import { REQUEST_TIMEOUT_MS } from '../src/config.js';

test('create returns id + promise; resolve settles it and clears the entry', async () => {
  const store = new PendingStore();
  const { id, promise } = store.create('connect', { foo: 1 }, 'mainnet');
  assert.equal(store.size(), 1);
  assert.ok(store.get(id));
  assert.equal(store.resolve(id, { address: 'T...' }), true);
  assert.deepEqual(await promise, { address: 'T...' });
  assert.equal(store.size(), 0);
  assert.equal(store.get(id), undefined);
});

test('reject settles the promise with the given reason', async () => {
  const store = new PendingStore();
  const { id, promise } = store.create('send_trx', {}, 'nile');
  const rejected = assert.rejects(promise, /USER_REJECTED/);
  assert.equal(store.reject(id, 'USER_REJECTED'), true);
  await rejected;
  assert.equal(store.size(), 0);
});

test('resolve/reject on an unknown id returns false', () => {
  const store = new PendingStore();
  assert.equal(store.resolve('missing', {}), false);
  assert.equal(store.reject('missing', 'x'), false);
});

test('getNext returns the oldest by createdAt; getAll is sorted', () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const store = new PendingStore();
    const a = store.create('connect', {}, 'mainnet'); // createdAt 0
    mock.timers.tick(10);
    const b = store.create('send_trx', {}, 'mainnet'); // createdAt 10
    mock.timers.tick(10);
    const c = store.create('sign_message', {}, 'mainnet'); // createdAt 20
    assert.equal(store.getNext()?.id, a.id);
    assert.deepEqual(store.getAll().map((r) => r.id), [a.id, b.id, c.id]);
    // resolving the oldest promotes the next-oldest
    store.resolve(a.id, {});
    a.promise.catch(() => {});
    assert.equal(store.getNext()?.id, b.id);
    void b; void c;
  } finally {
    mock.timers.reset();
  }
});

test('a request times out after REQUEST_TIMEOUT_MS and is removed', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const store = new PendingStore();
    const { id, promise } = store.create('connect', {}, 'mainnet');
    const rejected = assert.rejects(promise, /TIMEOUT.*5 minutes/);
    mock.timers.tick(REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(store.size(), 0);
    assert.equal(store.get(id), undefined);
  } finally {
    mock.timers.reset();
  }
});

test('resolve before timeout clears the timer (no late rejection)', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const store = new PendingStore();
    const { id, promise } = store.create('connect', {}, 'mainnet');
    assert.equal(store.resolve(id, { ok: true }), true);
    assert.deepEqual(await promise, { ok: true });
    // Advancing past the timeout must NOT throw a late rejection (timer cleared).
    mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
    assert.equal(store.size(), 0);
  } finally {
    mock.timers.reset();
  }
});

test('clearAll rejects every pending request with the reason', async () => {
  const store = new PendingStore();
  const r1 = store.create('connect', {}, 'mainnet');
  const r2 = store.create('send_trx', {}, 'mainnet');
  const p1 = assert.rejects(r1.promise, /WALLET_CHANGED: account/);
  const p2 = assert.rejects(r2.promise, /WALLET_CHANGED: account/);
  store.clearAll('WALLET_CHANGED: account');
  await Promise.all([p1, p2]);
  assert.equal(store.size(), 0);
});
