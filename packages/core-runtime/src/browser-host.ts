// The browser host — the client-only replacement for the DO + WebSocket. It wraps the sealed
// core with two PLUGGABLE seams so the same logic runs in a browser or a test:
//   - Persistence (IndexedDB/OPFS in the browser; a mock in tests) — durability.
//   - Broadcaster (BroadcastChannel in the browser; a mock in tests) — cross-tab liveness.
// It carries STATE SNAPSHOTS, not an op-log to replay, so an extern (a mock API) is called
// exactly once — the computed result travels, never re-run on another tab or on reload.
// No server. The resolve → RenderPlan → renderer → hooks → CSS pipeline is unchanged; only the
// data source moves from a socket to this in-process core.

import { createCore } from './core.ts';
import type { Cassette, Core, Externs, RowOp, RowState, Snapshot } from './types.ts';

export interface Persistence {
  loadSnapshot(): Promise<Snapshot | null>;
  saveSnapshot(s: Snapshot): Promise<void>;
}
export interface Broadcaster {
  post(s: Snapshot): void;
  onMessage(cb: (s: Snapshot) => void): void;
}
export interface BrowserHost {
  read(coll: string): RowState[];
  apply(coll: string, ops: RowOp[]): RowState[];
  subscribe(cb: () => void): () => void;
}

/**
 * Run a browser host over an ALREADY-CONSTRUCTED core. The core may be the in-process @core
 * (createCore) or the same core SEALED IN WASM (SealedCore from @app/core-wasm) — both satisfy the
 * Core contract, so the persistence + broadcaster + subscribe plumbing here, and every renderer
 * downstream, is byte-identical regardless of WHERE the core actually runs. That is the whole point
 * of the seam: presentation never learns whether the engine is in this JS context or inside wasm.
 */
export async function createBrowserHostOver(
  core: Core,
  cassette: Cassette,
  opts: { persistence?: Persistence; broadcaster?: Broadcaster; signature?: string } = {},
): Promise<BrowserHost> {
  core.load(cassette);
  const subs = new Set<() => void>();
  const notify = (): void => { for (const cb of subs) cb(); };
  const sig = opts.signature;

  // durability: restore the last computed state (externs are NOT re-run); else seed the cassette's
  // example rows (applied through the engine once, so their externs resolve + premium computes).
  const saved = opts.persistence ? await opts.persistence.loadSnapshot() : null;
  if (saved) core.restore(saved);
  else for (const s of cassette.seed ?? []) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  let lastSeq = core.snapshot().seq;

  // cross-tab: adopt another tab's state (BroadcastChannel never echoes to the sender). Gate it by the SAME
  // shape signature as persistence (so a tab on an OLD deploy cannot push a stale-shaped snapshot into a tab
  // on the new one) and by monotonic seq (never restore backward) — otherwise a rejected snapshot could be
  // re-persisted here under the current valid signature, amplifying the poison.
  opts.broadcaster?.onMessage((s) => {
    const inSig = (s as { __sig?: string }).__sig;
    if (sig !== undefined && inSig !== sig) return; // cross-version / unstamped broadcast — ignore
    if (typeof s.seq === 'number' && s.seq <= lastSeq) return; // stale/backward — ignore
    core.restore(s);
    lastSeq = s.seq;
    notify();
  });

  return {
    read: (coll) => core.read(coll),
    apply: (coll, ops) => {
      const rows = core.apply(coll, ops);
      const snap = core.snapshot();
      lastSeq = snap.seq;
      void opts.persistence?.saveSnapshot(snap);
      // stamp the broadcast with the signature so peers can reject a cross-version snapshot
      opts.broadcaster?.post(sig !== undefined ? ({ ...snap, __sig: sig } as Snapshot) : snap);
      notify();
      return rows;
    },
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}

/** The in-process convenience: build a @core in THIS JS context and run a host over it. */
export function createBrowserHost(
  cassette: Cassette,
  externs: Externs,
  opts: { persistence?: Persistence; broadcaster?: Broadcaster } = {},
): Promise<BrowserHost> {
  return createBrowserHostOver(createCore(externs), cassette, opts);
}
