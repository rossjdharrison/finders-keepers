// The pure, total evaluator — the oracle. Same (cols, env, resolver, clock) =>
// same result, forever; no throws, no I/O. Errors and blanks are values that
// propagate. The server and client share this exact function; the test suite
// pins it. This is the runtime companion to the compile-time typechecker.

import type { Value } from '@core/values';
import {
  BLANK,
  bool,
  date,
  datetime,
  dur,
  err,
  moneyAdd,
  moneyDivMoney,
  moneyDivNumber,
  moneyMulNumber,
  moneyNegate,
  moneySub,
  num,
  text,
  addMonths,
  compare,
  equals,
} from '@core/values';
import type { Node, Bin, FnName } from './ast.ts';
import { isBin } from './ast.ts';
import type { CompiledColumn } from './compile.ts';
import type { Clock, Resolver } from './resolver.ts';
import { emptyResolver } from './resolver.ts';

const MS_PER_DAY = 86_400_000;

export interface EvalCtx {
  resolver: Resolver;
  clock: Clock;
  recordId?: string;
}

const truthy = (v: Value): boolean => v.t === 'bool' && v.v;

// ---- arithmetic -------------------------------------------------------------
function addV(a: Value, b: Value): Value {
  if (a.t === 'num' && b.t === 'num') return num(a.v + b.v);
  if (a.t === 'money' && b.t === 'money') return moneyAdd(a, b);
  if (a.t === 'pct' && b.t === 'pct') return { t: 'pct', v: a.v + b.v };
  if (a.t === 'text' && b.t === 'text') return text(a.v + b.v);
  if (a.t === 'dur' && b.t === 'dur') return dur(a.months + b.months, a.ms + b.ms);
  if (a.t === 'date' && b.t === 'dur')
    return date(addMonths(a.epochDay, b.months) + Math.trunc(b.ms / MS_PER_DAY));
  if (a.t === 'datetime' && b.t === 'dur') {
    const day = Math.floor(a.epochMs / MS_PER_DAY);
    const shifted = (addMonths(day, b.months) - day) * MS_PER_DAY;
    return datetime(a.epochMs + shifted + b.ms);
  }
  return err('#TYPE', `add(${a.t},${b.t})`);
}

function subV(a: Value, b: Value): Value {
  if (a.t === 'num' && b.t === 'num') return num(a.v - b.v);
  if (a.t === 'money' && b.t === 'money') return moneySub(a, b);
  if (a.t === 'pct' && b.t === 'pct') return { t: 'pct', v: a.v - b.v };
  if (a.t === 'dur' && b.t === 'dur') return dur(a.months - b.months, a.ms - b.ms);
  if (a.t === 'date' && b.t === 'date') return dur(0, (a.epochDay - b.epochDay) * MS_PER_DAY);
  if (a.t === 'datetime' && b.t === 'datetime') return dur(0, a.epochMs - b.epochMs);
  if (a.t === 'date' && b.t === 'dur')
    return date(addMonths(a.epochDay, -b.months) - Math.trunc(b.ms / MS_PER_DAY));
  return err('#TYPE', `sub(${a.t},${b.t})`);
}

function mulV(a: Value, b: Value): Value {
  if (a.t === 'money' && b.t === 'num') return moneyMulNumber(a, b.v);
  if (a.t === 'num' && b.t === 'money') return moneyMulNumber(b, a.v);
  if (a.t === 'money' && b.t === 'pct') return moneyMulNumber(a, b.v);
  if (a.t === 'pct' && b.t === 'money') return moneyMulNumber(b, a.v);
  if (a.t === 'num' && b.t === 'num') return num(a.v * b.v);
  if (a.t === 'pct' && b.t === 'num') return { t: 'pct', v: a.v * b.v };
  if (a.t === 'num' && b.t === 'pct') return { t: 'pct', v: a.v * b.v };
  return err('#TYPE', `mul(${a.t},${b.t})`);
}

