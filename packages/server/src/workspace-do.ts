// WorkspaceDO — one Durable Object holds an ENTIRE workspace: many collections +
// the relations registry, co-located in one embedded SQLite. This makes rollups
// strongly consistent and locally recomputable (no cross-DO problem): a task's
// hours change ripples to its feature's rollup and up to the initiative, all in
// one single-threaded actor.
//
// The write path (submit) persists the folded op, then runs a rank-ordered
// recompute CASCADE: recompute the edited row, then every row that rolls it up,
// transitively, until stable. Termination is structural — the cross-collection
// rollup graph is a DAG, ranks are a topo order, and a `queued` set dedupes — not
// by convergence. All hard logic lives in the pure @core packages; this is the
// stateful authority shell.

import { DurableObject } from 'cloudflare:workers';
import type { Value, ValueType, VRef } from '@core/values';
import { equals } from '@core/values';
import type { Committed, RowOp, RowState } from '@core/events';
import { applyOp } from '@core/events';
import type { Schema, ViewSpec } from '@core/query';
import { compileView } from '@core/query';
import type { CompiledColumn, Node, RelationMeta, Resolver, TableDef } from '@core/formula';
import { applicable, compile, evalRecord, topoOrCycle } from '@core/formula';
import { reduces } from '@core/ontology';
import type { TypeMap } from '@core/ontology';

export interface Property {
  id: string;
  valueType: ValueType;
  source?: 'stored' | 'computed';
  formula?: unknown;
  category?: string; // optional HQDM class for this field's values (must reduce)
  availableWhen?: unknown; // a boolean formula: is this field in play for a record?
}
export interface Transition {
  id: string;
  field: string; // the enum field whose value moves
  from?: string; // required current option (any, if omitted)
  to: string; // the target option
  when: unknown; // a boolean guard formula over the record — the move is refused unless it holds
}
export interface CollectionDoc {
  id: string;
  properties: Property[];
  semanticClass: string; // the HQDM class records are classified by — must reduce to the lattice
  tables?: Record<string, TableDef>; // lookup tables (the data behind computed consequences)
  transitions?: Transition[]; // gated state moves: a verification seam is a transition guarded by a predicate
}
export interface RowStateWire {
  coll: string;
  id: string;
  doc: Record<string, Value>;
  deleted: boolean;
  seq: number;
  hidden?: string[]; // fields whose availableWhen is false for this record (not in play)
}

interface RelationDef extends RelationMeta {
  via: string;
}
interface Prepared {
  schema: Schema;
  computedIds: Set<string>;
  cols: CompiledColumn[]; // topo-ordered within the record
  tables?: Record<string, TableDef>; // lookup tables for this collection
  gated: { id: string; ast: Node }[]; // fields carrying an availableWhen predicate
  transitions: { id: string; field: string; from?: string; to: string; when: Node }[]; // gated state moves
}

const FIELD_RE = /^[A-Za-z0-9_]+$/;
const safeField = (f: string): string => {
  if (!FIELD_RE.test(f)) throw new Error(`unsafe field id: ${JSON.stringify(f)}`);
  return f;
};

function docEq(a: Record<string, Value>, b: Record<string, Value>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const bv = b[k];
    if (bv === undefined || !equals(a[k], bv)) return false;
  }
  return true;
}

