// A single shared editing session for a flat product cassette. ONE in-memory edited cassette that BOTH the
// Regels tab (batch: edit → Save) and the Grafiek formula inspector (edit → auto-save) read from and write
// to, persisted to the one localStorage key `fk-cassette-model-<id>` the player reads.
//
// Why this exists: previously each tab kept its OWN clone keyed to the same localStorage slot with different
// persistence models, so one editor could silently clobber the other's unsaved edits (a Grafiek auto-save
// wrote a clone that never held the Regels tab's pending rate change, then evicted+rebuilt Regels from that
// clone). Sharing one source of truth removes that divergence entirely: every edit lands on the same
// cassette, so nothing unsaved is ever lost, whichever tab persists.

import type { Cassette } from '@app/core-runtime';
import { setTableCell, setFormulaLiteral, setFormula, previewCassette, previewField, type FormulaPath, type PreviewResult } from '../model-edit.ts';

export interface ModelEditing {
  readonly key: string; // the localStorage key the player reads
  cass(): Cassette; // the current shared edited cassette
  /** batch edits — mutate the shared cassette + mark dirty; persistence happens via save() */
  applyTableCell(collId: string, tableId: string, key: string, minor: number): void;
  applyLiteral(collId: string, propId: string, path: FormulaPath, raw: number): void;
  /** structural edit: validate a whole-formula replacement in a throwaway core and, ONLY if it is valid,
   * commit + persist it. Returns the preview result; on failure the shared cassette is left untouched. */
  trySetFormula(collId: string, propId: string, formula: unknown): PreviewResult;
  preview(): PreviewResult; // validate the current cassette + a sample output (never persists)
  dirty(): boolean; // are there edits not yet persisted?
  saved(): boolean; // is there a persisted override (vs. shipped defaults)?
  /** validate + persist the shared cassette; on success clear dirty and notify subscribers. */
  save(): PreviewResult;
  /** drop the override + reset to shipped defaults; notify subscribers. */
  revert(): void;
  /** notified after save() or revert() (the persisted cassette changed) — the host re-syncs sibling tabs. */
  subscribe(cb: () => void): void;
}

export function createModelEditing(shipped: Cassette): ModelEditing {
  const key = `fk-cassette-model-${shipped.id}`;
  const load = (): Cassette => {
    try { const ov = localStorage.getItem(key); if (ov) return JSON.parse(ov) as Cassette; } catch { /* fall back to shipped */ }
    return structuredClone(shipped);
  };
  let cass = load();
  let isDirty = false;
  const subs: (() => void)[] = [];
  const notify = (): void => { for (const cb of subs) cb(); };
  const commit = (): void => {
    try { localStorage.setItem(key, JSON.stringify(cass)); } catch { /* private mode / quota — durability is best-effort */ }
    isDirty = false;
    notify();
  };

  return {
    key,
    cass: () => cass,
    applyTableCell: (c, t, k, m) => { cass = setTableCell(cass, c, t, k, m); isDirty = true; },
    applyLiteral: (c, p, path, raw) => { cass = setFormulaLiteral(cass, c, p, path, raw); isDirty = true; },
    trySetFormula: (c, p, formula) => {
      const candidate = setFormula(cass, c, p, formula);
      const res = previewCassette(candidate); // load + typecheck + the OUTPUT field is not an error
      if (!res.ok) return res;
      const fieldRes = previewField(candidate, c, p); // the EDITED field itself: not an error, type unchanged
      if (!fieldRes.ok) return fieldRes;
      cass = candidate;
      commit();
      return res;
    },
    preview: () => previewCassette(cass),
    dirty: () => isDirty,
    saved: () => { try { return !!localStorage.getItem(key); } catch { return false; } },
    save: () => {
      const res = previewCassette(cass);
      if (!res.ok) return res; // never persist an invalid cassette
      commit();
      return res;
    },
    revert: () => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      cass = structuredClone(shipped);
      isDirty = false;
      notify();
    },
    subscribe: (cb) => { subs.push(cb); },
  };
}
