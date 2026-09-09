// The journey renderer — an application rendered as a step wizard. It is presentation ONLY:
// it reads the neutral RenderPlan from resolve() (family / role / label / state / hidden) and
// the journey step order from the view config, and emits DOM + data-render-* hooks the style
// layer paints. It names no field, computes no premium, calls no engine — the plan carries it.

import { effect } from '@preact/signals-core';
import type { Renderer } from '../types.ts';
import { resolvePlan, overridesFrom } from '../resolve.ts';
import { format } from '../format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const journeyRenderer: Renderer = (mount, { store, view, workspace: _ws, model, vocab, viewer }) => {
  const collDoc = model.collections.find((c) => c.id === store.id);
  const overrides = overridesFrom(model.presentation ?? []);
  const l10n = new Map(Object.entries(view.config?.labels ?? {}));
  const enums = view.config?.enums ?? {};
  const journey = view.config?.journey;
  const srcOf = new Map((collDoc?.properties ?? []).map((p) => [p.id, p.source ?? 'stored']));

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  mount.append(wrap);

  return effect(() => {
    const rows = store.rows.value;
    wrap.replaceChildren();
    if (!rows.length) {
      wrap.append(el('div', 'empty', 'No applications yet.'));
      return;
    }
    for (const row of rows) {
      const plan = collDoc ? resolvePlan({ collection: collDoc, types: model.types, vocab, overrides, viewer, audience: { l10n }, row }) : undefined;
      const byField = new Map((plan?.fields ?? []).map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));

      const card = el('div', 'journey-card');
      if (plan) {
        card.dataset.renderFamily = plan.family;
        if (plan.variant) card.dataset.variant = plan.variant;
      }

      // the stepper: past steps positive, the current step carries its own state token, future muted
      if (journey) {
        const cur = row.doc[journey.field];
        const stepVal = cur && cur.t === 'enum' ? cur.v : undefined;
        const stepState = byField.get(journey.field)?.state;
        const idx = journey.steps.findIndex((s) => s.id === stepVal);
        const stepper = el('div', 'stepper');
        journey.steps.forEach((s, i) => {
          const dot = el('div', 'step', s.label ?? s.id);
          dot.dataset.state = i < idx ? 'positive' : i === idx ? stepState ?? 'info' : 'muted';
          if (i === idx) dot.dataset.current = 'true';
          stepper.append(dot);
        });
        card.append(stepper);
      }

      // the premium panel: the headline measure, emphasized
      const prem = byField.get('premium');
      if (prem) {
        const panel = el('div', 'journey-premium');
        panel.dataset.role = 'measure';
        panel.dataset.provenance = 'derived';
        if (prem.emphasis) panel.dataset.emphasis = prem.emphasis;
        panel.append(el('span', 'jp-label', prem.label), el('span', 'jp-value', format(row.doc.premium)));
        card.append(panel);
      }

      // the inputs summary: the user's stored answers (computed intermediates stay internal)
      const grid = el('div', 'journey-fields');
      for (const f of plan?.fields ?? []) {
        const field = f.node.slice(f.node.indexOf('.') + 1);
        if (f.hidden || field === 'premium' || field === journey?.field) continue;
        if (srcOf.get(field) !== 'stored') continue; // show inputs, not the many computed intermediates
        const cell = el('div', 'jf');
        cell.dataset.role = f.role;
        if (f.state) cell.dataset.state = f.state;
        cell.dataset.provenance = 'authored';
        cell.append(el('div', 'jf-label', f.label), el('div', 'jf-value', format(row.doc[field], enums[field]) || '—'));
        grid.append(cell);
      }
      card.append(grid);
      wrap.append(card);
    }
  });
};
