// Board renderer — the SECOND view over the same data, proving the renderer
// registry. Groups rows into columns by an enum field (config.groupField);
// dragging a card to another column writes that field (setField), which the
// server folds + recomputes + broadcasts, so both tabs re-lay-out live.

import { effect } from '@preact/signals-core';
import { enumV } from '@core/values';
import type { Renderer } from '../types.ts';
import { format } from '../format.ts';

export const boardRenderer: Renderer = (mount, { store, view }) => {
  mount.replaceChildren();
  const gf = view.config?.groupField;
  if (!gf) {
    mount.textContent = 'board view needs config.groupField';
    return () => undefined;
  }
  const options = view.config?.enums?.[gf] ?? [];
  const columns = view.config?.columns ?? options.map((o) => o.id);
  const setProp = store.propOf(gf);
  const set = setProp?.valueType.k === 'enum' ? setProp.valueType.set : gf;

  const board = document.createElement('div');
  board.className = 'view-board';
  mount.append(board);

  return effect(() => {
    const rows = store.rows.value;
    board.replaceChildren();
    for (const colId of columns) {
      const col = document.createElement('div');
      col.className = 'board-col';
      const head = document.createElement('div');
      head.className = 'board-col-head';
      head.textContent = options.find((o) => o.id === colId)?.label ?? colId;
      col.append(head);

      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drop');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const id = e.dataTransfer?.getData('text/plain');
        if (id) store.setField(id, gf, enumV(set, colId));
      });

      for (const row of rows) {
        const cur = row.doc[gf];
        if (!(cur && cur.t === 'enum' && cur.v === colId)) continue;
        const card = document.createElement('div');
        card.className = 'board-card';
        card.draggable = true;
        card.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', row.id));
        for (const f of view.visibleProps) {
          if (f === gf) continue;
          const line = document.createElement('div');
          line.className = 'card-line';
          const lbl = view.config?.labels?.[f];
          line.textContent = (lbl ? `${lbl}: ` : '') + format(row.doc[f], view.config?.enums?.[f]);
          card.append(line);
        }
        col.append(card);
      }
      board.append(col);
    }
  });
};