function divV(a: Value, b: Value): Value {
  if (a.t === 'money' && b.t === 'money') return moneyDivMoney(a, b);
  if (a.t === 'money' && b.t === 'num') return moneyDivNumber(a, b.v);
  if (a.t === 'num' && b.t === 'num') return b.v === 0 ? err('#DIV0') : num(a.v / b.v);
  if (a.t === 'pct' && b.t === 'num') return b.v === 0 ? err('#DIV0') : { t: 'pct', v: a.v / b.v };
  return err('#TYPE', `div(${a.t},${b.t})`);
}

function applyBin(op: Bin, a: Value, b: Value): Value {
  if (a.t === 'error') return a;
  if (b.t === 'error') return b;
  if (op === 'eq') return bool(equals(a, b));
  if (op === 'ne') return bool(!equals(a, b));
  if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    const c = compare(a, b);
    if (typeof c !== 'number') return c; // a VErr (e.g. #CCY, #TYPE)
    return bool(op === 'lt' ? c < 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : c >= 0);
  }
  if (op === 'and') return bool(truthy(a) && truthy(b));
  if (op === 'or') return bool(truthy(a) || truthy(b));
  if (a.t === 'blank' || b.t === 'blank') return BLANK; // blank propagates through arithmetic
  return op === 'add' ? addV(a, b) : op === 'sub' ? subV(a, b) : op === 'mul' ? mulV(a, b) : divV(a, b);
}

function negV(a: Value): Value {
  if (a.t === 'error') return a;
  if (a.t === 'num') return num(-a.v);
  if (a.t === 'pct') return { t: 'pct', v: -a.v };
  if (a.t === 'money') return moneyNegate(a);
  return err('#TYPE', 'neg');
}

// ---- calls ------------------------------------------------------------------
function firstError(args: Value[]): Value | undefined {
  return args.find((a) => a.t === 'error');
}

function applyCall(fn: FnName, args: Value[], ctx: EvalCtx): Value {
  if (fn === 'today') return date(ctx.clock.today);
  if (fn === 'now') return datetime(ctx.clock.nowMs);
  if (fn === 'coalesce') {
    for (const a of args) if (a.t !== 'blank' && a.t !== 'error') return a;
    return BLANK;
  }
  const e = firstError(args);
  if (e) return e;
  if (args.some((a) => a.t === 'blank')) return BLANK;

  switch (fn) {
    case 'round': {
      const [x, d] = args;
      if (x.t !== 'num') return err('#TYPE', 'round');
      const p = d && d.t === 'num' ? 10 ** d.v : 1;
      return num(Math.round(x.v * p) / p);
    }
    case 'floor':
      return args[0].t === 'num' ? num(Math.floor(args[0].v)) : err('#TYPE', 'floor');
    case 'ceil':
      return args[0].t === 'num' ? num(Math.ceil(args[0].v)) : err('#TYPE', 'ceil');
    case 'abs':
      return args[0].t === 'num' ? num(Math.abs(args[0].v)) : err('#TYPE', 'abs');
    case 'min':
    case 'max': {
      let acc = args[0];
      for (let i = 1; i < args.length; i++) {
        const c = compare(acc, args[i]);
        if (typeof c !== 'number') return c;
        const pick = fn === 'min' ? c > 0 : c < 0;
        if (pick) acc = args[i];
      }
      return acc;
    }
    case 'clamp': {
      const [x, lo, hi] = args;
      if (x.t !== 'num' || lo.t !== 'num' || hi.t !== 'num') return err('#TYPE', 'clamp');
      return num(Math.min(Math.max(x.v, lo.v), hi.v));
    }
    case 'dateAdd':
      return addV(args[0], args[1]);
    case 'dateDiff':
      return args[0].t === 'date' && args[1].t === 'date'
        ? num(args[0].epochDay - args[1].epochDay)
        : err('#TYPE', 'dateDiff');
    case 'len':
      return args[0].t === 'text' ? num(args[0].v.length) : err('#TYPE', 'len');
    case 'lower':
      return args[0].t === 'text' ? text(args[0].v.toLowerCase()) : err('#TYPE', 'lower');
    case 'upper':
      return args[0].t === 'text' ? text(args[0].v.toUpperCase()) : err('#TYPE', 'upper');
    case 'contains':
      return args[0].t === 'text' && args[1].t === 'text'
        ? bool(args[0].v.includes(args[1].v))
        : err('#TYPE', 'contains');
    case 'has':
      return args[0].t === 'enumset' && args[1].t === 'enum'
        ? bool(args[0].v.includes(args[1].v))
        : err('#TYPE', 'has');
    default:
      return err('#NA', `unknown fn ${fn}`);
  }
}

