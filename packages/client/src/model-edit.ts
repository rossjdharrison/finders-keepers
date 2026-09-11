// Model editing — the admin changes RULES by producing an edited Cassette (pure), then previewCassette
// compiles the candidate in a THROWAWAY core so a bad edit surfaces as an error instead of bricking the
// live one, and returns a sample quote so the effect of a rule change is visible immediately. This is
// the finders-keepers analogue of wasm-calculator's model-edit + tryAssemble/validateFormula.

import type { Cassette } from '@app/core-runtime';
import { createCore, mockExterns } from '@app/core-runtime';
import type { Value } from '@core/values';

interface MoneyCell { t?: string; minor?: number; ccy?: string; scale?: number }

/** Set a lookup-table cell's minor value (a pricing RATE) — the smallest editable rule. Pure. */
export function setTableCell(cassette: Cassette, collId: string, tableId: string, key: string, minor: number): Cassette {
  const next = structuredClone(cassette);
  const coll = next.collections.find((c) => c.id === collId);
  const table = coll?.tables?.[tableId] as { map?: Record<string, MoneyCell> } | undefined;
  const cell = table?.map?.[key];
  if (cell && cell.t === 'money') cell.minor = Math.round(minor);
  return next;
}

/** Read a table cell's minor (for the editor's initial values). */
export function tableCellMinor(cassette: Cassette, collId: string, tableId: string, key: string): number | undefined {
  const coll = cassette.collections.find((c) => c.id === collId);
  const cell = (coll?.tables?.[tableId] as { map?: Record<string, MoneyCell> } | undefined)?.map?.[key];
  return cell && cell.t === 'money' ? cell.minor : undefined;
}

// --- formula literal editing (band thresholds + fee constants) ---------------------------------
// A formula is a tree of nodes { op, args?, value?, ... }. The only literals we let the admin edit
// are NUMERIC or MONEY `lit` values — band cutoffs (age < 23) and fee amounts (if(x, €3, €0)).
// Editing only a lit's number/minor, never its type or the tree shape, keeps every edit type-safe:
// buildPrepared re-typechecks the SAME graph, so it cannot start throwing. Enum band-names, the
// `blank` gate sentinels and bool comparators are deliberately NOT editable (an enum edit would
// silently break a downstream lookup), so they never surface as inputs. previewCassette is the backstop.

/** A path to a lit node within a formula: the sequence of object keys to walk from the root. */
export type FormulaPath = (string | number)[];

interface LitNode { op?: string; value?: { t?: string; v?: number; minor?: number | string } }

/** True for the literals the admin may edit: numeric thresholds and money constants only. Enum
 * band-names, `blank` gate sentinels and bool comparators are deliberately excluded (their type,
 * not their number, carries meaning — an enum edit would silently break a downstream lookup). */
function isEditableLit(node: unknown): node is Required<LitNode> {
  const n = node as LitNode;
  return !!n && n.op === 'lit' && (n.value?.t === 'num' || n.value?.t === 'money');
}

export interface LiteralRef {
  path: FormulaPath;
  valueType: 'num' | 'money';
  /** num → the raw number; money → minor units as a number (coerced; the AST may store either). */
  raw: number;
}

/** Walk a formula and collect every editable literal with a stable path. Recurses only through
 * `args`-bearing nodes (call / comparisons / arithmetic) — exactly where thresholds and constants
 * live — so opaque nodes (lookup, rollup, field) are left alone. Pure; the renderer walks in step. */
export function collectFormulaLiterals(formula: unknown, base: FormulaPath = []): LiteralRef[] {
  const out: LiteralRef[] = [];
  const n = formula as { op?: string; args?: unknown[]; value?: { t?: string; v?: number; minor?: number | string } };
  if (!n || typeof n !== 'object') return out;
  if (isEditableLit(n)) {
    const v = n.value;
    out.push({ path: base, valueType: v.t as 'num' | 'money', raw: Number((v.t === 'money' ? v.minor : v.v) ?? 0) });
    return out;
  }
  if (Array.isArray(n.args)) {
    n.args.forEach((child, i) => out.push(...collectFormulaLiterals(child, [...base, 'args', i])));
  }
  return out;
}

/** Set an editable literal (by path) to a new number. Pure: clones, preserves the lit's type and all
 * sibling fields (ccy/scale/set), writes only `v` (num) or `minor` (money). money.minor is kept an
 * INTEGER in the lit's OWN representation — string if it was a string, number if it was a number — so
 * it stays on @core's exact-integer money path (align() BigInt()s it) and consistent with its siblings. */
export function setFormulaLiteral(
  cassette: Cassette,
  collId: string,
  propId: string,
  path: FormulaPath,
  raw: number,
): Cassette {
  const next = structuredClone(cassette);
  const coll = next.collections.find((c) => c.id === collId);
  const prop = (coll?.properties ?? []).find((p) => p.id === propId) as { formula?: unknown } | undefined;
  let node = prop?.formula as Record<string, unknown> | undefined;
  for (const k of path) node = node?.[k as keyof typeof node] as Record<string, unknown> | undefined;
  const lit = node as LitNode | undefined;
  if (!lit || lit.op !== 'lit' || !lit.value) return next; // path stale — no-op (previewCassette still validates)
  if (lit.value.t === 'num') {
    lit.value.v = raw;
  } else if (lit.value.t === 'money') {
    const rounded = Math.round(raw);
    lit.value.minor = typeof lit.value.minor === 'string' ? String(rounded) : rounded;
  }
  return next;
}

