// The player — ONE client-only path for ANY cassette. It reads ?cassette=<id>, loads that cassette
// from the file-derived registry (or the admin's saved override), boots it into the sealed @core inside
// a QuickJS WASM sandbox in this tab, and renders it through the SAME registered journey renderer. The
// cassette decides everything the user sees: its theme re-skins the chrome, its l10n/docs re-label it,
// its journey (flat single-collection OR composed multi-configurator, with or without a summary rail)
// drives the body. Swap the cassette in the URL and the whole app changes — no code, no rebuild.

import './style/index.css';
import { signal } from '@preact/signals-core';
import { createBrowserHostOver } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import { createSealedCore } from '@app/core-wasm';
import coreBundleUrl from '@app/core-wasm/vendor/core.bundle.js?url';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import { createBrowserQuickJS } from './quickjs.ts';
import { createHostStore, recomputeAll } from './host-store.ts';
import { browserExterns } from './browser-externs.ts';
import { wireAutofill } from './autofill.ts';
import { initRequestDrawer } from './request-view.ts';
import { localStoragePersistence, broadcastChannelBroadcaster } from './adapters.ts';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { initConsent } from './consent.ts';
import { setLocale } from './format.ts';
import { RENDERERS } from './registry.ts';
import { coreVocabulary } from './resolve.ts';
import { REGISTRY, JOURNEYS, CATALOGUE, presentationDonor } from './cassette-registry.ts';
import { compileJourney } from './compile-journey.ts';
import type { CollectionDoc, ModelBundle, ViewDoc } from './types.ts';

const app = document.querySelector<HTMLElement>('#app')!;

// which cassette? ?cassette=<id>, else the first in the catalogue. A journey <id> is a cross-cassette L2
// doc — compiled on the fly into one composed cassette. Unknown id → a small chooser.
const wantId = new URLSearchParams(location.search).get('cassette') ?? CATALOGUE[0]?.id;
const journeyDoc = wantId ? JOURNEYS[wantId] : undefined;
const shipped = journeyDoc ? compileJourney(journeyDoc, REGISTRY) : wantId ? REGISTRY[wantId] : undefined;
if (!shipped) {
  app.innerHTML = `<main class="mount"><div class="empty" style="padding:40px">Onbekende cassette. <a href="/catalogue.html">Naar de catalogus →</a></div></main>`;
  throw new Error(`unknown cassette: ${wantId}`);
}

// the model is DATA: prefer the admin's saved edited rules for this cassette over the shipped JSON.
let modelIsEdited = false;
const cass: Cassette = ((): Cassette => {
  try {
    const ov = localStorage.getItem(`fk-cassette-model-${shipped.id}`);
    if (ov) { const parsed = JSON.parse(ov) as Cassette; modelIsEdited = true; return parsed; }
  } catch { /* fall back to shipped */ }
  return shipped;
})();

// presentation: a cassette may lean on another's theme/l10n (the composed variant reuses the flat brand)
const pres = presentationDonor(cass);
const theme = cass.theme ?? pres.theme;
const brand = theme?.brand ?? {};
const locale = cass.locale ?? pres.locale ?? 'nl';
setLocale(locale);
const labels = { ...(pres.l10n?.[locale] ?? {}), ...(cass.l10n?.[locale] ?? {}) };
const fieldDocs = { ...(pres.docs?.[locale] ?? {}), ...(cass.docs?.[locale] ?? {}) };
const enums = cass.enums ?? pres.enums ?? {};
document.title = `${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? ''}`.trim();

app.innerHTML = `
  <a class="skip-link" href="#mount">Direct naar de aanvraag</a>
  <header class="bank-topbar" role="banner">
    <div class="bank-identity">
      <span class="bank-mark" aria-hidden="true">${logoSvg}</span>
      <span class="bank-name">${brand.name ?? 'Rowblaa Bank'}</span>
      ${brand.tagline ? `<span class="bank-since">${brand.tagline}</span>` : ''}
    </div>
    ${brand.product ? `<span class="bank-product">${brand.product}</span>` : ''}
    <div class="bank-tools">
      <span class="bank-secure">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-4Zm0 10.9h6.3c-.5 3.6-2.8 6.9-6.3 8V12H5.7V6.3L12 3.2v8.7Z"/></svg>
        Beveiligd
      </span>
      <a class="cc-btn cc-btn-quiet" href="/catalogue.html">Catalogus</a>
      ${cass.example ? '<button class="cc-btn cc-btn-quiet" id="fill-example" type="button">Voorbeeld invullen</button>' : ''}
      <a class="cc-btn cc-btn-quiet" id="admin-link" href="/admin.html?model=${cass.id}">Beheer${modelIsEdited ? ' <span class="bank-edited" title="Er zijn aangepaste regels actief">•</span>' : ''}</a>
      <button class="cc-btn cc-btn-quiet" id="cookie-prefs" type="button">Cookievoorkeuren</button>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <h1 class="visually-hidden">${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? 'aanvraag'} aanvragen</h1>
  <main id="mount" class="mount" tabindex="-1"></main>
  <footer class="hint">Deze aanvraag draait volledig in uw browser: het model speelt af op de verzegelde <code>@core</code> in een <b>QuickJS&nbsp;WASM</b>-sandbox. Validatie, herberekening en de bewaakte stappen gebeuren in dit tabblad. Externe opzoekingen (kenteken via de gratis <b>RDW</b>-API, adres via <b>PDOK</b>) zijn live; verder gaat er niets naar een server na het laden.</footer>
`;

