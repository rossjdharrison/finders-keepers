import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moneyAdd,
  moneySub,
  moneyMulNumber,
  moneyDivMoney,
  moneyDec,
  moneyFormat,
} from './money.ts';
import { equals } from './compare.ts';
import { isErr } from './value.ts';

test('0.10 + 0.20 === 0.30 exactly (the reason money is not a float)', () => {
  const sum = moneyAdd(moneyDec(0.1, 'EUR'), moneyDec(0.2, 'EUR'));
  assert.ok(equals(sum, moneyDec(0.3, 'EUR')));
  assert.equal(moneyFormat(sum as never), '0.30 EUR');
});

test('scale alignment: €1.00 + €1.2345 === €2.2345 (exact, widened scale)', () => {
  const sum = moneyAdd(moneyDec(1, 'EUR', 2), { t: 'money', minor: '12345', scale: 4, ccy: 'EUR' });
  assert.deepEqual(sum, { t: 'money', minor: '22345', scale: 4, ccy: 'EUR' });
});

test('mixed currency is a #CCY value, never a throw', () => {
  const r = moneyAdd(moneyDec(1, 'EUR'), moneyDec(1, 'USD'));
  assert.ok(isErr(r) && r.code === '#CCY');
});

test('money * integer is exact; money / money is a ratio', () => {
  const total = moneyMulNumber(moneyDec(19.99, 'EUR'), 3);
  assert.deepEqual(total, { t: 'money', minor: '5997', scale: 2, ccy: 'EUR' });
  const ratio = moneyDivMoney(moneyDec(50, 'EUR'), moneyDec(200, 'EUR'));
  assert.deepEqual(ratio, { t: 'num', v: 0.25 });
});

test('subtraction can go negative and formats with a sign', () => {
  const r = moneySub(moneyDec(1, 'EUR'), moneyDec(1.5, 'EUR'));
  assert.equal(moneyFormat(r as never), '-0.50 EUR');
});

test('divide by zero is a #DIV0 value', () => {
  assert.ok(isErr(moneyDivMoney(moneyDec(1, 'EUR'), moneyDec(0, 'EUR'))));
});
