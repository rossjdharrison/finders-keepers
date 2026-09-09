// The cassette player — the client-only path. It boots a cassette into the in-browser sealed
// core (no server after the initial GET), adapts the engine to the WorkspaceStore the renderers
// already consume, and renders it through the SAME resolve → RenderPlan → hooks → CSS pipeline.
// The seam is clean: the engine gives data (host-store), resolve() turns data into a neutral
// plan (fed the cassette's presentation + l10n), the renderer paints hooks. Nothing else moves.

import './style/index.css';
import { createBrowserHost, mockExterns } from '@app/core-runtime';
import type { Cassette } from '@app/core-runtime';
import carInsurance from './cassettes/car-insurance.json';
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
    <div class="conn" id="conn" title="in-browser engine" data-status="open">local · no server</div>
    <button class="theme-toggle" id="theme" title="Toggle light / dark"></button>
  </header>
  <main id="mount" class="mount"></main>
  <footer class="hint">A <b>cassette</b> played by the in-browser sealed core: validate, recompute and the guarded steps run in this tab; RDW + region are mock externs; nothing hits a server after the initial GET.</footer>
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

// boot the sealed core in this tab, with real browser persistence + cross-tab liveness
const chan = `fk-cassette-${cass.id}`;
const host = await createBrowserHost(cass, mockExterns(), {
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
