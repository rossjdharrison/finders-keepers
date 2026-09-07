// CollectionDO — the authority for ONE collection. A single-threaded Durable
// Object is the total-order clock: it assigns every op a monotonic seq, folds it
// with the pure @core/events reducer, RECOMPUTES the row's typed computed columns
// with @core/formula, persists to embedded SQLite, and broadcasts the resulting
// rows over WebSockets so every open tab shows the server-computed values live.
//
// All the hard logic lives in the pure @core packages (reducer, typecheck/eval,
// view->SQL). This class is the thin, stateful shell that orders, stores, and fans
// out — the part that genuinely needs a server authority.

import { DurableObject } from 'cloudflare:workers';
import type { Value, ValueType } from '@core/values';
import type { Committed, RowOp, RowState } from '@core/events';
import { applyOp } from '@core/events';
import type { Schema, ViewSpec } from '@core/query';
import { compileView } from '@core/query';
import type { CompiledColumn, Node } from '@core/formula';
import { compile, evalRecord, topoOrCycle } from '@core/formula';

export interface Property {
  id: string;
  valueType: ValueType;
  source?: 'stored' | 'computed';
  formula?: Node;
}
export interface CollectionDoc {
  id: string;
  properties: Property[];
}

interface Prepared {
  schema: Schema; // id -> valueType, for the view compiler
  computedIds: Set<string>;
  cols: CompiledColumn[]; // topo-ordered computed columns
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Env {}

export class CollectionDO extends DurableObject<Env> {
  private prepared: Prepared | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS records(row_id TEXT PRIMARY KEY, doc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS oplog(seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const saved = sql.exec(`SELECT v FROM meta WHERE k = 'collection'`).toArray()[0];
    if (saved) this.prepared = this.prepare(JSON.parse(saved.v as string) as CollectionDoc);
  }

  // ---- schema preparation: typecheck + topo-order the computed columns --------
  private prepare(doc: CollectionDoc): Prepared {
    const schema: Schema = {};
    for (const p of doc.properties) schema[p.id] = p.valueType;
    const computedIds = new Set(doc.properties.filter((p) => p.source === 'computed').map((p) => p.id));
    const compiled: CompiledColumn[] = [];
    for (const p of doc.properties) {
      if (p.source === 'computed' && p.formula) {
        const r = compile(p.id, p.formula, { columns: schema });
        if ('errors' in r) throw new Error(`compile ${p.id}: ${r.errors.map((e) => e.message).join('; ')}`);
        compiled.push(r);
      }
    }
    const ordered = topoOrCycle(compiled);
    if ('cycle' in ordered) throw new Error(`cyclic computed columns: ${ordered.cycle.join(', ')}`);
    const byId = new Map(compiled.map((c) => [c.id, c]));
    const cols = ordered.order.map((id) => byId.get(id)).filter((c): c is CompiledColumn => c !== undefined);
    return { schema, computedIds, cols };
  }

  // ---- storage helpers --------------------------------------------------------
  private nextSeq(): number {
    const r = this.ctx.storage.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS m FROM oplog`).toArray()[0];
    return Number(r?.m ?? 0) + 1;
  }

  private loadRow(id: string): RowState | null {
    const r = this.ctx.storage.sql.exec(`SELECT doc, deleted, seq FROM records WHERE row_id = ?`, id).toArray()[0];
    if (!r) return null;
    return { id, values: JSON.parse(r.doc as string), deleted: !!r.deleted, updatedSeq: Number(r.seq) };
  }

  private clock(): { today: number; nowMs: number } {
    const nowMs = Date.now();
    return { today: Math.floor(nowMs / 86_400_000), nowMs };
  }

  // Derive computed columns from the row's stored inputs (never from stale computed).
  private recompute(values: Record<string, Value>, p: Prepared): Record<string, Value> {
    const inputs: Record<string, Value> = {};
    for (const [k, v] of Object.entries(values)) if (!p.computedIds.has(k)) inputs[k] = v;
    const computed = evalRecord(p.cols, inputs, { clock: this.clock() });
    return { ...inputs, ...computed };
  }

  // ---- the write path (the sole authority) ------------------------------------
  submit(ops: RowOp[], actor: string): { assigned: number[]; rows: RowStateWire[] } {
    if (!this.prepared) throw new Error('collection schema not set — PUT /collection first');
    const p = this.prepared;
    const sql = this.ctx.storage.sql;
    const assigned: number[] = [];
    const touched = new Map<string, RowState>();

    for (const op of ops) {
      const seq = this.nextSeq();
      const committed: Committed = { ...op, meta: { seq, at: new Date().toISOString(), actor } };
      const before = touched.get(op.row) ?? this.loadRow(op.row);
      const folded = applyOp(before, committed);
      const next: RowState = { ...folded, values: this.recompute(folded.values, p) };

      sql.exec(
        `INSERT INTO records(row_id, doc, deleted, seq) VALUES(?, ?, ?, ?)
         ON CONFLICT(row_id) DO UPDATE SET doc = excluded.doc, deleted = excluded.deleted, seq = excluded.seq`,
        op.row,
        JSON.stringify(next.values),
        next.deleted ? 1 : 0,
        seq,
      );
      sql.exec(`INSERT INTO oplog(seq, at, actor, op) VALUES(?, ?, ?, ?)`, seq, committed.meta.at, actor, JSON.stringify(op));
      assigned.push(seq);
      touched.set(op.row, next);
    }

    const rows = [...touched.values()].map(toWire);
    this.broadcast(rows);
    return { assigned, rows };
  }

  // ---- the read path (strong, from co-located SQLite) -------------------------
  query(spec: ViewSpec): { rows: RowStateWire[] } {
    if (!this.prepared) throw new Error('collection schema not set');
    const { sql, params } = compileView(spec, this.prepared.schema);
    const out = this.ctx.storage.sql.exec(sql, ...params).toArray();
    return {
      rows: out.map((r) => ({ id: r.row_id as string, doc: JSON.parse(r.doc as string), deleted: false, seq: 0 })),
    };
  }

  // ---- HTTP + WebSocket surface ----------------------------------------------
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') return this.wsUpgrade();
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/collections\/[^/]+/, '') || '/';
    try {
      if (req.method === 'PUT' && path === '/collection') {
        const doc = (await req.json()) as CollectionDoc;
        this.prepared = this.prepare(doc);
        this.ctx.storage.sql.exec(
          `INSERT INTO meta(k, v) VALUES('collection', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          JSON.stringify(doc),
        );
        return Response.json({ ok: true });
      }
      if (req.method === 'POST' && path === '/ops') {
        const body = (await req.json()) as { actor?: string; ops: RowOp[] };
        return Response.json(this.submit(body.ops, body.actor ?? 'anon'));
      }
      if (req.method === 'POST' && path === '/query') {
        return Response.json(this.query((await req.json()) as ViewSpec));
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
    let frame: WsClientFrame;
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
    if (frame.k === 'ops') {
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
    const msg = JSON.stringify({ k: 'rows', rows });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket closing — ignore */
      }
    }
  }
}

export interface RowStateWire {
  id: string;
  doc: Record<string, Value>;
  deleted: boolean;
  seq: number;
}
const toWire = (r: RowState): RowStateWire => ({ id: r.id, doc: r.values, deleted: r.deleted, seq: r.updatedSeq });

type WsClientFrame =
  | { k: 'ping' }
  | { k: 'hello'; token?: string }
  | { k: 'ops'; ops: RowOp[]; nonce?: string };
