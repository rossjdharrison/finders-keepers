// The host-agnostic workspace engine — lifted out of the WorkspaceDO so the SAME logic runs
// in the browser (over an in-memory / IndexedDB store) and, later, in the (now optional) DO
// (over SQLite). It owns the load-bearing behaviour: validate-before-persist (HQDM reduce +
// typecheck + acyclicity), the per-record recompute, availableWhen → hidden, the transition
// guards, and the rank-ordered cross-collection recompute CASCADE. Storage is abstracted
// behind `Store`; the host supplies it (and a clock). Nothing here does I/O.

import { reduces } from '@core/ontology';
import type { TypeMap } from '@core/ontology';
import { applicable, compile, evalRecord, topoOrCycle } from '@core/formula';
import type { CompiledColumn, Node, RelationMeta, Resolver, TableDef } from '@core/formula';
import { applyOp } from '@core/events';
import type { Committed, RowOp, RowState } from '@core/events';
import { equals } from '@core/values';
import type { Value, VRef } from '@core/values';

export interface Property {
  id: string;
  valueType: import('@core/values').ValueType;
  source?: 'stored' | 'computed';
  formula?: unknown;
  category?: string;
  availableWhen?: unknown;
}
export interface Transition { id: string; field: string; from?: string; to: string; when: unknown; category?: string }
export interface CollectionDoc {
  id: string;
  properties: Property[];
  semanticClass: string;
  tables?: Record<string, TableDef>;
  transitions?: Transition[];
}
export interface RelationDef extends RelationMeta { via: string }
export interface RowWire { coll: string; id: string; doc: Record<string, Value>; deleted: boolean; seq: number; hidden?: string[] }

/** The storage the engine runs over — SQLite in the DO, in-memory/IndexedDB in the browser. */
export interface Store {
  getRow(coll: string, id: string): RowState | null;
  putRow(coll: string, row: RowState): void;
  allRows(coll: string): RowState[]; // live (non-deleted)
  childrenByRef(childColl: string, childField: string, parentId: string): RowState[];
  nextSeq(): number;
  appendOp?(op: Committed): void; // oplog (optional)
}

interface Prepared {
  schema: Record<string, import('@core/values').ValueType>;
  computedIds: Set<string>;
  cols: CompiledColumn[];
  tables?: Record<string, TableDef>;
  gated: { id: string; ast: Node }[];
  transitions: { id: string; field: string; from?: string; to: string; when: Node }[];
}
export interface Built {
  prepared: Map<string, Prepared>;
  relations: Map<string, RelationDef>;
  relByChild: Map<string, RelationDef[]>;
  rolledUpVias: Set<string>;
  rank: Map<string, number>;
}

function docEq(a: Record<string, Value>, b: Record<string, Value>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const bv = b[k];
    if (bv === undefined || !equals(a[k], bv)) return false;
  }
  return true;
}

// Rank so that for every rolled-up child->parent edge, rank(parent) > rank(child).
function kahnRank(nodes: Set<string>, edges: [string, string][]): Map<string, number> {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();
  for (const n of nodes) { indeg.set(n, 0); adj.set(n, []); rank.set(n, 0); }
  for (const [f, t] of edges) {
    if (!nodes.has(f) || !nodes.has(t)) continue;
    adj.get(f)!.push(t);
    indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }
  const q = [...nodes].filter((n) => indeg.get(n) === 0);
  let seen = 0;
  while (q.length) {
    const n = q.shift()!;
    seen++;
    for (const m of adj.get(n)!) {
      rank.set(m, Math.max(rank.get(m) ?? 0, (rank.get(n) ?? 0) + 1));
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) q.push(m);
    }
  }
  if (seen !== nodes.size) throw new Error('cyclic relation graph');
  return rank;
}

/** Validate + compile a whole workspace. Throws on any problem, so callers validate before
 * persisting. Pure — no storage. (Lifted verbatim from the WorkspaceDO.) */
