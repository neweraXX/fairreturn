// Guardrail tests: what the model says must survive these checks before any money moves.
// Run: node --test   (no dependencies, no network)
const test = require('node:test');
const assert = require('node:assert');
const { verify } = require('../server.js');

const complaint = "the kettle showed up cracked?? the mugs aren't really my style. money back for everything";
const item = (sku, eligible, rule, quote) => ({ sku, eligible, rule, complaint_quote: quote, why: '' });

test('refunds only the items backed by a verbatim quote and a real rule', () => {
  const d = verify({ items: [item('KETTLE', true, 'R1', 'the kettle showed up cracked'), item('MUGS', false, 'R3', "the mugs aren't really my style"), item('TEA', false, 'R2', '')] }, complaint);
  assert.equal(d.needsHuman, false);
  assert.equal(d.refund, '25.00');
  assert.equal(d.blanket, '80.00');
});

test('a made-up quote blocks the refund and escalates to a human', () => {
  const d = verify({ items: [item('KETTLE', true, 'R1', 'the kettle exploded'), item('MUGS', false, 'R3', ''), item('TEA', false, 'R2', '')] }, complaint);
  assert.equal(d.needsHuman, true);
  assert.equal(d.refundCents, 0);
});

test('an invented policy rule blocks the refund', () => {
  const d = verify({ items: [item('KETTLE', true, 'R9', 'the kettle showed up cracked'), item('MUGS', false, 'R3', ''), item('TEA', false, 'R2', '')] }, complaint);
  assert.equal(d.needsHuman, true);
  assert.equal(d.refundCents, 0);
});

test('the model cannot set the amount or add items', () => {
  const d = verify({ refund: '80.00', items: [item('KETTLE', true, 'R1', 'the kettle showed up cracked'), item('YACHT', true, 'R1', 'the kettle showed up cracked'), item('MUGS', false, 'R3', ''), item('TEA', false, 'R2', '')] }, complaint);
  assert.equal(d.refund, '25.00');
  assert.equal(d.items.length, 3);
});

test('a missing verdict or needs_human=true moves no money', () => {
  assert.equal(verify({ items: [item('KETTLE', true, 'R1', 'the kettle showed up cracked')] }, complaint).refundCents, 0);
  assert.equal(verify({ needs_human: true, items: [item('KETTLE', true, 'R1', 'the kettle showed up cracked'), item('MUGS', false, 'R3', ''), item('TEA', false, 'R2', '')] }, complaint).refundCents, 0);
});
