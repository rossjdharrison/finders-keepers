// Total comparison and equality over Value. Neither ever throws.
//
// compare() returns -1 | 0 | 1 for order-comparable operands, or a VErr value
// when the operands are not orderable (mixed type, mixed currency, unordered
// kinds like enum/ref/list). Blank sorts LAST. Errors are incomparable.
// equals() is structural and total, and is what enum membership / dedupe use.

import type { Value, VErr } from './value.ts';
import { moneyCompare, moneyEquals } from './money.ts';

const cmpNum = (a: number, b: number): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

export function compare(a: Value, b: Value): -1 | 0 | 1 | VErr {
  // errors are incomparable — surface the first one
  if (a.t === 'error') return a;
  if (b.t === 'error') return b;

  // blank sorts last, consistently in both directions
  if (a.t === 'blank' || b.t === 'blank') {
    if (a.t === 'blank' && b.t === 'blank') return 0;
    return a.t === 'blank' ? 1 : -1;
  }

  if (a.t !== b.t) return { t: 'error', code: '#TYPE', detail: `compare ${a.t} vs ${b.t}` };

  switch (a.t) {
    case 'num':
      return cmpNum(a.v, (b as typeof a).v);
    case 'pct':
      return cmpNum(a.v, (b as typeof a).v);
    case 'money': {
      const r = moneyCompare(a, b as typeof a);
      return typeof r === 'number' ? r : (r as VErr);
    }
    case 'date':
      return cmpNum(a.epochDay, (b as typeof a).epochDay);
    case 'datetime':
      return cmpNum(a.epochMs, (b as typeof a).epochMs);
    case 'text':
      return a.v < (b as typeof a).v ? -1 : a.v > (b as typeof a).v ? 1 : 0;
    case 'bool':
      return cmpNum(a.v ? 1 : 0, (b as typeof a).v ? 1 : 0);
    default:
      // dur, enum, enumset, ref, list have no defined ordering
      return { t: 'error', code: '#TYPE', detail: `${a.t} is not orderable` };
  }
}

export function equals(a: Value, b: Value): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'num':
    case 'pct':
      return a.v === (b as typeof a).v;
    case 'bool':
      return a.v === (b as typeof a).v;
    case 'text':
      return a.v === (b as typeof a).v;
    case 'money':
      return moneyEquals(a, b as typeof a);
    case 'date':
      return a.epochDay === (b as typeof a).epochDay;
    case 'datetime':
      return a.epochMs === (b as typeof a).epochMs;
    case 'dur':
      return a.months === (b as typeof a).months && a.ms === (b as typeof a).ms;
    case 'enum':
      return a.set === (b as typeof a).set && a.v === (b as typeof a).v;
    case 'enumset': {
      const bb = b as typeof a;
      if (a.set !== bb.set || a.v.length !== bb.v.length) return false;
      const s = new Set(bb.v);
      return a.v.every((x) => s.has(x));
    }
    case 'ref':
      return a.collection === (b as typeof a).collection && a.id === (b as typeof a).id;
    case 'list': {
      const bb = b as typeof a;
      return a.items.length === bb.items.length && a.items.every((x, i) => equals(x, bb.items[i]));
    }
    case 'predicate':
      return JSON.stringify(a.ast) === JSON.stringify((b as typeof a).ast);
    case 'blank':
      return true;
    case 'error':
      return a.code === (b as typeof a).code;
  }
}
