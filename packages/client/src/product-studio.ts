// The demo workspace: "Product Studio" — product development x Confluence.
//
//   Initiatives ─┐(rollup points/shippedPoints)
//                └ Features ─┐(rollup effort/taskDone/progress from tasks, docCount from docs)
//                            ├ Tasks   (hours, status -> doneFlag)
//                            └ Docs    (Confluence pages: space + editorial status)
//
// Refs: Feature.initiative, Task.feature, Doc.feature. Rollups exercise
// rollup-of-stored (effort), rollup-of-computed (shippedPoints, taskDone) and
// computed-from-rollup (progress). Edit a Task's hours/status in one tab and the
// Feature + Initiative rollups move in every tab — server-computed, no client formula.

import { num, text, ref, enumV } from '@core/values';
import type { Value, ValueType } from '@core/values';
import type { CollectionDoc, RelationMeta, RowOp, ViewDoc } from './types.ts';

// --- formula-AST builders (Property.formula is opaque on the client) ---------
const field = (id: string) => ({ op: 'field', id });
const lit = (value: unknown) => ({ op: 'lit', value });
const rollup = (via: string, agg: string, of: string) => ({ op: 'rollup', via, agg, of: field(of) });
const iff = (c: unknown, a: unknown, b: unknown) => ({ op: 'call', fn: 'if', args: [c, a, b] });
const eq = (a: unknown, b: unknown) => ({ op: 'eq', args: [a, b] });
const gt = (a: unknown, b: unknown) => ({ op: 'gt', args: [a, b] });
const div = (a: unknown, b: unknown) => ({ op: 'div', args: [a, b] });
const numT: ValueType = { k: 'num' };
const st = (id: string, valueType: ValueType) => ({ id, valueType, source: 'stored' as const });
const cp = (id: string, valueType: ValueType, formula: unknown) => ({ id, valueType, source: 'computed' as const, formula });

export const collections: CollectionDoc[] = [
  {
    id: 'initiatives',
    properties: [
      st('name', { k: 'text' }),
      st('status', { k: 'enum', set: 'initiativeStatus' }),
      cp('totalPoints', numT, rollup('features', 'sum', 'points')),
      cp('shippedPoints', numT, rollup('features', 'sum', 'shippedPoints')),
      cp('featureCount', numT, rollup('features', 'count', 'points')),
    ],
  },
  {
    id: 'features',
    properties: [
      st('name', { k: 'text' }),
      st('initiative', { k: 'ref', collection: 'initiatives' }),
      st('status', { k: 'enum', set: 'featureStatus' }),
      st('points', { k: 'num' }),
      cp('effort', numT, rollup('tasks', 'sum', 'hours')),
      cp('taskCount', numT, rollup('tasks', 'count', 'hours')),
      cp('taskDone', numT, rollup('tasks', 'sum', 'doneFlag')),
      cp('docCount', numT, rollup('docs', 'count', 'title')),
      cp('shippedPoints', numT, iff(eq(field('status'), lit(enumV('featureStatus', 'shipped'))), field('points'), lit(num(0)))),
      cp('progress', numT, iff(gt(field('taskCount'), lit(num(0))), div(field('taskDone'), field('taskCount')), lit(num(0)))),
    ],
  },
  {
    id: 'tasks',
    properties: [
      st('title', { k: 'text' }),
      st('feature', { k: 'ref', collection: 'features' }),
      st('status', { k: 'enum', set: 'taskStatus' }),
      st('hours', { k: 'num' }),
      cp('doneFlag', numT, iff(eq(field('status'), lit(enumV('taskStatus', 'done'))), lit(num(1)), lit(num(0)))),
    ],
  },
  {
    id: 'docs',
    properties: [
      st('title', { k: 'text' }),
      st('space', { k: 'enum', set: 'docSpace' }),
      st('status', { k: 'enum', set: 'docStatus' }),
      st('feature', { k: 'ref', collection: 'features' }),
    ],
  },
];

export const relations: Record<string, RelationMeta> = {
  features: { parentColl: 'initiatives', childColl: 'features', childField: 'initiative' },
  tasks: { parentColl: 'features', childColl: 'tasks', childField: 'feature' },
  docs: { parentColl: 'features', childColl: 'docs', childField: 'feature' },
};

// --- seed data ---------------------------------------------------------------
const ins = (coll: string, row: string, values: Record<string, Value>): RowOp => ({ op: 'insert', coll, row, values });
const fs = (v: string) => enumV('featureStatus', v);
const ts = (v: string) => enumV('taskStatus', v);
const ds = (v: string) => enumV('docStatus', v);

