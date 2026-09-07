import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoOrCycle } from './graph.ts';

test('orders columns so dependencies come first', () => {
  const r = topoOrCycle([
    { id: 'c', deps: ['b'] },
    { id: 'b', deps: ['a'] },
    { id: 'a', deps: [] },
  ]);
  assert.ok('order' in r);
  if ('order' in r) {
    assert.ok(r.order.indexOf('a') < r.order.indexOf('b'));
    assert.ok(r.order.indexOf('b') < r.order.indexOf('c'));
  }
});

test('ignores dependencies on stored (non-computed) inputs', () => {
  // `qty` and `unitPrice` are stored inputs, not in the column set — no edges, no cycle
  const r = topoOrCycle([{ id: 'lineTotal', deps: ['qty', 'unitPrice'] }]);
  assert.deepEqual(r, { order: ['lineTotal'] });
});

test('detects a cycle and names the loop members with #CYCLE intent', () => {
  const r = topoOrCycle([
    { id: 'a', deps: ['b'] },
    { id: 'b', deps: ['a'] },
  ]);
  assert.ok('cycle' in r);
  if ('cycle' in r) assert.deepEqual(new Set(r.cycle), new Set(['a', 'b']));
});
