// An in-memory Store — the browser/Node adapter behind the engine (the SQLite adapter is the
// DO's). snapshot()/restore() give the browser host a serializable state for IndexedDB/OPFS.

import type { Committed, RowState } from '@core/events';
import type { Store } from './engine.ts';
import type { Snapshot } from './types.ts';

export interface MemoryStore extends Store {
  snapshot(): Snapshot;
  restore(s: Snapshot): void;
  oplog(): Committed[];
}

export function createMemoryStore(): MemoryStore {
  const rows = new Map<string, Map<string, RowState>>();
  const log: Committed[] = [];
  let seq = 0;
  const coll = (c: string): Map<string, RowState> => rows.get(c) ?? rows.set(c, new Map()).get(c)!;

  return {
    getRow: (c, id) => coll(c).get(id) ?? null,
    putRow: (c, row) => void coll(c).set(row.id, row),
    allRows: (c) => [...coll(c).values()].filter((r) => !r.deleted),
    childrenByRef: (childColl, childField, parentId) =>
      [...coll(childColl).values()].filter((r) => {
        if (r.deleted) return false;
        const v = r.values[childField];
        return !!v && v.t === 'ref' && v.id === parentId;
      }),
    nextSeq: () => ++seq,
    appendOp: (op) => void log.push(op),
    oplog: () => log,
    snapshot: () => ({ seq, rows: Object.fromEntries([...rows].map(([c, m]) => [c, [...m.values()]])) }),
    restore: (s) => {
      rows.clear();
      seq = s.seq ?? 0;
      for (const [c, list] of Object.entries(s.rows ?? {})) rows.set(c, new Map(list.map((r) => [r.id, r])));
    },
  };
}