// ---- relation traversal + rollups ------------------------------------------
function evalRef(path: string[], env: Record<string, Value>, ctx: EvalCtx): Value {
  let cur: Value = env[path[0]] ?? BLANK;
  for (let i = 1; i < path.length; i++) {
    if (cur.t !== 'ref') return cur.t === 'blank' ? BLANK : err('#REF', `${path[i - 1]} not a ref`);
    cur = ctx.resolver.cell(cur.id, path[i]);
  }
  return cur;
}

function aggregate(agg: string, vals: Value[]): Value {
  if (agg === 'count') return num(vals.length);
  const usable: Value[] = vals.filter((v) => v.t !== 'blank');
  if (!usable.length) return agg === 'sum' ? num(0) : BLANK;
  if (agg === 'sum') return usable.reduce((acc, v) => addV(acc, v));
  if (agg === 'avg') {
    const total = usable.reduce((acc, v) => addV(acc, v));
    return divV(total, num(usable.length));
  }
  // min / max
  let acc = usable[0];
  for (let i = 1; i < usable.length; i++) {
    const c = compare(acc, usable[i]);
    if (typeof c !== 'number') return c;
    if ((agg === 'min' && c > 0) || (agg === 'max' && c < 0)) acc = usable[i];
  }
  return acc;
}

function evalRollup(node: Extract<Node, { op: 'rollup' }>, ctx: EvalCtx): Value {
  if (ctx.recordId === undefined) return err('#REF', 'rollup needs a record context');
  if (node.of.op !== 'field') return err('#NA', 'rollup supports a field target in v0');
  const ids = ctx.resolver.related(ctx.recordId, node.via);
  const column = node.of.id;
  return aggregate(node.agg, ids.map((rid) => ctx.resolver.cell(rid, column)));
}

// ---- the evaluator ----------------------------------------------------------
export function evalNode(node: Node, env: Record<string, Value>, ctx: EvalCtx): Value {
  switch (node.op) {
    case 'lit':
      return node.value;
    case 'field':
      return env[node.id] ?? BLANK;
    case 'ref':
      return evalRef(node.path, env, ctx);
    case 'rollup':
      return evalRollup(node, ctx);
    case 'not': {
      const a = evalNode(node.args[0], env, ctx);
      return a.t === 'error' ? a : bool(!truthy(a));
    }
    case 'neg':
      return negV(evalNode(node.args[0], env, ctx));
    case 'call': {
      if (node.fn === 'if') {
        const c = evalNode(node.args[0], env, ctx);
        if (c.t === 'error') return c;
        return evalNode(truthy(c) ? node.args[1] : node.args[2], env, ctx);
      }
      return applyCall(node.fn, node.args.map((a) => evalNode(a, env, ctx)), ctx);
    }
    default:
      if (isBin(node.op))
        return applyBin(node.op, evalNode(node.args[0], env, ctx), evalNode(node.args[1], env, ctx));
      return err('#TYPE', `unknown op ${(node as { op: string }).op}`);
  }
}

/** Evaluate a record's computed columns (already topo-ordered) over its inputs. */
export function evalRecord(
  cols: CompiledColumn[],
  env: Record<string, Value>,
  ctx: Partial<EvalCtx> = {},
): Record<string, Value> {
  const full: EvalCtx = {
    resolver: ctx.resolver ?? emptyResolver(),
    clock: ctx.clock ?? { today: 0, nowMs: 0 },
    recordId: ctx.recordId,
  };
  const work: Record<string, Value> = { ...env };
  const out: Record<string, Value> = {};
  for (const c of cols) {
    const v = evalNode(c.ast, work, full);
    out[c.id] = v;
    work[c.id] = v;
  }
  return out;
}
