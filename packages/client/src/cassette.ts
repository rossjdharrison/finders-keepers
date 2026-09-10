// The cassette player — the client-only path. It boots a cassette into the sealed core running
// INSIDE a QuickJS WASM sandbox in this tab (the vendored artifact + the prebuilt QuickJS wasm are
// fetched once, then no server), adapts the engine to the WorkspaceStore the renderers already
// consume, and renders it through the SAME resolve → RenderPlan → hooks → CSS pipeline.
//
// EVERYTHING the user sees that is brand- or product-specific comes from the cassette, not code:
// the palette + fonts (theme, projected to CSS custom properties), the labels + help prose (l10n +
// docs), the journey and its guards. Swap the cassette and the whole site re-skins and re-documents.

import './style/index.css';
import { effect, signal } from '@preact/signals-core';
import { createBrowserHostOver } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import type { Value } from '@core/values';
import { createSealedCore } from '@app/core-wasm';
import coreBundleUrl from '@app/core-wasm/vendor/core.bundle.js?url';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import carInsurance from './cassettes/car-insurance.json';
import { createBrowserQuickJS } from './quickjs.ts';
import { createHostStore } from './host-store.ts';
import { browserExterns } from './browser-externs.ts';
import { normalizeKenteken, formatKenteken, isValidKenteken } from './kenteken.ts';
import { normalizePostcode, formatPostcode, isValidPostcode } from './pdok.ts';
import { initRequestDrawer } from './request-view.ts';
import { localStoragePersistence, broadcastChannelBroadcaster } from './adapters.ts';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { initConsent } from './consent.ts';
import { setLocale } from './format.ts';
import { RENDERERS } from './registry.ts';
import { coreVocabulary } from './resolve.ts';
import type { CollectionDoc, ModelBundle, ViewDoc } from './types.ts';

const cass = carInsurance as unknown as Cassette;
setLocale(cass.locale ?? 'nl'); // money reads "€ 6.800,00" and numbers group per the cassette's locale
const brand = cass.theme?.brand ?? {};
if (cass.title) document.title = `${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? ''}`.trim();

// model-driven brand chrome. Only the wordmark/product/tagline are read from the theme; the look is
// all tokens/CSS (brand.css), so a different cassette re-brands this header with no code change.
const app = document.querySelector<HTMLElement>('#app')!;
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
      ${cass.example ? '<button class="cc-btn cc-btn-quiet" id="fill-example" type="button">Voorbeeld invullen</button>' : ''}
      <button class="cc-btn cc-btn-quiet" id="cookie-prefs" type="button">Cookievoorkeuren</button>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <h1 class="visually-hidden">${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? 'aanvraag'} aanvragen</h1>
  <main id="mount" class="mount" tabindex="-1"></main>
  <footer class="hint">Deze aanvraag draait volledig in uw browser: het verzekerings­model speelt af op de verzegelde <code>@core</code> in een <b>QuickJS&nbsp;WASM</b>-sandbox. Validatie, herberekening en de bewaakte stappen gebeuren in dit tabblad. Het kenteken wordt live opgezocht bij de gratis <b>RDW</b> open-data-API (regio is gesimuleerd); verder gaat er niets naar een server na het laden.</footer>
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
// fetched once — watch the Network tab), inject the browser externs as the sole egress, then run the
// same browser host over it. The externs are SYNCHRONOUS (the sealed core requires it); the async RDW
// lookup is bridged by prefetching into the externs' cache and re-triggering a recompute (below).
const externs = browserExterns();
const quickjs = await createBrowserQuickJS();
const bundleSource = await fetch(coreBundleUrl).then((r) => r.text());
const sealed = await createSealedCore(quickjs, bundleSource, externs);

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
// reactive per-field datalist options (the house/flat numbers on the entered postcode), filled by the
// postcode effect below and read by the renderer.
const suggestions = signal<Record<string, string[]>>({});
RENDERERS[view.renderer!](mount, { store: collStore, view, workspace: store, model, vocab, viewer, suggestions });

