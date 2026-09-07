// The typechecker — the headline differentiator over Notion/Airtable. It runs at
// column SAVE time and infers a column's result ValueType, or returns a compile
// error the builder sees inline (money EUR + money USD is #CCY BEFORE any row runs,
// not a per-row runtime surprise). Currency, enum-set and element type are carried
// in the type, so mismatches are static.

import type { ErrCode, ValueType } from '@core/values';
import { typeEq, typeOf } from '@core/values';
import type { Bin, Node, TableDef } from './ast.ts';
import { isBin } from './ast.ts';
import type { RelationMeta, Resolver } from './resolver.ts';

export interface TypeCtx {
  columns: Record<string, ValueType>; // this collection's property types
  resolver?: Resolver; // for ref/rollup path checking (columnType over other collections)
  relations?: Record<string, RelationMeta>; // via -> {parentColl, childColl, childField}
  tables?: Record<string, TableDef>; // this collection's lookup tables (for the lookup op)
}

// Kinds usable as a lookup key (a choice / scalar), so a bad key type is static.
const KEYABLE = new Set(['enum', 'text', 'num', 'bool']);
export interface InferFail {
  err: ErrCode;
  msg: string;
}
export type Infer = ValueType | InferFail;

export const isFail = (x: Infer): x is InferFail => (x as InferFail).err !== undefined;
const fail = (err: ErrCode, msg: string): InferFail => ({ err, msg });

const numT: ValueType = { k: 'num' };
const boolT: ValueType = { k: 'bool' };

// Order-comparable kinds for lt/lte/gt/gte.
const ORDERED = new Set(['num', 'money', 'pct', 'date', 'datetime', 'text', 'bool']);

/** Unify two branch types (if/coalesce), letting blank/error yield to the concrete side. */
function unify(a: ValueType, b: ValueType): Infer {
  if (a.k === 'error' || a.k === 'blank') return b;
  if (b.k === 'error' || b.k === 'blank') return a;
  if (typeEq(a, b)) return a;
  return fail('#TYPE', `branches disagree: ${a.k} vs ${b.k}`);
}

function inferBin(op: Bin, a: ValueType, b: ValueType): Infer {
  const money = (ccy?: string): ValueType => ({ k: 'money', ccy });
  const sameCcy = (): boolean =>
    !(a.k === 'money' && b.k === 'money') || a.ccy === undefined || b.ccy === undefined || a.ccy === b.ccy;

  switch (op) {
    case 'add':
      if (a.k === 'money' && b.k === 'money') return sameCcy() ? money(a.ccy ?? b.ccy) : fail('#CCY', 'money+money');
      if (a.k === 'date' && b.k === 'dur') return { k: 'date' };
      if (a.k === 'datetime' && b.k === 'dur') return { k: 'datetime' };
      if (a.k === 'num' && b.k === 'num') return numT;
      if (a.k === 'pct' && b.k === 'pct') return { k: 'pct' };
      if (a.k === 'dur' && b.k === 'dur') return { k: 'dur' };
      if (a.k === 'text' && b.k === 'text') return { k: 'text' };
      return fail('#TYPE', `add(${a.k},${b.k})`);
    case 'sub':
      if (a.k === 'date' && b.k === 'date') return { k: 'dur' };
      if (a.k === 'datetime' && b.k === 'datetime') return { k: 'dur' };
      if (a.k === 'date' && b.k === 'dur') return { k: 'date' };
      if (a.k === 'datetime' && b.k === 'dur') return { k: 'datetime' };
      if (a.k === 'money' && b.k === 'money') return sameCcy() ? money(a.ccy ?? b.ccy) : fail('#CCY', 'money-money');
      if (a.k === 'num' && b.k === 'num') return numT;
      if (a.k === 'pct' && b.k === 'pct') return { k: 'pct' };
      if (a.k === 'dur' && b.k === 'dur') return { k: 'dur' };
      return fail('#TYPE', `sub(${a.k},${b.k})`);
    case 'mul':
      if (a.k === 'money' && b.k === 'num') return money(a.ccy);
      if (a.k === 'num' && b.k === 'money') return money(b.ccy);
      if (a.k === 'money' && b.k === 'pct') return money(a.ccy);
      if (a.k === 'pct' && b.k === 'money') return money(b.ccy);
      if (a.k === 'num' && b.k === 'num') return numT;
      if (a.k === 'pct' && b.k === 'num') return { k: 'pct' };
      if (a.k === 'num' && b.k === 'pct') return { k: 'pct' };
      return fail('#TYPE', `mul(${a.k},${b.k})`);
    case 'div':
      if (a.k === 'money' && b.k === 'money') return sameCcy() ? numT : fail('#CCY', 'money/money');
      if (a.k === 'money' && b.k === 'num') return money(a.ccy);
      if (a.k === 'num' && b.k === 'num') return numT;
      if (a.k === 'pct' && b.k === 'num') return { k: 'pct' };
      return fail('#TYPE', `div(${a.k},${b.k})`);
    case 'eq':
    case 'ne':
      return boolT; // equality is defined for any operands (runtime decides)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      if (a.k === 'money' && b.k === 'money' && !sameCcy()) return fail('#CCY', 'compare money');
      if (a.k === b.k && ORDERED.has(a.k)) return boolT;
      return fail('#TYPE', `${op}(${a.k},${b.k}) not orderable`);
    case 'and':
    case 'or':
      if (a.k === 'bool' && b.k === 'bool') return boolT;
      return fail('#TYPE', `${op} needs bool,bool`);
  }
}

