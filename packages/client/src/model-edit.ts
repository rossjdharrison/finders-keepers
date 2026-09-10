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
