// The admin / rules editor — the "view + change the rules" surface. It loads the SAME cassette the
// player runs (rules are DATA), projects the logic (formulas via describeFormula, the pricing rate
// tables), lets you EDIT a rate, VALIDATES the edit by try-loading a throwaway core (never the live
// one), shows the effect on a sample quote live, and SAVES the edited cassette to localStorage — which
// the player then loads instead of the shipped JSON. First slice: editable rate tables + read-only
// formulas. No engine change: the sealed core already interprets whatever cassette it is given.

import './style/index.css';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import carInsurance from './cassettes/car-insurance.json';
import type { Cassette } from '@app/core-runtime';
import type { Value } from '@core/values';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { setLocale, format } from './format.ts';
import { describeFormula } from './renderers/docs.ts';
import { setTableCell, tableCellMinor, previewCassette } from './model-edit.ts';

const shipped = carInsurance as unknown as Cassette;
const MODEL_KEY = `fk-cassette-model-${shipped.id}`;
const locale = shipped.locale ?? 'nl';
setLocale(locale);
const brand = shipped.theme?.brand ?? {};
const labels = shipped.l10n?.[locale] ?? {};
const sample = (shipped.example ?? {}) as Record<string, Value>;
document.title = `${brand.name ?? 'Rowblaa Bank'} — Beheer`;

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

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="bank-topbar" role="banner">
    <div class="bank-identity">
      <span class="bank-mark" aria-hidden="true">${logoSvg}</span>
      <span class="bank-name">${brand.name ?? 'Rowblaa Bank'}</span>
      <span class="bank-since">Beheer · regels</span>
    </div>
    <div class="bank-tools">
      <a class="cc-btn cc-btn-quiet" href="/cassette.html">Naar de aanvraag →</a>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <main id="mount" class="mount admin" tabindex="-1"></main>
`;

// theme
const themeBtn = app.querySelector<HTMLButtonElement>('#theme')!;
let mode: ThemeMode = initialMode();
const paint = (m: ThemeMode): void => {
  mode = m;
  applyTheme(shipped.theme, m);
  try {
    localStorage.setItem('fk-theme', m);
  } catch {
    /* private mode */
  }
  themeBtn.textContent = m === 'light' ? '☀' : '☾';
  themeBtn.setAttribute('aria-pressed', String(m === 'dark'));
};
paint(mode);
themeBtn.addEventListener('click', () => paint(mode === 'light' ? 'dark' : 'light'));

const mount = app.querySelector<HTMLElement>('#mount')!;
const label = (id: string): string => labels[id] ?? id;

// --- the live preview panel (right) -----------------------------------------------------------
const previewPremium = el('div', 'adm-premium', '—');
const previewStatus = el('div', 'adm-status');
const saveBtn = el('button', 'j-btn j-next', 'Regels opslaan') as HTMLButtonElement;
saveBtn.type = 'button';
const revertBtn = el('button', 'j-btn', 'Terugzetten naar standaard') as HTMLButtonElement;
revertBtn.type = 'button';
const savedNote = el('div', 'adm-saved');

const refreshPreview = (): void => {
  const res = previewCassette(cass, sample);
  previewPremium.textContent = res.ok && res.premium ? format(res.premium) : '—';
  previewStatus.textContent = res.ok ? '✓ Regels geldig' : `✗ ${res.error ?? 'ongeldig'}`;
  previewStatus.dataset.state = res.ok ? 'positive' : 'error';
  saveBtn.disabled = !res.ok || !dirty;
  savedNote.textContent = dirty ? 'Niet-opgeslagen wijzigingen' : localStorage.getItem(MODEL_KEY) ? 'Opgeslagen — de aanvraag gebruikt deze regels.' : 'Standaardregels.';
};

saveBtn.addEventListener('click', () => {
  const res = previewCassette(cass, sample);
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

// --- render --------------------------------------------------------------------------------------
function render(): void {
  mount.replaceChildren();
  const cols = el('div', 'adm-cols');

  // LEFT: editable rate tables + read-only formulas (the rules)
  const left = el('div', 'adm-main');
  left.append(el('h2', 'adm-h', 'Tarieven'));
  left.append(el('p', 'adm-sub', 'De prijstabellen die de premie bepalen. Wijzig een bedrag en zie het effect direct rechts; sla op om de aanvraag deze regels te laten gebruiken.'));

  const appColl = cass.collections[0];
  const tables = (appColl.tables ?? {}) as Record<string, { map?: Record<string, { t?: string }> }>;
  for (const [tableId, tdef] of Object.entries(tables)) {
    const sec = el('section', 'adm-table');
    sec.append(el('h3', 'adm-table-title', tableId));
    const grid = el('div', 'adm-rates');
    for (const key of Object.keys(tdef.map ?? {})) {
      const minor = tableCellMinor(cass, appColl.id, tableId, key);
      if (minor === undefined) continue;
      const cell = el('label', 'adm-rate');
      cell.append(el('span', 'adm-rate-key', key));
      const input = document.createElement('input');
      input.className = 'cell-input adm-rate-input';
      input.type = 'number';
      input.step = '0.01';
      input.min = '0';
      input.value = (minor / 100).toFixed(2);
      input.setAttribute('aria-label', `${tableId} · ${key} (euro)`);
      input.addEventListener('change', () => {
        const euros = Number(input.value);
        if (!Number.isFinite(euros) || euros < 0) return;
        cass = setTableCell(cass, appColl.id, tableId, key, euros * 100);
        dirty = true;
        refreshPreview();
      });
      const suffix = el('span', 'adm-rate-cur', '€');
      cell.append(suffix, input);
      grid.append(cell);
    }
    sec.append(grid);
    left.append(sec);
  }

  // read-only: the computed formulas (the derived logic), projected from the model
  left.append(el('h2', 'adm-h', 'Formules'));
  left.append(el('p', 'adm-sub', 'De berekende velden en hun formule — afgeleid uit het model, alleen-lezen in deze eerste versie.'));
  const flist = el('div', 'adm-formulas');
  for (const p of appColl.properties) {
    if (p.source !== 'computed' || !p.formula) continue;
    const row = el('div', 'adm-formula');
    row.append(el('span', 'adm-formula-id', label(p.id)));
    row.append(el('code', 'adm-formula-body', describeFormula(p.formula)));
    flist.append(row);
  }
  left.append(flist);
  cols.append(left);

  // RIGHT: the live preview + save
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
