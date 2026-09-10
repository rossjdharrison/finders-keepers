// The Grafiek FORMULA INSPECTOR — click a computed node in the dependency graph to SEE its formula and,
// for a flat product cassette, EDIT the numeric constants inside it (the same band-threshold / fee-amount
// literals the Regels tab exposes, here reached straight from the graph). It reuses buildEditableFormula
// (the inline-editable renderer) + setFormulaLiteral + previewCassette, so an edit is type-safe and
// validated in a throwaway core before it is persisted; nothing here can brick the live model.
//
// Two modes: EDITABLE (a flat product cassette — the host wires onEdit to persist to the same localStorage
// the player reads) and READ-ONLY (a compiled journey — its rules live in the member products, so the
// composed seam/formula is shown but not editable, mirroring the Regels tab's view-only journey stance).

import type { Cassette } from '@app/core-runtime';
import type { Value } from '@core/values';
import type { GNode } from './graph.ts';
import type { FormulaPath } from '../model-edit.ts';
import { buildEditableFormula } from '../renderers/formula-edit.ts';
import { describeFormula } from '../renderers/docs.ts';
import { format } from '../format.ts';

interface Prop { id: string; source?: string; valueType: { k: string }; formula?: unknown }

export interface EditResult { ok: boolean; error?: string; premium?: Value }

export interface FormulaInspectorOpts {
  label: (id: string) => string;
  /** the cassette to READ a field's current formula from — the edited copy in editable mode, else the model */
  model: () => Cassette;
  /** present → the field's numeric literals are editable; the callback applies + validates + persists and
   * returns the result (ok / error / the resulting sample output). Absent → read-only. */
  onEdit?: (collId: string, propId: string, path: FormulaPath, raw: number) => EditResult;
  /** label for the sample-output readout shown after an edit (e.g. "Maandtermijn") */
  outputLabel?: string;
  /** jump to the full Regels editor (offered as a link in editable mode) */
  openRules?: () => void;
}

export interface FormulaInspector {
  /** render the inspector for a clicked computed node */
  show: (n: GNode) => void;
  /** render the empty hint (nothing selected yet) */
  reset: () => void;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Mount a formula inspector into `mount`. Call show(node) on a computed-node click; reset() for the
 * empty state. Self-contained — the host owns the edited cassette + persistence via opts.onEdit. */
export function createFormulaInspector(mount: HTMLElement, opts: FormulaInspectorOpts): FormulaInspector {
  const editable = !!opts.onEdit;

  const reset = (): void => {
    mount.replaceChildren();
    const hint = el('div', 'lm-inspect-empty');
    hint.append(el('span', 'lm-inspect-glyph', 'ƒ'));
    hint.append(document.createTextNode(editable
      ? ' Klik op een berekend veld om de formule te bekijken en de getallen erin aan te passen.'
      : ' Klik op een berekend veld om de formule te bekijken.'));
    mount.append(hint);
  };

  const show = (n: GNode): void => {
    const cass = opts.model();
    const coll = cass.collections.find((c) => c.id === n.coll);
    const prop = (coll?.properties as Prop[] | undefined)?.find((p) => p.id === n.id);

    mount.replaceChildren();
    const card = el('div', 'lm-inspect-card');

    const head = el('div', 'lm-inspect-head');
    head.append(el('span', 'lm-inspect-badge', 'ƒ'));
    head.append(el('span', 'lm-inspect-title', opts.label(n.id)));
    head.append(el('span', 'lm-inspect-meta', `${n.collLabel} · ${n.typeK} · berekend`));
    card.append(head);

    if (!prop || prop.source !== 'computed' || !prop.formula) {
      // a stored/extern input, or a computed field with no stored formula — nothing to show
      card.append(el('p', 'lm-inspect-note', 'Dit veld heeft geen formule om te tonen (het is een invoer- of extern veld).'));
      mount.append(card);
      return;
    }

    const eq = el('div', 'lm-inspect-eq');
    eq.append(el('span', 'lm-inspect-eq-lhs', `${opts.label(n.id)} =`));

    if (!editable) {
      // read-only (a journey's composed formula): the derived expression as text, not editable
      const code = el('code', 'fx');
      code.textContent = describeFormula(prop.formula);
      eq.append(code);
      card.append(eq);
      card.append(el('p', 'lm-inspect-note', 'Berekend — vast. In een pakket wonen de regels in de samengestelde producten; bewerk ze in het Loom van elk product.'));
      mount.append(card);
      return;
    }

    // editable (a flat product cassette): inline-editable numeric literals, validated + persisted per edit
    const status = el('div', 'lm-inspect-status');
    const showResult = (res: EditResult): void => {
      if (res.ok) {
        status.dataset.state = 'positive';
        const msg = res.premium && opts.outputLabel
          ? `✓ Opgeslagen — ${opts.outputLabel}: ${format(res.premium)}`
          : '✓ Opgeslagen — de aanvraag gebruikt deze regel.';
        status.textContent = msg;
      } else {
        status.dataset.state = 'error';
        status.textContent = `✗ ${res.error ?? 'ongeldige waarde — niet opgeslagen'}`;
      }
    };

    const { el: body, count } = buildEditableFormula(prop.formula, {
      subject: opts.label(n.id),
      onEdit: (path, raw) => showResult(opts.onEdit!(n.coll, n.id, path, raw)),
    });
    body.classList.add('lm-inspect-formula');
    eq.append(body);
    card.append(eq);

    card.append(el('p', 'lm-inspect-note', count > 0
      ? 'De blauw omkaderde getallen — drempels en vaste bedragen — kunt u aanpassen; elke wijziging wordt in de verzegelde core gevalideerd en direct opgeslagen. De overige delen zijn afgeleid uit het model.'
      : 'Deze formule is volledig afgeleid uit andere velden — er zijn geen instelbare getallen om aan te passen.'));
    if (count > 0) card.append(status);

    if (opts.openRules) {
      const more = el('button', 'lm-inspect-more', 'Alle regels & voorbeeldpremie →') as HTMLButtonElement;
      more.type = 'button';
      more.addEventListener('click', () => opts.openRules!());
      card.append(more);
    }

    mount.append(card);
  };

  reset();
  return { show, reset };
}
