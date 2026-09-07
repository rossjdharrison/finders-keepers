// Table renderer — a data-defined grid. Columns come from view.visibleProps +
// config.labels; each cell is drawn by the cell registry (stored cells editable,
// computed cells read-only). An effect() re-renders the body whenever the store's
// rows signal changes, so a server-recomputed column updates live.

import { effect } from '@preact/signals-core';
import type { EnumOption, Renderer } from '../types.ts';
import { mountCell } from '../cells.ts';
import { format } from '../format.ts';

export const tableRenderer: Renderer = (mount, { store, view, workspace }) => {
  // Candidate parent rows for a ref field, read live from the parent collection.
  const refOptionsFor = (field: string): EnumOption[] | undefined => {
    const cfg = view.config?.refs?.[field];
    const parent = cfg && workspace.collection(cfg.collection);
    if (!cfg || !parent) return undefined;
    return parent.rows.value.map((r) => ({ id: r.id, label: format(r.doc[cfg.labelField]) || r.id }));
  };
  mount.replaceChildren();
  const table = document.createElement('table');
  table.className = 'view-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const f of view.visibleProps) {
    const th = document.createElement('th');
    th.textContent = view.config?.labels?.[f] ?? f;
    htr.append(th);
  }
  thead.append(htr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  mount.append(table);

  return effect(() => {
    const rows = store.rows.value;
    tbody.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = view.visibleProps.length;
      td.className = 'empty';
      td.textContent = 'No records yet.';
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const f of view.visibleProps) {
        const td = document.createElement('td');
        const prop = store.propOf(f);
        if (prop) {
          mountCell(td, {
            value: row.doc[f],
            prop,
            options: view.config?.enums?.[f],
            refOptions: prop.valueType.k === 'ref' ? refOptionsFor(f) : undefined,
            readOnly: prop.source === 'computed',
            onEdit: (val) => store.setField(row.id, f, val),
          });
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
  });
};
