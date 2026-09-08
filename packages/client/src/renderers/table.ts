// Table renderer — a data-defined grid, now driven by a neutral RenderPlan. Columns come
// from view.visibleProps; each field's LABEL, ROLE and EDITABILITY are resolved (labels
// via the view's config.labels used as the l10n resource, falling back to a humanized
// default; role derived from the HQDM category; editable from the viewer's affordance).
// The table stamps data-render-family and each cell stamps data-role / data-state — the
// neutral hooks the style layer keys on. An effect() re-renders the body on any row change.

import { effect } from '@preact/signals-core';
import type { EnumOption, Renderer } from '../types.ts';
import { mountCell } from '../cells.ts';
import { format } from '../format.ts';
import { resolvePlan } from '../resolve.ts';

export const tableRenderer: Renderer = (mount, { store, view, workspace, model, vocab, viewer }) => {
  const refOptionsFor = (field: string): EnumOption[] | undefined => {
    const cfg = view.config?.refs?.[field];
    const parent = cfg && workspace.collection(cfg.collection);
    if (!cfg || !parent) return undefined;
    return parent.rows.value.map((r) => ({ id: r.id, label: format(r.doc[cfg.labelField]) || r.id }));
  };

  // The neutral plan for this collection: config.labels are the l10n resource for the
  // current locale; a field with no authored label falls back to a humanized default.
  const collDoc = model.collections.find((c) => c.id === store.id);
  const plan = collDoc
    ? resolvePlan({ collection: collDoc, types: model.types, vocab, viewer, audience: { l10n: new Map(Object.entries(view.config?.labels ?? {})) } })
    : undefined;
  const fp = new Map((plan?.fields ?? []).map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));

  mount.replaceChildren();
  const table = document.createElement('table');
  table.className = 'view-table';
  if (plan) table.dataset.renderFamily = plan.family; // the classification-derived family (a neutral hook)

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const f of view.visibleProps) {
    const th = document.createElement('th');
    th.textContent = fp.get(f)?.label ?? view.config?.labels?.[f] ?? f; // derived label unless authored
    const role = fp.get(f)?.role;
    if (role) th.dataset.role = role;
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
        const fieldPlan = fp.get(f);
        if (fieldPlan?.role) td.dataset.role = fieldPlan.role; // neutral role hook
        if (row.hidden?.includes(f)) {
          // not in play for this record — its availableWhen is false (category-gated)
          td.className = 'cell-gated';
          td.dataset.state = 'blocked';
          td.textContent = '—';
          td.title = 'not applicable for this record';
        } else if (prop) {
          const value = row.doc[f];
          if (value && value.t === 'enum') td.dataset.state = value.v; // value-conditional style hook
          mountCell(td, {
            value,
            prop,
            options: view.config?.enums?.[f],
            refOptions: prop.valueType.k === 'ref' ? refOptionsFor(f) : undefined,
            readOnly: fieldPlan ? !fieldPlan.editable : prop.source === 'computed',
            onEdit: (val) => store.setField(row.id, f, val),
          });
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
  });
};
