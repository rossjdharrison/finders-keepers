// The Loom — ONE surface to VIEW a cassette/journey's whole structure AND ALTER its editable rules,
// for ANY cassette, driven entirely by the file-derived registry. It reads ?cassette=<id> (a product
// cassette: flat or composed) or ?journey=<id> (a cross-cassette L2 journey doc), boots that model's
// presentation (theme/l10n, borrowing a donor's brand when the model carries none), and mounts tabs:
//
//   · Compositie (journeys only) — the macro graph: member products as boxes, typed bindings as wires,
//     each box drilling into its own Loom (the two-altitude zoom, ported from wasm-calculator).
//   · Structuur — the schema, projected: collections, typed fields (source-badged), computed formulas
//     in prose, relations — all DERIVED from the model, never authored.
//   · Grafiek — the dependency graph: what feeds what, re-derived from the formula ASTs; the cross-
//     collection rollups (and, for a compiled journey, the L2 binding seam) draw as rollup wires.
//   · Regels — the rate tables + in-formula thresholds, editable, validated in a throwaway core, saved
//     to localStorage the player hot-reloads through the SAME sealed @core. (Journeys: view-only, with
//     edit-through links to the member products, whose Looms own the rules.)

import './style/index.css';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import type { Cassette } from '@app/core-runtime';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { setLocale } from './format.ts';
import { REGISTRY, JOURNEYS, presentationDonor } from './cassette-registry.ts';
import { compileJourney, type JourneyDoc } from './compile-journey.ts';
import { projectStructure, renderStructure } from './loom/structure.ts';
import { buildGraph, renderGraph } from './loom/graph.ts';
import { renderRulesEditor } from './loom/rules-edit.ts';
import { renderCompositionEditor } from './loom/composition-edit.ts';
import { loadJourneyDoc } from './loom/journey-edit.ts';
import { createFormulaInspector } from './loom/formula-inspector.ts';
import { createModelEditing } from './loom/model-editing.ts';

const COLL_LABELS: Record<string, string> = { applications: 'Aanvraag', vehicles: 'Voertuig', drivers: 'Bestuurder', covers: 'Dekking' };

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const qs = new URLSearchParams(location.search);
const cassId = qs.get('cassette');
const journeyId = qs.get('journey');

// resolve the subject: a journey doc (compiled to a composed cassette for view/graph) or a product cassette.
// Object.hasOwn guards against a crafted ?journey=toString reading an inherited prototype member.
const journeyDoc: JourneyDoc | undefined = journeyId && Object.hasOwn(JOURNEYS, journeyId) ? JOURNEYS[journeyId] : undefined;
let shipped: Cassette | undefined;
let compileError: string | undefined;
if (journeyDoc) {
  try {
    // compile the EFFECTIVE doc (a saved composition override, else the shipped one) so the Structuur
    // and Grafiek tabs reflect edits saved in the Compositie tab (and by the player).
    shipped = compileJourney(loadJourneyDoc(journeyDoc.id, journeyDoc).doc, REGISTRY);
  } catch (e) {
    compileError = e instanceof Error ? e.message : String(e);
  }
} else {
  const wantId = cassId ?? (REGISTRY['car-insurance'] ? 'car-insurance' : Object.keys(REGISTRY)[0]);
  shipped = wantId && Object.hasOwn(REGISTRY, wantId) ? REGISTRY[wantId] : undefined;
}

const app = document.querySelector<HTMLElement>('#app')!;

if (!shipped) {
  // build the banner with textContent (never innerHTML): compileError is assembled from journey-doc
  // ids/aliases, so an author's stray '<' must not become markup.
  const msg = compileError ? `Kon het pakket niet samenstellen: ${compileError}` : 'Onbekend model.';
  const main = document.createElement('main');
  main.className = 'mount';
  main.style.padding = '40px';
  const box = document.createElement('div');
  box.className = 'lm-empty';
  box.append(document.createTextNode(`${msg} `));
  const link = document.createElement('a');
  link.href = '/catalogue.html';
  link.textContent = 'Naar de catalogus →';
  box.append(link);
  main.append(box);
  app.replaceChildren(main);
  throw new Error(msg);
}

