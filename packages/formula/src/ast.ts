// @core/formula — the formula AST. JSON, a direct generalisation of the PoC's
// {op,args}. Leaves are typed literals (a literal carries a full Value), so
// there are no per-type constructor ops to keep in sync.

import type { Value } from '@core/values';

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
  | { op: 'not' | 'neg'; args: [Node] }
  | { op: Bin; args: [Node, Node] }
  | { op: 'call'; fn: FnName; args: Node[] };

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
