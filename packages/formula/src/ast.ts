// @core/formula — the formula AST. JSON, a direct generalisation of the PoC's
// {op,args}. Leaves are typed literals (a literal carries a full Value), so
// there are no per-type constructor ops to keep in sync.

import type { Value, ValueType } from '@core/values';

export type Bin =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'and'
  | 'or';

export type Agg = 'sum' | 'count' | 'avg' | 'min' | 'max';

export type FnName =
  | 'round'
  | 'floor'
  | 'ceil'
  | 'abs'
  | 'min'
  | 'max'
  | 'clamp'
  | 'coalesce'
  | 'if'
  | 'today'
  | 'now'
  | 'dateAdd'
  | 'dateDiff'
  | 'len'
  | 'lower'
  | 'upper'
  | 'contains'
  | 'has';

export type Node =
  | { op: 'lit'; value: Value }
  | { op: 'field'; id: string } // a column of THIS record
  | { op: 'ref'; path: string[] } // relation traversal, e.g. ['account','name']
  | { op: 'rollup'; via: string; agg: Agg; of: Node } // aggregate over a to-many relation
  | { op: 'lookup'; table: string; key: Node; key2?: Node } // table lookup: a choice -> a consequence
  | { op: 'not' | 'neg'; args: [Node] }
  | { op: Bin; args: [Node, Node] }
  | { op: 'call'; fn: FnName; args: Node[] };

// A lookup table maps option ids (choices) to consequence values — the data behind
// a configurator (option.effort = lookup(sizing, size)). Values are full Values so
// the same table travels the wire, the store, and the evaluator unchanged. `of` is
// the declared cell type (what a lookup returns), so lookups typecheck statically.
export interface Table1d {
  kind: '1d';
  of: ValueType;
  map: Record<string, Value>;
  default?: Value;
}
export interface Table2d {
  kind: '2d';
  of: ValueType;
  cells: Record<string, Record<string, Value>>;
  default?: Value;
}
export type TableDef = Table1d | Table2d;

const BINS = new Set<string>([
  'add',
  'sub',
  'mul',
  'div',
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'and',
  'or',
]);
export const isBin = (op: string): op is Bin => BINS.has(op);