export function buildPrepared(docs: Map<string, CollectionDoc>, relations: Map<string, RelationDef>, types: TypeMap): Built {
  for (const id of Object.keys(types)) {
    if (!reduces(id, types)) throw new Error(`type '${id}' does not reduce to HQDM (bad or missing 'specializes' chain)`);
  }
  for (const [coll, doc] of docs) {
    if (!doc.semanticClass) throw new Error(`collection '${coll}' must declare a semanticClass`);
    if (!reduces(doc.semanticClass, types)) throw new Error(`collection '${coll}': semanticClass '${doc.semanticClass}' does not reduce to HQDM`);
    for (const p of doc.properties) if (p.category && !reduces(p.category, types)) throw new Error(`'${coll}.${p.id}': category '${p.category}' does not reduce to HQDM`);
    for (const t of doc.transitions ?? []) if (t.category && !reduces(t.category, types)) throw new Error(`'${coll}' transition '${t.id}': category '${t.category}' does not reduce to HQDM`);
  }
  const schemas = new Map<string, Record<string, import('@core/values').ValueType>>();
  for (const [coll, doc] of docs) {
    const s: Record<string, import('@core/values').ValueType> = {};
    for (const p of doc.properties) s[p.id] = p.valueType;
    schemas.set(coll, s);
  }
  const relByChild = new Map<string, RelationDef[]>();
  const relRecord: Record<string, RelationMeta> = {};
  for (const def of relations.values()) {
    (relByChild.get(def.childColl) ?? relByChild.set(def.childColl, []).get(def.childColl)!).push(def);
    relRecord[def.via] = def;
  }
  const typeResolver: Resolver = { related: () => [], cell: () => ({ t: 'blank' }), columnType: (c, col) => schemas.get(c)?.[col] };
  const prepared = new Map<string, Prepared>();
  for (const [coll, doc] of docs) {
    const schema = schemas.get(coll)!;
    const tables = doc.tables;
    const compileCtx = { columns: schema, resolver: typeResolver, relations: relRecord, tables };
    const computedIds = new Set(doc.properties.filter((p) => p.source === 'computed').map((p) => p.id));
    const cols: CompiledColumn[] = [];
    const gated: { id: string; ast: Node }[] = [];
    for (const p of doc.properties) {
      if (p.source === 'computed' && p.formula) {
        const r = compile(p.id, p.formula as Node, compileCtx);
        if ('errors' in r) throw new Error(`compile ${coll}.${p.id}: ${r.errors.map((e) => e.message).join('; ')}`);
        cols.push(r);
      }
      if (p.availableWhen) {
        const g = compile(`__avail_${p.id}`, p.availableWhen as Node, compileCtx);
        if ('errors' in g) throw new Error(`availableWhen ${coll}.${p.id}: ${g.errors.map((e) => e.message).join('; ')}`);
        if (g.type.k !== 'bool') throw new Error(`availableWhen ${coll}.${p.id} must be boolean, got ${g.type.k}`);
        gated.push({ id: p.id, ast: p.availableWhen as Node });
      }
    }
    const ordered = topoOrCycle(cols);
    if ('cycle' in ordered) throw new Error(`cyclic computed columns in ${coll}: ${ordered.cycle.join(', ')}`);
    const byId = new Map(cols.map((c) => [c.id, c]));
    const orderedCols = ordered.order.map((id) => byId.get(id)).filter((c): c is CompiledColumn => c !== undefined);
    const transitions: { id: string; field: string; from?: string; to: string; when: Node }[] = [];
    for (const t of doc.transitions ?? []) {
      if (!schema[t.field]) throw new Error(`transition '${t.id}': field '${t.field}' does not exist in ${coll}`);
      const g = compile(`__guard_${t.id}`, t.when as Node, compileCtx);
      if ('errors' in g) throw new Error(`transition '${t.id}' guard: ${g.errors.map((e) => e.message).join('; ')}`);
      if (g.type.k !== 'bool') throw new Error(`transition '${t.id}' guard must be boolean, got ${g.type.k}`);
      transitions.push({ id: t.id, field: t.field, from: t.from, to: t.to, when: t.when as Node });
    }
    prepared.set(coll, { schema, computedIds, cols: orderedCols, tables, gated, transitions });
  }
  const rolledUpVias = new Set<string>();
  for (const p of prepared.values()) for (const c of p.cols) for (const rd of c.rollupDeps) rolledUpVias.add(rd.via);
  const edges: [string, string][] = [];
  for (const via of rolledUpVias) {
    const def = relations.get(via);
    if (!def) continue;
    if (def.parentColl === def.childColl) throw new Error(`self-relation not allowed: ${via}`);
    edges.push([def.childColl, def.parentColl]);
  }
  const rank = kahnRank(new Set(docs.keys()), edges);
  return { prepared, relations, relByChild, rolledUpVias, rank };
}

