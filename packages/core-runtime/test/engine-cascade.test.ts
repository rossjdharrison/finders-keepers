import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/core.ts';
import { mockExterns } from '../src/mock-externs.ts';
import type { Cassette } from '../src/types.ts';
import type { ValueType } from '@core/values';

// The crux lifted from the WorkspaceDO: a cross-collection rollup CASCADE, now host-agnostic.
const text = (v: string) => ({ t: 'text' as const, v });
const num = (v: number) => ({ t: 'num' as const, v });
const ref = (collection: string, id: string) => ({ t: 'ref' as const, collection, id });
const field = (id: string) => ({ op: 'field', id });
const rollup = (via: string, agg: string, of: string) => ({ op: 'rollup', via, agg, of: field(of) });
const stored = (id: string, valueType: ValueType) => ({ id, valueType, source: 'stored' as const });
const computed = (id: string, valueType: ValueType, formula: unknown) => ({ id, valueType, source: 'computed' as const, formula });

const studio: Cassette = {
  id: 'studio',
  types: { Initiative: { specializes: ['activity'] }, Feature: { specializes: ['activity'] }, Task: { specializes: ['activity'] } },
  collections: [
    { id: 'initiatives', semanticClass: 'Initiative', properties: [stored('name', { k: 'text' }), computed('totalPoints', { k: 'num' }, rollup('features', 'sum', 'points'))] },
    { id: 'features', semanticClass: 'Feature', properties: [stored('name', { k: 'text' }), stored('initiative', { k: 'ref', collection: 'initiatives' }), stored('points', { k: 'num' }), computed('effort', { k: 'num' }, rollup('tasks', 'sum', 'hours'))] },
    { id: 'tasks', semanticClass: 'Task', properties: [stored('title', { k: 'text' }), stored('feature', { k: 'ref', collection: 'features' }), stored('hours', { k: 'num' })] },
  ],
  relations: {
    features: { parentColl: 'initiatives', childColl: 'features', childField: 'initiative' },
    tasks: { parentColl: 'features', childColl: 'tasks', childField: 'feature' },
  },
};

test('the shared engine rolls child fields up across collections, and a leaf edit cascades up', () => {
  const core = createCore(mockExterns());
  core.load(studio);
  core.apply('initiatives', [{ op: 'insert', row: 'i1', values: { name: text('Realtime') } }]);
  core.apply('features', [{ op: 'insert', row: 'f1', values: { name: text('Presence'), initiative: ref('initiatives', 'i1'), points: num(8) } }]);
  core.apply('tasks', [
    { op: 'insert', row: 't1', values: { title: text('a'), feature: ref('features', 'f1'), hours: num(6) } },
    { op: 'insert', row: 't2', values: { title: text('b'), feature: ref('features', 'f1'), hours: num(4) } },
  ]);

  const f1 = () => core.read('features').find((r) => r.id === 'f1')!;
  assert.equal((f1().doc.effort as { v: number }).v, 10); // 6 + 4, rolled up from tasks
  assert.equal((core.read('initiatives')[0].doc.totalPoints as { v: number }).v, 8);

  // a leaf edit cascades UP the chain (task.hours -> feature.effort), no client formula
  core.apply('tasks', [{ op: 'setField', row: 't1', field: 'hours', value: num(20) }]);
  assert.equal((f1().doc.effort as { v: number }).v, 24); // 20 + 4
});