function inferCall(fn: string, args: ValueType[]): Infer {
  const need = (i: number, k: ValueType['k']): boolean => args[i] !== undefined && args[i].k === k;
  switch (fn) {
    case 'round':
    case 'floor':
    case 'ceil':
    case 'abs':
      return need(0, 'num') ? numT : fail('#TYPE', `${fn}(num)`);
    case 'min':
    case 'max':
      if (args.length && args.every((a) => a.k === 'num')) return numT;
      if (args.length && args.every((a) => a.k === 'money')) return args[0];
      return fail('#TYPE', `${fn}(...)`);
    case 'clamp':
      return args.length === 3 && args.every((a) => a.k === 'num') ? numT : fail('#TYPE', 'clamp(num,num,num)');
    case 'coalesce': {
      if (!args.length) return fail('#NA', 'coalesce needs args');
      let acc: ValueType = args[0];
      for (let i = 1; i < args.length; i++) {
        const u = unify(acc, args[i]);
        if (isFail(u)) return u;
        acc = u;
      }
      return acc;
    }
    case 'today':
      return { k: 'date' };
    case 'now':
      return { k: 'datetime' };
    case 'dateAdd':
      return need(0, 'date') && need(1, 'dur') ? { k: 'date' } : fail('#TYPE', 'dateAdd(date,dur)');
    case 'dateDiff':
      return need(0, 'date') && need(1, 'date') ? numT : fail('#TYPE', 'dateDiff(date,date)');
    case 'len':
      return need(0, 'text') ? numT : fail('#TYPE', 'len(text)');
    case 'lower':
    case 'upper':
      return need(0, 'text') ? { k: 'text' } : fail('#TYPE', `${fn}(text)`);
    case 'contains':
      return need(0, 'text') && need(1, 'text') ? boolT : fail('#TYPE', 'contains(text,text)');
    case 'has':
      return need(0, 'enumset') && need(1, 'enum') ? boolT : fail('#TYPE', 'has(enumset,enum)');
    default:
      return fail('#NA', `unknown fn ${fn}`);
  }
}

