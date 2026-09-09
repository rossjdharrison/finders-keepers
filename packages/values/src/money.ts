// Money arithmetic on integer minor units — never floats.
//
// The whole reason money is not a f64: 0.10 + 0.20 must equal 0.30 exactly, and
// a rollup summing 50k rows must not drift a cent. All add/sub/compare is exact
// BigInt integer math after aligning scales; only multiplication by a fractional
// number rounds (to the money's own scale), which is unavoidable and explicit.

import type { Value, VMoney } from './value.ts';
import { err, money, num } from './value.ts';

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Bring two money values to a common scale (the larger of the two) as bigints. */
function align(a: VMoney, b: VMoney): { av: bigint; bv: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const av = BigInt(a.minor) * pow10(scale - a.scale);
  const bv = BigInt(b.minor) * pow10(scale - b.scale);
  return { av, bv, scale };
}

export function moneyAdd(a: VMoney, b: VMoney): Value {
  if (a.ccy !== b.ccy) return err('#CCY', `${a.ccy} + ${b.ccy}`);
  const { av, bv, scale } = align(a, b);
  return money(av + bv, scale, a.ccy);
}

export function moneySub(a: VMoney, b: VMoney): Value {
  if (a.ccy !== b.ccy) return err('#CCY', `${a.ccy} - ${b.ccy}`);
  const { av, bv, scale } = align(a, b);
  return money(av - bv, scale, a.ccy);
}

/** money * number. Exact for integer multipliers; rounds (half-up) otherwise. */
export function moneyMulNumber(m: VMoney, n: number): Value {
  if (!Number.isFinite(n)) return err('#TYPE', 'money * non-finite');
  if (Number.isInteger(n)) return money(BigInt(m.minor) * BigInt(n), m.scale, m.ccy);
  const scaled = Math.round(Number(m.minor) * n);
  return money(scaled, m.scale, m.ccy);
}

/** money / number -> money (rounds). Division by zero is a value, not a throw. */
export function moneyDivNumber(m: VMoney, n: number): Value {
  if (n === 0) return err('#DIV0');
  if (!Number.isFinite(n)) return err('#TYPE', 'money / non-finite');
  return money(Math.round(Number(m.minor) / n), m.scale, m.ccy);
}

/** money / money -> a dimensionless ratio (num). Same currency required. */
export function moneyDivMoney(a: VMoney, b: VMoney): Value {
  if (a.ccy !== b.ccy) return err('#CCY', `${a.ccy} / ${b.ccy}`);
  const { av, bv } = align(a, b);
  if (bv === 0n) return err('#DIV0');
  return num(Number(av) / Number(bv));
}

/** -1 | 0 | 1, or a #CCY error value when currencies differ. */
export function moneyCompare(a: VMoney, b: VMoney): -1 | 0 | 1 | Value {
  if (a.ccy !== b.ccy) return err('#CCY', `${a.ccy} vs ${b.ccy}`);
  const { av, bv } = align(a, b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function moneyEquals(a: VMoney, b: VMoney): boolean {
  if (a.ccy !== b.ccy) return false;
  const { av, bv } = align(a, b);
  return av === bv;
}

export function moneyNegate(m: VMoney): VMoney {
  return money(-BigInt(m.minor), m.scale, m.ccy) as VMoney;
}

/** Convenience: build money from a decimal amount (0.1 -> minor 10 @ scale 2). */
export function moneyDec(amount: number, ccy: string, scale = 2): VMoney {
  return money(Math.round(amount * 10 ** scale), scale, ccy) as VMoney;
}

/** Human-readable, for debugging/snapshots (not locale-aware). Defensive on `minor`: the type
 * is string (arbitrary precision), but a value straight from JSON data (a lookup table / lit)
 * may carry a numeric minor — coerce so display never throws on well-formed money data. */
export function moneyFormat(m: VMoney): string {
  const minor = String(m.minor);
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(m.scale + 1, '0');
  const whole = digits.slice(0, digits.length - m.scale) || '0';
  const frac = m.scale > 0 ? '.' + digits.slice(digits.length - m.scale) : '';
  return `${neg ? '-' : ''}${whole}${frac} ${m.ccy}`;
}