// theme + toggle
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

// consent (reusable, transparency-first; our storage is strictly-necessary)
const consent = initConsent({
  storageKey: 'rowblaa-consent',
  version: 1,
  categories: [
    { id: 'necessary', label: 'Noodzakelijk', required: true, description: 'Nodig om de aanvraag te laten werken: uw themakeuze, de status van uw aanvraag in dit tabblad, en deze cookievoorkeur zelf.' },
    { id: 'analytics', label: 'Statistieken', description: 'Anonieme gebruiksstatistieken. In dit voorbeeld niet in gebruik.' },
    { id: 'marketing', label: 'Marketing', description: 'Persoonlijke aanbiedingen. In dit voorbeeld niet in gebruik.' },
  ],
  copy: {
    bannerTitle: 'Cookies', bannerBody: 'Rowblaa Bank gebruikt alleen noodzakelijke opslag. Lees ons {policy}.',
    policyLabel: 'cookiebeleid', policyHref: '#cookiebeleid', acceptAll: 'Alles accepteren', necessaryOnly: 'Alleen noodzakelijk',
    customize: 'Voorkeuren', dialogTitle: 'Cookievoorkeuren', dialogIntro: 'Kies welke cookies Rowblaa Bank mag gebruiken.', save: 'Voorkeuren opslaan', lockedLabel: 'Altijd aan',
  },
});
app.querySelector<HTMLButtonElement>('#cookie-prefs')!.addEventListener('click', () => consent.openPreferences());

// boot the sealed core inside wasm
const externs = browserExterns();
const quickjs = await createBrowserQuickJS();
const bundleSource = await fetch(coreBundleUrl).then((r) => r.text());
const sealed = await createSealedCore(quickjs, bundleSource, externs);
const chan = `fk-cassette-${cass.id}`;
const host = await createBrowserHostOver(sealed, cass, {
  persistence: localStoragePersistence(chan),
  broadcaster: broadcastChannelBroadcaster(chan),
});
const collections = cass.collections as unknown as CollectionDoc[];
if (modelIsEdited) recomputeAll(host, collections); // edited rules over a snapshot → recompute under them
const store = createHostStore(host, collections);

// the spine = the relation graph's parent (a collection that is a parent and never a child), else the
// first collection (flat). The journey renderer reads the step machine from the spine.
const rels = Object.values(cass.relations ?? {});
const childColls = new Set(rels.map((r) => r.childColl));
const spine = rels.map((r) => r.parentColl).find((p) => !childColls.has(p)) ?? collections[0].id;
const spineStore = store.collection(spine)!;

const model: ModelBundle = {
  collections,
  relations: (cass.relations ?? {}) as ModelBundle['relations'],
  types: cass.types as ModelBundle['types'],
  docRecords: [],
  presentation: (cass.presentation ?? []) as ModelBundle['presentation'],
  seedOps: [],
};
const view: ViewDoc = {
  id: spine,
  collection: spine,
  title: cass.title ?? brand.product ?? 'Aanvraag',
  renderer: 'journey',
  query: { coll: spine },
  visibleProps: [],
  config: { labels, docs: fieldDocs, enums, journey: cass.journey },
};

const mount = app.querySelector<HTMLElement>('#mount')!;
const suggestions = signal<Record<string, string[]>>({}); // reactive datalist options (house numbers), filled by autofill
RENDERERS[view.renderer!](mount, { store: spineStore, view, workspace: store, model, vocab: coreVocabulary(), viewer: { canWrite: true }, suggestions });

// the request drawer carries the premium for a single-collection journey; a composed journey (with a
// journey.summary) shows the premium inline in the renderer's rail instead, so no drawer there.
if (!cass.journey?.summary) {
  const steps = cass.journey?.steps ?? [];
  const lastStepId = steps[steps.length - 1]?.id;
  initRequestDrawer(
    app, spineStore,
    {
      props: (model.collections.find((c) => c.id === spine)?.properties ?? []) as { id: string; valueType: { k: string; set?: string } }[],
      steps, labels, enums, stepField: cass.journey?.field,
      title: `${brand.product ?? 'Aanvraag'} — uw aanvraag`,
    },
    (doc) => {
      const s = cass.journey?.field ? doc[cass.journey.field] : undefined;
      return !!s && s.t === 'enum' && s.v === lastStepId;
    },
  );
}

// generic auto-fill: RDW (kenteken) + PDOK (postcode) across every collection, keyed off constraint.format
wireAutofill(store, collections, externs, suggestions);

// "Voorbeeld invullen": populate the active record with the cassette's example values
const fillBtn = app.querySelector<HTMLButtonElement>('#fill-example');
if (fillBtn && cass.example) {
  const example = cass.example;
  fillBtn.addEventListener('click', () => {
    const row = spineStore.rows.value[0];
    if (!row) return;
    for (const [field, value] of Object.entries(example)) spineStore.setField(row.id, field, value);
  });
}
