// The journey renderer — the aanvragen as an EDITABLE step wizard. It is presentation only: it
// reads the neutral RenderPlan (family / role / label / doc / state / editable / hidden) and the
// engine's per-row `actions` (which step transitions are enabled), and emits SEMANTIC, accessible
// DOM + data-render-* hooks. It NEVER evaluates a condition itself — `hidden` (availableWhen) and
// `actions.enabled` (transition guards) are both verdicts computed once by the engine's single
// conditional function. Editing a field → store.setField → engine recompute → new verdicts → re-render.
//
// Accessibility is first-class here: the stepper is an ordered list with aria-current; every editable
// field has a real <label for> + aria-describedby pointing at the model's own help prose; the premium
// is an aria-live status so a recompute is announced; the nav is a labelled group and a disabled
// advance also carries aria-disabled. Nothing here is bank-specific — the look is all tokens/CSS.

import { effect } from '@preact/signals-core';
import type { Renderer } from '../types.ts';
import { resolvePlan, overridesFrom } from '../resolve.ts';
import { mountCell, isEditableKind } from '../cells.ts';
import { format } from '../format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const hidden = (text: string): HTMLElement => el('span', 'visually-hidden', text);

export const journeyRenderer: Renderer = (mount, { store, view, model, vocab, viewer }) => {
  const collDoc = model.collections.find((c) => c.id === store.id);
  const overrides = overridesFrom(model.presentation ?? []);
  const l10n = new Map(Object.entries(view.config?.labels ?? {}));
  const docs = new Map(Object.entries(view.config?.docs ?? {})); // the model's self-documentation (i18n)
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
  // A persistent polite live region. The effect rebuilds the cards on every recompute, so a live
  // region INSIDE a card would be destroyed and recreated with its content already present — which
  // screen readers do NOT announce. This region lives outside the rebuild and survives it, so writing
  // its text on a change reliably announces the new premium. The visible premium panel stays plain
  // content, read in normal flow; this announces the update.
  const live = el('div', 'visually-hidden');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  mount.append(wrap, live);
  let lastAnnounce: string | null = null;

  return effect(() => {
    const rows = store.rows.value;
    wrap.replaceChildren();
    const announceParts: string[] = [];
    if (!rows.length) {
      wrap.append(el('div', 'empty', 'Geen aanvragen.'));
      return;
    }
    for (const row of rows) {
      const plan = collDoc
        ? resolvePlan({ collection: collDoc, types: model.types, vocab, overrides, viewer, audience: { l10n, docs }, row })
        : undefined;
      const byField = new Map((plan?.fields ?? []).map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));
      const stepVal = stepField && row.doc[stepField]?.t === 'enum' ? (row.doc[stepField] as { v: string }).v : undefined;
      const idx = steps.findIndex((s) => s.id === stepVal);

      const card = el('article', 'journey-card');
      card.setAttribute('aria-label', `Aanvraag — stap ${labelOfStep(stepVal ?? '')}`);
      if (plan) {
        card.dataset.renderFamily = plan.family;
        if (plan.variant) card.dataset.variant = plan.variant;
      }

      // stepper: an ordered list; past = positive, current carries aria-current + its state token,
      // future = muted. Each step gets visually-hidden status text for screen readers.
      if (journey && stepField) {
        const stepState = byField.get(stepField)?.state;
        const nav = el('nav');
        nav.setAttribute('aria-label', 'Voortgang');
        const ol = el('ol', 'stepper');
        steps.forEach((s, i) => {
          const li = el('li', 'step');
          li.dataset.state = i < idx ? 'positive' : i === idx ? stepState ?? 'info' : 'muted';
          if (i === idx) {
            li.dataset.current = 'true';
            li.setAttribute('aria-current', 'step');
          }
          li.append(document.createTextNode(s.label ?? s.id));
          li.append(hidden(i < idx ? ' (voltooid)' : i === idx ? ' (huidige stap)' : ' (nog te doen)'));
          ol.append(li);
        });
        nav.append(ol);
        card.append(nav);
      }

      // the premium headline, always visible. It is plain visible content (read in flow); the
      // recompute is announced by the persistent live region below, not by this rebuilt node.
      const prem = byField.get('premium');
      if (prem) {
        const value = format(row.doc.premium);
        const panel = el('div', 'journey-premium');
        panel.dataset.role = 'measure';
        panel.dataset.provenance = 'derived';
        if (prem.emphasis) panel.dataset.emphasis = prem.emphasis;
        panel.append(el('span', 'jp-label', prem.label), el('span', 'jp-value', value));
        card.append(panel);
        if (value) announceParts.push(`${prem.label}: ${value}`);
      }

      // the CURRENT step's fields, editable — hidden (availableWhen) skipped, computed read-only.
      // Each field: a real <label for> (editable) or a <div> label (read-only), the control, and the
      // model's help prose as <p> wired via aria-describedby.
      const grid = el('div', 'journey-fields');
      for (const field of steps[idx]?.fields ?? []) {
        const fp = byField.get(field);
        if (!fp || fp.hidden || field === 'premium') continue;
        const prop = store.propOf(field);
        const willEdit = !!prop && fp.editable && isEditableKind(prop.valueType.k);
        const inputId = `f-${row.id}-${field}`;
        const helpId = `${inputId}-help`;

        const cell = el('div', 'jf');
        cell.dataset.role = fp.role;
        if (fp.state) cell.dataset.state = fp.state;
        cell.dataset.provenance = prop?.source === 'computed' ? 'derived' : 'authored';

        const label = el(willEdit ? 'label' : 'div', 'jf-label');
        if (willEdit) (label as HTMLLabelElement).htmlFor = inputId;
        label.append(document.createTextNode(fp.label));
        cell.append(label);

        const host = el('div', 'jf-input');
        if (prop) {
          const options = prop.valueType.k === 'enum' ? enums[prop.valueType.set] : undefined;
          mountCell(host, {
            value: row.doc[field], prop, options, refOptions: undefined,
            readOnly: !fp.editable, onEdit: (val) => store.setField(row.id, field, val),
            id: willEdit ? inputId : undefined,
            describedBy: fp.doc ? helpId : undefined,
          });
        } else {
          host.textContent = format(row.doc[field]) || '—';
        }
        cell.append(host);

        if (fp.doc) {
          const help = el('p', 'jf-help', fp.doc);
          help.id = helpId;
          cell.append(help);
        }
        grid.append(cell);
      }
      card.append(grid);

      // step navigation: back is free (no guard); forward is the engine's guarded action, enabled/
      // disabled purely from act.enabled — the same conditional the engine already ran. A labelled
      // group; a blocked advance carries aria-disabled + an explanatory title.
      const navBar = el('div', 'journey-nav');
      navBar.setAttribute('role', 'group');
      navBar.setAttribute('aria-label', 'Stapnavigatie');
      if (idx > 0) {
        const back = el('button', 'j-btn j-back', `← ${labelOfStep(steps[idx - 1].id)}`);
        (back as HTMLButtonElement).type = 'button';
        back.addEventListener('click', () => go(row.id, steps[idx - 1].id));
        navBar.append(back);
      }
      for (const act of row.actions ?? []) {
        if (act.field !== stepField) continue;
        const btn = el('button', 'j-btn j-next', `${labelOfStep(act.to)} →`) as HTMLButtonElement;
        btn.type = 'button';
        btn.dataset.state = act.enabled ? 'ready' : 'blocked';
        btn.disabled = !act.enabled;
        btn.setAttribute('aria-disabled', String(!act.enabled));
        if (!act.enabled) btn.title = 'Rond deze stap eerst af';
        btn.addEventListener('click', () => act.enabled && go(row.id, act.to));
        navBar.append(btn);
      }
      card.append(navBar);
      wrap.append(card);
    }

    // announce a changed premium (skip the first render so nothing is barked on load)
    const announce = announceParts.join('; ');
    if (lastAnnounce !== null && announce !== lastAnnounce) live.textContent = announce;
    lastAnnounce = announce;
  });
};
