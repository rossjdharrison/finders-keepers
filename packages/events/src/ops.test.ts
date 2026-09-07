import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, text, enumSet, equals } from '@core/values';
import type { Committed, RowOp } from './ops.ts';
import { applyOp, fold, invert } from './ops.ts';

let seq = 0;
const commit = (op: RowOp): Committed => ({ ...op, meta: { seq: ++seq, at: '', actor: 'u1' } });

test('insert then setField folds to current state', () => {
  const s = fold([
    commit({ op: 'insert', coll: 'deals', row: 'd1', values: { name: text('Acme'), qty: num(1) } }),
    commit({ op: 'setField', coll: 'deals', row: 'd1', field: 'qty', value: num(5) }),
  ]);
  assert.ok(s && !s.deleted);
  assert.ok(s && equals(s.values.qty, num(5)));
  assert.ok(s && equals(s.values.name, text('Acme')));
});

test('last-writer-by-seq: later setField wins because it applies later', () => {
  const s = fold([
    commit({ op: 'setField', coll: 'd', row: 'r', field: 'x', value: num(1) }),
    commit({ op: 'setField', coll: 'd', row: 'r', field: 'x', value: num(2) }),
  ]);
  assert.ok(s && equals(s.values.x, num(2)));
  assert.equal(s?.updatedSeq, seq);
});

test('addElement is commutative — concurrent tag adds both survive', () => {
  const a = fold([
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 'tags', set: 'tags', elem: 'x' }),
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 'tags', set: 'tags', elem: 'y' }),
  ]);
  assert.ok(a && equals(a.values.tags, enumSet('tags', ['x', 'y'])));
  // opposite order yields the same set
  seq = 0;
  const b = fold([
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 'tags', set: 'tags', elem: 'y' }),
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 'tags', set: 'tags', elem: 'x' }),
  ]);
  assert.ok(b && equals(b.values.tags, enumSet('tags', ['y', 'x'])));
});

test('removeElement drops just its element; delete/restore toggles the tombstone', () => {
  const s1 = fold([
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 't', set: 't', elem: 'a' }),
    commit({ op: 'addElement', coll: 'd', row: 'r', field: 't', set: 't', elem: 'b' }),
    commit({ op: 'removeElement', coll: 'd', row: 'r', field: 't', elem: 'a' }),
  ]);
  assert.ok(s1 && equals(s1.values.t, enumSet('t', ['b'])));
  const del = applyOp(s1, commit({ op: 'delete', coll: 'd', row: 'r' }));
  assert.equal(del.deleted, true);
  const back = applyOp(del, commit({ op: 'restore', coll: 'd', row: 'r' }));
  assert.equal(back.deleted, false);
});

test('invert(setField) restores the previous value (undo)', () => {
  const before = applyOp(null, commit({ op: 'setField', coll: 'd', row: 'r', field: 'x', value: num(1) }));
  const change: RowOp = { op: 'setField', coll: 'd', row: 'r', field: 'x', value: num(9) };
  const after = applyOp(before, commit(change));
  assert.ok(equals(after.values.x, num(9)));

  const undo = invert(before, change);
  assert.ok(undo);
  const restored = applyOp(after, commit(undo!));
  assert.ok(equals(restored.values.x, num(1)));
});

test('invert(setField) of a brand-new field is a clearField', () => {
  const change: RowOp = { op: 'setField', coll: 'd', row: 'r', field: 'x', value: num(1) };
  const undo = invert(null, change);
  assert.deepEqual(undo, { op: 'clearField', coll: 'd', row: 'r', field: 'x' });
});
