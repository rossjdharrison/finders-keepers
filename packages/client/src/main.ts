// The demo shell. The model is DATA (model/**, bundled into ./model.data.json);
// this file is pure view engine — a collection switcher + a data-defined view per
// collection. Editing a Task's hours/status recomputes the Feature and Initiative
// rollups on the server and updates every open tab live, with no formula on the client.

import { effect } from '@preact/signals-core';
import { createWorkspaceStore } from './store.ts';
import { RENDERERS } from './registry.ts';
import type { CollectionDoc, DocRecord, ModelBundle, RelationMeta, RowOp, TypeMap, ViewDoc } from './types.ts';
import model from './model.data.json';

const collections = model.collections as unknown as CollectionDoc[];
const relations = model.relations as unknown as Record<string, RelationMeta>;
const types = model.types as unknown as TypeMap;
const seedOps = model.seedOps as unknown as RowOp[];
const docRecords = (model.docRecords ?? []) as unknown as DocRecord[];

// The static model the projections (self-portrait, node doc-view) read from.
const modelBundle: ModelBundle = { collections, relations, types, docRecords, seedOps };

const ORDER = ['intentions', 'requirements', 'observations', 'decisions', 'options', 'initiatives', 'features', 'tasks', 'docs', 'actors', 'grants', 'collections', 'properties', 'types'];
// The two projection views lead (System overview, then Model docs); the rest follow
// the collection order. A view's renderer decides its rank, so no schema change.
const rankOf = (v: ViewDoc): number =>
  v.renderer === 'self-portrait' ? -2 : v.renderer === 'docs' ? -1 : ORDER.indexOf(v.collection);
const views = (model.views as unknown as ViewDoc[]).slice().sort((a, b) => rankOf(a) - rankOf(b));

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">Dev Journey <span class="muted">· Computable Records</span></div>
    <div class="tabs" id="tabs"></div>
    <div class="conn" id="conn" title="connection"></div>
  </header>
  <main id="mount" class="mount"></main>
  <footer class="hint"><b>Intention → Requirement → Decision → Option.</b> One intention decomposes into requirements; each is resolved by a committed decision whose options' effort is computed down from size — grounded in HQDM (plan → requirement&#95;specification → agreement), live across every tab.</footer>
`;

const tabsEl = app.querySelector<HTMLElement>('#tabs')!;
const mount = app.querySelector<HTMLElement>('#mount')!;
const conn = app.querySelector<HTMLElement>('#conn')!;

const workspace = await createWorkspaceStore({
  baseUrl: location.origin, // Vite proxy forwards /collections + /workspace + ws to :8787
  token: import.meta.env.VITE_WORKSPACE_TOKEN ?? 'dev-admin', // dev anchor → actor a-admin (bootstrap); server stamps the verified actor
  collections,
  relations,
  types,
  seedOps,
});

effect(() => {
  conn.dataset.status = workspace.status.value;
  conn.textContent = workspace.status.value;
});

let dispose: () => void = () => undefined;
function show(view: ViewDoc): void {
  dispose();
  mount.replaceChildren();
  const store = workspace.collection(view.collection);
  const renderer = RENDERERS[view.renderer];
  dispose = store && renderer ? renderer(mount, { store, view, workspace, model: modelBundle }) : () => undefined;
  for (const b of tabsEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.id === view.id);
}

for (const view of views) {
  const b = document.createElement('button');
  b.textContent = view.title;
  b.dataset.id = view.id;
  b.addEventListener('click', () => show(view));
  tabsEl.append(b);
}

show(views.find((v) => v.renderer === 'self-portrait') ?? views.find((v) => v.collection === 'intentions') ?? views[0]);
