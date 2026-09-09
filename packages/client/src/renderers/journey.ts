// The journey renderer — the aanvragen as EITHER a stepped wizard OR a single page, chosen by a
// toggle (persisted). Both share the sticky quote rail, the field rendering, and the a11y. It is
// presentation only: it reads the neutral RenderPlan (family / role / label / doc / state / editable /
// hidden) and the engine's per-row `actions`, and NEVER evaluates a condition itself.
//
// Progressive disclosure is model-driven: a field's `availableWhen` makes it `hidden` (skipped), and a
// journey step's `gate` (a computed-bool field, e.g. vehicleReady) unlocks a whole section on the
// single page. Single-page may lift drop-out by showing the whole form at once; stepped keeps focus.

import { effect, signal } from '@preact/signals-core';
import type { Renderer, CollectionStore } from '../types.ts';
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
const boolOf = (v: Value | undefined): boolean => !!v && v.t === 'bool' && v.v;

type Row = CollectionStore['rows']['value'][number];
type Layout = 'stepped' | 'single';
const LAYOUT_KEY = 'fk-journey-layout';

export const journeyRenderer: Renderer = (mount, { store, view, model, vocab, viewer, suggestions }) => {
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
  // walk the guarded step machine to the end (single-page submit): each transition is guarded, so a
  // missing confirmation simply stops the walk. Enabled only when everything is ready.
  const walkToEnd = (rowId: string, fromStep: string): void => {
    const order = steps.map((s) => s.id);
    for (let i = order.indexOf(fromStep) + 1; i < order.length; i++) {
      try {
        go(rowId, order[i]);
      } catch {
        break;
      }
    }
  };
  const sectionUnlocked = (row: Row, gate?: string): boolean => !gate || boolOf(row.doc[gate]);
  const readyToSubmit = (row: Row): boolean => steps.every((s) => !s.gate || boolOf(row.doc[s.gate])) && boolOf(row.doc.termsAccepted);

  const loadLayout = (): Layout => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'stepped';
    } catch {
      return 'stepped';
    }
  };
  const layout = signal<Layout>(loadLayout());
  const setLayout = (l: Layout): void => {
    if (l === layout.value) return;
    focusToggle = true; // the rebuild will drop focus; restore it to the active option + announce
    layout.value = l;
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* private mode */
    }
  };

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  const live = el('div', 'visually-hidden');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  mount.append(wrap, live);
  let lastAnnounce: string | null = null;
  let focusToggle = false; // set when the user flips the layout, so we restore focus after the rebuild
  let prevVisible = new Set<string>(); // section/step ids visible last render — to detect a NEW one
  let firstRender = true; // don't auto-scroll on the initial paint
  // uncommitted invalid edits, keyed "rowId::field" — kept across the full re-render so a user's
  // in-progress invalid value + its error survive an unrelated commit elsewhere on the form.
  const pending = new Map<string, { raw: string; msg: string }>();

  // --- one field cell (used by both layouts). Returns null for a hidden field. ---
  const fieldCell = (row: Row, byField: Map<string, ReturnType<typeof resolvePlan>['fields'][number]>, field: string, isLedger: boolean): HTMLElement | null => {
    const fp = byField.get(field);
    if (!fp || fp.hidden || field === 'premium') return null;
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
      cell.classList.add('jf-readout');
      cell.append(el('span', 'jf-rolabel', fp.label));
      const disp = format(row.doc[field], options) || '—';
      cell.append(el('span', 'jf-rovalue', fp.role === 'deduction' && disp !== '—' ? `− ${disp}` : disp));
      if (!isLedger) {
        const h = helpNode();
        if (h) cell.append(h);
      }
    } else if (isBool) {
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
      const lab = el('label', 'jf-label') as HTMLLabelElement;
      lab.htmlFor = inputId;
      lab.textContent = fp.label;
      const host = el('div', 'jf-input');
      const pkey = `${row.id}::${field}`;
      mountCell(host, {
        value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false,
        onEdit: (v) => store.setField(row.id, field, v), id: inputId, describedBy: fp.doc ? helpId : undefined,
        pending: pending.get(pkey),
        onValidity: (st) => (st ? pending.set(pkey, st) : pending.delete(pkey)),
        suggestions: suggestions?.value?.[field], // reactive: read here so the effect re-renders when they arrive
      });
      cell.append(lab, host);
      const h = helpNode();
      if (h) cell.append(h);
    }
    return cell;
  };

  // --- the sticky quote rail (used by both layouts) ---
  const buildRail = (row: Row, byField: Map<string, ReturnType<typeof resolvePlan>['fields'][number]>, announceParts: string[]): HTMLElement => {
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
      const line = (f: string): void => {
        const v = row.doc[f];
        if (!isMoney(v)) return;
        const sign = byField.get(f)?.role === 'deduction' ? '− ' : '';
        const r2 = el('div', 'quote-line');
        r2.append(el('dt', undefined, labelOf(f)), el('dd', undefined, `${sign}${format(v)}`));
        lines.append(r2);
      };
      line('gross');
      line('noClaimDiscount');
      if (lines.children.length) quote.append(lines);
      announceParts.push(`${labelOf('premium')}: ${value}`);
    } else {
      quote.append(el('p', 'quote-empty', 'Uw premie verschijnt hier zodra u een dekking kiest.'));
    }
    const desc = row.doc.vehicleDesc;
    const plate = row.doc.plate;
    if (desc?.t === 'text' && desc.v) {
      const veh = el('div', 'quote-vehicle');
      veh.append(el('span', 'qv-name', desc.v));
      if (plate?.t === 'text' && plate.v) veh.append(el('span', 'qv-plate', plate.v));
      quote.append(veh);
    }
    rail.append(quote);
    return rail;
  };

  const buildToggle = (mode: Layout): HTMLElement => {
    const bar = el('div', 'journey-toggle');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Weergave');
    const opt = (l: Layout, text: string): void => {
      const b = el('button', 'jt-opt', text) as HTMLButtonElement;
      b.type = 'button';
      b.dataset.active = String(mode === l);
      b.setAttribute('aria-pressed', String(mode === l));
      b.addEventListener('click', () => setLayout(l));
      bar.append(b);
    };
    opt('stepped', 'Stapsgewijs');
    opt('single', 'Alles op één pagina');
    return bar;
  };

  return effect(() => {
    const rows = store.rows.value;
    const mode = layout.value;
    // preserve the focused input's focus + caret + uncommitted text across this full rebuild — an
    // async arrival (a resolved postcode/suggestions or plate) must not yank focus or discard what
    // the user is mid-typing (the pending map only covers committed-but-invalid edits).
    const ae = document.activeElement as HTMLInputElement | null;
    const keepId = ae && ae.id && wrap.contains(ae) ? ae.id : null;
    const keepVal = keepId ? ae!.value : null;
    const keepStart = keepId ? ae!.selectionStart : null;
    const keepEnd = keepId ? ae!.selectionEnd : null;
    wrap.replaceChildren();
    const announceParts: string[] = [];
    const nowVisible = new Set<string>(); // section/step ids on screen this render (for reveal-scroll)
    let modeAnnounced = false;
    if (steps.length > 1) wrap.append(buildToggle(mode));
    if (focusToggle) {
      // the rebuild removed the button the user activated — restore focus to the active option and
      // announce the change, so the switch is operable and heard (a11y). This announce wins this tick.
      focusToggle = false;
      modeAnnounced = true;
      wrap.querySelector<HTMLElement>('.jt-opt[data-active="true"]')?.focus();
      live.textContent = mode === 'single' ? 'Weergave: alles op één pagina.' : 'Weergave: stapsgewijs.';
    }
    if (!rows.length) {
      wrap.append(el('div', 'empty', 'Geen aanvragen.'));
      return;
    }

    for (const row of rows) {
      const plan = collDoc ? resolvePlan({ collection: collDoc, types: model.types, vocab, overrides, viewer, audience: { l10n, docs }, row }) : undefined;
      const byField = new Map((plan?.fields ?? []).map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));
      const stepVal = stepField && row.doc[stepField]?.t === 'enum' ? (row.doc[stepField] as { v: string }).v : undefined;

      const card = el('article', 'journey-card');
      if (plan) {
        card.dataset.renderFamily = plan.family;
        if (plan.variant) card.dataset.variant = plan.variant;
      }
      const main = el('div', 'jc-main');
      card.append(main);

      if (mode === 'stepped') {
        card.setAttribute('aria-label', `Aanvraag — stap ${labelOfStep(stepVal ?? '')}`);
        const idx = Math.max(0, steps.findIndex((s) => s.id === stepVal));
        const rawFields = steps[idx]?.fields ?? [];
        const nonPremium = rawFields.filter((f) => f !== 'premium');
        const isLedger = nonPremium.length > 0 && nonPremium.every((f) => !byField.get(f)?.editable);
        const stepFields = isLedger ? rawFields : nonPremium.length ? nonPremium : rawFields;

        // stepper
        if (stepField) {
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
        const head = el('div', 'jc-step-head');
        if (stepVal) {
          head.dataset.section = stepVal; // scroll anchor when the step changes
          nowVisible.add(stepVal);
        }
        head.append(el('span', 'jc-step-eyebrow', `Stap ${idx + 1} van ${steps.length}`));
        head.append(el('h2', 'jc-step-title', labelOfStep(stepVal ?? '')));
        main.append(head);

        const grid = el('div', 'journey-fields');
        if (isLedger) grid.classList.add('is-ledger');
        for (const field of stepFields) {
          const cell = fieldCell(row, byField, field, isLedger);
          if (cell) grid.append(cell);
        }
        main.append(grid);

        // navigation — back is free; forward is the engine's guarded action
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
      } else {
        // --- single page: every section stacked, gated (progressive disclosure), one submit ---
        card.setAttribute('aria-label', 'Aanvraag — alles op één pagina');
        main.append(el('h2', 'jc-page-title', view.title ?? 'Uw aanvraag'));
        for (const step of steps) {
          const inputs = (step.fields ?? []).filter((f) => f !== 'premium');
          // skip informational sections (the all-computed premie-opbouw + the terminal step) — the
          // rail carries the premium, so on one page we show only the sections the user fills in.
          if (!inputs.some((f) => byField.get(f)?.editable)) continue;
          // a section only BECOMES VISIBLE once its gate (a wasm-computed bool) is satisfied — the
          // previous step is complete. Locked sections are hidden entirely (progressive reveal).
          if (!sectionUnlocked(row, step.gate)) continue;
          const section = el('section', 'jc-section');
          section.dataset.section = step.id; // scroll anchor when newly revealed
          nowVisible.add(step.id);
          section.setAttribute('aria-label', step.label ?? step.id);
          section.append(el('h3', 'jc-section-title', step.label ?? step.id));
          const grid = el('div', 'journey-fields');
          for (const field of inputs) {
            const cell = fieldCell(row, byField, field, false);
            if (cell) grid.append(cell);
          }
          section.append(grid);
          main.append(section);
        }
        const lastStepId = steps[steps.length - 1]?.id;
        if (stepVal === lastStepId) {
          // the walk reached the terminal step — single-page has no 'done' section, so show an
          // explicit confirmation (and announce it, since no premium changed to trigger the live region)
          const done = el('div', 'jc-complete');
          done.append(el('span', 'jc-complete-mark', '✓'), el('span', 'jc-complete-text', 'Uw aanvraag is afgerond.'));
          main.append(done);
          announceParts.push('Uw aanvraag is afgerond');
        } else {
          const navBar = el('div', 'journey-nav');
          navBar.setAttribute('role', 'group');
          navBar.setAttribute('aria-label', 'Aanvraag afronden');
          const submit = el('button', 'j-btn j-next', 'Aanvraag afronden →') as HTMLButtonElement;
          submit.type = 'button';
          const ok = readyToSubmit(row);
          submit.dataset.state = ok ? 'ready' : 'blocked';
          submit.disabled = !ok;
          submit.setAttribute('aria-disabled', String(!ok));
          if (!ok) submit.title = 'Vul alle stappen in en accepteer de voorwaarden';
          submit.addEventListener('click', () => ok && walkToEnd(row.id, stepVal ?? steps[0]?.id ?? ''));
          navBar.append(submit);
          main.append(navBar);
        }
      }

      card.append(buildRail(row, byField, announceParts));
      wrap.append(card);
    }

    const announce = announceParts.join('; ');
    if (!modeAnnounced && lastAnnounce !== null && announce !== lastAnnounce) live.textContent = announce;
    lastAnnounce = announce;

    // restore focus/caret/uncommitted text (skip when a layout switch already claimed focus).
    // preventScroll so it doesn't fight the reveal-scroll below.
    if (keepId && !modeAnnounced) {
      const back = wrap.querySelector<HTMLInputElement>('#' + CSS.escape(keepId));
      if (back) {
        if (keepVal != null && back.value !== keepVal) back.value = keepVal; // keep the in-progress text
        back.focus({ preventScroll: true });
        try {
          if (keepStart != null) back.setSelectionRange(keepStart, keepEnd ?? keepStart);
        } catch {
          /* number inputs don't support setSelectionRange */
        }
      }
    }

    // vertically center a section/step that JUST became visible (a progressive reveal in single-page,
    // or a step change in stepped) — driven by the wasm-computed gates. Not on first paint or a toggle.
    if (!firstRender && !modeAnnounced) {
      const appeared = [...nowVisible].find((id) => !prevVisible.has(id));
      if (appeared) {
        const target = wrap.querySelector<HTMLElement>(`[data-section="${appeared}"]`);
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        target?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        // announce "now available" ONLY for a single-page progressive reveal. In stepped mode a step
        // change (incl. Back) is navigation, not a reveal — the step title + aria-current convey it.
        if (mode === 'single') live.textContent = `${labelOfStep(appeared)} — nu beschikbaar.`;
      }
    }
    prevVisible = nowVisible;
    firstRender = false;
  });
};