export interface EngineOpts {
  clock: () => { today: number; nowMs: number };
  /** a host hook to fill extern-sourced fields on a row before it recomputes (core-runtime uses it) */
  resolveExterns?: (coll: string, row: RowState) => void;
}

export interface Engine {
  submit(ops: RowOp[], actor: string): { assigned: number[]; rows: RowWire[] };
  read(coll: string): RowWire[];
}

/** The write path + cascade, over a Store. `built` comes from buildPrepared. */
export function createEngine(store: Store, built: Built, opts: EngineOpts): Engine {
  const { prepared, relations, relByChild, rolledUpVias, rank } = built;
  const key = (c: string, r: string) => `${c} ${r}`;
  const refIdOf = (v: Value | undefined): string | null => (v && v.t === 'ref' ? v.id : null);

  const resolver: Resolver = {
    related(from: VRef, via: string): VRef[] {
      const rel = relations.get(via);
      if (!rel || rel.parentColl !== from.collection) return [];
      return store.childrenByRef(rel.childColl, rel.childField, from.id).map((r) => ({ t: 'ref', collection: rel.childColl, id: r.id }));
    },
    cell(ref: VRef, column: string): Value {
      const r = store.getRow(ref.collection, ref.id);
      return r && !r.deleted ? (r.values[column] ?? { t: 'blank' }) : { t: 'blank' };
    },
    columnType: (coll, col) => prepared.get(coll)?.schema[col],
  };

  const recompute = (coll: string, vals: Record<string, Value>, p: Prepared, self: VRef): Record<string, Value> => {
    const inputs: Record<string, Value> = {};
    for (const [k, v] of Object.entries(vals)) if (!p.computedIds.has(k)) inputs[k] = v;
    const computed = evalRecord(p.cols, inputs, { clock: opts.clock(), resolver, self, tables: p.tables });
    return { ...inputs, ...computed };
  };
  const hiddenFields = (vals: Record<string, Value>, p: Prepared, self: VRef): string[] => {
    if (!p.gated.length) return [];
    const ctx = { clock: opts.clock(), resolver, self, tables: p.tables };
    return p.gated.filter((g) => !applicable(g.ast, vals, ctx)).map((g) => g.id);
  };
  const guardTransitions = (op: RowOp, before: RowState | null, folded: RowState): void => {
    if (op.op !== 'setField') return;
    const p = prepared.get(op.coll);
    if (!p || !p.transitions.length) return;
    const enumOf = (v: Value | undefined): string | undefined => (v && v.t === 'enum' ? v.v : undefined);
    const toVal = enumOf(folded.values[op.field]);
    const fromVal = enumOf(before?.values[op.field]);
    const match = p.transitions.find((t) => t.field === op.field && t.to === toVal && (t.from === undefined || t.from === fromVal));
    if (!match) return;
    const self: VRef = { t: 'ref', collection: op.coll, id: op.row };
    const rec = recompute(op.coll, folded.values, p, self);
    if (!applicable(match.when, rec, { clock: opts.clock(), resolver, self, tables: p.tables }))
      throw new Error(`transition '${match.id}' blocked: ${op.field} ${fromVal ?? '∅'} → ${match.to} is not permitted yet (guard not satisfied)`);
  };

  const recomputeCascade = (seeds: Set<string>): RowWire[] => {
    const buckets = new Map<number, Set<string>>();
    const queued = new Set<string>();
    const enqueue = (c: string, r: string): void => {
      const k = key(c, r);
      if (queued.has(k)) return;
      queued.add(k);
      const rk = rank.get(c) ?? 0;
      (buckets.get(rk) ?? buckets.set(rk, new Set()).get(rk)!).add(k);
    };
    for (const k of seeds) { const [c, r] = k.split(' '); enqueue(c, r); }
    const out: RowWire[] = [];
    const maxRank = Math.max(0, ...rank.values());
    for (let rk = 0; rk <= maxRank; rk++) {
      for (const k of buckets.get(rk) ?? []) {
        const [coll, row] = k.split(' ');
        const p = prepared.get(coll);
        if (!p) continue;
        const cur = store.getRow(coll, row);
        if (!cur) continue;
        const self: VRef = { t: 'ref', collection: coll, id: row };
        const next = recompute(coll, cur.values, p, self);
        if (docEq(next, cur.values)) continue; // changed-gate
        const saved: RowState = { ...cur, values: next };
        store.putRow(coll, saved);
        const hidden = hiddenFields(next, p, self);
        out.push({ coll, id: saved.id, doc: saved.values, deleted: saved.deleted, seq: saved.updatedSeq, ...(hidden.length ? { hidden } : {}) });
        for (const rel of relByChild.get(coll) ?? []) {
          if (!rolledUpVias.has(rel.via)) continue;
          const pid = refIdOf(next[rel.childField]);
          if (pid) enqueue(rel.parentColl, pid);
        }
      }
    }
    return out;
  };

  const submit = (ops: RowOp[], actor: string): { assigned: number[]; rows: RowWire[] } => {
    if (!prepared.size) throw new Error('workspace schema not set');
    const assigned: number[] = [];
    const seeds = new Set<string>();
    const cache = new Map<string, RowState>();
    for (const op of ops) {
      if (!prepared.has(op.coll)) throw new Error(`unknown collection ${op.coll}`);
      const seq = store.nextSeq();
      const committed: Committed = { ...op, meta: { seq, at: new Date(opts.clock().nowMs).toISOString(), actor } };
      const bk = key(op.coll, op.row);
      const before = cache.get(bk) ?? store.getRow(op.coll, op.row);
      const folded = applyOp(before, committed);
      if (opts.resolveExterns) opts.resolveExterns(op.coll, folded); // fill extern fields before guard/recompute
      guardTransitions(op, before, folded);
      store.putRow(op.coll, folded);
      store.appendOp?.(committed);
      cache.set(bk, folded);
      assigned.push(seq);
      seeds.add(bk);
      for (const rel of relByChild.get(op.coll) ?? []) {
        if (!rolledUpVias.has(rel.via)) continue;
        for (const pid of new Set([refIdOf(before?.values[rel.childField]), refIdOf(folded.values[rel.childField])])) if (pid) seeds.add(key(rel.parentColl, pid));
      }
    }
    return { assigned, rows: recomputeCascade(seeds) };
  };

  const read = (coll: string): RowWire[] => {
    const p = prepared.get(coll);
    if (!p) throw new Error(`unknown collection ${coll}`);
    return store.allRows(coll).map((r) => {
      const self: VRef = { t: 'ref', collection: coll, id: r.id };
      const hidden = hiddenFields(r.values, p, self);
      return { coll, id: r.id, doc: r.values, deleted: r.deleted, seq: r.updatedSeq, ...(hidden.length ? { hidden } : {}) };
    });
  };

  return { submit, read };
}
