// The catalogue — the browsable index of cassettes, DERIVED from the files (cassette-registry). Every
// card loads its cassette into the SAME player (/play.html?cassette=<id>) with no code change. Grouped
// by the spine's HQDM class, so the taxonomy comes from the models themselves, not a hand-written list.

import './style/index.css';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { setLocale } from './format.ts';
import { CATALOGUE, REGISTRY, type CassetteMeta } from './cassette-registry.ts';

const themed = Object.values(REGISTRY).find((c) => c.theme);
const theme = themed?.theme;
const brand = theme?.brand ?? {};
setLocale(themed?.locale ?? 'nl');
document.title = `${brand.name ?? 'Rowblaa Bank'} — Catalogus`;

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
      ${brand.tagline ? `<span class="bank-since">${brand.tagline}</span>` : ''}
    </div>
    <div class="bank-tools">
      <a class="cc-btn cc-btn-quiet" href="/admin.html">Beheer</a>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <main id="mount" class="mount cat" tabindex="-1"></main>
`;

const themeBtn = app.querySelector<HTMLButtonElement>('#theme')!;
let mode: ThemeMode = initialMode();
const paint = (m: ThemeMode): void => {
  mode = m;
  applyTheme(theme, m);
  try { localStorage.setItem('fk-theme', m); } catch { /* private mode */ }
  themeBtn.textContent = m === 'light' ? '☀' : '☾';
  themeBtn.setAttribute('aria-pressed', String(m === 'dark'));
};
paint(mode);
themeBtn.addEventListener('click', () => paint(mode === 'light' ? 'dark' : 'light'));

const mount = app.querySelector<HTMLElement>('#mount')!;
const hero = el('div', 'cat-hero');
hero.append(el('h1', 'cat-title', 'Catalogus'));
hero.append(el('p', 'cat-sub', 'Elke kaart is een cassette — een model dat volledig in de browser draait op de verzegelde @core. Ze laden allemaal in dezelfde speler; er verandert geen code, alleen de cassette.'));
mount.append(hero);

const shapeLabel = (s: CassetteMeta['shape']): string => (s === 'composed' ? 'Samengesteld' : 'Eén pagina');

// group by HQDM class (the taxonomy the models themselves declare)
const byClass = new Map<string, CassetteMeta[]>();
for (const m of CATALOGUE) (byClass.get(m.klass) ?? byClass.set(m.klass, []).get(m.klass)!).push(m);

for (const [klass, metas] of byClass) {
  const section = el('section', 'cat-section');
  section.append(el('h2', 'cat-section-head', klass));
  const grid = el('div', 'cat-grid');
  for (const m of metas) {
    const card = el('a', 'cat-card') as HTMLAnchorElement;
    card.href = `/play.html?cassette=${encodeURIComponent(m.id)}`;
    const top = el('div', 'cat-card-top');
    top.append(el('span', 'cat-card-title', m.title));
    top.append(el('span', `cat-badge cat-badge-${m.shape}`, shapeLabel(m.shape)));
    card.append(top);
    if (m.doc) card.append(el('p', 'cat-card-doc', m.doc));
    const vitals = el('div', 'cat-vitals');
    vitals.append(el('span', 'cat-vital', `${m.collections} ${m.collections === 1 ? 'collectie' : 'collecties'}`));
    if (m.hasSteps) vitals.append(el('span', 'cat-vital', 'stapsgewijze journey'));
    vitals.append(el('span', 'cat-vital cat-mono', m.id));
    card.append(vitals);
    card.append(el('span', 'cat-go', 'Openen →'));
    grid.append(card);
  }
  section.append(grid);
  mount.append(section);
}

if (!CATALOGUE.length) mount.append(el('div', 'empty', 'Geen cassettes gevonden.'));
