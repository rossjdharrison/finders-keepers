// How the engine sees the world beyond one record: cross-record data (for
// ref/rollup) and the schema (for typechecking). COLLECTION-AWARE — it speaks in
// VRefs ({collection,id}), so a rollup over `features` and a ref into `initiatives`
// resolve against the right collection. PURE from the evaluator's view: it only
// reads and returns blank/error values, never throws. The server backs it with
// SQLite; tests back it with plain maps.

import type { Value, ValueType, VRef } from '@core/values';

/** A `via` names a parent -> child ref-field relation (the many-to-one case). */
export interface RelationMeta {
  parentColl: string; // e.g. 'features'
  childColl: string; // e.g. 'tasks'
  childField: string; // the ref column on the child, e.g. 'feature'
}

export interface Resolver {
  /** Child rows reachable from `from` via a to-many relation. */
  related(from: VRef, via: string): VRef[];
  /** Read a column of the record `ref` points at. Blank if absent. */
  cell(ref: VRef, column: string): Value;
  /** Schema lookup: the declared/result type of a column in a collection (typecheck). */
  columnType(collection: string, column: string): ValueType | undefined;
}

/** The injected clock keeps today()/now() deterministic (and testable). */
export interface Clock {
  today: number; // epoch day
  nowMs: number; // UTC ms
}

// A trivial resolver — used where no relations are traversed (single-record eval).
export function emptyResolver(): Resolver {
  return {
    related: () => [],
    cell: () => ({ t: 'blank' }),
    columnType: () => undefined,
  };
}
