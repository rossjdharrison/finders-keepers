// The client store — a signals-backed view of one collection.
//
// Lifecycle: PUT the schema, seed once if empty, snapshot via POST /query, then
// open the WebSocket. Edits to STORED fields are applied optimistically (inline
// patch) and sent as ops; computed columns are left stale until the server's
// authoritative {k:'rows'} broadcast lands and reconcile merges them by id.
//
// Contract details that MUST hold (verified against collection-do.ts):
//  - send {k:'hello', token: actor} on open, else writes are attributed 'anon'
//  - HTTP fallback body carries {actor, ops}
//  - reconcile MERGES by id (broadcasts are touched-rows-only)
//  - computed fields are read-only (the server drops setField to them)

import { computed, signal } from '@preact/signals-core';
import type { Value } from '@core/values';
import type { ViewSpec } from '@core/query';
import type { CollectionDoc, ConnStatus, Property, RowOp, RowStateWire, Store } from './types.ts';
import { mergeRows } from './reconcile.ts';

export interface StoreInit {
  baseUrl: string; // same-origin in dev (Vite proxy forwards /collections + ws)
  collectionId: string;
  actor: string;
  collection: CollectionDoc;
  query: ViewSpec;
  seedOps?: RowOp[]; // inserted only when the collection is empty
}

const rid = (): string => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export async function createStore(init: StoreInit): Promise<Store> {
  const { baseUrl, collectionId, actor, collection, query } = init;
  const at = (p: string): string => `${baseUrl}/collections/${collectionId}${p}`;
  const props = new Map<string, Property>(collection.properties.map((p) => [p.id, p]));

  const rowMap = signal(new Map<string, RowStateWire>());
  const status = signal<ConnStatus>('connecting');
  const rows = computed(() => [...rowMap.value.values()].filter((r) => !r.deleted));

  async function api<T>(path: string, method: string, body: unknown): Promise<T> {
    const res = await fetch(at(path), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  }

  async function snapshot(): Promise<void> {
    const { rows: qr } = await api<{ rows: RowStateWire[] }>('/query', 'POST', query);
    rowMap.value = new Map(qr.map((r) => [r.id, r]));
  }

  // one-time schema + (idempotent) seed
  await api('/collection', 'PUT', collection);
  await snapshot();
  if (rowMap.value.size === 0 && init.seedOps?.length) {
    await api('/ops', 'POST', { actor, ops: init.seedOps });
    await snapshot();
  }

  let ws: WebSocket | null = null;
  let closed = false;

  function connect(): void {
    status.value = 'connecting';
    ws = new WebSocket(at('/ws').replace(/^http/, 'ws'));
    ws.addEventListener('open', () => {
      status.value = 'open';
      ws?.send(JSON.stringify({ k: 'hello', token: actor }));
      void snapshot(); // catch anything missed while the socket was down
    });
    ws.addEventListener('message', (e: MessageEvent) => {
      let f: { k?: string; rows?: RowStateWire[] };
      try {
        f = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (f.k === 'rows' && f.rows) rowMap.value = mergeRows(rowMap.value, f.rows);
      else if (f.k === 'reject') void snapshot(); // drop optimistic edit, refetch truth
    });
    ws.addEventListener('close', () => {
      status.value = 'closed';
      if (!closed) setTimeout(connect, 800);
    });
    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    });
  }
  connect();

  function send(ops: RowOp[]): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ k: 'ops', ops, nonce: rid() }));
    else void api('/ops', 'POST', { actor, ops }).catch(() => undefined);
  }

  return {
    rows,
    status,
    propOf: (id) => props.get(id),
    setField(row, field, value) {
      if (props.get(field)?.source === 'computed') return; // server would drop it
      const cur = rowMap.value.get(row);
      const nextRow: RowStateWire = {
        id: row,
        doc: { ...(cur?.doc ?? {}), [field]: value },
        deleted: cur?.deleted ?? false,
        seq: cur?.seq ?? 0,
      };
      rowMap.value = new Map(rowMap.value).set(row, nextRow); // optimistic
      send([{ op: 'setField', coll: collectionId, row, field, value }]);
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export type { Value };
