// The journey renderer — the aanvragen as an EDITABLE step wizard. It is presentation only: it
// reads the neutral RenderPlan (family / role / label / state / editable / hidden) and the
// engine's per-row `actions` (which step transitions are enabled), and emits DOM + data-render-*
// hooks. It NEVER evaluates a condition itself — `hidden` (availableWhen) and `actions.enabled`
// (transition guards) are both verdicts computed once by the engine's single conditional
// function. Editing a field → store.setField → engine recompute → new verdicts → re-render.

import { effect } from '@preact/signals-core';
import type { Renderer } from '../types.ts';
import { resolvePlan, overridesFrom } from '../resolve.ts';
import { mountCell } from '../cells.ts';
import { format } from '../format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const journeyRenderer: Renderer = (mount, { store, view, model, vocab, viewer }) => {
  const collDoc = model.collections.find((c) => c.id === store.id);
  const overrides = overridesFrom(model.presentation ?? []);
  const l10n = new Map(Object.entries(view.config?.labels ?? {}));
  const enums = view.config?.enums ?? {};
  const journey = view.config?.journey;
  const steps = journey?.steps ?? [];
  const stepField = journey?.field;
  const stepProp = collDoc?.properties.find((p) => p.id === stepField);
  const stepSet = stepProp && stepProp.valueType.k === 'enum' ? stepProp.valueType.set : 'step';
  const labelOfStep = (id: string): string => steps.find((s) => s.id === id)?.label ?? id;
  const go = (rowId: string, to: string): void => {
    if (stepField) store.setField(rowId, stepField, { t: 'enum', set: stepSet, v: to });
  };

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  mount.append(wrap);

  return effect(() => {
    const rows = store.rows.value;
    wrap.replaceChildren();
    if (!rows.length) {
      wrap.append(el('div', 'empty', 'Geen aanvragen.'));
      return;
    }
    for (const row of rows) {
      const plan = collDoc ? resolvePlan({ collection: collDoc, types: model.types, vocab, overrides, viewer, audience: { l10n }, row }) : undefined;
      const byField = new Map((plan?.fields ?? []).map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));
      const stepVal = stepField && row.doc[stepField]?.t === 'enum' ? (row.doc[stepField] as { v: string }).v : undefined;
      const idx = steps.findIndex((s) => s.id === stepVal);

      const card = el('div', 'journey-card');
      if (plan) {
        card.dataset.renderFamily = plan.family;
        if (plan.variant) card.dataset.variant = plan.variant;
      }

      // stepper: past = positive, current carries its own state token, future = muted
      if (journey && stepField) {
        const stepState = byField.get(stepField)?.state;
        const stepper = el('div', 'stepper');
        steps.forEach((s, i) => {
          const dot = el('div', 'step', s.label ?? s.id);
          dot.dataset.state = i < idx ? 'positive' : i === idx ? stepState ?? 'info' : 'muted';
          if (i === idx) dot.dataset.current = 'true';
          stepper.append(dot);
        });
        card.append(stepper);
      }

      // the premium headline, always visible
      const prem = byField.get('premium');
      if (prem) {
        const panel = el('div', 'journey-premium');
        panel.dataset.role = 'measure';
        panel.dataset.provenance = 'derived';
        if (prem.emphasis) panel.dataset.emphasis = prem.emphasis;
        panel.append(el('span', 'jp-label', prem.label), el('span', 'jp-value', format(row.doc.premium)));
        card.append(panel);
      }

      // the CURRENT step's fields, editable — hidden (availableWhen) skipped, computed read-only
      const grid = el('div', 'journey-fields');
      for (const field of steps[idx]?.fields ?? []) {
        const fp = byField.get(field);
        if (!fp || fp.hidden || field === 'premium') continue;
        const prop = store.propOf(field);
        const cell = el('div', 'jf');
        cell.dataset.role = fp.role;
        if (fp.state) cell.dataset.state = fp.state;
        cell.dataset.provenance = prop?.source === 'computed' ? 'derived' : 'authored';
        cell.append(el('div', 'jf-label', fp.label));
        const host = el('div', 'jf-input');
        if (prop) {
          const options = prop.valueType.k === 'enum' ? enums[prop.valueType.set] : undefined;
          mountCell(host, { value: row.doc[field], prop, options, refOptions: undefined, readOnly: !fp.editable, onEdit: (val) => store.setField(row.id, field, val) });
        } else {
          host.textContent = format(row.doc[field]) || '—';
        }
        cell.append(host);
        grid.append(cell);
      }
      card.append(grid);

      // step navigation: back is free (no guard); forward is the engine's guarded action,
      // enabled/disabled purely from act.enabled — the same conditional the engine already ran.
      const nav = el('div', 'journey-nav');
      if (idx > 0) {
        const back = el('button', 'j-btn j-back', `← ${labelOfStep(steps[idx - 1].id)}`);
        back.addEventListener('click', () => go(row.id, steps[idx - 1].id));
        nav.append(back);
      }
      for (const act of row.actions ?? []) {
        if (act.field !== stepField) continue;
        const btn = el('button', 'j-btn j-next', `${labelOfStep(act.to)} →`) as HTMLButtonElement;
        btn.dataset.state = act.enabled ? 'ready' : 'blocked';
        btn.disabled = !act.enabled;
        if (!act.enabled) btn.title = 'Rond deze stap eerst af';
        btn.addEventListener('click', () => act.enabled && go(row.id, act.to));
        nav.append(btn);
      }
      card.append(nav);
      wrap.append(card);
    }
  });
};
