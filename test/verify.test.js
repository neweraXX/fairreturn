// Guardrail tests: what the model says must survive these checks before any money moves.
// Run: node --test   (no dependencies, no network)
const test = require('node:test');
const assert = require('node:assert');
const { verify, cleanPolicy, snapshotOrder, POLICY_PRESETS } = require('../server.js');

const complaint = "the kettle showed up cracked?? the mugs aren't really my style. money back for everything";
const items = [{ sku: 'KETTLE', name: 'Glass kettle', qty: 1, cents: 2500 }, { sku: 'MUGS', name: 'Mugs', qty: 1, cents: 4000 }, { sku: 'TEA', name: 'Tea', qty: 1, cents: 1500 }];
const strict = cleanPolicy(POLICY_PRESETS.strict.rules);     // R1 refund, R2 deny, R3 deny
const generous = cleanPolicy(POLICY_PRESETS.generous.rules); // R1 refund, R2 deny, R3 refund
const v = (sku, eligible, rule, quote) => ({ sku, eligible, rule, complaint_quote: quote, why: '' });
const rest = [v('MUGS', false, 'R3', "the mugs aren't really my style"), v('TEA', false, 'R2', '')];

test('refunds only the items backed by a verbatim quote and a granting rule', () => {
  const d = verify({ items: [v('KETTLE', true, 'R1', 'the kettle showed up cracked'), ...rest] }, complaint, strict, items);
  assert.equal(d.needsHuman, false);
  assert.equal(d.refund, '25.00');
  assert.equal(d.blanket, '80.00');
});

test('the same verdict pays more only when the policy itself grants more', () => {
  const raw = { items: [v('KETTLE', true, 'R1', 'the kettle showed up cracked'), v('MUGS', true, 'R3', "the mugs aren't really my style"), v('TEA', false, 'R2', '')] };
  assert.equal(verify(raw, complaint, generous, items).refund, '65.00');
  const s = verify(raw, complaint, strict, items); // under the strict policy R3 denies refunds
  assert.equal(s.needsHuman, true);
  assert.equal(s.refundCents, 0);
});

test('a made-up quote blocks the refund and escalates to a human', () => {
  const d = verify({ items: [v('KETTLE', true, 'R1', 'the kettle exploded'), ...rest] }, complaint, strict, items);
  assert.equal(d.needsHuman, true);
  assert.equal(d.refundCents, 0);
});

test('case or whitespace rewritten by the model is not a verbatim quote', () => {
  for (const quote of ['The kettle showed up cracked', 'the kettle  showed up cracked']) {
    const d = verify({ items: [v('KETTLE', true, 'R1', quote), ...rest] }, complaint, strict, items);
    assert.equal(d.needsHuman, true);
    assert.equal(d.refundCents, 0);
  }
});

test('malformed booleans and duplicate item verdicts require human review', () => {
  const kettle = v('KETTLE', true, 'R1', 'the kettle showed up cracked');
  for (const raw of [
    { items: [{ ...kettle, eligible: 'true' }, ...rest] },
    { items: [kettle, ...rest], needs_human: 'true' },
    { items: [kettle, { ...kettle, eligible: false }, ...rest] },
  ]) {
    assert.equal(verify(raw, complaint, strict, items).refundCents, 0);
    assert.equal(verify(raw, complaint, strict, items).needsHuman, true);
  }
});

test('an invented or inherited rule name blocks the refund', () => {
  for (const rule of ['R9', 'toString', 'constructor', '__proto__']) {
    const d = verify({ items: [v('KETTLE', true, rule, 'the kettle showed up cracked'), ...rest] }, complaint, strict, items);
    assert.equal(d.refundCents, 0, rule);
    assert.equal(d.needsHuman, true, rule);
  }
});

test('the model cannot set the amount or add items', () => {
  const d = verify({ refund: '80.00', items: [v('KETTLE', true, 'R1', 'the kettle showed up cracked'), v('YACHT', true, 'R1', 'the kettle showed up cracked'), ...rest] }, complaint, strict, items);
  assert.equal(d.refund, '25.00');
  assert.equal(d.items.length, 3);
});

test('a missing verdict, needs_human=true or garbage output moves no money', () => {
  assert.equal(verify({ items: [v('KETTLE', true, 'R1', 'the kettle showed up cracked')] }, complaint, strict, items).refundCents, 0);
  assert.equal(verify({ needs_human: true, items: [v('KETTLE', true, 'R1', 'the kettle showed up cracked'), ...rest] }, complaint, strict, items).refundCents, 0);
  assert.equal(verify(null, complaint, strict, items).refundCents, 0);
  assert.equal(verify({ items: 'nope' }, complaint, strict, items).refundCents, 0);
});

test('policy input is validated', () => {
  assert.throws(() => cleanPolicy([]));
  assert.throws(() => cleanPolicy([{ effect: 'maybe', text: 'Refund everything always, no questions.' }]));
  assert.throws(() => cleanPolicy([{ effect: 'refund', text: 'short' }]));
  assert.equal(cleanPolicy([{ effect: 'refund', text: 'Refund damaged items in full.' }])[0].id, 'R1');
});

test('a PayPal order is only adjudicated if its lines add up to the captured amount', () => {
  const order = (cap) => ({ id: 'O1', purchase_units: [{ items: [{ sku: 'A', name: 'A', quantity: '2', unit_amount: { currency_code: 'USD', value: '10.00' } }],
    payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: cap } }] } }] });
  assert.equal(snapshotOrder(order('20.00')).totalCents, 2000);
  assert.equal(snapshotOrder(order('25.00')), null);
  assert.equal(snapshotOrder({ id: 'O2', purchase_units: [{}] }), null);
});
