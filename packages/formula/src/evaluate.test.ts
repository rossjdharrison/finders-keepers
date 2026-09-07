import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Value, ValueType } from '@core/values';
import { num, money, moneyDec, date, dur, equals, ymdToEpochDay } from '@core/values';
import type { Node } from './ast.ts';
import { compile } from './compile.ts';
import { topoOrCycle } from './graph.ts';
import { evalNode, evalRecord } from './evaluate.ts';
import type { Resolver } from './resolver.ts';

const field = (id: string): Node => ({ op: 'field', id });
const lit = (value: Value): Node => ({ op: 'lit', value });
const evalIn = (n: Node, env: Record<string, Value> = {}) =>
  evalNode(n, env, { resolver: { related: () => [], cell: () => ({ t: 'blank' }), columnType: () => undefined }, clock: { today: 0, nowMs: 0 } });

test('division by zero is a value, not a throw', () => {
  const r = evalIn({ op: 'div', args: [lit(num(1)), lit(num(0))] });
  assert.deepEqual(r, { t: 'error', code: '#DIV0' });
});

test('errors propagate through arithmetic', () => {
  const bad: Node = { op: 'div', args: [lit(num(1)), lit(num(0))] }; // -> #DIV0
  const r = evalIn({ op: 'add', args: [bad, lit(num(5))] });
  assert.deepEqual(r, { t: 'error', code: '#DIV0' });
});

test('money * quantity is exact', () => {
  const r = evalIn({ op: 'mul', args: [field('unitPrice'), field('qty')] }, {
    unitPrice: moneyDec(19.99, 'EUR'),
    qty: num(3),
  });
  assert.ok(equals(r, moneyDec(59.97, 'EUR')));
});

test('date + duration lands on the right civil date', () => {
  const jan31 = date(ymdToEpochDay(2024, 1, 31));
  const r = evalIn({ op: 'add', args: [lit(jan31), lit(dur(1, 0))] });
  assert.deepEqual(r, date(ymdToEpochDay(2024, 2, 29)));
});

test('if() is lazy — the untaken branch never runs (no spurious #DIV0)', () => {
  const r = evalIn({
    op: 'call',
    fn: 'if',
    args: [lit({ t: 'bool', v: true }), lit(num(42)), { op: 'div', args: [lit(num(1)), lit(num(0))] }],
  });
  assert.deepEqual(r, num(42));
});

test('coalesce skips blanks and errors', () => {
  const r = evalIn({ op: 'call', fn: 'coalesce', args: [field('missing'), lit(num(7))] });
  assert.deepEqual(r, num(7));
});

test('evalRecord computes a chain of columns in dependency order', () => {
  // lineTotal = unitPrice*qty ; withVat = lineTotal + lineTotal*19%
  const columns: Record<string, ValueType> = { unitPrice: { k: 'money', ccy: 'EUR' }, qty: { k: 'num' } };
  const lineTotal = compile('lineTotal', { op: 'mul', args: [field('unitPrice'), field('qty')] }, { columns });
  const c2 = { ...columns, lineTotal: { k: 'money', ccy: 'EUR' } as ValueType };
  const withVat = compile(
    'withVat',
    { op: 'add', args: [field('lineTotal'), { op: 'mul', args: [field('lineTotal'), lit({ t: 'pct', v: 0.19 })] }] },
    { columns: c2 },
  );
  assert.ok(!('errors' in lineTotal) && !('errors' in withVat));

  const ordered = topoOrCycle([lineTotal as never, withVat as never]);
  assert.ok('order' in ordered && ordered.order.indexOf('lineTotal') < ordered.order.indexOf('withVat'));

  const out = evalRecord([lineTotal as never, withVat as never], {
    unitPrice: moneyDec(100, 'EUR'),
    qty: num(2),
  });
  assert.ok(equals(out.lineTotal, moneyDec(200, 'EUR')));
  assert.ok(equals(out.withVat, moneyDec(238, 'EUR')));
});

test('rollup sums a money column across related records', () => {
  const resolver: Resolver = {
    related: (id, via) => (id === 'acc1' && via === 'deals' ? ['d1', 'd2'] : []),
    cell: (id, col) =>
      col === 'total' ? (id === 'd1' ? moneyDec(300, 'EUR') : moneyDec(150, 'EUR')) : { t: 'blank' },
    columnType: () => ({ k: 'money', ccy: 'EUR' }),
  };
  const r = evalNode({ op: 'rollup', via: 'deals', agg: 'sum', of: field('total') }, {}, {
    resolver,
    clock: { today: 0, nowMs: 0 },
    recordId: 'acc1',
  });
  assert.ok(equals(r, moneyDec(450, 'EUR')));
});
