// Pure reconcile — the ONLY writer of server-computed columns on the client.
//
// The CollectionDO broadcasts ONLY the rows a write touched (it builds the frame
// from its `touched` map), never the whole collection. So we MUST merge by id:
// a replace-all would wipe every untouched row on each edit. `deleted` removes.

import type { RowStateWire } from './types.ts';

export function mergeRows(
  current: Map<string, RowStateWire>,
  incoming: RowStateWire[],
): Map<string, RowStateWire> {
  const next = new Map(current);
  for (const r of incoming) {
    if (r.deleted) next.delete(r.id);
    else next.set(r.id, r);
  }
  return next;
}
