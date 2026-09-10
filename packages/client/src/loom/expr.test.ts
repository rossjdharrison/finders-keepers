import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpr, formatExpr, type Node } from './expr.ts';

const f = (id: string): Node => ({ op: 'field', id });
const litN = (v: number): Node => ({ op: 'lit', value: { t: 'num', v } });
const litM = (minor: number): Node => ({ op: 'lit', value: { t: 'money', minor, ccy: 'EUR', scale: 2 } });

// The load-bearing guarantee: parse ∘ format = identity on the AST (an edit round-trips exactly).
const ROUND_TRIP: [string, Node][] = [
  ['bare field', f('vval')],
  ['dotted ref', { op: 'ref', path: ['account', 'name'] }],
  ['num lit', litN(0.9)],
  ['money lit', litM(250000)],
  ['bool lit', { op: 'lit', value: { t: 'bool', v: true } }],
  ['blank lit', { op: 'lit', value: { t: 'blank' } }],
  ['enum lit', { op: 'lit', value: { t: 'enum', set: 'term', v: 't48' } }],
  ['pass-through mul', { op: 'mul', args: [f('vval'), litN(0.9)] }],
  ['sub down-payment', { op: 'sub', args: [f('principal'), f('downPayment')] }],
  ['left-assoc chain', { op: 'sub', args: [{ op: 'sub', args: [f('a'), f('b')] }, f('c')] }],
  ['right nested needs parens', { op: 'sub', args: [f('a'), { op: 'sub', args: [f('b'), f('c')] }] }],
  ['precedence add/mul', { op: 'add', args: [f('a'), { op: 'mul', args: [f('b'), f('c')] }] }],
  ['forced parens', { op: 'mul', args: [{ op: 'add', args: [f('a'), f('b')] }, f('c')] }],
  ['comparison', { op: 'gte', args: [f('nc'), litN(5)] }],
  ['and of comparisons', { op: 'and', args: [{ op: 'gte', args: [f('nc'), litN(5)] }, { op: 'gt', args: [f('vval'), litM(100000)] }] }],
  ['if call', { op: 'call', fn: 'if', args: [{ op: 'gte', args: [f('nc'), litN(10)] }, litN(0.01), litN(0)] }],
  ['nested if', { op: 'call', fn: 'if', args: [{ op: 'gte', args: [f('nc'), litN(10)] }, litN(0.01), { op: 'call', fn: 'if', args: [{ op: 'gte', args: [f('nc'), litN(5)] }, litN(0.005), litN(0)] }] }],
  ['min call', { op: 'call', fn: 'min', args: [f('a'), litM(0)] }],
  ['lookup', { op: 'lookup', table: 'rateTable', key: f('termMonths') }],
  ['not', { op: 'not', args: [f('flag')] }],
  ['neg', { op: 'neg', args: [f('x')] }],
];

for (const [name, node] of ROUND_TRIP) {
  test(`expr round-trips: ${name}`, () => {
    const text = formatExpr(node);
    const back = parseExpr(text);
    assert.deepEqual(back, node, `format→parse must reproduce the AST (text was: ${text})`);
  });
}

test('expr: canonical text is stable (format∘parse∘format)', () => {
  const cases = ['vval', 'vval * 0.9', 'principal - downPayment - tradeIn', 'if(nc >= 5, 0.005, 0)', '(a + b) * c', 'a + b * c', '€2500', 'nc >= 5 && vval > €1000'];
  for (const src of cases) {
    const once = formatExpr(parseExpr(src));
    const twice = formatExpr(parseExpr(once));
    assert.equal(twice, once, `text must be a stable fixed point (${src} → ${once})`);
  }
});

test('expr: syntax errors throw a message, not a crash', () => {
  for (const bad of ['', '   ', 'a +', '(a', 'a b', 'lookup()', '€', '1 + * 2']) {
    assert.throws(() => parseExpr(bad), /.+/, `"${bad}" should be a clean parse error`);
  }
});

test('expr: money round-trips through minor units exactly', () => {
  assert.deepEqual(parseExpr('€41000'), litM(4100000));
  assert.deepEqual(parseExpr('€250.5'), litM(25050));
  assert.equal(formatExpr(litM(25050)), '€250.5');
  assert.equal(formatExpr(litM(4100000)), '€41000');
});
