// How the engine sees the world beyond one record: cross-record data (for
// ref/rollup) and the schema (for typechecking ref/rollup paths). PURE from the
// evaluator's view — it only reads, and returns blank/error values, never throws.
// The server backs this with the SQLite/D1 projection; the client with its cache.

import type { Value, ValueType } from '@core/values';

export interface Resolver {
  /** Follow one relation hop from a record, yielding the related record ids. */
  related(recordId: string, via: string): string[];
  /** Read a column value of a (possibly related) record. Blank if absent. */
  cell(recordId: string, column: string): Value;
  /** Schema lookup: the declared type of a column in a collection (for typecheck). */
  columnType(collection: string, column: string): ValueType | undefined;
}

/** The injected clock keeps today()/now() deterministic (and testable). */
export interface Clock {
  today: number; // epoch day
  nowMs: number; // UTC ms
}

// A trivial in-memory resolver — used by tests and by a single-record eval where
// no relations are traversed.
export function emptyResolver(): Resolver {
  return {
    related: () => [],
    cell: () => ({ t: 'blank' }),
    columnType: () => undefined,
  };
}
