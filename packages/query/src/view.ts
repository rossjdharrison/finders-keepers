// @core/query — compile a data-defined ViewSpec into parameterised SQL over the
// records table. Records are stored one row per record as { doc: JSON of
// {field: Value} }; the compiler reads the collection's schema so it knows how to
// extract a comparable scalar per field kind (money on integer minor units with a
// currency guard, dates on epochDay, etc). Pure string+params in, no DB here — the
// CollectionDO runs the result against its embedded SQLite.

import type { Value, ValueType } from '@core/values';

export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'empty' | 'notEmpty';

export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }
  | { field: string; op: FilterOp; value?: Value; values?: Value[] };

export interface Sort {
  field: string;
  dir: 'asc' | 'desc';
}
export interface ViewSpec {
  coll: string;
  filter?: FilterNode;
  sort?: Sort[];
  group?: { field: string };
  page?: { limit?: number; offset?: number };
}

export type SqlParam = string | number | null;
export interface CompiledSql {
  sql: string;
  params: SqlParam[];
}
export type Schema = Record<string, ValueType>;

const FIELD_RE = /^[A-Za-z0-9_]+$/;
function safeField(f: string): string {
  if (!FIELD_RE.test(f)) throw new Error(`unsafe field id: ${JSON.stringify(f)}`);
  return f;
}

/** SQL expression extracting the comparable scalar for a field from the doc JSON. */
function keyExpr(field: string, vt: ValueType | undefined, table = 't'): string {
  const f = safeField(field);
  const at = (path: string): string => `json_extract(${table}.doc, '$.${f}.${path}')`;
  switch (vt?.k) {
    case 'money':
      return `CAST(${at('minor')} AS INTEGER)`; // assumes one scale per column (v0)
    case 'date':
      return at('epochDay');
    case 'datetime':
      return at('epochMs');
    default:
      // num, pct, bool, text, enum, and unknown all live under `.v`
      return at('v');
  }
}

/** The comparable scalar bound for a filter value, matching keyExpr. */
function paramOf(v: Value): SqlParam {
  switch (v.t) {
    case 'num':
    case 'pct':
      return v.v;
    case 'money':
      return Number(v.minor);
    case 'date':
      return v.epochDay;
    case 'datetime':
      return v.epochMs;
    case 'bool':
      return v.v ? 1 : 0;
    case 'text':
    case 'enum':
      return v.v;
    default:
      return null;
  }
}

const CMP: Partial<Record<FilterOp, string>> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

function compileFilter(node: FilterNode, schema: Schema, out: SqlParam[], table: string): string {
  if ('and' in node) {
    if (!node.and.length) return '1';
    return '(' + node.and.map((n) => compileFilter(n, schema, out, table)).join(' AND ') + ')';
  }
  if ('or' in node) {
    if (!node.or.length) return '0';
    return '(' + node.or.map((n) => compileFilter(n, schema, out, table)).join(' OR ') + ')';
  }
  if ('not' in node) {
    return 'NOT (' + compileFilter(node.not, schema, out, table) + ')';
  }

  const vt = schema[node.field];
  const key = keyExpr(node.field, vt, table);

  if (node.op === 'empty') return `${key} IS NULL`;
  if (node.op === 'notEmpty') return `${key} IS NOT NULL`;

  if (node.op === 'in') {
    const vals = node.values ?? [];
    if (!vals.length) return '0';
    const holes = vals.map((v) => {
      out.push(paramOf(v));
      return '?';
    });
    return `${key} IN (${holes.join(', ')})`;
  }

  if (node.value === undefined) throw new Error(`filter op ${node.op} needs a value`);

  if (node.op === 'contains') {
    out.push('%' + String(paramOf(node.value)) + '%');
    return `${key} LIKE ?`;
  }

  const cmp = CMP[node.op];
  if (!cmp) throw new Error(`unknown filter op ${node.op}`);
  let sql = `${key} ${cmp} ?`;
  out.push(paramOf(node.value));
  // currency guard: only compare money within the same currency
  if (vt?.k === 'money' && node.value.t === 'money') {
    sql = `(${sql} AND json_extract(${table}.doc, '$.${safeField(node.field)}.ccy') = ?)`;
    out.push(node.value.ccy);
  }
  return sql;
}

/** Compile a view into `SELECT row_id, doc FROM records WHERE … ORDER BY … LIMIT …`. */
export function compileView(spec: ViewSpec, schema: Schema, table = 't'): CompiledSql {
  // A workspace's records share one table keyed by (coll, row_id), so every read
  // is scoped to the collection. The coll param goes first, before any filter params.
  const params: SqlParam[] = [spec.coll];
  const where = [`${table}.deleted = 0`, `${table}.coll = ?`];
  if (spec.filter) where.push(compileFilter(spec.filter, schema, params, table));

  let sql = `SELECT ${table}.row_id, ${table}.doc FROM records ${table} WHERE ${where.join(' AND ')}`;

  const order: string[] = [];
  for (const s of spec.sort ?? []) {
    order.push(`${keyExpr(s.field, schema[s.field], table)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  order.push(`${table}.seq ASC`); // stable tiebreak
  sql += ` ORDER BY ${order.join(', ')}`;

  const limit = spec.page?.limit ?? 200;
  sql += ` LIMIT ${Number(limit) | 0}`;
  if (spec.page?.offset) sql += ` OFFSET ${Number(spec.page.offset) | 0}`;

  return { sql, params };
}

/** Board/group counts: `SELECT <key> AS k, COUNT(*) AS c … GROUP BY k`. */
export function compileGroupCounts(spec: ViewSpec, schema: Schema, table = 't'): CompiledSql {
  if (!spec.group) throw new Error('compileGroupCounts needs spec.group');
  const params: SqlParam[] = [spec.coll];
  const where = [`${table}.deleted = 0`, `${table}.coll = ?`];
  if (spec.filter) where.push(compileFilter(spec.filter, schema, params, table));
  const key = keyExpr(spec.group.field, schema[spec.group.field], table);
  const sql =
    `SELECT ${key} AS k, COUNT(*) AS c FROM records ${table} ` +
    `WHERE ${where.join(' AND ')} GROUP BY k ORDER BY k ASC`;
  return { sql, params };
}
