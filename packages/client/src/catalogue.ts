// The catalogue — the browsable index of cassettes, DERIVED from the files (cassette-registry). Every
// card loads its cassette into the SAME player (/play.html?cassette=<id>) with no code change. Grouped
// by the spine's HQDM class, so the taxonomy comes from the models themselves, not a hand-written list.

import './style/index.css';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { setLocale } from './format.ts';
import { CATALOGUE, REGISTRY, type CassetteMeta } from './cassette-registry.ts';
import { playerHref, loomHref, shapeLabel, NAV } from './nav.ts';

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

const renderCard = (m: CassetteMeta): HTMLElement => {
  const card = el('div', 'cat-card');
  const main = el('a', 'cat-card-main') as HTMLAnchorElement;
  main.href = playerHref(m.id); // the aanvraag
  const top = el('div', 'cat-card-top');
  top.append(el('span', 'cat-card-title', m.title));
  top.append(el('span', `cat-badge cat-badge-${m.collections > 1 ? 'reis' : 'configurator'}`, shapeLabel(m.collections)));
  main.append(top);
  if (m.doc) main.append(el('p', 'cat-card-doc', m.doc));
  const vitals = el('div', 'cat-vitals');
  vitals.append(el('span', 'cat-vital', `${m.collections} ${m.collections === 1 ? 'collectie' : 'collecties'}`));
  if (m.hasSteps) vitals.append(el('span', 'cat-vital', 'stapsgewijze reis'));
  vitals.append(el('span', 'cat-vital cat-mono', m.id));
  main.append(vitals);
  main.append(el('span', 'cat-go', `${NAV.aanvraag} →`));
  card.append(main);
  // second entry: the Model (view the structure + graph, alter the rules) — a journey opens by ?journey=
  const foot = el('div', 'cat-card-foot');
  const model = el('a', 'cat-card-loom') as HTMLAnchorElement;
  model.href = loomHref(m.id, { isJourney: m.shape === 'journey' });
  model.append(el('span', 'cat-card-loom-gear', '⚙'), document.createTextNode(` ${NAV.model} →`));
  foot.append(model);
  card.append(foot);
  return card;
};
const gridOf = (metas: CassetteMeta[]): HTMLElement => {
  const grid = el('div', 'cat-grid');
  for (const m of metas) grid.append(renderCard(m));
  return grid;
};

// A composed product/journey (more than one collection) is a whole assembled process; a single-collection
// cassette is a reusable building block. Lead with the assembled ones, then the components they are made of.
const journeys = CATALOGUE.filter((m) => m.collections > 1);
const components = CATALOGUE.filter((m) => m.collections <= 1);

if (journeys.length) {
  const section = el('section', 'cat-section');
  section.append(el('h2', 'cat-section-head', 'Reizen'));
  section.append(el('p', 'cat-section-sub', 'Samengestelde reizen — meerdere configurators, gekoppeld via getypte L2-naden tot één aanvraag.'));
  section.append(gridOf(journeys));
  mount.append(section);
}

if (components.length) {
  const section = el('section', 'cat-section');
  section.append(el('h2', 'cat-section-head', 'Configuratoren'));
  section.append(el('p', 'cat-section-sub', 'Losse, herbruikbare configurators — elk een op zichzelf staand model, gegroepeerd naar hun HQDM-klasse.'));
  mount.append(section);
  // within the components, keep the HQDM-class taxonomy the models themselves declare
  const byClass = new Map<string, CassetteMeta[]>();
  for (const m of components) (byClass.get(m.klass) ?? byClass.set(m.klass, []).get(m.klass)!).push(m);
  for (const [klass, metas] of byClass) {
    const sub = el('section', 'cat-subsection');
    sub.append(el('h3', 'cat-subsection-head', klass));
    sub.append(gridOf(metas));
    mount.append(sub);
  }
}

if (!CATALOGUE.length) mount.append(el('div', 'empty', 'Geen cassettes gevonden.'));