// the live request preview — a subtle drawer over the wasm-computed model state, full-screen at the end
const journeySteps = cass.journey?.steps ?? [];
const lastStepId = journeySteps[journeySteps.length - 1]?.id;
initRequestDrawer(
  app,
  collStore,
  {
    props: (cass.collections[0]?.properties ?? []) as { id: string; valueType: { k: string; set?: string } }[],
    steps: journeySteps,
    labels,
    enums: cass.enums ?? {},
    stepField: cass.journey?.field,
    title: `${cass.theme?.brand?.product ?? 'Aanvraag'} — uw aanvraag`,
  },
  (doc) => {
    const s = cass.journey?.field ? doc[cass.journey.field] : undefined;
    return !!s && s.t === 'enum' && s.v === lastStepId;
  },
);

// --- kenteken auto-fill: when a valid Dutch plate is entered, look it up (live RDW → demo fallback)
// and fill the vehicle. The extern reads a cache; here we prefetch it, then re-set the (canonical)
// plate to trigger a recompute that now resolves vehicleDesc/vehicleValue. Also canonicalizes hyphens.
const seenPlate = new Set<string>();
effect(() => {
  for (const row of collStore.rows.value) {
    const pv = row.doc.plate;
    if (pv?.t !== 'text' || !pv.v) continue;
    const norm = normalizeKenteken(pv.v);
    if (!isValidKenteken(norm)) continue;
    const canonical = formatKenteken(norm) ?? pv.v;
    if (!externs.hasVehicle(norm) && !seenPlate.has(norm)) {
      seenPlate.add(norm);
      void externs.prefetchVehicle(norm).then((ok) => {
        // guard the async write: drop a stale resolution if the user has since changed the plate,
        // so a slow lookup can't clobber a newer plate (last-typed stays authoritative)
        const live = collStore.rows.value.find((r) => r.id === row.id)?.doc.plate;
        if (ok && live?.t === 'text' && normalizeKenteken(live.v) === norm) collStore.setField(row.id, 'plate', { t: 'text', v: canonical });
      });
    } else if (externs.hasVehicle(norm) && pv.v !== canonical) {
      collStore.setField(row.id, 'plate', { t: 'text', v: canonical }); // just normalize the display form
    }
  }
});

// --- postcode → address (PDOK): when a valid postcode is entered, look it up (live PDOK BAG) and
// fill street + city, and populate the house/flat-number datalist for that postcode. Same async
// bridge as the plate: prefetch the cache, then re-set the (canonical) postcode to trigger recompute.
const seenPostcode = new Set<string>();
effect(() => {
  for (const row of collStore.rows.value) {
    const pc = row.doc.postcode;
    if (pc?.t !== 'text' || !pc.v) continue;
    const norm = normalizePostcode(pc.v);
    if (!isValidPostcode(norm)) continue;
    const canonical = formatPostcode(norm);
    if (!externs.hasAddress(norm) && !seenPostcode.has(norm)) {
      seenPostcode.add(norm);
      void externs.prefetchAddress(norm).then((ok) => {
        if (!ok) return;
        // guard BOTH writes on the live postcode: a stale resolution for an abandoned postcode must
        // not overwrite the datalist or the field with the wrong postcode's data.
        const live = collStore.rows.value.find((r) => r.id === row.id)?.doc.postcode;
        if (!(live?.t === 'text' && normalizePostcode(live.v) === norm)) return;
        suggestions.value = { ...suggestions.value, houseNumber: externs.addressNumbers(norm) };
        if (live.v !== canonical) collStore.setField(row.id, 'postcode', { t: 'text', v: canonical });
      });
    } else if (externs.hasAddress(norm)) {
      const nums = externs.addressNumbers(norm);
      if (nums.length && suggestions.value.houseNumber !== nums) suggestions.value = { ...suggestions.value, houseNumber: nums };
      if (pc.v !== canonical) collStore.setField(row.id, 'postcode', { t: 'text', v: canonical });
    }
  }
});

// --- "Voorbeeld invullen": populate the active application with the cassette's example values (a
// blank-form convenience). Only stored fields are set; the plate then auto-resolves the vehicle.
const fillBtn = app.querySelector<HTMLButtonElement>('#fill-example');
if (fillBtn && cass.example) {
  fillBtn.addEventListener('click', () => {
    const row = collStore.rows.value[0];
    if (!row) return;
    for (const [field, value] of Object.entries(cass.example as Record<string, Value>)) collStore.setField(row.id, field, value);
    collStore.setField(row.id, 'step', { t: 'enum', set: 'step', v: 'quote' }); // jump to the computed quote
  });
}