export function inferType(node: Node, ctx: TypeCtx): Infer {
  switch (node.op) {
    case 'lit':
      return typeOf(node.value);
    case 'field': {
      const t = ctx.columns[node.id];
      return t ?? fail('#REF', `unknown field ${node.id}`);
    }
    case 'ref': {
      // walk the path across collections using the resolver's schema view
      if (!ctx.resolver) return fail('#REF', 'no resolver for ref');
      // path[0] is a reference column on THIS record; each hop must be a ref
      let t = ctx.columns[node.path[0]];
      if (!t) return fail('#REF', `unknown field ${node.path[0]}`);
      for (let i = 1; i < node.path.length; i++) {
        if (t.k !== 'ref') return fail('#REF', `${node.path[i - 1]} is not a reference`);
        const next = ctx.resolver.columnType(t.collection, node.path[i]);
        if (!next) return fail('#REF', `unknown ${t.collection}.${node.path[i]}`);
        t = next;
      }
      return t;
    }
    case 'rollup': {
      // The rolled-up field lives on the CHILD collection, not this (parent) one —
      // resolve its type through the relation registry + the child's schema.
      if (node.of.op !== 'field') return fail('#NA', 'rollup supports a field target');
      const childColl = ctx.relations?.[node.via]?.childColl;
      if (!childColl) return fail('#REF', `unknown relation ${node.via}`);
      if (!ctx.resolver) return fail('#REF', 'no resolver for rollup');
      const inner = ctx.resolver.columnType(childColl, node.of.id);
      if (!inner) return fail('#REF', `unknown ${childColl}.${node.of.id}`);
      if (node.agg === 'count') return numT;
      if (node.agg === 'avg') return inner.k === 'money' ? inner : numT;
      return inner; // sum/min/max keep the child element type
    }
    case 'lookup': {
      const tbl = ctx.tables?.[node.table];
      if (!tbl) return fail('#REF', `unknown table ${node.table}`);
      const k = inferType(node.key, ctx);
      if (isFail(k)) return k;
      if (!KEYABLE.has(k.k)) return fail('#TYPE', `lookup key must be a choice/scalar, got ${k.k}`);
      if (tbl.kind === '2d') {
        if (!node.key2) return fail('#NA', `2d table ${node.table} needs a second key`);
        const k2 = inferType(node.key2, ctx);
        if (isFail(k2)) return k2;
        if (!KEYABLE.has(k2.k)) return fail('#TYPE', `lookup key2 must be a choice/scalar, got ${k2.k}`);
      }
      return tbl.of; // the declared cell type — lookups are statically typed
    }
    case 'signal':
      return numT; // observables are numeric measurements
    case 'build': {
      const cmp = inferType(node.cmp, ctx);
      if (isFail(cmp)) return cmp;
      if (cmp.k !== 'enum' && cmp.k !== 'text') return fail('#TYPE', 'build: comparator must be a choice');
      const obs = inferType(node.observable, ctx);
      if (isFail(obs)) return obs;
      if (obs.k !== 'enum' && obs.k !== 'text') return fail('#TYPE', 'build: observable must be a choice');
      const thr = inferType(node.threshold, ctx);
      if (isFail(thr)) return thr;
      if (thr.k !== 'num' && thr.k !== 'blank') return fail('#TYPE', 'build: threshold must be a number');
      return { k: 'predicate' };
    }
    case 'check': {
      const pred = inferType(node.pred, ctx);
      if (isFail(pred)) return pred;
      if (pred.k !== 'predicate' && pred.k !== 'blank') return fail('#TYPE', 'check: first arg must be a predicate');
      const ev = inferType(node.evidence, ctx);
      if (isFail(ev)) return ev;
      return boolT;
    }
    case 'not': {
      const a = inferType(node.args[0], ctx);
      if (isFail(a)) return a;
      return a.k === 'bool' ? boolT : fail('#TYPE', 'not(bool)');
    }
    case 'neg': {
      const a = inferType(node.args[0], ctx);
      if (isFail(a)) return a;
      return a.k === 'num' || a.k === 'money' || a.k === 'pct' ? a : fail('#TYPE', 'neg');
    }
    case 'call': {
      if (node.fn === 'if') {
        const c = inferType(node.args[0], ctx);
        if (isFail(c)) return c;
        const x = inferType(node.args[1], ctx);
        if (isFail(x)) return x;
        const y = inferType(node.args[2], ctx);
        if (isFail(y)) return y;
        if (c.k !== 'bool') return fail('#TYPE', 'if() needs a bool condition');
        return unify(x, y);
      }
      const parts: ValueType[] = [];
      for (const a of node.args) {
        const p = inferType(a, ctx);
        if (isFail(p)) return p;
        parts.push(p);
      }
      return inferCall(node.fn, parts);
    }
    default: {
      if (isBin(node.op)) {
        const a = inferType(node.args[0], ctx);
        if (isFail(a)) return a;
        const b = inferType(node.args[1], ctx);
        if (isFail(b)) return b;
        return inferBin(node.op, a, b);
      }
      return fail('#TYPE', `unknown op ${(node as { op: string }).op}`);
    }
  }
}
