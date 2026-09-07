import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { CollectionDoc } from '../src/collection-do.ts';

const BASE = 'https://x/collections/deals';

const money = (minor: string, ccy = 'EUR') => ({ t: 'money', minor, scale: 2, ccy });
const num = (v: number) => ({ t: 'num', v });
const enumV = (v: string) => ({ t: 'enum', set: 'stage', v });

const collection: CollectionDoc = {
  id: 'deals',
  properties: [
    { id: 'name', valueType: { k: 'text' }, source: 'stored' },
    { id: 'unitPrice', valueType: { k: 'money', ccy: 'EUR' }, source: 'stored' },
    { id: 'qty', valueType: { k: 'num' }, source: 'stored' },
    { id: 'stage', valueType: { k: 'enum', set: 'stage' }, source: 'stored' },
    {
      id: 'lineTotal',
      valueType: { k: 'money', ccy: 'EUR' },
      source: 'computed',
      formula: { op: 'mul', args: [{ op: 'field', id: 'unitPrice' }, { op: 'field', id: 'qty' }] },
    },
  ],
};

const put = (path: string, body: unknown, method = 'POST') =>
  SELF.fetch(BASE + path, { method, body: JSON.stringify(body) });

describe('CollectionDO', () => {
  it('typed computed column recomputes on write, is queryable, and updates on edit', async () => {
    expect((await put('/collection', collection, 'PUT')).ok).toBe(true);

    // insert a deal: 100.00 EUR x 3  ->  lineTotal 300.00 EUR (money*num, exact)
    const ins = await put('/ops', {
      actor: 'u1',
      ops: [
        {
          op: 'insert',
          coll: 'deals',
          row: 'd1',
          values: { name: { t: 'text', v: 'Acme' }, unitPrice: money('10000'), qty: num(3), stage: enumV('won') },
        },
      ],
    });
    const insBody = (await ins.json()) as { assigned: number[]; rows: { doc: Record<string, unknown> }[] };
    expect(insBody.assigned).toEqual([1]);
    expect(insBody.rows[0].doc.lineTotal).toEqual(money('30000'));

    // query: stage = won returns the row (SQL over embedded SQLite, incl. the computed col)
    const q = await put('/query', { coll: 'deals', filter: { field: 'stage', op: 'eq', value: enumV('won') } });
    const qBody = (await q.json()) as { rows: { id: string; doc: Record<string, unknown> }[] };
    expect(qBody.rows).toHaveLength(1);
    expect(qBody.rows[0].id).toBe('d1');
    expect(qBody.rows[0].doc.lineTotal).toEqual(money('30000'));

    // edit qty to 5 -> lineTotal recomputes to 500.00 EUR
    const upd = await put('/ops', { ops: [{ op: 'setField', coll: 'deals', row: 'd1', field: 'qty', value: num(5) }] });
    const updBody = (await upd.json()) as { rows: { doc: Record<string, unknown> }[] };
    expect(updBody.rows[0].doc.lineTotal).toEqual(money('50000'));
  });

  it('rejects a write before the schema is set, as a value not a crash', async () => {
    const r = await SELF.fetch('https://x/collections/empty/ops', {
      method: 'POST',
      body: JSON.stringify({ ops: [{ op: 'setField', coll: 'empty', row: 'r', field: 'x', value: num(1) }] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toHaveProperty('error');
  });

  it('broadcasts recomputed rows to a connected WebSocket', async () => {
    await put('/collection', collection, 'PUT');
    const res = await SELF.fetch(BASE + '/ws', { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();

    const got = new Promise<any>((resolve) => {
      ws!.addEventListener('message', (e: MessageEvent) => {
        const f = JSON.parse(e.data as string);
        if (f.k === 'rows') resolve(f);
      });
    });

    await put('/ops', {
      actor: 'u2',
      ops: [
        { op: 'insert', coll: 'deals', row: 'd2', values: { unitPrice: money('5000'), qty: num(2), stage: enumV('lead') } },
      ],
    });

    const frame = await got;
    expect(frame.rows[0].doc.lineTotal).toEqual(money('10000')); // 50.00 x 2 = 100.00
  });
});
