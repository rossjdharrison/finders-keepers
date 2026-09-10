// The admin / rules editor — the "view + change the rules" surface. It loads the SAME cassette the
// player runs (rules are DATA), projects the logic (formulas, the pricing rate tables), lets you EDIT
// a rate or a threshold/fee, VALIDATES the edit by try-loading a throwaway core (never the live one),
// shows the effect on a sample quote live, and SAVES the edited cassette to localStorage — which the
// player then loads instead of the shipped JSON. No engine change: the sealed core already interprets
// whatever cassette it is given.
//
// One editor serves BOTH journeys, chosen by ?model=: the flat car-insurance (one collection) and the
// composed one (four collections — vehicles/drivers/covers rolled up into applications). The rate
// tables and formulas simply live across more collections there; the edit ops are already collection-
// keyed, and previewCassette derives its sample from the cassette (the composed `seed` graph or the
// flat `example`), so the same code drives both.

import './style/index.css';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import type { Cassette, Collection } from '@app/core-runtime';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { setLocale, format } from './format.ts';
import { buildEditableFormula } from './renderers/formula-edit.ts';
import { setTableCell, tableCellMinor, setFormulaLiteral, previewCassette } from './model-edit.ts';
import { REGISTRY, presentationDonor } from './cassette-registry.ts';

// registry-driven: this ONE editor can edit ANY product cassette (chosen by ?model=<id>). A cassette
// carrying no theme/l10n of its own (e.g. the composed variant) borrows a donor's presentation.
const MODELS: Record<string, { cassette: Cassette; player: string; label: string }> = Object.fromEntries(
  Object.values(REGISTRY).map((c) => [c.id, { cassette: c, player: `/play.html?cassette=${c.id}`, label: c.id }]),
);
const ids = Object.keys(MODELS);
const rawModel = new URLSearchParams(location.search).get('model') ?? (MODELS['car-insurance'] ? 'car-insurance' : ids[0]);
const modelId = MODELS[rawModel] ? rawModel : MODELS['car-insurance'] ? 'car-insurance' : ids[0]; // normalize unknown → default
const active = MODELS[modelId];
const shipped = active.cassette;
const MODEL_KEY = `fk-cassette-model-${shipped.id}`;
const locale = shipped.locale ?? 'nl';
setLocale(locale);
const pres = presentationDonor(shipped);
const theme = shipped.theme ?? pres.theme; // a lean cassette borrows a donor's brand/palette
const brand = theme?.brand ?? {};
const labels = { ...(pres.l10n?.[locale] ?? {}), ...(shipped.l10n?.[locale] ?? {}) };
// friendly names for the composed collections (the flat cassette has a single, unnamed collection)
const COLL_LABELS: Record<string, string> = { applications: 'Aanvraag', vehicles: 'Voertuig', drivers: 'Bestuurder', covers: 'Dekking' };
const collLabel = (coll: Collection): string => labels[coll.id] ?? COLL_LABELS[coll.id] ?? coll.id;
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
      <div class="adm-modelswitch" role="group" aria-label="Kies het model">
        ${Object.entries(MODELS).map(([id, m]) => `<a class="adm-modeltab${id === modelId ? ' is-active' : ''}" href="/admin.html?model=${id}"${id === modelId ? ' aria-current="true"' : ''}>${m.label}</a>`).join('')}
      </div>
      <a class="cc-btn cc-btn-quiet" href="${active.player}">Naar de aanvraag →</a>
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
  applyTheme(theme, m);
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
  const res = previewCassette(cass);
  previewPremium.textContent = res.ok && res.premium ? format(res.premium) : '—';
  previewStatus.textContent = res.ok ? '✓ Regels geldig' : `✗ ${res.error ?? 'ongeldig'}`;
  previewStatus.dataset.state = res.ok ? 'positive' : 'error';
  saveBtn.disabled = !res.ok || !dirty;
  savedNote.textContent = dirty ? 'Niet-opgeslagen wijzigingen' : localStorage.getItem(MODEL_KEY) ? 'Opgeslagen — de aanvraag gebruikt deze regels.' : 'Standaardregels.';
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

// one editable rate cell (€, euros in the UI ↔ integer minor in the model)
function renderRateCell(collId: string, tableId: string, key: string, minor: number): HTMLElement {
  const cell = el('label', 'adm-rate');
  cell.append(el('span', 'adm-rate-key', key));
  const input = document.createElement('input');
  input.className = 'cell-input adm-rate-input';
  input.type = 'number';
  input.step = '0.01';
  input.min = '0';
  let committedMinor = minor; // last VALID minor this cell holds — reject reverts here
  input.value = (committedMinor / 100).toFixed(2);
  input.setAttribute('aria-label', `${tableId} · ${key} (euro)`);
  input.addEventListener('change', () => {
    // valueAsNumber (NOT Number(value)) — it is NaN for an empty/invalid field; Number("") is 0,
    // which would silently commit a cleared rate as €0,00 (and desync the display from the cassette).
    const euros = input.valueAsNumber;
    if (!Number.isFinite(euros) || euros < 0) { input.value = (committedMinor / 100).toFixed(2); return; }
    committedMinor = Math.round(euros * 100);
    input.value = (committedMinor / 100).toFixed(2);
    cass = setTableCell(cass, collId, tableId, key, committedMinor);
    dirty = true;
    refreshPreview();
  });
  cell.append(el('span', 'adm-rate-cur', '€'), input);
  return cell;
}

// --- render --------------------------------------------------------------------------------------
function render(): void {
  mount.replaceChildren();
  const cols = el('div', 'adm-cols');
  const left = el('div', 'adm-main');
  const multi = cass.collections.length > 1; // composed → sub-head each block by collection

  // TARIEVEN — every rate table, across every collection (vehicles/drivers/covers in the composed model)
  left.append(el('h2', 'adm-h', 'Tarieven'));
  left.append(el('p', 'adm-sub', 'De prijstabellen die de premie bepalen. Wijzig een bedrag en zie het effect direct rechts; sla op om de aanvraag deze regels te laten gebruiken.'));
  for (const coll of cass.collections) {
    const tables = (coll.tables ?? {}) as Record<string, { map?: Record<string, { t?: string }> }>;
    if (!Object.keys(tables).length) continue;
    if (multi) left.append(el('h3', 'adm-coll-head', collLabel(coll)));
    for (const [tableId, tdef] of Object.entries(tables)) {
      const sec = el('section', 'adm-table');
      sec.append(el(multi ? 'h4' : 'h3', 'adm-table-title', tableId)); // one level under the collection head when grouped
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

  // FORMULES & DREMPELS — every computed field, across every collection. The numbers inside — band
  // drempels (age < 23) and vaste bedragen (€ 3,00) — are inline-editable; every operator and branch
  // stays fixed, so an edit can only change a value, never the shape. Purely derived formulas read-only.
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
