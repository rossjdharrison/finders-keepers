// The RULES editor — the "change the rules" surface, hosted as the Loom's Regels tab. It edits a rate cell
// or an in-formula threshold/fee, shows the effect on a sample quote live, and SAVES to the localStorage the
// player reads. Only VALUE literals are editable; the tree shape / types stay fixed, so buildPrepared cannot
// start throwing (the shared editor's preview() is the backstop regardless).
//
// State lives in a SHARED ModelEditing session (loom/model-editing.ts), not here: the Grafiek formula
// inspector edits the SAME cassette through the same session, so neither tab can silently discard the
// other's unsaved edits. This editor batches (edit → Save); the inspector auto-saves; both over one cassette.

import type { Collection } from '@app/core-runtime';
import { format } from '../format.ts';
import { buildEditableFormula } from '../renderers/formula-edit.ts';
import { tableCellMinor } from '../model-edit.ts';
import type { ModelEditing } from './model-editing.ts';

export interface RulesEditorOpts {
  editing: ModelEditing; // the shared edited-cassette session (owns load / dirty / save / revert)
  labels: Record<string, string>; // merged l10n
  collLabels?: Record<string, string>; // friendly names for composed collections
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Mount the rate-table + formula-threshold editor into `mount`, with a live preview and Save/revert.
 * Reads and writes the shared ModelEditing session; its own re-render is driven by that session's state. */
export function renderRulesEditor(mount: HTMLElement, opts: RulesEditorOpts): void {
  const { editing } = opts;
  const labels = opts.labels;
  const label = (id: string): string => labels[id] ?? id;
  const collLabel = (coll: Collection): string => labels[coll.id] ?? opts.collLabels?.[coll.id] ?? coll.id;

  const previewPremium = el('div', 'adm-premium', '—');
  const previewStatus = el('div', 'adm-status');
  const saveBtn = el('button', 'j-btn j-next', 'Regels opslaan') as HTMLButtonElement;
  saveBtn.type = 'button';
  const revertBtn = el('button', 'j-btn', 'Terugzetten naar standaard') as HTMLButtonElement;
  revertBtn.type = 'button';
  const savedNote = el('div', 'adm-saved');

  const refreshPreview = (): void => {
    const res = editing.preview();
    previewPremium.textContent = res.ok && res.premium ? format(res.premium) : '—';
    previewStatus.textContent = res.ok ? '✓ Regels geldig' : `✗ ${res.error ?? 'ongeldig'}`;
    previewStatus.dataset.state = res.ok ? 'positive' : 'error';
    saveBtn.disabled = !res.ok || !editing.dirty();
    savedNote.textContent = editing.dirty()
      ? 'Niet-opgeslagen wijzigingen'
      : editing.saved()
        ? 'Opgeslagen — de aanvraag gebruikt deze regels.'
        : 'Standaardregels.';
  };

  saveBtn.addEventListener('click', () => {
    if (editing.save().ok) refreshPreview(); // save() persists + notifies sibling tabs; never persists if invalid
  });
  revertBtn.addEventListener('click', () => {
    editing.revert(); // clears the override + notifies sibling tabs
    render();
  });

  function renderRateCell(collId: string, tableId: string, key: string, minor: number): HTMLElement {
    const cell = el('label', 'adm-rate');
    cell.append(el('span', 'adm-rate-key', key));
    const input = document.createElement('input');
    input.className = 'cell-input adm-rate-input';
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    let committedMinor = minor;
    input.value = (committedMinor / 100).toFixed(2);
    input.setAttribute('aria-label', `${tableId} · ${key} (euro)`);
    input.addEventListener('change', () => {
      const euros = input.valueAsNumber;
      if (!Number.isFinite(euros) || euros < 0) {
        input.value = (committedMinor / 100).toFixed(2);
        return;
      }
      committedMinor = Math.round(euros * 100);
      input.value = (committedMinor / 100).toFixed(2);
      editing.applyTableCell(collId, tableId, key, committedMinor);
      refreshPreview();
    });
    cell.append(el('span', 'adm-rate-cur', '€'), input);
    return cell;
  }

  function render(): void {
    mount.replaceChildren();
    const cass = editing.cass();
    const cols = el('div', 'adm-cols');
    const left = el('div', 'adm-main');
    const multi = cass.collections.length > 1;

    left.append(el('h2', 'adm-h', 'Tarieven'));
    left.append(el('p', 'adm-sub', 'De prijstabellen die de premie bepalen. Wijzig een bedrag en zie het effect direct rechts; sla op om de aanvraag deze regels te laten gebruiken.'));
    for (const coll of cass.collections) {
      const tables = (coll.tables ?? {}) as Record<string, { map?: Record<string, { t?: string }> }>;
      if (!Object.keys(tables).length) continue;
      if (multi) left.append(el('h3', 'adm-coll-head', collLabel(coll)));
      for (const [tableId, tdef] of Object.entries(tables)) {
        const sec = el('section', 'adm-table');
        sec.append(el(multi ? 'h4' : 'h3', 'adm-table-title', tableId));
        const grid = el('div', 'adm-rates');
        for (const key of Object.keys(tdef.map ?? {})) {
          const minor = tableCellMinor(cass, coll.id, tableId, key);
          if (minor === undefined) continue;
          grid.append(renderRateCell(coll.id, tableId, key, minor));
        }
        sec.append(grid);
        left.append(sec);
      }
    }

    left.append(el('h2', 'adm-h', 'Formules & drempels'));
    left.append(el('p', 'adm-sub', 'De berekende velden. De blauw omkaderde getallen — drempelwaarden en vaste bedragen — kunt u aanpassen; de overige velden zijn volledig afgeleid uit het model.'));
    for (const coll of cass.collections) {
      const comps = (coll.properties ?? []).filter((p) => p.source === 'computed' && p.formula);
      if (!comps.length) continue;
      if (multi) left.append(el('h3', 'adm-coll-head', collLabel(coll)));
      const flist = el('div', 'adm-formulas');
      for (const p of comps) {
        const row = el('div', 'adm-formula');
        row.append(el('span', 'adm-formula-id', label(p.id)));
        const { el: body, count } = buildEditableFormula(p.formula, {
          subject: label(p.id),
          onEdit: (path, raw) => {
            editing.applyLiteral(coll.id, p.id, path, raw);
            refreshPreview();
          },
        });
        body.classList.add('adm-formula-body');
        if (count > 0) row.classList.add('adm-formula-editable');
        row.append(body);
        flist.append(row);
      }
      left.append(flist);
    }
    cols.append(left);

    const right = el('aside', 'adm-preview');
    const card = el('div', 'quote');
    card.append(el('div', 'quote-eyebrow', 'Voorbeeldpremie (met deze regels)'));
    const hero = el('div', 'quote-hero');
    hero.append(previewPremium);
    previewPremium.classList.add('quote-amount');
    card.append(hero);
    card.append(previewStatus);
    const actions = el('div', 'adm-actions');
    saveBtn.classList.add('j-next');
    actions.append(saveBtn, revertBtn);
    card.append(actions);
    card.append(savedNote);
    right.append(card);
    cols.append(right);

    mount.append(cols);
    refreshPreview();
  }

  render();
}
