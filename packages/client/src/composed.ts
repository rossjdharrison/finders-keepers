// The COMPOSED cassette player — the viewable/workable prototype of the journey-as-composed-
// configurators thesis. It boots car-insurance-composed (four collections: applications = the
// activity spine, vehicles/drivers/covers = configurators) into the SAME sealed wasm core, and
// renders it as one journey via the composed-journey renderer. The premium composes across the
// collections through the engine's relations + rollup — no engine change. Presentation (theme,
// labels, enums) is reused from the flat cassette so the two players look identical.

import './style/index.css';
import { effect } from '@preact/signals-core';
import { createBrowserHostOver } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import { createSealedCore } from '@app/core-wasm';
import coreBundleUrl from '@app/core-wasm/vendor/core.bundle.js?url';
import logoSvg from './assets/rowblaa-logo.svg?raw';
import composedCassette from './cassettes/car-insurance-composed.json';
import flatCassette from './cassettes/car-insurance.json';
import { createBrowserQuickJS } from './quickjs.ts';
import { createHostStore, recomputeAll } from './host-store.ts';
import { browserExterns } from './browser-externs.ts';
import { normalizeKenteken, formatKenteken, isValidKenteken } from './kenteken.ts';
import { normalizePostcode, formatPostcode, isValidPostcode } from './pdok.ts';
import { localStoragePersistence, broadcastChannelBroadcaster } from './adapters.ts';
import { applyTheme, initialMode, type ThemeMode } from './theme.ts';
import { initConsent } from './consent.ts';
import { setLocale } from './format.ts';
import { coreVocabulary } from './resolve.ts';
import { mountComposedJourney } from './renderers/composed-journey.ts';
import type { CollectionDoc } from './types.ts';

// the model is DATA: if the admin (/admin.html?model=car-insurance-composed) saved edited rules, run
// those instead of the shipped JSON — same override seam as the flat player (cassette.ts).
let modelIsEdited = false;
const model: Cassette = ((): Cassette => {
  const shipped = composedCassette as unknown as Cassette;
  try {
    const ov = localStorage.getItem(`fk-cassette-model-${shipped.id}`);
    if (ov) {
      const parsed = JSON.parse(ov) as Cassette; // parse BEFORE flagging, so a corrupt override falls back cleanly
      modelIsEdited = true;
      return parsed;
    }
  } catch {
    /* fall back to shipped */
  }
  return shipped;
})();
const pres = flatCassette as unknown as Cassette; // reuse theme / l10n / enums for presentation
const theme = pres.theme;
const brand = theme?.brand ?? {};
const locale = model.locale ?? 'nl';
setLocale(locale);
document.title = `${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? ''} (composed)`.trim();

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <a class="skip-link" href="#mount">Direct naar de aanvraag</a>
  <header class="bank-topbar" role="banner">
    <div class="bank-identity">
      <span class="bank-mark" aria-hidden="true">${logoSvg}</span>
      <span class="bank-name">${brand.name ?? 'Rowblaa Bank'}</span>
      ${brand.tagline ? `<span class="bank-since">${brand.tagline}</span>` : ''}
    </div>
    ${brand.product ? `<span class="bank-product">${brand.product} · composed</span>` : ''}
    <div class="bank-tools">
      <span class="bank-secure">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-4Zm0 10.9h6.3c-.5 3.6-2.8 6.9-6.3 8V12H5.7V6.3L12 3.2v8.7Z"/></svg>
        Beveiligd
      </span>
      <a class="cc-btn cc-btn-quiet" id="admin-link" href="/admin.html?model=car-insurance-composed">Beheer${modelIsEdited ? ' <span class="bank-edited" title="Er zijn aangepaste regels actief">•</span>' : ''}</a>
      <button class="cc-btn cc-btn-quiet" id="cookie-prefs" type="button">Cookievoorkeuren</button>
      <button class="theme-toggle" id="theme" type="button" aria-label="Wissel tussen licht en donker thema"></button>
    </div>
  </header>
  <h1 class="visually-hidden">${brand.name ?? 'Rowblaa Bank'} — ${brand.product ?? 'aanvraag'} (composed)</h1>
  <main id="mount" class="mount" tabindex="-1"></main>
  <footer class="hint">Dezelfde aanvraag, maar gemodelleerd als <b>drie configuratoren</b> (voertuig, bestuurder, dekking) samengesteld tot één journey — de premie stelt zich samen via <code>relations + rollup</code> in de verzegelde <b>QuickJS&nbsp;WASM</b>-kern, zonder aanpassing aan de engine.</footer>
