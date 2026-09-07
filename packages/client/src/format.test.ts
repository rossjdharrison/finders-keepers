import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyDec, num, enumV, date, err, BLANK } from '@core/values';
import { format } from './format.ts';

test('formats each value kind for display', () => {
  assert.equal(format(num(3)), '3');
  assert.equal(format(moneyDec(300, 'EUR')), '300.00 EUR');
  assert.equal(format({ t: 'pct', v: 0.19 }), '19.0%');
  assert.equal(format({ t: 'text', v: 'hi' }), 'hi');
  assert.equal(format({ t: 'bool', v: true }), '✓');
  assert.equal(format(date(0)), '1970-01-01');
  assert.equal(format(BLANK), '');
  assert.equal(format(undefined), '');
});

test('enum shows the option label when provided, else the raw id', () => {
  const opts = [{ id: 'won', label: 'Won' }];
  assert.equal(format(enumV('stage', 'won'), opts), 'Won');
  assert.equal(format(enumV('stage', 'lead'), opts), 'lead');
});

test('errors render as their bare code — not double-hashed', () => {
  assert.equal(format(err('#DIV0')), '#DIV0');
  assert.equal(format(err('#CCY', 'EUR≠USD')), '#CCY (EUR≠USD)');
});
