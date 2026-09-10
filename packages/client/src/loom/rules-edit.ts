// The RULES editor — the "change the rules" surface, extracted from admin.ts so the Loom hosts it as
// its third tab (the unified view+alter canvas). It is unchanged in behaviour: it loads the SAME
// cassette the player runs (rules are DATA), edits a rate cell or an in-formula threshold/fee, VALIDATES
// each edit by try-loading a throwaway core (previewCassette — never the live one), shows the effect on
// a sample quote live, and SAVES the edited cassette to localStorage (`fk-cassette-model-<id>`) — which
// the player then loads instead of the shipped JSON. Only VALUE literals are editable; the tree shape /
// types stay fixed, so buildPrepared cannot start throwing (previewCassette is the backstop regardless).

import type { Cassette, Collection } from '@app/core-runtime';
import { format } from '../format.ts';
import { buildEditableFormula } from '../renderers/formula-edit.ts';
import { setTableCell, tableCellMinor, setFormulaLiteral, previewCassette } from '../model-edit.ts';

export interface RulesEditorOpts {
  shipped: Cassette; // the shipped (unedited) cassette — revert target + storage key source
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
 * Self-contained: owns its edited-cassette state, its localStorage key, and its own re-render. */
export function renderRulesEditor(mount: HTMLElement, opts: RulesEditorOpts): void {
  const { shipped } = opts;
  const MODEL_KEY = `fk-cassette-model-${shipped.id}`;
  const labels = opts.labels;
  const label = (id: string): string => labels[id] ?? id;
  const collLabel = (coll: Collection): string => labels[coll.id] ?? opts.collLabels?.[coll.id] ?? coll.id;

  const loadCassette = (): Cassette => {
    try {
      const ov = localStorage.getItem(MODEL_KEY);
      if (ov) return JSON.parse(ov) as Cassette;
    } catch {
      /* fall back to shipped */
    }
    return structuredClone(shipped);
  };

  let cass = loadCassette();
  let dirty = false;

  const previewPremium = el('div', 'adm-premium', '—');
  const previewStatus = el('div', 'adm-status');
  const saveBtn = el('button', 'j-btn j-next', 'Regels opslaan') as HTMLButtonElement;
  saveBtn.type = 'button';
  const revertBtn = el('button', 'j-btn', 'Terugzetten naar standaard') as HTMLButtonElement;
  revertBtn.type = 'button';
  const savedNote = el('div', 'adm-saved');

  const refreshPreview = (): void => {
    const res = previewCassette(cass);
    previewPremium.textContent = res.ok && res.premium ? format(res.premium) : '—';
    previewStatus.textContent = res.ok ? '✓ Regels geldig' : `✗ ${res.error ?? 'ongeldig'}`;
    previewStatus.dataset.state = res.ok ? 'positive' : 'error';
    saveBtn.disabled = !res.ok || !dirty;
    savedNote.textContent = dirty
      ? 'Niet-opgeslagen wijzigingen'
      : localStorage.getItem(MODEL_KEY)
        ? 'Opgeslagen — de aanvraag gebruikt deze regels.'
        : 'Standaardregels.';
  };

  saveBtn.addEventListener('click', () => {
    const res = previewCassette(cass);
    if (!res.ok) return; // never persist an invalid cassette
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(cass));
    } catch {
      /* private mode */
    }
    dirty = false;
    refreshPreview();
  });
  revertBtn.addEventListener('click', () => {
    try {
      localStorage.removeItem(MODEL_KEY);
    } catch {
      /* ignore */
    }
    cass = structuredClone(shipped);
    dirty = false;
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
      cass = setTableCell(cass, collId, tableId, key, committedMinor);
      dirty = true;
      refreshPreview();
    });
    cell.append(el('span', 'adm-rate-cur', '€'), input);
    return cell;
  }

  function render(): void {
    mount.replaceChildren();
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
            cass = setFormulaLiteral(cass, coll.id, p.id, path, raw);
            dirty = true;
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