/** Replace a computed field's WHOLE formula AST (a structural edit — new operators, refs, conditions), not
 * just a literal. Pure: clones, swaps `formula`, touches nothing else. Validity (types stay consistent with
 * the field's declared valueType, no new cycle, referenced fields exist) is NOT checked here — hand the
 * result to previewCassette, whose throwaway buildPrepared throws on any of those, so a bad expression is
 * caught before it is ever persisted. A no-op if the field is missing or not computed. */
export function setFormula(cassette: Cassette, collId: string, propId: string, formula: unknown): Cassette {
  const next = structuredClone(cassette);
  const coll = next.collections.find((c) => c.id === collId);
  const prop = (coll?.properties ?? []).find((p) => p.id === propId) as { source?: string; formula?: unknown } | undefined;
  if (prop && (prop.source ?? 'stored') === 'computed') prop.formula = structuredClone(formula);
  return next;
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  premium?: Value; // the sample quote's premium under the (edited) rules
}

interface SeedRow2 { coll: string; row: string; values: Record<string, Value> }

/** Validate a SINGLE computed field after a STRUCTURAL edit: load the candidate in a throwaway core, seed it,
 * and read the field — rejecting a runtime ERROR value OR a value whose type no longer matches the field's
 * DECLARED valueType (a structural edit that silently re-typed the field, which buildPrepared does not itself
 * reconcile). Complements previewCassette (which only sees the OUTPUT field). */
export function previewField(cassette: Cassette, collId: string, propId: string): PreviewResult {
  try {
    const core = createCore(mockExterns());
    core.load(cassette);
    const seed = (cassette as { seed?: SeedRow2[] }).seed;
    if (cassette.collections.length > 1 && Array.isArray(seed) && seed.length) {
      for (const s of seed) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
    } else {
      const values = (cassette as { example?: Record<string, Value> }).example ?? {};
      core.apply(collId, [{ op: 'insert', row: 'preview', values }]);
    }
    const prop = (cassette.collections.find((c) => c.id === collId)?.properties ?? []).find((p) => p.id === propId) as { valueType?: { k?: string } } | undefined;
    const docs = core.read(collId).map((r) => r.doc[propId]);
    const val = docs.find((v) => v && v.t !== 'blank') ?? docs[0];
    if (val && val.t === 'error') {
      const e = val as { code?: string; detail?: string };
      return { ok: false, error: `${e.code ?? '#ERR'}${e.detail ? ` ${e.detail}` : ''}` };
    }
    const declared = prop?.valueType?.k;
    if (val && val.t !== 'blank' && declared && val.t !== declared) {
      return { ok: false, error: `de formule levert ${val.t}, maar het veld is ${declared}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface SeedRow { coll: string; row: string; values: Record<string, Value> }

/** The cassette's headline output field — its journey summary total (e.g. finMonthly), else `premium`. */
function outputField(cassette: Cassette): string {
  return (cassette as { journey?: { summary?: { total?: string } } }).journey?.summary?.total ?? 'premium';
}
/** The collection that computes the output field (the flat cassette's single collection, or the
 * composed/journey spine). Falls back to the first collection. */
function outputCollection(cassette: Cassette, field: string): string {
  const c = cassette.collections.find((coll) => (coll.properties ?? []).some((p) => p.id === field && p.source === 'computed'));
  return (c ?? cassette.collections[0]).id;
}

/** Try-load a candidate cassette in a THROWAWAY core: validates (buildPrepared throws on a bad edit —
 * HQDM reduce + typecheck + acyclicity) and computes a sample quote. Never touches the live core.
 *
 * The sample is taken FROM the cassette so this works for either shape:
 *  · composed (multiple collections) → apply the `seed` graph (rows across collections, linked by
 *    relations), so the premium rolls up exactly as in the live player;
 *  · flat (one collection) → insert one row of `example` (or an explicit `sample`) into it.
 * (The flat cassette also carries a 1-row `seed`, but it is only a journey-starter — `step` — not a
 * quote; the collection count, not the mere presence of a seed, is what selects the path.)
 * Either way the premium is read from the collection that computes it (outputCollection). */
export function previewCassette(cassette: Cassette, sample?: Record<string, Value>): PreviewResult {
  try {
    const core = createCore(mockExterns());
    core.load(cassette);
    const field = outputField(cassette);
    const outColl = outputCollection(cassette, field);
    const seed = (cassette as { seed?: SeedRow[] }).seed;
    let premium: Value | undefined;
    if (cassette.collections.length > 1 && Array.isArray(seed) && seed.length) {
      // composed / journey: apply each seeded row into its collection (seed order puts the parent first);
      // the engine composes the total across collections via relations + rollup.
      for (const s of seed) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
      premium = core.read(outColl).find((r) => r.doc[field] && r.doc[field].t !== 'blank')?.doc[field];
    } else {
      const values = sample ?? (cassette as { example?: Record<string, Value> }).example ?? {};
      const [row] = core.apply(outColl, [{ op: 'insert', row: 'preview', values }]);
      premium = row?.doc[field];
    }
    // a formula that TYPECHECKS but computes to a runtime ERROR value (#DIV0, #TYPE, a bad lookup) is NOT ok —
    // the engine returns it as an error Value rather than throwing, so catch it here or a broken rule persists.
    if (premium && premium.t === 'error') {
      const e = premium as { code?: string; detail?: string };
      return { ok: false, error: `${e.code ?? '#ERR'}${e.detail ? ` ${e.detail}` : ''}` };
    }
    return { ok: true, premium: premium && premium.t !== 'blank' ? premium : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
