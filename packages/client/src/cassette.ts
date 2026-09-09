// The cassette player — the client-only path. It boots a cassette into the sealed core running
// INSIDE a QuickJS WASM sandbox in this tab (the vendored artifact + the prebuilt QuickJS wasm are
// fetched once, then no server), adapts the engine to the WorkspaceStore the renderers already
// consume, and renders it through the SAME resolve → RenderPlan → hooks → CSS pipeline.
// The seam is clean AND real now: createBrowserHostOver runs over whatever satisfies the Core
// contract — here a SealedCore living in wasm — so the host, store, resolve() and renderers are
// byte-identical to the in-process path. Presentation never learns the engine is inside wasm.

import './style/index.css';
import { createBrowserHostOver, mockExterns } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import { createSealedCore } from '@app/core-wasm';
import coreBundleUrl from '@app/core-wasm/vendor/core.bundle.js?url';
import carInsurance from './cassettes/car-insurance.json';
import { createBrowserQuickJS } from './quickjs.ts';
import { createHostStore } from './host-store.ts';
import { localStoragePersistence, broadcastChannelBroadcaster } from './adapters.ts';
import { RENDERERS } from './registry.ts';
import { coreVocabulary } from './resolve.ts';
import type { CollectionDoc, ModelBundle, ViewDoc } from './types.ts';

const cass = carInsurance as unknown as Cassette;

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">Autoverzekering <span class="muted">· aanvragen · cassette</span></div>
    <div class="conn" id="conn" title="sealed core in a QuickJS WASM sandbox" data-status="open">wasm · no server</div>
    <button class="theme-toggle" id="theme" title="Toggle light / dark"></button>
  </header>
  <main id="mount" class="mount"></main>
  <footer class="hint">A <b>cassette</b> played by the sealed <code>@core</code> running in a <b>QuickJS WASM</b> sandbox in this tab: validate, recompute and the guarded steps all run inside wasm; RDW + region are mock externs injected across the seam; nothing hits a server after the initial GET.</footer>
`;

const themeBtn = app.querySelector<HTMLButtonElement>('#theme')!;
const applyTheme = (t: string): void => {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('fk-theme', t);
  } catch {
    /* private mode */
  }
  themeBtn.textContent = t === 'light' ? '☀' : '☾';
};
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
themeBtn.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

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
const labels = cass.l10n?.[cass.locale ?? 'nl'] ?? {};
const view: ViewDoc = {
  id: 'applications',
  collection: 'applications',
  title: 'Aanvraag',
  renderer: 'journey',
  query: { coll: 'applications' },
  visibleProps: [],
  config: { labels, enums: cass.enums, journey: cass.journey },
};

const mount = app.querySelector<HTMLElement>('#mount')!;
const collStore = store.collection('applications')!; // the active collection; `store` is the workspace
RENDERERS[view.renderer!](mount, { store: collStore, view, workspace: store, model, vocab, viewer });
