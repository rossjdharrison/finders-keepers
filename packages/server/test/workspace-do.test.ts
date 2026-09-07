import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { CollectionDoc } from '../src/workspace-do.ts';

// --- value + node builders (wire JSON) --------------------------------------
const num = (v: number) => ({ t: 'num', v });
const text = (v: string) => ({ t: 'text', v });
const en = (set: string, v: string) => ({ t: 'enum', set, v });
const ref = (collection: string, id: string) => ({ t: 'ref', collection, id });
const field = (id: string) => ({ op: 'field', id });
const lit = (value: unknown) => ({ op: 'lit', value });
const rollup = (via: string, agg: string, of: string) => ({ op: 'rollup', via, agg, of: field(of) });
const stored = (id: string, valueType: unknown) => ({ id, valueType, source: 'stored' });
const computed = (id: string, valueType: unknown, formula: unknown) => ({ id, valueType, source: 'computed', formula });

const collections: CollectionDoc[] = [
  {
    id: 'initiatives',
    semanticClass: 'Initiative',
    properties: [
      stored('name', { k: 'text' }),
      computed('totalPoints', { k: 'num' }, rollup('features', 'sum', 'points')),
    ],
  } as CollectionDoc,
  {
    id: 'features',
    semanticClass: 'Feature',
    properties: [
      stored('name', { k: 'text' }),
      stored('initiative', { k: 'ref', collection: 'initiatives' }),
      stored('points', { k: 'num' }),
      computed('effort', { k: 'num' }, rollup('tasks', 'sum', 'hours')),
      computed('taskCount', { k: 'num' }, rollup('tasks', 'count', 'hours')),
      computed('taskDone', { k: 'num' }, rollup('tasks', 'sum', 'doneFlag')),
      computed('progress', { k: 'num' }, {
        op: 'call', fn: 'if', args: [
          { op: 'gt', args: [field('taskCount'), lit(num(0))] },
          { op: 'div', args: [field('taskDone'), field('taskCount')] },
          lit(num(0)),
        ],
      }),
    ],
  } as CollectionDoc,
  {
    id: 'tasks',
    semanticClass: 'Task',
    properties: [
      stored('title', { k: 'text' }),
      stored('feature', { k: 'ref', collection: 'features' }),
      stored('status', { k: 'enum', set: 'taskStatus' }),
      stored('hours', { k: 'num' }),
      computed('doneFlag', { k: 'num' }, {
        op: 'call', fn: 'if', args: [
          { op: 'eq', args: [field('status'), lit(en('taskStatus', 'done'))] },
          lit(num(1)), lit(num(0)),
        ],
      }),
    ],
  } as CollectionDoc,
];
const relations = {
  features: { parentColl: 'initiatives', childColl: 'features', childField: 'initiative' },
  tasks: { parentColl: 'features', childColl: 'tasks', childField: 'feature' },
};
const types = {
  Initiative: { specializes: ['activity'] },
  Feature: { specializes: ['activity'] },
  Task: { specializes: ['activity'] },
};

const call = (path: string, body: unknown, method = 'POST') =>
  SELF.fetch('https://x' + path, { method, body: JSON.stringify(body) });
const ops = (coll: string, list: unknown[]) => call(`/collections/${coll}/ops`, { actor: 'u1', ops: list });
const rowsOf = async (coll: string) =>
  ((await (await call(`/collections/${coll}/query`, { coll })).json()) as { rows: { id: string; doc: Record<string, { v?: number }> }[] }).rows;
const featureById = async (id: string) => (await rowsOf('features')).find((r) => r.id === id)!;

async function seed() {
  expect((await call('/workspace', { collections, relations, types }, 'PUT')).ok).toBe(true);
  await ops('initiatives', [{ op: 'insert', coll: 'initiatives', row: 'i1', values: { name: text('Realtime') } }]);
  await ops('features', [
    { op: 'insert', coll: 'features', row: 'f1', values: { name: text('Presence'), initiative: ref('initiatives', 'i1'), points: num(8) } },
    { op: 'insert', coll: 'features', row: 'f2', values: { name: text('Threads'), initiative: ref('initiatives', 'i1'), points: num(5) } },
  ]);
  await ops('tasks', [
    { op: 'insert', coll: 'tasks', row: 't1', values: { title: text('a'), feature: ref('features', 'f1'), status: en('taskStatus', 'done'), hours: num(6) } },
    { op: 'insert', coll: 'tasks', row: 't2', values: { title: text('b'), feature: ref('features', 'f1'), status: en('taskStatus', 'todo'), hours: num(4) } },
  ]);
}

describe('WorkspaceDO relations + rollups', () => {
  it('rolls up child fields on insert (effort, taskCount, taskDone, progress) and up to the initiative', async () => {
    await seed();
    const f1 = await featureById('f1');
    expect(f1.doc.effort.v).toBe(10); // 6 + 4
    expect(f1.doc.taskCount.v).toBe(2);
    expect(f1.doc.taskDone.v).toBe(1); // one task done
    expect(f1.doc.progress.v).toBe(0.5);
    const i1 = (await rowsOf('initiatives'))[0];
    expect(i1.doc.totalPoints.v).toBe(13); // 8 + 5
  });

  it('a leaf edit cascades UP: Task.hours -> Feature.effort (no task computed col changes)', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'hours', value: num(20) }]);
    expect((await featureById('f1')).doc.effort.v).toBe(24); // 20 + 4
  });

  it('rollup-of-computed + computed-from-rollup: Task.status done -> Feature.taskDone/progress', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't2', field: 'status', value: en('taskStatus', 'done') }]);
    const f1 = await featureById('f1');
    expect(f1.doc.taskDone.v).toBe(2);
    expect(f1.doc.progress.v).toBe(1);
  });

  it('re-pointing a ref updates BOTH the old and the new parent', async () => {
    await seed();
    await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'feature', value: ref('features', 'f2') }]);
    expect((await featureById('f1')).doc.effort.v).toBe(4); // lost t1
    expect((await featureById('f2')).doc.effort.v).toBe(6); // gained t1
  });

  it('broadcast rows and query rows carry their collection', async () => {
    await seed();
    const res = await ops('tasks', [{ op: 'setField', coll: 'tasks', row: 't1', field: 'hours', value: num(9) }]);
    const body = (await res.json()) as { rows: { coll: string }[] };
    expect(body.rows.every((r) => r.coll === 'features' || r.coll === 'tasks')).toBe(true);
    expect(body.rows.some((r) => r.coll === 'features')).toBe(true); // f1 cascaded
  });

  it('rejects a workspace whose semanticClass does not reduce to HQDM (and does not persist it)', async () => {
    const bad = await call('/workspace', {
      collections: [{ id: 'gizmos', semanticClass: 'Gizmo', properties: [stored('name', { k: 'text' })] }],
      relations: {},
      types: { Gizmo: { specializes: ['nowhere'] } }, // dangles — never reaches the lattice root
    }, 'PUT');
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toHaveProperty('error');
    // ...and a well-formed one on a fresh collection is accepted
    const good = await call('/workspace', {
      collections: [{ id: 'gizmos', semanticClass: 'Gizmo', properties: [stored('name', { k: 'text' })] }],
      relations: {},
      types: { Gizmo: { specializes: ['ordinary_physical_object'] } },
    }, 'PUT');
    expect(good.ok).toBe(true);
  });

  it('rejects a collection with no semanticClass at all', async () => {
    const r = await call('/workspace', {
      collections: [{ id: 'x', properties: [stored('n', { k: 'text' })] }],
      relations: {}, types: {},
    }, 'PUT');
    expect(r.status).toBe(400);
  });
});