// presentation: a lean/compiled model borrows a donor's brand (car-insurance), exactly as the player does
const pres = presentationDonor(shipped);
const theme = shipped.theme ?? pres.theme;
const brand = theme?.brand ?? {};
const locale = shipped.locale ?? pres.locale ?? 'nl';
setLocale(locale);
const labels = { ...(pres.l10n?.[locale] ?? {}), ...(shipped.l10n?.[locale] ?? {}) };
const label = (id: string): string => labels[id] ?? id;
// a compiled journey namespaces collection ids (alias__base) and synthesizes seam fields (__to_*,
// __seam_*); for a journey, strip that plumbing prefix so the schema/graph views read at author level.
const stripNs = (id: string): string => (id.includes('__') ? id.split('__').slice(1).join('__') : id);
const labelFor = journeyDoc ? (id: string): string => labels[stripNs(id)] ?? labels[id] ?? stripNs(id) : label;
document.title = `${brand.name ?? 'Rowblaa Bank'} — Loom`;

const subjectTitle = journeyDoc?.title ?? shipped.title ?? shipped.id;
const subjectDoc = journeyDoc?.doc ?? shipped.doc;
const playerHref = `/play.html?cassette=${encodeURIComponent(journeyDoc?.id ?? shipped.id)}`;

app.innerHTML = `
  <header class="bank-topbar" role="banner">
    <div class="bank-identity">
      <span class="bank-mark" aria-hidden="true">${logoSvg}</span>
      <span class="bank-name">${brand.name ?? 'Rowblaa Bank'}</span>
      <span class="bank-since">Loom · model</span>
    </div>
    <div class="bank-tools">
      <a class="cc-btn cc-btn-quiet" href="/catalogue.html">Catalogus</a>
      <a class="cc-btn cc-btn-quiet" href="${playerHref}">Naar de aanvraag →</a>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <main id="mount" class="mount lm" tabindex="-1"></main>
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

// arrived here by drilling from a journey's composition? the "back to the journey" link is rendered just
// above the diagram in the Grafiek panel (where a drill lands), not up here in the hero — see that tab.
const fromJourney = qs.get('from');
const backToJourney = (): HTMLAnchorElement | null => {
  if (journeyDoc || !fromJourney || !Object.hasOwn(JOURNEYS, fromJourney)) return null;
  const back = el('a', 'lm-back') as HTMLAnchorElement;
  back.href = `/loom.html?journey=${encodeURIComponent(fromJourney)}#compositie`;
  back.append(el('span', 'lm-back-arrow', '←'), document.createTextNode(` Terug naar ${JOURNEYS[fromJourney].title ?? fromJourney}`));
  return back;
};

// hero
const hero = el('div', 'lm-hero');
const badge = el('span', `lm-hero-badge lm-badge-${journeyDoc ? 'journey' : shipped.collections.length > 1 ? 'composed' : 'flat'}`, journeyDoc ? 'Pakket' : shipped.collections.length > 1 ? 'Samengesteld' : 'Eén model');
hero.append(badge);
hero.append(el('h1', 'lm-hero-title', subjectTitle));
if (subjectDoc) hero.append(el('p', 'lm-hero-doc', subjectDoc));
mount.append(hero);

// --- tabs ----------------------------------------------------------------------------------------
interface Tab {
  id: string;
  label: string;
  build: (panel: HTMLElement) => void;
}

const outputField = (shipped.journey?.summary?.total as string | undefined) ?? 'premium';

// a flat product cassette has ONE shared editing session: the Regels tab AND the Grafiek formula inspector
// both read/write it (so neither can silently discard the other's unsaved edits). A journey is view-only here.
const editing = journeyDoc ? undefined : createModelEditing(shipped);

const tabs: Tab[] = [];

