// Save-time cycle guard + per-record evaluation order among COMPUTED columns.
// A Kahn topological sort restricted to edges between computed columns (deps on
// plain stored inputs are ignored). A cycle is rejected with #CYCLE and the loop
// members named, so the editor can highlight them. Evolves the PoC's topoComputed.

export interface HasDeps {
  id: string;
  deps: string[];
}

export type TopoResult = { order: string[] } | { cycle: string[] };

export function topoOrCycle(cols: HasDeps[]): TopoResult {
  const ids = new Set(cols.map((c) => c.id));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const c of cols) {
    indeg.set(c.id, 0);
    out.set(c.id, []);
  }
  for (const c of cols) {
    for (const d of c.deps) {
      if (!ids.has(d)) continue; // dep on a stored input, not a computed column — no edge
      out.get(d)!.push(c.id);
      indeg.set(c.id, (indeg.get(c.id) ?? 0) + 1);
    }
  }
  const queue = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of out.get(n)!) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length !== cols.length) {
    return { cycle: cols.map((c) => c.id).filter((id) => !order.includes(id)) };
  }
  return { order };
}
