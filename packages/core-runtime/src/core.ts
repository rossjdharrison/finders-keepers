// createCore — the sealed core. Reuses @core (HQDM reducibility + the total formula engine)
// to interpret a cassette. Its methods are the controlled ENTRY; the Externs it was given are
// the controlled EGRESS. It does no I/O: any external/API value comes from externs.api(), any
// clock from externs.clock() — exactly the wasm import model.
//
// Stage 1a scope: per-record compute (evalRecord) — enough for a configurator cassette like
// car insurance (one application row with computed fields). The cross-collection recompute
// cascade (lifted from the WorkspaceDO) arrives when the browser host replaces the server.

import { reduces } from '@core/ontology';
import type { TypeMap } from '@core/ontology';
import { compile, evalRecord, topoOrCycle } from '@core/formula';
import type { CompiledColumn, Node, Resolver, TableDef } from '@core/formula';
import type { Value, ValueType, VRef } from '@core/values';
import type { Cassette, Core, Externs, RowOp, RowState } from './types.ts';

interface Prepared {
  schema: Record<string, ValueType>;
  computedIds: Set<string>;
  cols: CompiledColumn[]; // topo-ordered within a record
  tables?: Record<string, TableDef>;
  externs: { field: string; api: string; params: Record<string, string> }[];
}

export function createCore(externs: Externs): Core {
  const prepared = new Map<string, Prepared>();
  const rows = new Map<string, Map<string, RowState>>();
  let types: TypeMap = {};

  // no relations in stage 1a: related/cell are inert; columnType feeds the typechecker
  const resolver: Resolver = { related: () => [], cell: () => ({ t: 'blank' }), columnType: (c, col) => prepared.get(c)?.schema[col] };

  function load(cassette: Cassette): void {
    types = cassette.types ?? {};
    for (const id of Object.keys(types)) {
      if (!reduces(id, types)) throw new Error(`type '${id}' does not reduce to HQDM (fix its 'specializes' chain)`);
    }
    prepared.clear();
    rows.clear();
    for (const c of cassette.collections) {
      if (!reduces(c.semanticClass, types)) throw new Error(`collection '${c.id}': semanticClass '${c.semanticClass}' does not reduce to HQDM`);
      const schema: Record<string, ValueType> = {};
      for (const p of c.properties) {
        schema[p.id] = p.valueType;
        if (p.category && !reduces(p.category, types)) throw new Error(`'${c.id}.${p.id}': category '${p.category}' does not reduce to HQDM`);
      }
      const tables = c.tables as Record<string, TableDef> | undefined;
      const compileCtx = { columns: schema, resolver, relations: {}, tables };
      const computedIds = new Set(c.properties.filter((p) => p.source === 'computed').map((p) => p.id));
      const cols: CompiledColumn[] = [];
      for (const p of c.properties) {
        if (p.source === 'computed' && p.formula) {
          const r = compile(p.id, p.formula as Node, compileCtx);
          if ('errors' in r) throw new Error(`compile ${c.id}.${p.id}: ${r.errors.map((e) => e.message).join('; ')}`);
          cols.push(r);
        }
      }
      const ordered = topoOrCycle(cols);
      if ('cycle' in ordered) throw new Error(`cyclic computed columns in ${c.id}: ${ordered.cycle.join(', ')}`);
      const byId = new Map(cols.map((col) => [col.id, col]));
      const orderedCols = ordered.order.map((id) => byId.get(id)).filter((x): x is CompiledColumn => x !== undefined);
      const externDecls = c.properties
        .filter((p) => p.source === 'extern' && p.api)
        .map((p) => ({ field: p.id, api: p.api as string, params: p.params ?? {} }));
      prepared.set(c.id, { schema, computedIds, cols: orderedCols, tables, externs: externDecls });
      rows.set(c.id, new Map());
    }
  }

  function recompute(coll: string, row: RowState): RowState {
    const p = prepared.get(coll);
    if (!p) throw new Error(`unknown collection ${coll}`);
    // resolve extern fields: when their source fields are present, CALL THE HOST EXTERN
    // (the mock API). This is the only reach outside the core.
    for (const ex of p.externs) {
      const params: Record<string, Value> = {};
      let ready = true;
      for (const [pname, fid] of Object.entries(ex.params)) {
        const v = row.doc[fid];
        if (!v || v.t === 'blank') { ready = false; break; }
        params[pname] = v;
      }
      if (ready) row.doc[ex.field] = externs.api(ex.api, params);
    }
    // recompute the computed columns purely, via @core (topo-ordered; total)
    const inputs: Record<string, Value> = {};
    for (const [k, v] of Object.entries(row.doc)) if (!p.computedIds.has(k)) inputs[k] = v;
    const self: VRef = { t: 'ref', collection: coll, id: row.id };
    const computed = evalRecord(p.cols, inputs, { clock: externs.clock(), resolver, self, tables: p.tables });
    return { id: row.id, doc: { ...inputs, ...computed } };
  }

  function apply(coll: string, ops: RowOp[]): RowState[] {
    const store = rows.get(coll);
    if (!store) throw new Error(`unknown collection ${coll}`);
    const touched = new Set<string>();
    for (const op of ops) {
      if (op.op === 'insert') store.set(op.row, { id: op.row, doc: { ...(op.values ?? {}) } });
      else {
        const cur = store.get(op.row) ?? { id: op.row, doc: {} };
        cur.doc[op.field] = op.value;
        store.set(op.row, cur);
      }
      touched.add(op.row);
    }
    const out: RowState[] = [];
    for (const id of touched) {
      const next = recompute(coll, store.get(id)!);
      store.set(id, next);
      out.push(next);
    }
    return out;
  }

  const read = (coll: string): RowState[] => [...(rows.get(coll)?.values() ?? [])];

  return { load, apply, read };
}