// Rank so that for every rolled-up edge child->parent, rank(parent) > rank(child).
function kahnRank(nodes: Set<string>, edges: [string, string][]): Map<string, number> {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();
  for (const n of nodes) {
    indeg.set(n, 0);
    adj.set(n, []);
    rank.set(n, 0);
  }
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Env {}

export class WorkspaceDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private prepared = new Map<string, Prepared>();
  private relations = new Map<string, RelationDef>();
  private relByChild = new Map<string, RelationDef[]>();
  private rolledUpVias = new Set<string>();
  private rank = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS records(coll TEXT NOT NULL, row_id TEXT NOT NULL, doc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (coll, row_id))`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_records_live ON records(coll, deleted)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS oplog(seq INTEGER PRIMARY KEY, coll TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS collections(coll TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS relations(via TEXT PRIMARY KEY, parent_coll TEXT NOT NULL, child_coll TEXT NOT NULL, child_field TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.reload();
  }

  // ---- schema + relations -----------------------------------------------------
  private readState(): { docs: Map<string, CollectionDoc>; relations: Map<string, RelationDef>; types: TypeMap } {
    const docs = new Map<string, CollectionDoc>(
      this.sql.exec(`SELECT coll, doc FROM collections`).toArray().map((r) => [r.coll as string, JSON.parse(r.doc as string)]),
    );
    const relations = new Map<string, RelationDef>();
    for (const r of this.sql.exec(`SELECT via, parent_coll, child_coll, child_field FROM relations`).toArray()) {
      relations.set(r.via as string, { via: r.via as string, parentColl: r.parent_coll as string, childColl: r.child_coll as string, childField: r.child_field as string });
    }
    const t = this.sql.exec(`SELECT v FROM meta WHERE k = 'types'`).toArray()[0];
    const types: TypeMap = t ? JSON.parse(t.v as string) : {};
    return { docs, relations, types };
  }

  // Build (and VALIDATE) the whole workspace from a candidate state. Throws on any
  // problem — HQDM reducibility, a compile error, a cycle — so callers can validate
  // BEFORE persisting. This is where "every model is HQDM-based" is enforced.
  private buildPrepared(
    docs: Map<string, CollectionDoc>,
    relations: Map<string, RelationDef>,
    types: TypeMap,
  ): { prepared: Map<string, Prepared>; relations: Map<string, RelationDef>; relByChild: Map<string, RelationDef[]>; rolledUpVias: Set<string>; rank: Map<string, number> } {
    // ---- REDUCIBILITY GATE: every declared type, every collection's semanticClass,
    //      and every tagged property category must reduce to the HQDM lattice.
    for (const id of Object.keys(types)) {
      if (!reduces(id, types)) throw new Error(`type '${id}' does not reduce to HQDM (bad or missing 'specializes' chain)`);
    }
    for (const [coll, doc] of docs) {
      if (!doc.semanticClass) throw new Error(`collection '${coll}' must declare a semanticClass (HQDM reducibility is required)`);
      if (!reduces(doc.semanticClass, types)) throw new Error(`collection '${coll}': semanticClass '${doc.semanticClass}' does not reduce to HQDM`);
      for (const p of doc.properties) {
        if (p.category && !reduces(p.category, types)) throw new Error(`'${coll}.${p.id}': category '${p.category}' does not reduce to HQDM`);
      }
    }

    // declared value types per collection (computed cols declare their result type)
    const schemas = new Map<string, Schema>();
    for (const [coll, doc] of docs) {
      const s: Schema = {};
      for (const p of doc.properties) s[p.id] = p.valueType;
      schemas.set(coll, s);
    }
    // relation indexes (relations are passed in, already validated)
    const relByChild = new Map<string, RelationDef[]>();
    const relRecord: Record<string, RelationMeta> = {};
    for (const def of relations.values()) {
      (relByChild.get(def.childColl) ?? relByChild.set(def.childColl, []).get(def.childColl)!).push(def);
      relRecord[def.via] = def;
    }
    // typecheck resolver: columnType from the declared schemas (related/cell unused at compile)
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
    // which vias are actually rolled up (drives cascade seeding)
    const rolledUpVias = new Set<string>();
    for (const p of prepared.values()) for (const c of p.cols) for (const rd of c.rollupDeps) rolledUpVias.add(rd.via);
    // rank the collections by the rolled-up child->parent DAG
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

  private applyBuilt(b: {
    prepared: Map<string, Prepared>;
    relations: Map<string, RelationDef>;
    relByChild: Map<string, RelationDef[]>;
    rolledUpVias: Set<string>;
    rank: Map<string, number>;
  }): void {
    this.prepared = b.prepared;
    this.relations = b.relations;
    this.relByChild = b.relByChild;
    this.rolledUpVias = b.rolledUpVias;
    this.rank = b.rank;
  }

  private reload(): void {
    const s = this.readState();
    this.applyBuilt(this.buildPrepared(s.docs, s.relations, s.types));
  }

  // ---- storage helpers --------------------------------------------------------
  private key(c: string, r: string): string {
    return `${c} ${r}`;
  }
  private nextSeq(): number {
    const r = this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS m FROM oplog`).toArray()[0];
    return Number(r?.m ?? 0) + 1;
  }
  private loadRow(coll: string, id: string): RowState | null {
    const r = this.sql.exec(`SELECT doc, deleted, seq FROM records WHERE coll = ? AND row_id = ?`, coll, id).toArray()[0];
    return r ? { id, values: JSON.parse(r.doc as string), deleted: !!r.deleted, updatedSeq: Number(r.seq) } : null;
  }
  private persist(coll: string, r: RowState): void {
    this.sql.exec(
      `INSERT INTO records(coll, row_id, doc, deleted, seq) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(coll, row_id) DO UPDATE SET doc = excluded.doc, deleted = excluded.deleted, seq = excluded.seq`,
      coll, r.id, JSON.stringify(r.values), r.deleted ? 1 : 0, r.updatedSeq,
    );
  }
  private clock(): { today: number; nowMs: number } {
    const nowMs = Date.now();
    return { today: Math.floor(nowMs / 86_400_000), nowMs };
  }
  private refIdOf(v: Value | undefined): string | null {
    return v && v.t === 'ref' ? v.id : null;
  }

  private resolver(): Resolver {
    const sql = this.sql;
    const relations = this.relations;
    const prepared = this.prepared;
    return {
      related(from: VRef, via: string): VRef[] {
        const rel = relations.get(via);
        if (!rel || rel.parentColl !== from.collection) return [];
        const rows = sql
          .exec(
            `SELECT row_id FROM records WHERE coll = ? AND deleted = 0 AND json_extract(doc, '$.${safeField(rel.childField)}.id') = ?`,
            rel.childColl, from.id,
          )
          .toArray();
        return rows.map((r) => ({ t: 'ref', collection: rel.childColl, id: r.row_id as string }));
      },
      cell(ref: VRef, column: string): Value {
        const r = sql.exec(`SELECT doc FROM records WHERE coll = ? AND row_id = ? AND deleted = 0`, ref.collection, ref.id).toArray()[0];
        if (!r) return { t: 'blank' };
        return (JSON.parse(r.doc as string) as Record<string, Value>)[column] ?? { t: 'blank' };
      },
      columnType: (coll, col) => prepared.get(coll)?.schema[col],
    };
  }

  // Derive computed columns from the row's stored inputs, resolving ref/rollup/lookup.
  private recompute(vals: Record<string, Value>, p: Prepared, res: Resolver, self: VRef): Record<string, Value> {
    const inputs: Record<string, Value> = {};
    for (const [k, v] of Object.entries(vals)) if (!p.computedIds.has(k)) inputs[k] = v;
    const computed = evalRecord(p.cols, inputs, { clock: this.clock(), resolver: res, self, tables: p.tables });
    return { ...inputs, ...computed };
  }

  // The fields not in play for a record — availableWhen evaluated over the full record.
  private hiddenFields(vals: Record<string, Value>, p: Prepared, res: Resolver, self: VRef): string[] {
    if (!p.gated.length) return [];
    const ctx = { clock: this.clock(), resolver: res, self, tables: p.tables };
    return p.gated.filter((g) => !applicable(g.ast, vals, ctx)).map((g) => g.id);
  }

  // The verification seam: a declared state move is refused unless its guard holds
  // on the resulting (recomputed) record — the runtime guard hook. Fail-closed.
  private guardTransitions(op: RowOp, before: RowState | null, folded: RowState, res: Resolver): void {
    if (op.op !== 'setField') return;
    const p = this.prepared.get(op.coll);
    if (!p || !p.transitions.length) return;
    const enumOf = (v: Value | undefined): string | undefined => (v && v.t === 'enum' ? v.v : undefined);
    const toVal = enumOf(folded.values[op.field]);
    const fromVal = enumOf(before?.values[op.field]);
    const match = p.transitions.find((t) => t.field === op.field && t.to === toVal && (t.from === undefined || t.from === fromVal));
    if (!match) return;
    const self: VRef = { t: 'ref', collection: op.coll, id: op.row };
    const rec = this.recompute(folded.values, p, res, self); // compute the guard's inputs (e.g. `met`)
    const ok = applicable(match.when, rec, { clock: this.clock(), resolver: res, self, tables: p.tables });
    if (!ok) throw new Error(`transition '${match.id}' blocked: ${op.field} ${fromVal ?? '∅'} → ${match.to} is not permitted yet (guard not satisfied)`);
  }

  // ---- the write path + cascade ----------------------------------------------
  submit(ops: RowOp[], actor: string): { assigned: number[]; rows: RowStateWire[] } {
    if (!this.prepared.size) throw new Error('workspace schema not set — PUT /workspace first');
    const assigned: number[] = [];
    const seeds = new Set<string>();
    const cache = new Map<string, RowState>();
    const res = this.resolver();

    for (const op of ops) {
      if (!this.prepared.has(op.coll)) throw new Error(`unknown collection ${op.coll}`);
      const seq = this.nextSeq();
      const committed: Committed = { ...op, meta: { seq, at: new Date().toISOString(), actor } };
      const bk = this.key(op.coll, op.row);
      const before = cache.get(bk) ?? this.loadRow(op.coll, op.row);
      const folded = applyOp(before, committed); // stored edit; computed still stale
      this.guardTransitions(op, before, folded, res); // fail-closed BEFORE persist: a gated move must satisfy its guard
      this.persist(op.coll, folded);
      this.sql.exec(`INSERT INTO oplog(seq, coll, at, actor, op) VALUES(?, ?, ?, ?, ?)`, seq, op.coll, committed.meta.at, actor, JSON.stringify(op));
      cache.set(bk, folded);
      assigned.push(seq);
      seeds.add(bk);
      // seed parents from UNION(before, after) ref targets — covers set/clear/delete/re-point.
      // KEY: unconditional, so an hours-only edit (which changes no task computed col) still reaches the parent rollup.
      for (const rel of this.relByChild.get(op.coll) ?? []) {
        if (!this.rolledUpVias.has(rel.via)) continue;
        for (const pid of new Set([this.refIdOf(before?.values[rel.childField]), this.refIdOf(folded.values[rel.childField])])) {
          if (pid) seeds.add(this.key(rel.parentColl, pid));
        }
      }
    }

    const rows = this.recomputeCascade(seeds);
    this.broadcast(rows);
    return { assigned, rows };
  }

  private recomputeCascade(seeds: Set<string>): RowStateWire[] {
    const res = this.resolver();
    const buckets = new Map<number, Set<string>>();
    const queued = new Set<string>();
    const enqueue = (c: string, r: string): void => {
      const k = this.key(c, r);
      if (queued.has(k)) return;
      queued.add(k);
      const rk = this.rank.get(c) ?? 0;
      (buckets.get(rk) ?? buckets.set(rk, new Set()).get(rk)!).add(k);
    };
    for (const k of seeds) {
      const [c, r] = k.split(' ');
      enqueue(c, r);
    }
    const out: RowStateWire[] = [];
    const maxRank = Math.max(0, ...this.rank.values());
    for (let rk = 0; rk <= maxRank; rk++) {
      for (const k of buckets.get(rk) ?? []) {
        const [coll, row] = k.split(' ');
        const p = this.prepared.get(coll);
        if (!p) continue;
        const cur = this.loadRow(coll, row);
        if (!cur) continue;
        const self: VRef = { t: 'ref', collection: coll, id: row };
        const next = this.recompute(cur.values, p, res, self);
        if (docEq(next, cur.values)) continue; // changed-gate: no change => no propagation
        const saved: RowState = { ...cur, values: next };
        this.persist(coll, saved);
        const hidden = this.hiddenFields(next, p, res, self);
        out.push({ coll, id: saved.id, doc: saved.values, deleted: saved.deleted, seq: saved.updatedSeq, ...(hidden.length ? { hidden } : {}) });
        // propagate to the (strictly higher-rank) parents that roll this row up
        for (const rel of this.relByChild.get(coll) ?? []) {
          if (!this.rolledUpVias.has(rel.via)) continue;
          const pid = this.refIdOf(next[rel.childField]);
          if (pid) enqueue(rel.parentColl, pid);
        }
      }
    }
    return out;
  }

  query(spec: ViewSpec): { rows: RowStateWire[] } {
    const p = this.prepared.get(spec.coll);
    if (!p) throw new Error(`unknown collection ${spec.coll}`);
    const { sql, params } = compileView(spec, p.schema);
    const res = this.resolver();
    return {
      rows: this.sql.exec(sql, ...params).toArray().map((r) => {
        const id = r.row_id as string;
        const doc = JSON.parse(r.doc as string) as Record<string, Value>;
        const hidden = this.hiddenFields(doc, p, res, { t: 'ref', collection: spec.coll, id });
        return { coll: spec.coll, id, doc, deleted: false, seq: 0, ...(hidden.length ? { hidden } : {}) };
      }),
    };
  }

  // ---- HTTP + WebSocket -------------------------------------------------------
  private persistCollectionDoc(doc: CollectionDoc): void {
    this.sql.exec(`INSERT INTO collections(coll, doc) VALUES(?, ?) ON CONFLICT(coll) DO UPDATE SET doc = excluded.doc`, doc.id, JSON.stringify(doc));
  }
  private persistWorkspace(docs: Map<string, CollectionDoc>, relations: Map<string, RelationDef>, types: TypeMap): void {
    this.sql.exec(`DELETE FROM collections`);
    this.sql.exec(`DELETE FROM relations`);
    this.sql.exec(`DELETE FROM meta WHERE k = 'types'`);
    for (const doc of docs.values()) this.persistCollectionDoc(doc);
    for (const def of relations.values()) {
      this.sql.exec(`INSERT INTO relations(via, parent_coll, child_coll, child_field) VALUES(?, ?, ?, ?)`, def.via, def.parentColl, def.childColl, def.childField);
    }
    if (Object.keys(types).length) this.sql.exec(`INSERT INTO meta(k, v) VALUES('types', ?)`, JSON.stringify(types));
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') return this.wsUpgrade();
    const url = new URL(req.url);
    try {
      if (req.method === 'PUT' && url.pathname === '/workspace') {
        const body = (await req.json()) as { collections: CollectionDoc[]; relations?: Record<string, RelationMeta>; types?: TypeMap };
        const docs = new Map(body.collections.map((d) => [d.id, d] as const));
        const relations = new Map<string, RelationDef>(Object.entries(body.relations ?? {}).map(([via, m]) => [via, { via, ...m }]));
        const types = body.types ?? {};
        const built = this.buildPrepared(docs, relations, types); // validates (incl. reducibility) BEFORE persisting
        this.persistWorkspace(docs, relations, types);
        this.applyBuilt(built);
        return Response.json({ ok: true, collections: [...this.prepared.keys()] });
      }
      if (req.method === 'GET' && url.pathname === '/workspace') {
        return Response.json({ collections: [...this.prepared.keys()] });
      }
      const m = url.pathname.match(/^\/collections\/([^/]+)(\/.*)?$/);
      if (m) {
        const coll = m[1];
        const sub = m[2] ?? '/';
        if (req.method === 'PUT' && sub === '/collection') {
          const doc = (await req.json()) as CollectionDoc;
          const s = this.readState();
          s.docs.set(coll, doc);
          const built = this.buildPrepared(s.docs, s.relations, s.types); // validate before persisting
          this.persistCollectionDoc(doc);
          this.applyBuilt(built);
          return Response.json({ ok: true });
        }
        if (req.method === 'POST' && sub === '/ops') {
          const body = (await req.json()) as { actor?: string; ops: RowOp[] };
          for (const op of body.ops) if (op.coll !== coll) throw new Error(`op.coll ${op.coll} != ${coll}`);
          return Response.json(this.submit(body.ops, body.actor ?? 'anon'));
        }
        if (req.method === 'POST' && sub === '/query') {
          const spec = (await req.json()) as ViewSpec;
          return Response.json(this.query({ ...spec, coll }));
        }
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  private wsUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ k: 'welcome', seq: this.nextSeq() - 1 }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let frame: { k?: string; token?: string; ops?: RowOp[]; nonce?: string };
    try {
      frame = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (frame.k === 'ping') return ws.send(JSON.stringify({ k: 'pong' }));
    if (frame.k === 'hello') {
      ws.serializeAttachment({ actor: frame.token || 'anon' });
      return ws.send(JSON.stringify({ k: 'welcome', seq: this.nextSeq() - 1 }));
    }
    if (frame.k === 'ops' && frame.ops) {
      const att = ws.deserializeAttachment() as { actor?: string } | null;
      try {
        const { assigned } = this.submit(frame.ops, att?.actor ?? 'anon');
        ws.send(JSON.stringify({ k: 'ack', nonce: frame.nonce, assigned }));
      } catch (e) {
        ws.send(JSON.stringify({ k: 'reject', nonce: frame.nonce, error: (e as Error).message }));
      }
    }
  }

  private broadcast(rows: RowStateWire[]): void {
    if (!rows.length) return;
    const msg = JSON.stringify({ k: 'rows', rows });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket closing */
      }
    }
  }
}
