// The demo shell: one workspace ("Product Studio"), a collection switcher, and a
// data-defined view per collection. Edit a Task's hours/status (or drag a Doc
// between editorial columns) and the Feature + Initiative rollups update live in
// every open tab — the server computes them; the client runs no formula code.

import { effect } from '@preact/signals-core';
import { createWorkspaceStore } from './store.ts';
import { RENDERERS } from './registry.ts';
import { collections, relations, seedOps, types, views } from './product-studio.ts';
import type { ViewDoc } from './types.ts';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">Product Studio <span class="muted">· Computable Records</span></div>
    <div class="tabs" id="tabs"></div>
    <div class="conn" id="conn" title="connection"></div>
  </header>
  <main id="mount" class="mount"></main>
  <footer class="hint">Edit a <b>Task</b>'s hours or status — the <b>Feature</b> and <b>Initiative</b> rollups (effort, progress, points) recompute on the server and update every open tab live.</footer>
`;

const tabsEl = app.querySelector<HTMLElement>('#tabs')!;
const mount = app.querySelector<HTMLElement>('#mount')!;
const conn = app.querySelector<HTMLElement>('#conn')!;

const workspace = await createWorkspaceStore({
  baseUrl: location.origin, // Vite proxy forwards /collections + /workspace + ws to :8787
  actor: `tab-${Math.random().toString(36).slice(2, 6)}`,
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
  dispose = store && renderer ? renderer(mount, { store, view, workspace }) : () => undefined;
  for (const b of tabsEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.id === view.id);
}

for (const view of views) {
  const b = document.createElement('button');
  b.textContent = view.title;
  b.dataset.id = view.id;
  b.addEventListener('click', () => show(view));
  tabsEl.append(b);
}

show(views[1]); // open on Features — where the rollups are most visible