`;

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

// boot the composed cassette in the sealed wasm core
const externs = browserExterns();
const quickjs = await createBrowserQuickJS();
const bundleSource = await fetch(coreBundleUrl).then((r) => r.text());
const sealed = await createSealedCore(quickjs, bundleSource, externs);
const chan = `fk-cassette-${model.id}`;
const host = await createBrowserHostOver(sealed, model, {
  persistence: localStoragePersistence(chan),
  broadcaster: broadcastChannelBroadcaster(chan),
});
const collections = model.collections as unknown as CollectionDoc[];
// edited rules booted over a persisted snapshot: restore reloads stored computed docs verbatim, so
// recompute every row's derived fields under the edited rules before the renderer reads them (else a
// child-collection rate edit shows a stale rolled-up premium until a manual field edit).
if (modelIsEdited) recomputeAll(host, collections);
const store = createHostStore(host, collections);

const mount = app.querySelector<HTMLElement>('#mount')!;
// presentation: borrow the flat cassette's labels (same brand), with the composed cassette's own l10n
// merged OVER them (so it can name its journey-specific fields, e.g. the confirm checkbox)
const labels = { ...(pres.l10n?.[locale] ?? {}), ...(model.l10n?.[locale] ?? {}) };

// The journey is DATA: sections (each with its configurator collection) and the rail come from the
// cassette's journey block — nothing about vehicles/drivers/covers is hardcoded here anymore. The
// spine is derived generically as the relation graph's parent (the collection that is a parent and
// never a child), so any composed cassette drives this same renderer.
const journey = model.journey;
const rels = Object.values(model.relations ?? {});
const childColls = new Set(rels.map((r) => r.childColl));
const spine = rels.map((r) => r.parentColl).find((p) => !childColls.has(p)) ?? collections[0].id;
// the join field per section is the relation's OWN childField (not a literal), so a composed cassette
// whose children ref the spine through a differently-named field still resolves.
const childFieldOf = (coll: string): string => rels.find((r) => r.childColl === coll && r.parentColl === spine)?.childField ?? 'app';
// the full ordered journey (sections + any terminal step) — the stepper + gating read it; sections
// carry their child collection's join field so the renderer resolves each section's row generically.
const steps = (journey?.steps ?? []).map((s) => ({
  id: s.id,
  label: s.label ?? s.id,
  collection: s.collection,
  childField: s.collection ? childFieldOf(s.collection) : undefined,
  gate: s.gate,
  fields: s.fields ?? [],
}));

mountComposedJourney(mount, {
  workspace: store,
  appColl: spine,
  stepField: journey?.field,
  steps,
  summary: journey?.summary,
  collections,
  types: model.types as Record<string, { specializes: string[] }>,
  vocab: coreVocabulary(),
  overrides: [],
  labels,
  enums: model.enums ?? pres.enums ?? {},
  title: `${brand.product ?? 'Aanvraag'} — aanvraag`,
});

// --- RDW auto-fill on the vehicles configurator (plate → vehicleDesc/vehicleValue) ---
const vehStore = store.collection('vehicles')!;
const seenPlate = new Set<string>();
effect(() => {
  for (const row of vehStore.rows.value) {
    const pv = row.doc.plate;
    if (pv?.t !== 'text' || !pv.v) continue;
    const norm = normalizeKenteken(pv.v);
    if (!isValidKenteken(norm)) continue;
    const canonical = formatKenteken(norm) ?? pv.v;
    if (!externs.hasVehicle(norm) && !seenPlate.has(norm)) {
      seenPlate.add(norm);
      void externs.prefetchVehicle(norm).then((ok) => {
        const live = vehStore.rows.value.find((r) => r.id === row.id)?.doc.plate;
        if (ok && live?.t === 'text' && normalizeKenteken(live.v) === norm) vehStore.setField(row.id, 'plate', { t: 'text', v: canonical });
      });
    } else if (externs.hasVehicle(norm) && pv.v !== canonical) {
      vehStore.setField(row.id, 'plate', { t: 'text', v: canonical });
    }
  }
});

// --- PDOK auto-fill on the drivers configurator (postcode → city, regionBand) ---
const drvStore = store.collection('drivers')!;
const seenPostcode = new Set<string>();
effect(() => {
  for (const row of drvStore.rows.value) {
    const pc = row.doc.postcode;
    if (pc?.t !== 'text' || !pc.v) continue;
    const norm = normalizePostcode(pc.v);
    if (!isValidPostcode(norm)) continue;
    const canonical = formatPostcode(norm);
    if (!externs.hasAddress(norm) && !seenPostcode.has(norm)) {
      seenPostcode.add(norm);
      void externs.prefetchAddress(norm).then((ok) => {
        if (!ok) return;
        // re-set the postcode (guarded on the live value) to trigger the driver row's recompute so its
        // city/regionBand externs re-resolve from the now-filled cache — unconditional (same value is
        // fine; host.apply doesn't dedupe), because unlike the flat cassette the plate is on a DIFFERENT
        // row here, so the plate's recompute can't pick up this row's address externs.
        const live = drvStore.rows.value.find((r) => r.id === row.id)?.doc.postcode;
        if (live?.t === 'text' && normalizePostcode(live.v) === norm) drvStore.setField(row.id, 'postcode', { t: 'text', v: canonical });
      });
    } else if (externs.hasAddress(norm) && pc.v !== canonical) {
      drvStore.setField(row.id, 'postcode', { t: 'text', v: canonical });
    }
  }
});
