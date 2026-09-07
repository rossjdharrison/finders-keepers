// The walking skeleton wired together: seed the Deals collection, open the store,
// and mount a data-defined view with a table<->board switcher. Editing a stored
// cell (or dragging a card) writes an op; the server recomputes lineTotal and
// broadcasts, so every open tab updates live — with no formula code on the client.

import { effect } from '@preact/signals-core';
import { createStore } from './store.ts';
import { RENDERERS } from './registry.ts';
import { COLLECTION, dealsDoc, seedOps } from './deals.ts';
import type { ViewDoc } from './types.ts';
import tableView from './views/deals-table.json';
import boardView from './views/deals-board.json';

const views = [tableView, boardView] as unknown as ViewDoc[];
const app = document.querySelector<HTMLElement>('#app')!;

// shell: header (title + connection dot + view tabs) and a mount point
app.innerHTML = `
  <header class="topbar">
    <div class="brand">Computable Records <span class="muted">· Deals</span></div>
    <div class="tabs" id="tabs"></div>
    <div class="conn" id="conn" title="connection"></div>
  </header>
  <main id="mount" class="mount"></main>
  <footer class="hint">Edit a cell or drag a card — <b>lineTotal</b> is computed on the server and updates every open tab live.</footer>
`;

const tabsEl = app.querySelector<HTMLElement>('#tabs')!;
const mount = app.querySelector<HTMLElement>('#mount')!;
const conn = app.querySelector<HTMLElement>('#conn')!;

const actor = `tab-${Math.random().toString(36).slice(2, 6)}`;
const store = await createStore({
  baseUrl: location.origin, // Vite proxy forwards /collections + ws to :8787 (same-origin)
  collectionId: COLLECTION,
  actor,
  collection: dealsDoc,
  query: views[0].query,
  seedOps,
});

effect(() => {
  conn.dataset.status = store.status.value;
  conn.textContent = store.status.value;
});

let dispose: () => void = () => undefined;
function show(view: ViewDoc): void {
  dispose();
  const renderer = RENDERERS[view.renderer];
  dispose = renderer ? renderer(mount, { store, view }) : () => undefined;
  for (const b of tabsEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.id === view.id);
}

for (const view of views) {
  const b = document.createElement('button');
  b.textContent = view.title;
  b.dataset.id = view.id;
  b.addEventListener('click', () => show(view));
  tabsEl.append(b);
}

show(views[0]);
