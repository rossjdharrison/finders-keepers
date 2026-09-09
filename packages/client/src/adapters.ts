// Real browser adapters for the engine's two pluggable seams (the Node tests use mocks). Both
// are thin and feature-guarded, so the cassette page still runs where they are unavailable.

import type { Broadcaster, Persistence, Snapshot } from '@app/core-runtime';

/** Durability via localStorage (simple + synchronous-backed; swap for IndexedDB/OPFS if the
 * snapshot outgrows the ~5MB budget). One key per cassette instance. */
export function localStoragePersistence(key: string): Persistence {
  return {
    loadSnapshot: async () => {
      try {
        const s = localStorage.getItem(key);
        return s ? (JSON.parse(s) as Snapshot) : null;
      } catch {
        return null;
      }
    },
    saveSnapshot: async (snap) => {
      try {
        localStorage.setItem(key, JSON.stringify(snap));
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
