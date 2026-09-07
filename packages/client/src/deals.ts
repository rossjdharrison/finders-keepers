// The demo collection: a Deals pipeline. Four stored fields + ONE typed computed
// column (lineTotal = unitPrice * qty, money*num -> money(EUR)), which the SERVER
// evaluates and broadcasts. Seed rows use fixed ids so re-runs are idempotent
// (insert upserts) and only apply when the collection is empty.

import { money, num, text, enumV } from '@core/values';
import type { CollectionDoc, RowOp } from './types.ts';

export const COLLECTION = 'deals';

export const dealsDoc: CollectionDoc = {
  id: 'deals',
  properties: [
    { id: 'name', valueType: { k: 'text' }, source: 'stored' },
    { id: 'stage', valueType: { k: 'enum', set: 'stage' }, source: 'stored' },
    { id: 'qty', valueType: { k: 'num' }, source: 'stored' },
    { id: 'unitPrice', valueType: { k: 'money', ccy: 'EUR' }, source: 'stored' },
    {
      id: 'lineTotal',
      valueType: { k: 'money', ccy: 'EUR' },
      source: 'computed',
      formula: { op: 'mul', args: [{ op: 'field', id: 'unitPrice' }, { op: 'field', id: 'qty' }] },
    },
  ],
};

const eur = (amount: number) => money(Math.round(amount * 100), 2, 'EUR');

export const seedOps: RowOp[] = [
  { op: 'insert', coll: COLLECTION, row: 'd1', values: { name: text('Acme Corp'), stage: enumV('stage', 'won'), qty: num(3), unitPrice: eur(100) } },
  { op: 'insert', coll: COLLECTION, row: 'd2', values: { name: text('Globex'), stage: enumV('stage', 'proposal'), qty: num(10), unitPrice: eur(49.99) } },
  { op: 'insert', coll: COLLECTION, row: 'd3', values: { name: text('Initech'), stage: enumV('stage', 'lead'), qty: num(1), unitPrice: eur(1200) } },
  { op: 'insert', coll: COLLECTION, row: 'd4', values: { name: text('Umbrella'), stage: enumV('stage', 'proposal'), qty: num(6), unitPrice: eur(250) } },
];
