import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ValueType } from '@core/values';
import { money } from '@core/values';
import type { Node } from './ast.ts';
import { compile } from './compile.ts';
import { inferType } from './typecheck.ts';

const columns: Record<string, ValueType> = {
  unitPrice: { k: 'money', ccy: 'EUR' },
  qty: { k: 'num' },
  lineTotal: { k: 'money', ccy: 'EUR' },
  cost: { k: 'money', ccy: 'EUR' },
  closeDate: { k: 'date' },
};
const field = (id: string): Node => ({ op: 'field', id });
const infer = (n: Node) => inferType(n, { columns });

test('lineTotal = unitPrice * qty  ->  money(EUR)', () => {
  const t = infer({ op: 'mul', args: [field('unitPrice'), field('qty')] });
  assert.deepEqual(t, { k: 'money', ccy: 'EUR' });
});

test('daysToClose = dateDiff(closeDate, today())  ->  num', () => {
  const t = infer({ op: 'call', fn: 'dateDiff', args: [field('closeDate'), { op: 'call', fn: 'today', args: [] }] });
  assert.deepEqual(t, { k: 'num' });
});

test('date + duration  ->  date', () => {
  const t = infer({ op: 'add', args: [field('closeDate'), { op: 'lit', value: { t: 'dur', months: 1, ms: 0 } }] });
  assert.deepEqual(t, { k: 'date' });
});

test('mixing currencies is rejected at compile with #CCY — before any row runs', () => {
  const bad: Node = { op: 'add', args: [field('lineTotal'), { op: 'lit', value: money(100, 2, 'USD') }] };
  const r = compile('badMix', bad, { columns });
  assert.ok('errors' in r && r.errors[0].code === '#CCY');
});

test('an if() with an error guard branch types to the concrete branch', () => {
  // margin = if(total == 0, <#DIV0>, (total - cost) / total)
  const margin: Node = {
    op: 'call',
    fn: 'if',
    args: [
      { op: 'eq', args: [field('lineTotal'), { op: 'lit', value: money(0, 2, 'EUR') }] },
      { op: 'lit', value: { t: 'error', code: '#DIV0' } },
      { op: 'div', args: [{ op: 'sub', args: [field('lineTotal'), field('cost')] }, field('lineTotal')] },
    ],
  };
  const r = compile('margin', margin, { columns });
  assert.ok(!('errors' in r) && r.type.k === 'num');
});

test('an unknown field is a #REF compile error', () => {
  const r = compile('x', field('nope'), { columns });
  assert.ok('errors' in r && r.errors[0].code === '#REF');
});

test('compile records same-record dependencies for ordering', () => {
  // lineTotal * qty is money*num -> money; two field deps recorded for topo ordering
  const r = compile('scaled', { op: 'mul', args: [field('lineTotal'), field('qty')] }, { columns });
  assert.ok(!('errors' in r));
  assert.deepEqual(new Set(('deps' in r && r.deps) as string[]), new Set(['lineTotal', 'qty']));
});
