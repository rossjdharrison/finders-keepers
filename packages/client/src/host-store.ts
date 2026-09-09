// createHostStore — the data-source adapter that makes the in-browser engine look exactly like
// the DO-backed WorkspaceStore the renderers already consume. This is the clean seam: it deals
// ONLY in data — rows in (as signals), ops out (setField → host.apply) — and carries NO
// presentation. A renderer cannot tell whether its rows come from the Durable Object over a
// socket or from the sealed core in this tab. Swapping the data source is swapping this adapter.

import { computed, signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import type { BrowserHost } from '@app/core-runtime';
import type { CollectionDoc, ConnStatus, Property, RowStateWire, WorkspaceStore } from './types.ts';

export function createHostStore(host: BrowserHost, collections: CollectionDoc[]): WorkspaceStore {
  const status = signal<ConnStatus>('open'); // local engine — always "connected"
  const rowsById = new Map<string, Signal<RowStateWire[]>>();
  const stores = new Map<string, ReturnType<typeof makeStore>>();

  const toWire = (coll: string, r: { id: string; doc: RowStateWire['doc']; hidden?: string[]; actions?: RowStateWire['actions'] }): RowStateWire => ({
    coll, id: r.id, doc: r.doc, deleted: false, seq: 0, ...(r.hidden ? { hidden: r.hidden } : {}), ...(r.actions ? { actions: r.actions } : {}),
  });

  function makeStore(doc: CollectionDoc) {
    const props = new Map<string, Property>(doc.properties.map((p) => [p.id, p]));
    const sig = signal<RowStateWire[]>([]);
    rowsById.set(doc.id, sig);
    return {
      id: doc.id,
      rows: computed(() => sig.value),
      propOf: (field: string) => props.get(field),
      labelOf(rowId: string, labelField: string) {
        const v = sig.value.find((r) => r.id === rowId)?.doc[labelField];
        return v && v.t === 'text' ? v.v : rowId;
      },
      setField(row: string, field: string, value: RowStateWire['doc'][string]) {
        if (props.get(field)?.source !== 'stored') return; // computed/extern are engine-owned
        host.apply(doc.id, [{ op: 'setField', row, field, value }]); // fires the host's subscribers → refresh
      },
    };
  }
  for (const doc of collections) stores.set(doc.id, makeStore(doc));

  const refresh = (): void => {
    for (const doc of collections) rowsById.get(doc.id)!.value = host.read(doc.id).map((r) => toWire(doc.id, r));
  };
  refresh();
  host.subscribe(refresh); // any apply (this tab or, via the broadcaster, another) re-reads

  return {
    status,
    collectionIds: collections.map((c) => c.id),
    collection: (id) => stores.get(id),
    close() {},
  };
}
