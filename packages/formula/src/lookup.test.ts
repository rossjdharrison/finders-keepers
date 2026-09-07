import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Node, TableDef } from './ast.ts';
import { compile } from './compile.ts';
import { evalNode, applicable } from './evaluate.ts';
import { emptyResolver } from './resolver.ts';
import type { Value } from '@core/values';

const sizing: TableDef = {
  kind: '1d',
  of: { k: 'num' },
  map: { S: { t: 'num', v: 2 }, M: { t: 'num', v: 5 }, L: { t: 'num', v: 13 }, XL: { t: 'num', v: 34 } },
};
const ctx = { resolver: emptyResolver(), clock: { today: 0, nowMs: 0 }, tables: { sizing } };
const size = (v: string): Value => ({ t: 'enum', set: 'optionSize', v });

const effort: Node = { op: 'lookup', table: 'sizing', key: { op: 'field', id: 'size' } };

test('lookup typechecks to the table cell type', () => {
  const r = compile('effort', effort, { columns: { size: { k: 'enum', set: 'optionSize' } }, tables: { sizing } });
  assert.ok(!('errors' in r), JSON.stringify(r));
  if ('errors' in r) return;
  assert.equal(r.type.k, 'num');
  assert.deepEqual(r.deps, ['size']); // the key field is a recompute dependency
});

test('lookup computes a consequence down from a choice', () => {
  assert.deepEqual(evalNode(effort, { size: size('M') }, ctx), { t: 'num', v: 5 });
  assert.deepEqual(evalNode(effort, { size: size('XL') }, ctx), { t: 'num', v: 34 });
});

test('lookup is total: missing key -> error value, blank key -> blank, no throw', () => {
  assert.equal(evalNode(effort, { size: size('ZZ') }, ctx).t, 'error');
  assert.equal(evalNode(effort, { size: { t: 'blank' } }, ctx).t, 'blank');
  assert.equal(evalNode({ op: 'lookup', table: 'nope', key: { op: 'field', id: 'size' } }, { size: size('M') }, ctx).t, 'error');
});

test('availableWhen gates a field by another field (category-driven reshaping)', () => {
  const gate: Node = {
    op: 'eq',
    args: [{ op: 'field', id: 'kind' }, { op: 'lit', value: { t: 'enum', set: 'reqKind', v: 'performance' } }],
  };
  const perf = (k: string): Record<string, Value> => ({ kind: { t: 'enum', set: 'reqKind', v: k } });
  assert.equal(applicable(gate, perf('performance'), ctx), true);
  assert.equal(applicable(gate, perf('constraint'), ctx), false);
  assert.equal(applicable(undefined, perf('constraint'), ctx), true); // no gate = always in play
});
