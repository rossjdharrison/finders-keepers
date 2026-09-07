// @core/values — the canonical Value union and its static type mirror.
//
// Two rules make this the spine of the whole platform:
//   1. Errors and blanks are FIRST-CLASS VALUES, never thrown. Every operation
//      is total: a bad cell yields {t:'error'} in place, the rest stays live.
//   2. Every Value is JSON-serialisable as-is (money is integer minor units in a
//      string, never a float) so the same shape travels the wire and the store.

export type ErrCode =
  | '#DIV0' // division by zero
  | '#TYPE' // operator applied to incompatible types
  | '#REF' // reference / relation could not be resolved
  | '#CYCLE' // cyclic computed dependency
  | '#CCY' // mixed-currency money operation
  | '#NA' // not available (missing arg, unknown option)
  | '#OOB' // index / lookup out of bounds
  | '#UNIT'; // incompatible units

export interface VNum {
  t: 'num';
  v: number;
}
export interface VMoney {
  t: 'money';
  minor: string; // integer minor units as a decimal string, e.g. "12345"
  scale: number; // number of minor-unit decimal places, e.g. 2 => €123.45
  ccy: string; // ISO 4217 code, e.g. "EUR"
}
export interface VPct {
  t: 'pct';
  v: number; // 0.2 === 20%
}
export interface VDur {
  t: 'dur';
  months: number; // calendar part (months are not a fixed number of ms)
  ms: number; // exact part
}
export interface VDate {
  t: 'date';
  epochDay: number; // civil date, no timezone. 0 === 1970-01-01
}
export interface VDateTime {
  t: 'datetime';
  epochMs: number; // UTC instant
}
export interface VBool {
  t: 'bool';
  v: boolean;
}
export interface VText {
  t: 'text';
  v: string;
}
export interface VEnum {
  t: 'enum';
  set: string; // enum-set id the option belongs to
  v: string; // option id
}
export interface VEnumSet {
  t: 'enumset';
  set: string;
  v: string[]; // option ids (order-insensitive set)
}
export interface VRef {
  t: 'ref';
  collection: string;
  id: string;
}
export interface VList {
  t: 'list';
  of: ValueType;
  items: Value[];
}
export interface VBlank {
  t: 'blank'; // the SQL-NULL analogue: no value
}
export interface VErr {
  t: 'error';
  code: ErrCode;
  detail?: string;
}

export type Value =
  | VNum
  | VMoney
  | VPct
  | VDur
  | VDate
  | VDateTime
  | VBool
  | VText
  | VEnum
  | VEnumSet
  | VRef
  | VList
  | VBlank
  | VErr;

// ---- the static type mirror -------------------------------------------------
// Carries currency / enum-set id / element type so mismatches (money EUR + money
// USD, an enum literal outside its set) are caught by the typechecker at column
// SAVE time, before any row runs. `computed` is deliberately NOT a type here —
// derivation is a Property.source axis; a computed cell's type is its result type.

export type ValueType =
  | { k: 'num' }
  | { k: 'money'; ccy?: string }
  | { k: 'pct' }
  | { k: 'dur' }
  | { k: 'date' }
  | { k: 'datetime' }
  | { k: 'bool' }
  | { k: 'text' }
  | { k: 'enum'; set: string }
  | { k: 'enumset'; set: string }
  | { k: 'ref'; collection: string }
  | { k: 'list'; of: ValueType }
  | { k: 'blank' }
  | { k: 'error' };

// ---- constructors -----------------------------------------------------------
export const num = (v: number): VNum => ({ t: 'num', v });
export const pct = (v: number): VPct => ({ t: 'pct', v });
export const bool = (v: boolean): VBool => ({ t: 'bool', v });
export const text = (v: string): VText => ({ t: 'text', v });
export const date = (epochDay: number): VDate => ({ t: 'date', epochDay });
export const datetime = (epochMs: number): VDateTime => ({ t: 'datetime', epochMs });
export const dur = (months: number, ms: number): VDur => ({ t: 'dur', months, ms });
export const enumV = (set: string, v: string): VEnum => ({ t: 'enum', set, v });
export const enumSet = (set: string, v: string[]): VEnumSet => ({ t: 'enumset', set, v });
export const ref = (collection: string, id: string): VRef => ({ t: 'ref', collection, id });
export const list = (of: ValueType, items: Value[]): VList => ({ t: 'list', of, items });
export const BLANK: VBlank = { t: 'blank' };
export const err = (code: ErrCode, detail?: string): VErr =>
  detail === undefined ? { t: 'error', code } : { t: 'error', code, detail };

// Low-level money constructor (minor is an integer). Prefer moneyDec for literals.
export const money = (minor: bigint | number | string, scale: number, ccy: string): VMoney => ({
  t: 'money',
  minor: typeof minor === 'string' ? minor : minor.toString(),
  scale,
  ccy,
});

// ---- guards -----------------------------------------------------------------
export const isErr = (x: Value): x is VErr => x.t === 'error';
export const isBlank = (x: Value): x is VBlank => x.t === 'blank';

// The static type of a value (used when a literal or input feeds the typechecker).
export function typeOf(v: Value): ValueType {
  switch (v.t) {
    case 'num':
      return { k: 'num' };
    case 'money':
      return { k: 'money', ccy: v.ccy };
    case 'pct':
      return { k: 'pct' };
    case 'dur':
      return { k: 'dur' };
    case 'date':
      return { k: 'date' };
    case 'datetime':
      return { k: 'datetime' };
    case 'bool':
      return { k: 'bool' };
    case 'text':
      return { k: 'text' };
    case 'enum':
      return { k: 'enum', set: v.set };
    case 'enumset':
      return { k: 'enumset', set: v.set };
    case 'ref':
      return { k: 'ref', collection: v.collection };
    case 'list':
      return { k: 'list', of: v.of };
    case 'blank':
      return { k: 'blank' };
    case 'error':
      return { k: 'error' };
  }
}

// Structural type equality (currency / enum-set / element type must match).
export function typeEq(a: ValueType, b: ValueType): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'money') return a.ccy === (b as { ccy?: string }).ccy;
  if (a.k === 'enum' || a.k === 'enumset') return a.set === (b as { set: string }).set;
  if (a.k === 'ref') return a.collection === (b as { collection: string }).collection;
  if (a.k === 'list') return typeEq(a.of, (b as { of: ValueType }).of);
  return true;
}
