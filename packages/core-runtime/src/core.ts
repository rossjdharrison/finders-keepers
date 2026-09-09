// createCore — the sealed core, now over the SHARED host-agnostic engine (engine.ts) + an
// in-memory store. Its methods are the controlled ENTRY; the Externs it was given are the
// controlled EGRESS. It reuses @core through the engine (full validate + cross-collection
// recompute cascade), and adds extern resolution as the engine's host hook: source:'extern'
// fields are filled by calling externs.api(...) before each row recomputes. No I/O of its own.

import { buildPrepared, createEngine } from './engine.ts';
import type { CollectionDoc, Engine, RelationDef } from './engine.ts';
import { createMemoryStore } from './memory-store.ts';
import type { RowOp as EngineRowOp, RowState as EngineRow } from '@core/events';
import type { Value } from '@core/values';
import type { Cassette, Core, Externs, RowOp, RowState } from './types.ts';

export function createCore(externs: Externs): Core {
  const store = createMemoryStore();
  const externDecls = new Map<string, { field: string; api: string; params: Record<string, string> }[]>();
  let engine: Engine | null = null;

  // the engine's host hook: fill extern-sourced fields on a row before it recomputes.
  const resolveExterns = (coll: string, row: EngineRow): void => {
    for (const ex of externDecls.get(coll) ?? []) {
      const params: Record<string, Value> = {};
      let ready = true;
      for (const [pname, fid] of Object.entries(ex.params)) {
        const v = row.values[fid];
        if (!v || v.t === 'blank') { ready = false; break; }
        params[pname] = v;
      }
      if (ready) row.values[ex.field] = externs.api(ex.api, params);
    }
  };

  function load(cassette: Cassette): void {
    externDecls.clear();
    const docs = new Map<string, CollectionDoc>();
    for (const c of cassette.collections) {
      // to the engine an extern field is just a stored input; the runtime fills it.
      const properties: CollectionDoc['properties'] = c.properties.map((p) => ({
        id: p.id,
        valueType: p.valueType,
        source: (p.source === 'extern' ? 'stored' : p.source) as 'stored' | 'computed' | undefined,
        formula: p.source === 'extern' ? undefined : p.formula,
        category: p.category,
        availableWhen: p.source === 'extern' ? undefined : (p as { availableWhen?: unknown }).availableWhen,
      }));
      docs.set(c.id, { id: c.id, semanticClass: c.semanticClass, properties, tables: c.tables as CollectionDoc['tables'], transitions: (c as { transitions?: CollectionDoc['transitions'] }).transitions });
      externDecls.set(c.id, c.properties.filter((p) => p.source === 'extern' && p.api).map((p) => ({ field: p.id, api: p.api as string, params: p.params ?? {} })));
    }
    const relations = new Map<string, RelationDef>(Object.entries(cassette.relations ?? {}).map(([via, m]) => [via, { via, ...m }]));
    const built = buildPrepared(docs, relations, cassette.types ?? {});
    engine = createEngine(store, built, { clock: externs.clock, resolveExterns });
  }

  function apply(coll: string, ops: RowOp[]): RowState[] {
    if (!engine) throw new Error('load a cassette first');
    const engineOps: EngineRowOp[] = ops.map((op) =>
      op.op === 'insert'
        ? { op: 'insert', coll, row: op.row, values: op.values ?? {} }
        : { op: 'setField', coll, row: op.row, field: op.field, value: op.value },
    );
    const { rows } = engine.submit(engineOps, 'local');
    return rows.filter((r) => r.coll === coll).map((r) => ({ id: r.id, doc: r.doc, ...(r.hidden ? { hidden: r.hidden } : {}), ...(r.actions ? { actions: r.actions } : {}) }));
  }

  function read(coll: string): RowState[] {
    if (!engine) throw new Error('load a cassette first');
    return engine.read(coll).map((r) => ({ id: r.id, doc: r.doc, ...(r.hidden ? { hidden: r.hidden } : {}), ...(r.actions ? { actions: r.actions } : {}) }));
  }

  return { load, apply, read, snapshot: () => store.snapshot(), restore: (s) => store.restore(s) };
}
