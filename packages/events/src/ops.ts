// @core/events — the row change model. Ordinary rows are CRUD-with-history, NOT
// event-sourced: current state is authoritative in the store, and a bounded op
// log gives audit + undo. (Full event-sourced process INSTANCES are a v2 concern.)
//
// The merge policy falls out of the substrate for free: a Durable Object is
// single-threaded, so it assigns every op a monotonic `seq` and applies them in
// that order. Applying in seq order IS last-writer-by-seq for scalar fields;
// addElement/removeElement are commutative, so concurrent multi-value edits both
// survive. There is no separate conflict-resolution code — just this reducer.

import type { Value } from '@core/values';

export type Seq = number;

export interface OpMeta {
  seq: Seq; // DO-assigned total order — never a client clock
  at: string; // ISO timestamp (informational)
  actor: string; // user id
}

// A submitted op (no seq yet) — the client sends these optimistically.
export type RowOp =
  | { op: 'insert'; coll: string; row: string; values: Record<string, Value> }
  | { op: 'setField'; coll: string; row: string; field: string; value: Value }
  | { op: 'clearField'; coll: string; row: string; field: string }
  | { op: 'addElement'; coll: string; row: string; field: string; set: string; elem: string }
  | { op: 'removeElement'; coll: string; row: string; field: string; elem: string }
  | { op: 'delete'; coll: string; row: string }
  | { op: 'restore'; coll: string; row: string };

// An op the DO has ordered and stamped.
export type Committed = RowOp & { meta: OpMeta };

export interface RowState {
  id: string;
  values: Record<string, Value>;
  deleted: boolean;
  updatedSeq: Seq;
}

const emptyRow = (id: string): RowState => ({ id, values: {}, deleted: false, updatedSeq: 0 });

/** Fold one ordered op onto a row's prior state. Pure and total. */
export function applyOp(before: RowState | null, op: Committed): RowState {
  const base = before ?? emptyRow(op.row);
  const values: Record<string, Value> = { ...base.values };
  let deleted = base.deleted;

  switch (op.op) {
    case 'insert':
      for (const [k, v] of Object.entries(op.values)) values[k] = v;
      deleted = false;
      break;
    case 'setField':
      values[op.field] = op.value;
      break;
    case 'clearField':
      delete values[op.field];
      break;
    case 'addElement': {
      const cur = values[op.field];
      const items = cur && cur.t === 'enumset' && cur.set === op.set ? cur.v.slice() : [];
      if (!items.includes(op.elem)) items.push(op.elem);
      values[op.field] = { t: 'enumset', set: op.set, v: items };
      break;
    }
    case 'removeElement': {
      const cur = values[op.field];
      if (cur && cur.t === 'enumset') {
        values[op.field] = { t: 'enumset', set: cur.set, v: cur.v.filter((x) => x !== op.elem) };
      }
      break;
    }
    case 'delete':
      deleted = true;
      break;
    case 'restore':
      deleted = false;
      break;
  }
  return { id: op.row, values, deleted, updatedSeq: op.meta.seq };
}

/** Replay an ordered op log into current state (null if the row never existed / was hard-gone). */
export function fold(ops: Committed[]): RowState | null {
  let state: RowState | null = null;
  for (const op of ops) state = applyOp(state, op);
  return state;
}

/**
 * The compensating op that undoes `op`, given the row state BEFORE it applied.
 * Returns null when there is nothing to undo. Powers the bounded change-log undo.
 */
export function invert(before: RowState | null, op: RowOp): RowOp | null {
  switch (op.op) {
    case 'insert':
      return before ? null : { op: 'delete', coll: op.coll, row: op.row };
    case 'setField': {
      const prev = before?.values[op.field];
      return prev === undefined
        ? { op: 'clearField', coll: op.coll, row: op.row, field: op.field }
        : { op: 'setField', coll: op.coll, row: op.row, field: op.field, value: prev };
    }
    case 'clearField': {
      const prev = before?.values[op.field];
      return prev === undefined
        ? null
        : { op: 'setField', coll: op.coll, row: op.row, field: op.field, value: prev };
    }
    case 'addElement': {
      const cur = before?.values[op.field];
      const had = cur && cur.t === 'enumset' && cur.v.includes(op.elem);
      return had ? null : { op: 'removeElement', coll: op.coll, row: op.row, field: op.field, elem: op.elem };
    }
    case 'removeElement': {
      const cur = before?.values[op.field];
      const had = cur && cur.t === 'enumset' && cur.v.includes(op.elem);
      return had
        ? { op: 'addElement', coll: op.coll, row: op.row, field: op.field, set: cur.set, elem: op.elem }
        : null;
    }
    case 'delete':
      return before && !before.deleted ? { op: 'restore', coll: op.coll, row: op.row } : null;
    case 'restore':
      return before && before.deleted ? { op: 'delete', coll: op.coll, row: op.row } : null;
  }
}
