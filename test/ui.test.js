const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('browser code compiles and only completed refunds receive a Refunded queue label', () => {
  new vm.Script(script);
  const context = vm.createContext({});
  // Load declarations without starting the browser's network/bootstrap routine.
  vm.runInContext(script.slice(0, script.lastIndexOf('(async function init()')), context);
  for (const status of ['PENDING', 'FAILED', 'CANCELLED']) {
    const label = vm.runInContext('statusOf(' + JSON.stringify({ refund: { status, amount: '25.00' } }) + ')[1]', context);
    assert.ok(!label.startsWith('Refunded'), status + ' is not a completed refund');
  }
  assert.equal(vm.runInContext('statusOf({refund:{status:"COMPLETED",amount:"25.00"}})[1]', context), 'Refunded $25.00');
});
