// The cassette player — the client-only path. It boots a cassette into the sealed core running
// INSIDE a QuickJS WASM sandbox in this tab (the vendored artifact + the prebuilt QuickJS wasm are
// fetched once, then no server), adapts the engine to the WorkspaceStore the renderers already
// consume, and renders it through the SAME resolve → RenderPlan → hooks → CSS pipeline.
//
// EVERYTHING the user sees that is brand- or product-specific comes from the cassette, not code:
// the palette + fonts (theme, projected to CSS custom properties), the labels + help prose (l10n +
// docs), the journey and its guards. Swap the cassette and the whole site re-skins and re-documents.

import './style/index.css';
import { createBrowserHostOver, mockExterns } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import { createSealedCore } from '@app/core-wasm';
import coreBundleUrl from '@app/core-wasm/vendor/core.bundle.js?url';
import carInsurance from './cassettes/car-insurance.json';
import { createBrowserQuickJS } from './quickjs.ts';
import { createHostStore } from './host-store.ts';
import { localStoragePersistence, broadcastChannelBroadcaster } from './adapters.ts';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { initConsent } from './consent.ts';
import { RENDERERS } from './registry.ts';
import { coreVocabulary } from './resolve.ts';
import type { CollectionDoc, ModelBundle, ViewDoc } from './types.ts';

const cass = carInsurance as unknown as Cassette;
const brand = cass.theme?.brand ?? {};
const mark = (brand.name ?? 'Rowblaa Bank').trim().charAt(0) || 'R';
if (cass.title) document.title = `${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? ''}`.trim();

// model-driven brand chrome. Only the wordmark/product/tagline are read from the theme; the look is
// all tokens/CSS (brand.css), so a different cassette re-brands this header with no code change.
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <a class="skip-link" href="#mount">Direct naar de aanvraag</a>
  <header class="bank-topbar" role="banner">
    <div class="bank-identity">
      <span class="bank-mark" aria-hidden="true">${mark}</span>
      <span class="bank-name">${brand.name ?? 'Rowblaa Bank'}</span>
      ${brand.tagline ? `<span class="bank-since">${brand.tagline}</span>` : ''}
    </div>
    ${brand.product ? `<span class="bank-product">${brand.product}</span>` : ''}
    <div class="bank-tools">
      <span class="bank-secure">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-4Zm0 10.9h6.3c-.5 3.6-2.8 6.9-6.3 8V12H5.7V6.3L12 3.2v8.7Z"/></svg>
        Beveiligd
      </span>
      <button class="cc-btn cc-btn-quiet" id="cookie-prefs" type="button">Cookievoorkeuren</button>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <h1 class="visually-hidden">${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? 'aanvraag'} aanvragen</h1>
  <main id="mount" class="mount" tabindex="-1"></main>
  <footer class="hint">Deze aanvraag draait volledig in uw browser: het verzekerings­model speelt af op de verzegelde <code>@core</code> in een <b>QuickJS&nbsp;WASM</b>-sandbox. Validatie, herberekening en de bewaakte stappen gebeuren in dit tabblad; RDW en regio zijn gesimuleerde koppelingen; er gaat niets naar een server na het laden.</footer>
`;

// theme: project the cassette's palette/fonts onto :root, and keep the toggle re-projecting it.
const themeBtn = app.querySelector<HTMLButtonElement>('#theme')!;
let mode: ThemeMode = initialMode();
const paint = (m: ThemeMode): void => {
  mode = m;
  applyTheme(cass.theme, m);
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

// consent: a reusable, transparency-first notice. Our storage is strictly-necessary (theme, in-tab
// workspace state, this consent record) so it needs no gate under EU/NL ePrivacy; the optional
// categories are shown OFF for reuse on sites that DO set analytics/marketing cookies.
const consent = initConsent({
  storageKey: 'rowblaa-consent',
  version: 1,
  categories: [
    { id: 'necessary', label: 'Noodzakelijk', required: true, description: 'Nodig om de aanvraag te laten werken: uw themakeuze, de status van uw aanvraag in dit tabblad, en deze cookievoorkeur zelf. Deze kunnen niet worden uitgezet.' },
    { id: 'analytics', label: 'Statistieken', description: 'Anonieme gebruiksstatistieken waarmee wij de aanvraag verbeteren. In dit voorbeeld niet in gebruik.' },
    { id: 'marketing', label: 'Marketing', description: 'Persoonlijke aanbiedingen en advertenties. In dit voorbeeld niet in gebruik.' },
  ],
  copy: {
    bannerTitle: 'Cookies',
    bannerBody: 'Rowblaa Bank gebruikt alleen noodzakelijke opslag om deze aanvraag te laten werken. Optionele cookies blijven uit tot u ze aanzet. Lees ons {policy}.',
    policyLabel: 'cookiebeleid',
    policyHref: '#cookiebeleid',
    acceptAll: 'Alles accepteren',
    necessaryOnly: 'Alleen noodzakelijk',
    customize: 'Voorkeuren',
    dialogTitle: 'Cookievoorkeuren',
    dialogIntro: 'Kies welke cookies Rowblaa Bank mag gebruiken. Noodzakelijke opslag staat altijd aan; zonder deze werkt de aanvraag niet.',
    save: 'Voorkeuren opslaan',
    lockedLabel: 'Altijd aan',
  },
});
app.querySelector<HTMLButtonElement>('#cookie-prefs')!.addEventListener('click', () => consent.openPreferences());

// boot the sealed core INSIDE wasm: load the QuickJS runtime + the vendored @core bundle (both
// fetched once — watch the Network tab), inject the mock externs as the sole egress, then run the
// same browser host over it. mockExterns is synchronous, which the sealed core requires.
const quickjs = await createBrowserQuickJS();
const bundleSource = await fetch(coreBundleUrl).then((r) => r.text());
const sealed = await createSealedCore(quickjs, bundleSource, mockExterns());

const chan = `fk-cassette-${cass.id}`;
const host = await createBrowserHostOver(sealed, cass, {
  persistence: localStoragePersistence(chan),
  broadcaster: broadcastChannelBroadcaster(chan),
});

// the clean seam: engine → data-only WorkspaceStore
const collections = cass.collections as unknown as CollectionDoc[];
const store = createHostStore(host, collections);

// the presentation inputs, gathered here (not in the store, not in the engine) and handed to resolve()
const model: ModelBundle = {
  collections,
  relations: (cass.relations ?? {}) as ModelBundle['relations'],
  types: cass.types as ModelBundle['types'],
  docRecords: [],
  presentation: (cass.presentation ?? []) as ModelBundle['presentation'],
  seedOps: [],
};
const vocab = coreVocabulary();
const viewer = { canWrite: true };
const locale = cass.locale ?? 'nl';
const labels = cass.l10n?.[locale] ?? {};
const fieldDocs = cass.docs?.[locale] ?? {};
const view: ViewDoc = {
  id: 'applications',
  collection: 'applications',
  title: cass.title ?? 'Aanvraag',
  renderer: 'journey',
  query: { coll: 'applications' },
  visibleProps: [],
  config: { labels, docs: fieldDocs, enums: cass.enums, journey: cass.journey },
};

const mount = app.querySelector<HTMLElement>('#mount')!;
const collStore = store.collection('applications')!; // the active collection; `store` is the workspace
RENDERERS[view.renderer!](mount, { store: collStore, view, workspace: store, model, vocab, viewer });
