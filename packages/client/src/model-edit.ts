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

export interface PreviewResult {
  ok: boolean;
  error?: string;
  premium?: Value; // the sample quote's premium under the (edited) rules
}

/** Try-load a candidate cassette in a THROWAWAY core: validates (buildPrepared throws on a bad edit —
 * HQDM reduce + typecheck + acyclicity) and computes a sample quote. Never touches the live core. */
export function previewCassette(cassette: Cassette, sample: Record<string, Value>): PreviewResult {
  try {
    const core = createCore(mockExterns());
    core.load(cassette);
    const [row] = core.apply('applications', [{ op: 'insert', row: 'preview', values: sample }]);
    const p = row?.doc.premium;
    return { ok: true, premium: p && p.t !== 'blank' ? p : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
