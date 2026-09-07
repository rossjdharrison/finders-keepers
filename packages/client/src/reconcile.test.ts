import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, moneyDec } from '@core/values';
import { mergeRows } from './reconcile.ts';
import type { RowStateWire } from './types.ts';

const row = (id: string, doc: RowStateWire['doc'], deleted = false): RowStateWire => ({ coll: 'x', id, doc, deleted, seq: 1 });

test('a touched-rows broadcast merges by id and leaves untouched rows intact', () => {
  const cur = new Map([
    ['a', row('a', { qty: num(1) })],
    ['b', row('b', { qty: num(2) })],
  ]);
  // server broadcasts ONLY b (with a recomputed column)
  const next = mergeRows(cur, [row('b', { qty: num(9), lineTotal: moneyDec(90, 'EUR') })]);
  assert.deepEqual(next.get('a')?.doc.qty, num(1)); // untouched survives
  assert.deepEqual(next.get('b')?.doc.qty, num(9)); // replaced by id
  assert.deepEqual(next.get('b')?.doc.lineTotal, moneyDec(90, 'EUR')); // computed column carried in
});

test('a deleted row is removed from the map', () => {
  const cur = new Map([['a', row('a', { qty: num(1) })]]);
  const next = mergeRows(cur, [row('a', {}, true)]);
  assert.equal(next.has('a'), false);
});

test('merge does not mutate the input map (new reference)', () => {
  const cur = new Map([['a', row('a', { qty: num(1) })]]);
  const next = mergeRows(cur, [row('a', { qty: num(2) })]);
  assert.notEqual(next, cur);
  assert.deepEqual(cur.get('a')?.doc.qty, num(1)); // original unchanged
});
