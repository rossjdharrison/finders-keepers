// Tiny constructors used across the value tests. Not part of the public API.
import { moneyDec } from './money.ts';
import type { VMoney } from './value.ts';
export { num, text, date, datetime, bool, pct, enumV, enumSet, BLANK, err } from './value.ts';

/** money from a decimal, EUR by default — keeps the compare tests terse. */
export const moneyDec2 = (amount: number, ccy = 'EUR'): VMoney => moneyDec(amount, ccy);
