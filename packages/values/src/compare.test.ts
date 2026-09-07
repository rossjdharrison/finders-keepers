import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, equals } from './compare.ts';
import { num, text, date, moneyDec2, enumSet, BLANK, err } from './fixtures.ts';

test('numbers, dates and text order naturally', () => {
  assert.equal(compare(num(1), num(2)), -1);
  assert.equal(compare(date(10), date(10)), 0);
  assert.equal(compare(text('b'), text('a')), 1);
});

test('same-currency money orders on true value; different currency is #CCY', () => {
  assert.equal(compare(moneyDec2(5), moneyDec2(10)), -1);
  const r = compare(moneyDec2(5, 'EUR'), moneyDec2(5, 'USD'));
  assert.ok(typeof r !== 'number' && r.t === 'error' && r.code === '#CCY');
});

test('blank always sorts last, in both argument positions', () => {
  assert.equal(compare(BLANK, num(1)), 1);
  assert.equal(compare(num(1), BLANK), -1);
  assert.equal(compare(BLANK, BLANK), 0);
});

test('mixed types and unorderable kinds are #TYPE, never a throw', () => {
  const a = compare(num(1), text('x'));
  assert.ok(typeof a !== 'number' && a.code === '#TYPE');
  const b = compare(enumSet('tags', ['a']), enumSet('tags', ['b']));
  assert.ok(typeof b !== 'number' && b.code === '#TYPE');
});

test('errors are incomparable and surface themselves', () => {
  const r = compare(err('#DIV0'), num(1));
  assert.ok(typeof r !== 'number' && r.code === '#DIV0');
});

test('equals is structural: enumset is order-insensitive, money is scale-insensitive', () => {
  assert.ok(equals(enumSet('tags', ['a', 'b']), enumSet('tags', ['b', 'a'])));
  assert.ok(equals(moneyDec2(1), { t: 'money', minor: '10000', scale: 4, ccy: 'EUR' }));
  assert.ok(!equals(num(1), text('1')));
});