export const seedOps: RowOp[] = [
  ins('initiatives', 'i1', { name: text('Realtime Collaboration'), status: enumV('initiativeStatus', 'active') }),
  ins('initiatives', 'i2', { name: text('Mobile App'), status: enumV('initiativeStatus', 'active') }),

  ins('features', 'f1', { name: text('Presence & Cursors'), initiative: ref('initiatives', 'i1'), status: fs('shipped'), points: num(8) }),
  ins('features', 'f2', { name: text('Comment Threads'), initiative: ref('initiatives', 'i1'), status: fs('building'), points: num(5) }),
  ins('features', 'f3', { name: text('Offline Sync'), initiative: ref('initiatives', 'i2'), status: fs('building'), points: num(13) }),
  ins('features', 'f4', { name: text('Push Notifications'), initiative: ref('initiatives', 'i2'), status: fs('backlog'), points: num(3) }),

  ins('tasks', 't1', { title: text('Cursor transport'), feature: ref('features', 'f1'), status: ts('done'), hours: num(6) }),
  ins('tasks', 't2', { title: text('Avatar stack'), feature: ref('features', 'f1'), status: ts('done'), hours: num(4) }),
  ins('tasks', 't3', { title: text('Thread model'), feature: ref('features', 'f2'), status: ts('doing'), hours: num(8) }),
  ins('tasks', 't4', { title: text('Mentions'), feature: ref('features', 'f2'), status: ts('todo'), hours: num(5) }),
  ins('tasks', 't5', { title: text('CRDT merge'), feature: ref('features', 'f3'), status: ts('done'), hours: num(10) }),
  ins('tasks', 't6', { title: text('Conflict UI'), feature: ref('features', 'f3'), status: ts('doing'), hours: num(12) }),
  ins('tasks', 't7', { title: text('Sync queue'), feature: ref('features', 'f3'), status: ts('todo'), hours: num(6) }),
  ins('tasks', 't8', { title: text('APNs plumbing'), feature: ref('features', 'f4'), status: ts('todo'), hours: num(3) }),

  ins('docs', 'd1', { title: text('Presence RFC'), space: enumV('docSpace', 'eng'), status: ds('published'), feature: ref('features', 'f1') }),
  ins('docs', 'd2', { title: text('Threads spec'), space: enumV('docSpace', 'product'), status: ds('review'), feature: ref('features', 'f2') }),
  ins('docs', 'd3', { title: text('Sync design'), space: enumV('docSpace', 'eng'), status: ds('review'), feature: ref('features', 'f3') }),
  ins('docs', 'd4', { title: text('Notif UX notes'), space: enumV('docSpace', 'design'), status: ds('draft'), feature: ref('features', 'f4') }),
];

// --- views (data-defined) ----------------------------------------------------
const featureStatusOpts = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'building', label: 'Building' },
  { id: 'shipped', label: 'Shipped' },
];
const taskStatusOpts = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];
const docStatusOpts = [
  { id: 'draft', label: 'Draft' },
  { id: 'review', label: 'In review' },
  { id: 'published', label: 'Published' },
];
const docSpaceOpts = [
  { id: 'product', label: 'Product' },
  { id: 'eng', label: 'Engineering' },
  { id: 'design', label: 'Design' },
];
const initiativeStatusOpts = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'done', label: 'Done' },
];

export const views: ViewDoc[] = [
  {
    id: 'initiatives', collection: 'initiatives', title: 'Initiatives', renderer: 'table',
    query: { coll: 'initiatives' },
    visibleProps: ['name', 'status', 'featureCount', 'totalPoints', 'shippedPoints'],
    config: {
      labels: { name: 'Initiative', status: 'Status', featureCount: 'Features', totalPoints: 'Total pts', shippedPoints: 'Shipped pts' },
      enums: { status: initiativeStatusOpts },
    },
  },
  {
    id: 'features', collection: 'features', title: 'Features', renderer: 'table',
    query: { coll: 'features' },
    visibleProps: ['name', 'initiative', 'status', 'points', 'effort', 'taskDone', 'taskCount', 'progress', 'docCount', 'shippedPoints'],
    config: {
      labels: { name: 'Feature', initiative: 'Initiative', status: 'Status', points: 'Points', effort: 'Effort (h)', taskDone: 'Done', taskCount: 'Tasks', progress: 'Progress', docCount: 'Docs', shippedPoints: 'Shipped' },
      enums: { status: featureStatusOpts },
      refs: { initiative: { collection: 'initiatives', labelField: 'name' } },
    },
  },
  {
    id: 'tasks', collection: 'tasks', title: 'Tasks', renderer: 'table',
    query: { coll: 'tasks' },
    visibleProps: ['title', 'feature', 'status', 'hours', 'doneFlag'],
    config: {
      labels: { title: 'Task', feature: 'Feature', status: 'Status', hours: 'Hours', doneFlag: 'Done?' },
      enums: { status: taskStatusOpts },
      refs: { feature: { collection: 'features', labelField: 'name' } },
    },
  },
  {
    id: 'docs', collection: 'docs', title: 'Docs', renderer: 'board',
    query: { coll: 'docs' },
    visibleProps: ['title', 'space'],
    config: {
      groupField: 'status',
      columns: ['draft', 'review', 'published'],
      labels: { title: 'Doc', space: 'Space' },
      enums: { status: docStatusOpts, space: docSpaceOpts },
    },
  },
];