if (journeyDoc) {
  tabs.push({
    id: 'compositie',
    label: 'Compositie',
    build: (panel) => {
      panel.append(el('p', 'lm-panel-intro', 'De producten en de getypte bindingen die ze samenstellen, bewerkbaar. Voeg producten of bindingen toe, pas de mapping van een naad aan, en kies wat optelt tot het totaal. Elke wijziging wordt in de verzegelde core gevalideerd voordat u opslaat; de speler draait daarna deze compositie.'));
      renderCompositionEditor(panel, {
        shippedDoc: journeyDoc,
        registry: REGISTRY,
        label: labelFor,
        // drill into a configurator's GRAPH (its field breakdown), carrying `from` so it can offer a way back
        loomHref: (ref) => `/loom.html?cassette=${encodeURIComponent(ref)}&from=${encodeURIComponent(journeyDoc.id)}#grafiek`,
        // a saved composition changes the compiled cassette — recompile it and evict the schema/graph
        // tabs so they rebuild from the new composition next time they are opened (no page reload).
        onSaved: () => {
          try { shipped = compileJourney(loadJourneyDoc(journeyDoc.id, journeyDoc).doc, REGISTRY); } catch { /* keep the last good compile */ }
          built.delete('structuur');
          built.delete('grafiek');
        },
      });
    },
  });
}

tabs.push({
  id: 'structuur',
  label: 'Structuur',
  build: (panel) => {
    panel.append(el('p', 'lm-panel-intro', 'Elke collectie, elk veld en elke relatie — afgeleid uit het model. Bron (invoer / berekend / extern), type, HQDM-grondslag en de formule in leesbare vorm.'));
    const sm = projectStructure(shipped!, { label: labelFor });
    const holder = el('div');
    renderStructure(holder, sm);
    panel.append(holder);
  },
});

tabs.push({
  id: 'grafiek',
  label: 'Grafiek',
  build: (panel) => {
    // the "← Terug naar <journey>" link sits right above the diagram (this is where a drill from the
    // journey composition lands), so the way back is clear next to the graph it brought you to.
    const back = backToJourney();
    if (back) panel.append(back);
    panel.append(el('p', 'lm-panel-intro', 'Wat voedt wat. Invoervelden links, uitkomsten rechts; de pijlen zijn afhankelijkheden, opnieuw afgeleid uit de formules. Rollups over relaties (en de L2-naad van een pakket) zijn geaccentueerd. Beweeg over een veld om zijn keten te lichten; klik op een berekend veld (ƒ) om de formule te bekijken' + (journeyDoc ? '.' : ' en de getallen erin aan te passen.')));
    const g = buildGraph(shipped!, { label: labelFor, collLabel: labelFor, outputField });
    const holder = el('div');
    panel.append(holder);
    const inspectorMount = el('div', 'lm-inspect');
    panel.append(inspectorMount);

    if (!editing) {
      // a compiled journey: the composed formula is shown READ-ONLY (its rules live in the member products)
      const inspector = createFormulaInspector(inspectorMount, { label: labelFor, model: () => shipped! });
      renderGraph(holder, g, { onSelect: (node) => inspector.show(node) });
    } else {
      // a flat product cassette: the field's numeric literals are EDITABLE through the SHARED session (the
      // same cassette the Regels tab edits), auto-saved so the effect is immediate. save() persists + notifies,
      // and the subscribe below re-syncs the Regels tab — so an edit here can never discard Regels' work.
      const inspector = createFormulaInspector(inspectorMount, {
        label: labelFor,
        model: () => editing.cass(),
        outputLabel: labelFor(outputField),
        onEdit: (collId, propId, path, raw) => {
          editing.applyLiteral(collId, propId, path, raw);
          const res = editing.save(); // validate + persist the shared cassette (no-op persist if invalid)
          return { ok: res.ok, error: res.error, premium: res.premium };
        },
        openRules: () => activate('regels'),
      });
      renderGraph(holder, g, { onSelect: (node) => inspector.show(node) });
    }
  },
});

