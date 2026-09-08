// The workspace store — all collections behind one WebSocket to the WorkspaceDO.
//
// One socket carries {k:rows} broadcasts for EVERY collection; the handler groups
// them by `coll` and merges each into that collection's own map (merge-by-id,
// since the server sends only touched rows — and a task edit's cascade touches
// feature rows too, which is exactly how a rollup updates in another tab).

import { computed, signal } from '@preact/signals-core';
import type { Value } from '@core/values';
import type {
  CollectionDoc,
  CollectionStore,
  ConnStatus,
  Property,
  RelationMeta,
  RowOp,
  RowStateWire,
  TypeMap,
  WorkspaceStore,
} from './types.ts';
import { mergeRows } from './reconcile.ts';

export interface WorkspaceInit {
  baseUrl: string;
  token: string; // bearer token the DO verifies to an actor; the server stamps the VERIFIED actor
  collections: CollectionDoc[];
  relations: Record<string, RelationMeta>;
  types?: TypeMap; // domain classes specializing HQDM (reducibility enforced server-side)
  seedOps?: RowOp[]; // applied only when the workspace is empty
}

const rid = (): string => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export async function createWorkspaceStore(init: WorkspaceInit): Promise<WorkspaceStore> {
  const { baseUrl, token, collections, relations } = init;
  const at = (p: string): string => `${baseUrl}${p}`;
  const status = signal<ConnStatus>('connecting');

  async function api<T>(path: string, method: string, body: unknown): Promise<T> {
    const res = await fetch(at(path), { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  }

  let ws: WebSocket | null = null;
  const send = (ops: RowOp[]): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ k: 'ops', ops, nonce: rid() }));
    else void api('/collections/' + ops[0].coll + '/ops', 'POST', { ops }).catch(() => undefined);
  };

  // per-collection sub-store
  const stores = new Map<string, CollectionStore & { _reconcile(w: RowStateWire[]): void; _snapshot(): Promise<void> }>();
  for (const doc of collections) {
    const props = new Map<string, Property>(doc.properties.map((p) => [p.id, p]));
    const rowMap = signal(new Map<string, RowStateWire>());
    const rows = computed(() => [...rowMap.value.values()].filter((r) => !r.deleted));
    stores.set(doc.id, {
      id: doc.id,
      rows,
      propOf: (field) => props.get(field),
      labelOf(rowId, labelField) {
        const v = rowMap.value.get(rowId)?.doc[labelField];
        return v && v.t === 'text' ? v.v : rowId;
      },
      setField(row, field, value) {
        if (props.get(field)?.source === 'computed') return;
        const cur = rowMap.value.get(row);
        const next: RowStateWire = { coll: doc.id, id: row, doc: { ...(cur?.doc ?? {}), [field]: value }, deleted: cur?.deleted ?? false, seq: cur?.seq ?? 0 };
        rowMap.value = new Map(rowMap.value).set(row, next); // optimistic
        send([{ op: 'setField', coll: doc.id, row, field, value }]);
      },
      _reconcile(w) {
        rowMap.value = mergeRows(rowMap.value, w);
      },
      async _snapshot() {
        const { rows: qr } = await api<{ rows: RowStateWire[] }>(`/collections/${doc.id}/query`, 'POST', { coll: doc.id });
        rowMap.value = new Map(qr.map((r) => [r.id, r]));
      },
    });
  }

  // one-time workspace schema + relations + HQDM types, then snapshot + seed-if-empty
  await api('/workspace', 'PUT', { collections, relations, types: init.types ?? {} });
  await Promise.all([...stores.values()].map((s) => s._snapshot()));
  // Seed PER COLLECTION: a collection is seeded only when it is empty. (The `collections`
  // and `properties` meta-collections are populated by the DO on PUT and carry no seedOps,
  // so their rows never suppress domain seeding — the reason this isn't a global empty check.)
  if (init.seedOps?.length) {
    const byColl = new Map<string, RowOp[]>();
    for (const op of init.seedOps) (byColl.get(op.coll) ?? byColl.set(op.coll, []).get(op.coll)!).push(op);
    let seeded = false;
    for (const [coll, list] of byColl) {
      const store = stores.get(coll);
      if (store && store.rows.value.length === 0) {
        await api(`/collections/${coll}/ops`, 'POST', { ops: list });
        seeded = true;
      }
    }
    if (seeded) await Promise.all([...stores.values()].map((s) => s._snapshot()));
  }

  let closed = false;
  function connect(): void {
    status.value = 'connecting';
    ws = new WebSocket(at('/workspace/ws').replace(/^http/, 'ws'));
    ws.addEventListener('open', () => {
      status.value = 'open';
      ws?.send(JSON.stringify({ k: 'hello', token }));
      void Promise.all([...stores.values()].map((s) => s._snapshot())); // catch missed writes
    });
    ws.addEventListener('message', (e: MessageEvent) => {
      let f: { k?: string; rows?: RowStateWire[] };
      try {
        f = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (f.k === 'rows' && f.rows) {
        const byColl = new Map<string, RowStateWire[]>();
        for (const r of f.rows) (byColl.get(r.coll) ?? byColl.set(r.coll, []).get(r.coll)!).push(r);
        for (const [coll, list] of byColl) stores.get(coll)?._reconcile(list);
      } else if (f.k === 'reject') {
        void Promise.all([...stores.values()].map((s) => s._snapshot()));
      }
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

  return {
    status,
    collectionIds: collections.map((c) => c.id),
    collection: (id) => stores.get(id),
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
