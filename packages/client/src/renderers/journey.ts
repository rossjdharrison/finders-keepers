// The journey renderer — the aanvragen as a two-pane wizard: a contained form (stepper + the current
// step's fields + navigation) beside a STICKY quote rail that keeps the premium in view as it is
// filled in. It is presentation only: it reads the neutral RenderPlan (family / role / label / doc /
// state / editable / hidden) and the engine's per-row `actions` (which step transitions are enabled),
// and emits semantic, accessible DOM + data-render-* hooks. It NEVER evaluates a condition itself —
// `hidden` (availableWhen) and `actions.enabled` (guards) are verdicts the engine computed once.
//
// Accessibility: banner/main/contentinfo landmarks (in cassette.ts); here a nav>ol stepper with
// aria-current, a step <h2>, real <label for> + aria-describedby help on every control, a labelled
// nav group, and a PERSISTENT polite live region (built once, outside the rebuild) that announces the
// recomputed premium — a live region destroyed and recreated each render is not announced by AT.

import { effect } from '@preact/signals-core';
import type { Renderer } from '../types.ts';
import type { Value } from '@core/values';
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
const isMoney = (v: Value | undefined): v is Value & { t: 'money' } => !!v && v.t === 'money';

export const journeyRenderer: Renderer = (mount, { store, view, model, vocab, viewer }) => {
  const collDoc = model.collections.find((c) => c.id === store.id);
  const overrides = overridesFrom(model.presentation ?? []);
  const l10n = new Map(Object.entries(view.config?.labels ?? {}));
  const docs = new Map(Object.entries(view.config?.docs ?? {}));
  const enums = view.config?.enums ?? {};
  const journey = view.config?.journey;
  const steps = journey?.steps ?? [];
  const stepField = journey?.field;
  const stepProp = collDoc?.properties.find((p) => p.id === stepField);
  const stepSet = stepProp && stepProp.valueType.k === 'enum' ? stepProp.valueType.set : 'step';
  const labelOfStep = (id: string): string => steps.find((s) => s.id === id)?.label ?? id;
  const labelOf = (field: string): string => l10n.get(field) ?? field;
  const go = (rowId: string, to: string): void => {
    if (stepField) store.setField(rowId, stepField, { t: 'enum', set: stepSet, v: to });
  };

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  // a persistent polite live region: it survives every re-render, so writing its text on a change
  // reliably announces the new premium (a region rebuilt with its content already present is not).
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
      const idx = Math.max(0, steps.findIndex((s) => s.id === stepVal));
      const rawFields = steps[idx]?.fields ?? [];
      const nonPremium = rawFields.filter((f) => f !== 'premium');
      // a ledger = an all-readout step (the premie-opbouw); its non-premium fields are all read-only
      const isLedger = nonPremium.length > 0 && nonPremium.every((f) => !(byField.get(f)?.editable));
      // premium normally lives in the rail (dropped from step bodies). In a LEDGER it stays as the
      // emphasized total row; on a premium-only step (terminal 'done') it stays as the final figure.
      const stepFields = isLedger ? rawFields : nonPremium.length ? nonPremium : rawFields;

      const card = el('article', 'journey-card');
      card.setAttribute('aria-label', `Aanvraag — stap ${labelOfStep(stepVal ?? '')}`);
      if (plan) {
        card.dataset.renderFamily = plan.family;
        if (plan.variant) card.dataset.variant = plan.variant;
      }
      const main = el('div', 'jc-main');
      card.append(main);

      // stepper — an ordered list; past = positive, current carries aria-current + its state token
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
        main.append(nav);
      }

      // step heading — clear place-in-flow + an <h2> for structure/AT
      const head = el('div', 'jc-step-head');
      head.append(el('span', 'jc-step-eyebrow', `Stap ${idx + 1} van ${steps.length}`));
      head.append(el('h2', 'jc-step-title', labelOfStep(stepVal ?? '')));
      main.append(head);

      // the current step's fields — editable inputs, read-only readouts, or (all read-only) a ledger
      const grid = el('div', 'journey-fields');
      if (isLedger) grid.classList.add('is-ledger');
      for (const field of stepFields) {
        const fp = byField.get(field);
        if (!fp || fp.hidden) continue;
        const prop = store.propOf(field);
        const options = prop && prop.valueType.k === 'enum' ? enums[prop.valueType.set] : undefined;
        const willEdit = !!prop && fp.editable && isEditableKind(prop.valueType.k);
        const isBool = !!prop && prop.valueType.k === 'bool';
        const inputId = `f-${row.id}-${field}`;
        const helpId = `${inputId}-help`;

        const cell = el('div', 'jf');
        cell.dataset.role = fp.role;
        if (fp.state) cell.dataset.state = fp.state;
        if (fp.emphasis) cell.dataset.emphasis = fp.emphasis;
        cell.dataset.provenance = prop?.source === 'computed' ? 'derived' : 'authored';

        const helpNode = (): HTMLElement | null => {
          if (!fp.doc) return null;
          const p = el('p', 'jf-help', fp.doc);
          p.id = helpId;
          return p;
        };

        if (!willEdit) {
          // a readout / ledger line: label + formatted value (auto-filled or computed). Help is for
          // inputs and single readouts; a ledger stays a clean summary, so it is suppressed there.
          cell.classList.add('jf-readout');
          cell.append(el('span', 'jf-rolabel', fp.label));
          const disp = format(row.doc[field], options) || '—';
          // a deduction (P-layer role) reads with a leading minus, so the ledger column reconciles
          const val = el('span', 'jf-rovalue', fp.role === 'deduction' && disp !== '—' ? `− ${disp}` : disp);
          cell.append(val);
          if (!isLedger) {
            const h = helpNode();
            if (h) cell.append(h);
          }
        } else if (isBool) {
          // an inline check: box + label on one row, help spanning below
          cell.classList.add('jf-bool');
          const box = el('span', 'jf-check');
          mountCell(box, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => store.setField(row.id, field, v), id: inputId, describedBy: fp.doc ? helpId : undefined });
          const lab = el('label', 'jf-boollabel') as HTMLLabelElement;
          lab.htmlFor = inputId;
          lab.textContent = fp.label;
          cell.append(box, lab);
          const h = helpNode();
          if (h) cell.append(h);
        } else {
          // a standard field: label above the control, help below
          const lab = el('label', 'jf-label') as HTMLLabelElement;
          lab.htmlFor = inputId;
          lab.textContent = fp.label;
          const host = el('div', 'jf-input');
          mountCell(host, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => store.setField(row.id, field, v), id: inputId, describedBy: fp.doc ? helpId : undefined });
          cell.append(lab, host);
          const h = helpNode();
          if (h) cell.append(h);
        }
        grid.append(cell);
      }
      main.append(grid);

      // navigation — back is free; forward is the engine's guarded action (enabled from act.enabled)
      const navBar = el('div', 'journey-nav');
      navBar.setAttribute('role', 'group');
      navBar.setAttribute('aria-label', 'Stapnavigatie');
      if (idx > 0) {
        const back = el('button', 'j-btn j-back', `← ${labelOfStep(steps[idx - 1].id)}`) as HTMLButtonElement;
        back.type = 'button';
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
      main.append(navBar);

      // --- the sticky quote rail: the live premium summary, always in view ---
      const rail = el('aside', 'jc-rail');
      rail.setAttribute('aria-label', 'Premieoverzicht');
      const quote = el('div', 'quote');
      quote.append(el('div', 'quote-eyebrow', labelOf('premium')));
      const premium = row.doc.premium;
      if (isMoney(premium)) {
        const value = format(premium);
        const heroWrap = el('div', 'quote-hero');
        heroWrap.append(el('span', 'quote-amount', value), el('span', 'quote-per', 'per maand'));
        quote.append(heroWrap);
        const lines = el('dl', 'quote-lines');
        const line = (field: string): void => {
          const v = row.doc[field];
          if (!isMoney(v)) return;
          const sign = byField.get(field)?.role === 'deduction' ? '− ' : ''; // same source as the ledger
          const row2 = el('div', 'quote-line');
          row2.append(el('dt', undefined, labelOf(field)), el('dd', undefined, `${sign}${format(v)}`));
          lines.append(row2);
        };
        line('gross');
        line('noClaimDiscount');
        if (lines.children.length) quote.append(lines);
        announceParts.push(`${labelOf('premium')}: ${value}`);
      } else {
        quote.append(el('p', 'quote-empty', 'Uw premie verschijnt hier zodra u een dekking kiest.'));
      }
      // vehicle recap (from the RDW extern), once it is known
      const desc = row.doc.vehicleDesc;
      const plate = row.doc.plate;
      if (desc?.t === 'text' && desc.v) {
        const veh = el('div', 'quote-vehicle');
        veh.append(el('span', 'qv-name', desc.v));
        if (plate?.t === 'text' && plate.v) veh.append(el('span', 'qv-plate', plate.v));
        quote.append(veh);
      }
      rail.append(quote);
      card.append(rail);

      wrap.append(card);
    }

    // announce a changed premium (skip the first render so nothing is barked on load)
    const announce = announceParts.join('; ');
    if (lastAnnounce !== null && announce !== lastAnnounce) live.textContent = announce;
    lastAnnounce = announce;
  });
};