tabs.push({
  id: 'regels',
  label: 'Regels',
  build: (panel) => {
    if (journeyDoc) {
      panel.append(el('p', 'lm-panel-intro', 'De regels van een pakket wonen in de samengestelde producten — de binding (naad) tussen twee producten is berekend en dus vast. Bewerk de tarieven en drempels in het Loom van elk product.'));
      const seams = el('div', 'lm-seams');
      for (const b of journeyDoc.bindings) {
        const row = el('div', 'lm-seam');
        row.append(el('span', 'lm-mono lm-seam-id', b.id));
        const flow = el('span', 'lm-seam-flow');
        flow.append(el('span', 'lm-seam-node', `${b.from} · ${b.contract.provides.map((p) => p.source).join(', ')}`));
        flow.append(el('span', 'lm-rel-arrow', '→'));
        flow.append(el('span', 'lm-seam-node', `${b.to} · ${b.contract.requires.map((r) => r.target).join(', ')}`));
        row.append(flow);
        row.append(el('span', 'lm-seam-lock', '🔒 berekend — vast'));
        seams.append(row);
      }
      panel.append(seams);
      const links = el('div', 'lm-edit-through');
      links.append(el('div', 'lm-edit-through-head', 'Regels bewerken per product'));
      for (const m of journeyDoc.models) {
        const a = el('a', 'lm-edit-link') as HTMLAnchorElement;
        a.href = `/loom.html?cassette=${encodeURIComponent(m.ref)}#regels`;
        a.append(el('span', 'lm-edit-link-name', REGISTRY[m.ref]?.title ?? m.ref));
        a.append(el('span', 'lm-edit-link-go', 'Regels →'));
        links.append(a);
      }
      panel.append(links);
      return;
    }
    // the Regels editor and the Grafiek inspector share ONE editing session (see `editing` + the subscribe
    // below that re-syncs sibling tabs on save/revert), so neither can discard the other's unsaved edits.
    renderRulesEditor(panel, { editing: editing!, labels, collLabels: COLL_LABELS });
  },
});

const nav = el('nav', 'lm-tabs');
nav.setAttribute('role', 'tablist');
nav.setAttribute('aria-label', 'Loom-weergaven');
const panelWrap = el('div', 'lm-panels');
const built = new Set<string>();
const panelById = new Map<string, HTMLElement>();
const btnById = new Map<string, HTMLButtonElement>();
let activeTab = '';

const activate = (id: string): void => {
  activeTab = id;
  for (const [tid, btn] of btnById) {
    const on = tid === id;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  for (const [tid, panel] of panelById) panel.hidden = tid !== id;
  const panel = panelById.get(id)!;
  if (!built.has(id)) {
    panel.replaceChildren(); // clear first so a tab evicted from `built` (after a save) rebuilds cleanly
    tabs.find((t) => t.id === id)!.build(panel);
    built.add(id);
  }
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
};

// keep the two editing tabs coherent: after a save/revert (from either the Regels editor or the Grafiek
// inspector), evict the OTHER cached tab so it rebuilds from the shared cassette next time it is opened. The
// active tab already reflects the change (it made it), so it is left intact (no focus/scroll disruption).
editing?.subscribe(() => {
  for (const id of ['regels', 'grafiek']) if (id !== activeTab) built.delete(id);
});

for (const t of tabs) {
  const btn = el('button', 'lm-tab', t.label) as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('role', 'tab');
  btn.id = `lm-tab-${t.id}`;
  btn.addEventListener('click', () => activate(t.id));
  nav.append(btn);
  btnById.set(t.id, btn);

  const panel = el('section', 'lm-panel');
  panel.id = `lm-panel-${t.id}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', btn.id);
  btn.setAttribute('aria-controls', panel.id); // reciprocal tab↔panel association (ARIA Tabs pattern)
  panel.hidden = true;
  panelWrap.append(panel);
  panelById.set(t.id, panel);
}
// keyboard: arrows move between tabs, Home/End jump to first/last (ARIA Tabs pattern; roving tabindex)
nav.addEventListener('keydown', (e) => {
  const order = tabs.map((t) => t.id);
  const cur = order.findIndex((id) => btnById.get(id)!.classList.contains('is-active'));
  let next: number;
  if (e.key === 'ArrowRight') next = (cur + 1) % order.length;
  else if (e.key === 'ArrowLeft') next = (cur - 1 + order.length) % order.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = order.length - 1;
  else return;
  e.preventDefault();
  activate(order[next]);
  btnById.get(order[next])!.focus();
});

mount.append(nav, panelWrap);

// initial tab from the hash (deep-linkable), else the first
const initial = location.hash.slice(1);
activate(tabs.some((t) => t.id === initial) ? initial : tabs[0].id);
