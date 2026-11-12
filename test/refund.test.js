// Isolated transport fakes exercise lost responses and delayed payment status, with no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { refund: approveRefund, refreshTicket } = require('../server.js');
const refund = (row) => approveRefund(row, 'DECISION');

function ticket() {
  return { trace: [], order: { orderId: 'ORDER', captureId: 'CAPTURE', currency: 'USD', captureStatus: 'COMPLETED' },
    decision: { id: 'DECISION', refund: '25.00', refundCents: 2500, needsHuman: false,
      items: [{ name: 'Glass kettle', eligible: true, rule: 'R1' }] }, intent: null, refund: null };
}

function transport(t, handle) {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'offline-test-token', expires_in: 3600 });
    return handle(path, options);
  };
  t.after(() => { global.fetch = original; });
}

test('a lost refund response freezes the original body for a later retry', async (t) => {
  const row = ticket(), requests = [];
  transport(t, (path, options) => {
    if (options.method === 'POST') {
      requests.push({ body: options.body, key: options.headers['PayPal-Request-Id'] });
      if (requests.length === 1) throw new Error('response lost after PayPal accepted payment');
      return Response.json({ id: 'REFUND', status: 'COMPLETED' });
    }
    return Response.json({ status: path.includes('/refunds/') ? 'COMPLETED' : 'PARTIALLY_REFUNDED' });
  });
  await assert.rejects(refund(row), /did not answer/);
  assert.ok(row.intent);
  row.decision.refund = '65.00'; // even an accidental local mutation cannot change the frozen request
  await refund(row);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[1].body).amount.value, '25.00');
  assert.equal(row.refund.amount, '25.00');
  assert.equal(row.refund.status, 'COMPLETED');
});

test('concurrent refund calls cannot overwrite the original refund record', async (t) => {
  const row = ticket();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  transport(t, async (path, options) => {
    if (options.method === 'POST') { await gate; return Response.json({ id: 'REFUND', status: 'COMPLETED' }); }
    return Response.json({ status: path.includes('/refunds/') ? 'COMPLETED' : 'PARTIALLY_REFUNDED' });
  });
  const first = refund(row);
  await assert.rejects(refund(row), /already in progress/);
  release();
  await first;
  await refund(row);
  assert.equal(row.refund.id, 'REFUND');
  assert.equal(row.refund.attempts, 2);
  assert.equal(row.refund.replayed, true);
});

test('pending refunds reconcile from PayPal without sending another refund', async (t) => {
  const row = ticket();
  row.refund = { id: 'REFUND', status: 'PENDING', amount: '25.00' };
  const calls = [];
  transport(t, (path, options) => {
    calls.push({ path, method: options.method });
    return Response.json({ status: path.includes('/refunds/') ? 'COMPLETED' : 'PARTIALLY_REFUNDED' });
  });
  await refreshTicket(row);
  assert.equal(row.refund.status, 'COMPLETED');
  assert.equal(row.order.captureStatus, 'PARTIALLY_REFUNDED');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET']);
});

test('an unavailable capture read-back is UNKNOWN, never a guessed success', async (t) => {
  const row = ticket();
  row.refund = { id: 'REFUND', status: 'PENDING', amount: '25.00' };
  transport(t, (path) => path.includes('/refunds/') ? Response.json({ status: 'PENDING' }) : Response.json({}, { status: 503 }));
  await refreshTicket(row);
  assert.equal(row.refund.status, 'PENDING');
  assert.equal(row.order.captureStatus, 'UNKNOWN');
});

test('ambiguous decisions cannot start a refund or freeze an intent', async () => {
  const row = ticket();
  row.decision.needsHuman = true;
  await assert.rejects(refund(row), /Nothing to refund/);
  assert.equal(row.intent, null);
  assert.equal(row.refund, null);
});

test('approval of an older proposal cannot send a newer proposal amount', async () => {
  const row = ticket();
  row.decision.id = 'NEW-DECISION';
  row.decision.refund = '65.00';
  await assert.rejects(refund(row), /decision changed/);
  assert.equal(row.intent, null);
  assert.equal(row.refund, null);
});
