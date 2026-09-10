// Real browser adapters for the engine's two pluggable seams (the Node tests use mocks). Both
// are thin and feature-guarded, so the cassette page still runs where they are unavailable.

import type { Broadcaster, Cassette, Persistence, Snapshot } from '@app/core-runtime';

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; // djb2
  return (h >>> 0).toString(36);
};

/** A signature of a cassette's SHAPE — everything whose change would make a restored snapshot INVALID
 * against the current cassette, while deliberately EXCLUDING the parts that legitimately change without
 * breaking a restore (formula literals + table cell values — i.e. rate/threshold tuning, which must keep the
 * user's entered rows). It covers: per field its id + full valueType (so a type / enum-set / ref-target
 * change bumps it) + source; each enum set's option ids (so a renamed/removed option is caught, not silently
 * fallen through a lookup default = a wrong price); each table's KEY set (not its values); the relations; the
 * seed row identities; and the total field. A persisted runtime snapshot is stamped with this, so a snapshot
 * saved against an OLD shape is discarded rather than restored into a mismatched cassette. */
export function snapshotSignature(cassette: Cassette): string {
  const colls = (cassette.collections ?? []).map((c) => {
    const props = (c.properties ?? [])
      .map((p) => `${p.id}:${JSON.stringify((p as { valueType?: unknown }).valueType ?? {})}:${(p as { source?: string }).source ?? 'stored'}`)
      .sort();
    const tables = Object.entries((c.tables ?? {}) as Record<string, { map?: Record<string, unknown> }>)
      .map(([tid, t]) => `${tid}:${Object.keys(t.map ?? {}).sort().join(',')}`)
      .sort();
    return `${c.id}[${props.join('|')}][${tables.join('|')}]`;
  }).sort();
  const enums = Object.entries((cassette as { enums?: Record<string, { id: string }[]> }).enums ?? {})
    .map(([set, opts]) => `${set}:${(opts ?? []).map((o) => o.id).sort().join(',')}`)
    .sort();
  const relations = Object.keys((cassette as { relations?: Record<string, unknown> }).relations ?? {}).sort();
  const seed = ((cassette as { seed?: { coll: string; row: string }[] }).seed ?? [])
    .map((s) => `${s.coll}/${s.row}`)
    .sort();
  const total = (cassette as { journey?: { summary?: { total?: string } } }).journey?.summary?.total ?? '';
  return hash(JSON.stringify({ colls, enums, relations, seed, total }));
}

interface Versioned { __sig?: string; snap?: Snapshot }

/** Durability via localStorage (simple + synchronous-backed; swap for IndexedDB/OPFS if the
 * snapshot outgrows the ~5MB budget). One key per cassette instance. When a `signature` is given, the
 * snapshot is wrapped with it and a stored snapshot whose signature does not match (including a legacy,
 * un-stamped one) is treated as absent — so the host re-seeds a fresh, compatible state. */
export function localStoragePersistence(key: string, signature?: string): Persistence {
  return {
    loadSnapshot: async () => {
      try {
        const s = localStorage.getItem(key);
        if (!s) return null;
        const parsed = JSON.parse(s) as Snapshot | Versioned;
        if (signature === undefined) return parsed as Snapshot; // unversioned callers: unchanged behaviour
        const v = parsed as Versioned;
        return v && v.__sig === signature && v.snap ? v.snap : null; // mismatch / legacy → discard
      } catch {
        return null;
      }
    },
    saveSnapshot: async (snap) => {
      try {
        localStorage.setItem(key, signature === undefined ? JSON.stringify(snap) : JSON.stringify({ __sig: signature, snap } as Versioned));
      } catch {
        /* private mode / over quota: durability is best-effort */
      }
    },
  };
}

/** Cross-tab liveness via BroadcastChannel — no server. Never echoes to the sender. */
export function broadcastChannelBroadcaster(name: string): Broadcaster {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null;
  return {
    post: (s) => {
      try {
        bc?.postMessage(s);
      } catch {
        /* ignore */
      }
    },
    onMessage: (cb) => {
      if (bc) bc.onmessage = (e: MessageEvent) => cb(e.data as Snapshot);
    },
  };
}
