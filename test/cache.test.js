const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheKey, decide, cleanPolicy, CARTS, POLICY_PRESETS } = require('../server.js');

test('case, whitespace, policy text and delivery age cannot alias a cached quotation', () => {
  const policy = cleanPolicy(POLICY_PRESETS.strict.rules);
  const items = [{ sku: 'KETTLE', name: 'Glass kettle' }];
  const key = cacheKey('the kettle arrived cracked', policy, items, 3);
  assert.notEqual(key, cacheKey('The kettle arrived cracked', policy, items, 3));
  assert.notEqual(key, cacheKey('the kettle  arrived cracked', policy, items, 3));
  assert.notEqual(key, cacheKey('the kettle arrived cracked', policy, items, 30));
  assert.notEqual(key, cacheKey('the kettle arrived cracked', [{ ...policy[0], text: policy[0].text + ' Please ask first.' }, ...policy.slice(1)], items, 3));
});

test('all six shipped answers migrate and remain available without a model request', async () => {
  const expected = { strict: ['25.00', '30.00', '0.00'], generous: ['65.00', '30.00', '0.00'] };
  for (const [name, preset] of Object.entries(POLICY_PRESETS)) for (const [index, cart] of CARTS.entries()) {
    const row = { deliveredDaysAgo: cart.deliveredDaysAgo,
      order: { items: cart.items.map(([sku, name, price]) => ({ sku, name, cents: Math.round(Number(price) * 100), qty: 1 })) } };
    const result = await decide(row, cart.complaint, cleanPolicy(preset.rules));
    assert.equal(result.ai.source, 'saved', name + ' ' + cart.id);
    assert.equal(result.refund, expected[name][index]);
    assert.equal(result.needsHuman, cart.id === 'T3');
  }
});
