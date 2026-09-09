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
  opts: { persistence?: Persistence; broadcaster?: Broadcaster } = {},
): Promise<BrowserHost> {
  core.load(cassette);
  const subs = new Set<() => void>();
  const notify = (): void => { for (const cb of subs) cb(); };

  // durability: restore the last computed state (externs are NOT re-run); else seed the cassette's
  // example rows (applied through the engine once, so their externs resolve + premium computes).
  const saved = opts.persistence ? await opts.persistence.loadSnapshot() : null;
  if (saved) core.restore(saved);
  else for (const s of cassette.seed ?? []) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);

  // cross-tab: adopt another tab's state (BroadcastChannel never echoes to the sender)
  opts.broadcaster?.onMessage((s) => { core.restore(s); notify(); });

  return {
    read: (coll) => core.read(coll),
    apply: (coll, ops) => {
      const rows = core.apply(coll, ops);
      const snap = core.snapshot();
      void opts.persistence?.saveSnapshot(snap);
      opts.broadcaster?.post(snap);
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
