import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHost, mockExterns } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import { createHostStore } from './host-store.ts';
import type { BrowserHost } from '@app/core-runtime';
import type { CollectionDoc } from './types.ts';

const text = (v: string) => ({ t: 'text' as const, v });
const num = (v: number) => ({ t: 'num' as const, v });

const cols: CollectionDoc[] = [
  {
    id: 'items',
    semanticClass: 'Thing',
    properties: [
      { id: 'name', valueType: { k: 'text' }, source: 'stored' },
      { id: 'n', valueType: { k: 'num' }, source: 'stored' },
      { id: 'dbl', valueType: { k: 'num' }, source: 'computed', formula: { op: 'add', args: [{ op: 'field', id: 'n' }, { op: 'field', id: 'n' }] } },
    ],
  } as CollectionDoc,
];

test('createHostStore is a DATA-only adapter: reads become a signal, subscribe refreshes it', () => {
  let notify = (): void => {};
  const applied: { coll: string; ops: unknown[] }[] = [];
  let rows: { id: string; doc: Record<string, unknown>; hidden?: string[] }[] = [{ id: 'i1', doc: { name: text('a') } }];
  const host: BrowserHost = {
    read: () => rows as never,
    apply: (coll, ops) => { applied.push({ coll, ops }); rows = [{ id: 'i1', doc: { name: text('b') } }]; notify(); return [] as never; },
    subscribe: (cb) => { notify = cb; return () => {}; },
  };
  const store = createHostStore(host, cols);
  const items = store.collection('items')!;
  assert.equal(items.rows.value[0].doc.name.t, 'text');
  assert.equal(items.propOf('name')?.source, 'stored'); // schema comes from the collection doc

  items.setField('i1', 'name', text('b')); // → host.apply → notify → refresh
  assert.equal(applied.length, 1);
  assert.equal((items.rows.value[0].doc.name as { v: string }).v, 'b'); // signal updated from the re-read

  items.setField('i1', 'dbl', num(9)); // computed field: the adapter refuses to write it
  assert.equal(applied.length, 1);
});

test('end-to-end: the in-browser engine drives the store through the adapter (compute + edit)', async () => {
  const host = await createBrowserHost({ id: 't', types: { Thing: { specializes: ['activity'] } }, collections: cols } as Cassette, mockExterns());
  const store = createHostStore(host, cols);
  const items = store.collection('items')!;

  host.apply('items', [{ op: 'insert', row: 'i1', values: { name: text('a'), n: num(21) } }]);
  const r = items.rows.value.find((x) => x.id === 'i1')!;
  assert.equal((r.doc.dbl as { v: number }).v, 42); // the engine computed dbl; the adapter surfaced it

  items.setField('i1', 'n', num(50));
  assert.equal((items.rows.value.find((x) => x.id === 'i1')!.doc.dbl as { v: number }).v, 100); // edit → recompute → signal
});
