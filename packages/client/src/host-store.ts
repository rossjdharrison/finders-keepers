// createHostStore — the data-source adapter that makes the in-browser engine look exactly like
// the DO-backed WorkspaceStore the renderers already consume. This is the clean seam: it deals
// ONLY in data — rows in (as signals), ops out (setField → host.apply) — and carries NO
// presentation. A renderer cannot tell whether its rows come from the Durable Object over a
// socket or from the sealed core in this tab. Swapping the data source is swapping this adapter.

import { computed, signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import type { BrowserHost } from '@app/core-runtime';
import type { CollectionDoc, ConnStatus, Property, RowStateWire, WorkspaceStore } from './types.ts';

/** Re-apply every stored input on every row so the engine recomputes all derived fields under the
 * CURRENT rules. Needed on boot when an EDITED model is loaded over a persisted row snapshot: restore
 * reloads the stored computed docs verbatim and never recomputes, and the cascade only re-fires on a
 * later apply — so an edited rule on a collection with no extern re-trigger (e.g. a covers rate in the
 * composed model) would otherwise show a STALE rolled-up total until the user happens to edit a field.
 * Touching each row's stored inputs re-runs engine.submit per row and cascades the rollups. Idempotent
 * (re-setting a value to itself), so it is safe to run whenever the effective rules may differ from the
 * snapshot; children are touched last so the application's rollup ends on fresh subtotals. */
export function recomputeAll(host: BrowserHost, collections: CollectionDoc[]): void {
  for (const doc of collections) {
    const stored = doc.properties.filter((p) => p.source === 'stored').map((p) => p.id);
    if (!stored.length) continue;
    for (const r of host.read(doc.id)) {
      const ops = stored
        .filter((f) => r.doc[f] !== undefined && r.doc[f].t !== 'blank')
        .map((f) => ({ op: 'setField' as const, row: r.id, field: f, value: r.doc[f] }));
      if (ops.length) host.apply(doc.id, ops);
    }
  }
}

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
