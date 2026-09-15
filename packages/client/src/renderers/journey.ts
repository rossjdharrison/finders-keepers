// The journey renderer — ONE renderer for both the flat (single-collection) and the composed
// (multi-configurator) aanvraag, as EITHER a stepped wizard OR a single progressive page (a persisted
// toggle). It reads the neutral RenderPlan (family/role/label/doc/state/editable/hidden) + the engine's
// per-row `actions`, and NEVER evaluates a guard itself.
//
// The step machine (the `step` enum + its guarded transitions + the ready gates) always lives on the
// SPINE (the view's own collection). A journey step with a `collection` edits a CHILD row of that
// collection, joined to the spine by the relation's childField — so a composed journey composes across
// collections by relations + rollup in the sealed core, with no engine change and no second renderer. A
// step with no `collection` edits the spine (the flat case). The rail is rendered inline only when the
// journey declares a `summary`; without one the premium lives in the separate request drawer (flat).

import { effect, signal } from '@preact/signals-core';
import type { Renderer, CollectionStore, RowStateWire } from '../types.ts';
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

type Row = RowStateWire;
type Field = ReturnType<typeof resolvePlan>['fields'][number];
type ByField = Map<string, Field>;
type StepCtx = { fstore: CollectionStore; row: Row; byField: ByField };
type Layout = 'stepped' | 'single';
const LAYOUT_KEY = 'fk-journey-layout';
const byFieldOf = (fields: Field[]): ByField => new Map(fields.map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));

export const journeyRenderer: Renderer = (mount, { store, view, model, workspace, vocab, viewer, suggestions }) => {
  const spineDoc = model.collections.find((c) => c.id === store.id);
  const overrides = overridesFrom(model.presentation ?? []);
  const l10n = new Map(Object.entries(view.config?.labels ?? {}));
  const docs = new Map(Object.entries(view.config?.docs ?? {}));
  const enums = view.config?.enums ?? {};
  const journey = view.config?.journey;
  const steps = journey?.steps ?? [];
  const stepField = journey?.field;
  const summary = journey?.summary;
  const totalField = summary?.total ?? 'premium'; // the headline money field (skipped in the body; shown in the rail/drawer)
  const confirmField = journey?.confirmField; // a spine bool that must be true to submit (e.g. termsAccepted)
  const relations = Object.values(model.relations ?? {});
  const childFieldOf = (coll: string): string => relations.find((r) => r.childColl === coll && r.parentColl === store.id)?.childField ?? 'app';

  const stepProp = spineDoc?.properties.find((p) => p.id === stepField);
  const stepSet = stepProp && stepProp.valueType.k === 'enum' ? stepProp.valueType.set : 'step';
  const labelOfStep = (id: string): string => steps.find((s) => s.id === id)?.label ?? id;
  const labelOf = (field: string): string => l10n.get(field) ?? field;
  const go = (rowId: string, to: string): void => {
    if (stepField) store.setField(rowId, stepField, { t: 'enum', set: stepSet, v: to });
  };
  const walkToEnd = (rowId: string, fromStep: string): void => {
    const order = steps.map((s) => s.id);
    for (let i = order.indexOf(fromStep) + 1; i < order.length; i++) {
      try { go(rowId, order[i]); } catch { break; } // each move is guarded; a blocked one stops the walk
    }
  };
  const sectionUnlocked = (spine: Row, gate?: string): boolean => !gate || boolOf(spine.doc[gate]);
  const readyToSubmit = (spine: Row): boolean =>
    steps.every((s) => !s.gate || boolOf(spine.doc[s.gate])) && (!confirmField || boolOf(spine.doc[confirmField]));

  const loadLayout = (): Layout => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'stepped'; } catch { return 'stepped'; }
  };
  const layout = signal<Layout>(loadLayout());
  const setLayout = (l: Layout): void => {
    if (l === layout.value) return;
    focusToggle = true;
    layout.value = l;
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* private mode */ }
  };

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  const live = el('div', 'visually-hidden');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  mount.append(wrap, live);
  let lastAnnounce: string | null = null;
  let focusToggle = false;
  let prevVisible = new Set<string>();
  let firstRender = true;
  const pending = new Map<string, { raw: string; msg: string }>(); // committed-but-invalid edits, kept across rebuilds

  // A step's collection may be a GRANDCHILD of the spine, not a direct child: e.g. an Address bound to the
  // Insurance, which is in turn surfaced up to the Financing spine (adr → ins → fin). Its row links to the
  // spine only THROUGH an intermediate parent, so a direct spine-ref lookup misses it and the step would be
  // silently dropped. Follow each row's parent-refs (the relations' childFields) up the chain; the row that
  // reaches the spine row is the one this step edits. A DAG + a `seen` guard keep it terminating.
  const rowForSpine = (coll: string, spineId: string): Row | null => {
    const cs = workspace.collection(coll);
    if (!cs) return null;
    const reaches = (c: string, r: Row, seen: Set<string>): boolean => {
      const key = `${c}/${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      for (const rel of relations) {
        if (rel.childColl !== c) continue;
        const ref = r.doc[rel.childField];
        if (ref?.t !== 'ref') continue;
        const pid = (ref as { id: string }).id;
        if (rel.parentColl === store.id && pid === spineId) return true; // reached the spine row
        const prow = workspace.collection(rel.parentColl)?.rows.value.find((x) => x.id === pid);
        if (prow && reaches(rel.parentColl, prow, seen)) return true; // reached it through this parent
      }
      return false;
    };
    return cs.rows.value.find((r) => reaches(coll, r, new Set())) ?? null;
  };

  // resolve a step's field context: which store/row/plan its fields come from. A step with a collection
  // edits that collection's CHILD row (joined to the spine); otherwise it edits the spine itself.
  const resolveStep = (step: { collection?: string }, spineRow: Row, spineByField: ByField): StepCtx | null => {
    // a step with no collection, OR one naming the spine's OWN collection (a section that edits the spine
    // itself, e.g. the downstream product in a compiled L2 journey), edits the spine row directly.
    if (!step.collection || step.collection === store.id) return { fstore: store, row: spineRow, byField: spineByField };
    const cs = workspace.collection(step.collection);
    const cd = model.collections.find((c) => c.id === step.collection);
    if (!cs || !cd) return null;
    const jf = childFieldOf(step.collection);
    // direct child of the spine (fast path), else a grandchild reached through an intermediate parent
    const row = cs.rows.value.find((r) => r.doc[jf]?.t === 'ref' && (r.doc[jf] as { id: string }).id === spineRow.id)
      ?? rowForSpine(step.collection, spineRow.id);
    if (!row) return null;
    const plan = resolvePlan({ collection: cd, types: model.types, vocab, overrides, viewer, audience: { l10n, docs }, row });
    return { fstore: cs, row, byField: byFieldOf(plan.fields) };
  };

  // a child row is "active" unless it carries an `actief` bool set false (the soft-remove flag for a to-many step)
  const isActiveRow = (r: Row): boolean => { const a = r.doc.actief; return !a || a.t !== 'bool' || a.v; };

  // a TO-MANY (repeat) step: render EVERY active child row of `step.collection` joined to the spine, each
  // editable, with per-row remove (soft: set actief=false) and an add button (insert a fresh child). The
  // engine rolls the rows up (sum/count) live; the store's `insert` adds rows, setField soft-removes.
  const renderRepeat = (mountEl: HTMLElement, step: NonNullable<typeof steps>[number], spineRow: Row, nowVisible: Set<string>): void => {
    const coll = step.collection!;
    const cs = workspace.collection(coll);
    const cd = model.collections.find((c) => c.id === coll);
    if (!cs || !cd) return;
    const jf = childFieldOf(coll);
    const rows = cs.rows.value.filter((r) => r.doc[jf]?.t === 'ref' && (r.doc[jf] as { id: string }).id === spineRow.id && isActiveRow(r));
    const section = el('section', 'jc-section jc-repeat');
    section.dataset.section = step.id;
    nowVisible.add(step.id);
    section.setAttribute('aria-label', step.label ?? step.id);
    section.append(el('h3', 'jc-section-title', step.label ?? step.id));
    if (step.hint) section.append(el('p', 'jc-repeat-hint', step.hint));
    rows.forEach((row, i) => {
      const plan = resolvePlan({ collection: cd, types: model.types, vocab, overrides, viewer, audience: { l10n, docs }, row });
      const byField = byFieldOf(plan.fields);
      const item = el('div', 'jc-repeat-item');
      const head = el('div', 'jc-repeat-head');
      head.append(el('span', 'jc-repeat-item-title', `${step.itemLabel ?? 'Item'} ${i + 1}`));
      // always render Remove so the affordance is discoverable, but disable it on the last row —
      // removing the last would empty the sum rollup (a money total collapsing to num(0), the #TYPE trap)
      const rm = el('button', 'jc-repeat-remove', 'Verwijderen') as HTMLButtonElement;
      rm.type = 'button';
      rm.disabled = rows.length <= 1;
      if (rm.disabled) rm.title = `Minimaal één ${(step.itemLabel ?? 'item').toLowerCase()}`;
      rm.addEventListener('click', () => { if (rows.length > 1) cs.setField(row.id, 'actief', { t: 'bool', v: false }); });
      head.append(rm);
      item.append(head);
      const grid = el('div', 'journey-fields');
      for (const field of (step.fields ?? []).filter((f) => f !== totalField)) { const c = fieldCell(cs, row, byField, field, false); if (c) grid.append(c); }
      item.append(grid);
      section.append(item);
    });
    if (cs.insert) {
      const add = el('button', 'jc-repeat-add', step.addLabel ?? '+ Toevoegen') as HTMLButtonElement;
      add.type = 'button';
      add.addEventListener('click', () => {
        const id = `${coll}-${cs.rows.value.length + 1}`; // rows are never deleted (soft-remove), so length is monotonic → unique
        cs.insert!(id, { [jf]: { t: 'ref', collection: store.id, id: spineRow.id } as Value, ...(step.newRow ?? {}) });
      });
      section.append(add);
    }
    mountEl.append(section);
  };

  // one field cell (used by both layouts, for the spine OR a child store). Returns null for a hidden field
  // or the headline total (which lives in the rail/drawer, not the body).
  const fieldCell = (fstore: CollectionStore, row: Row, byField: ByField, field: string, isLedger: boolean): HTMLElement | null => {
    const fp = byField.get(field);
    if (!fp || fp.hidden || field === totalField) return null;
    const prop = fstore.propOf(field);
    const options = prop && prop.valueType.k === 'enum' ? enums[prop.valueType.set] : undefined;
    const willEdit = !!prop && fp.editable && isEditableKind(prop.valueType.k);
    const isBool = !!prop && prop.valueType.k === 'bool';
    const inputId = `f-${fstore.id}-${row.id}-${field}`;
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
      if (!isLedger) { const h = helpNode(); if (h) cell.append(h); }
    } else if (isBool) {
      cell.classList.add('jf-bool');
      const box = el('span', 'jf-check');
      mountCell(box, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => fstore.setField(row.id, field, v), id: inputId, describedBy: fp.doc ? helpId : undefined });
      const lab = el('label', 'jf-boollabel') as HTMLLabelElement;
      lab.htmlFor = inputId;
      lab.textContent = fp.label;
      cell.append(box, lab);
      const h = helpNode(); if (h) cell.append(h);
    } else {
      const lab = el('label', 'jf-label') as HTMLLabelElement;
      lab.htmlFor = inputId;
      lab.textContent = fp.label;
      const host = el('div', 'jf-input');
      const pkey = `${fstore.id}:${row.id}::${field}`;
      mountCell(host, {
        value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false,
        onEdit: (v) => fstore.setField(row.id, field, v), id: inputId, describedBy: fp.doc ? helpId : undefined,
        pending: pending.get(pkey),
        onValidity: (st) => (st ? pending.set(pkey, st) : pending.delete(pkey)),
        suggestions: suggestions?.value?.[field],
      });
      cell.append(lab, host);
      const h = helpNode(); if (h) cell.append(h);
    }
    return cell;
  };

  // the inline rail (only when the journey declares a summary; else the premium lives in the drawer)
  const renderRail = (spine: Row): HTMLElement => {
    const rail = el('aside', 'jc-rail');
    rail.setAttribute('aria-label', labelOf(totalField));
    const quote = el('div', 'quote');
    quote.append(el('div', 'quote-eyebrow', labelOf(totalField)));
    const total = spine.doc[totalField];
    if (isMoney(total)) {
      const hero = el('div', 'quote-hero');
      hero.append(el('span', 'quote-amount', format(total)));
      if (summary?.per) hero.append(el('span', 'quote-per', summary.per));
      quote.append(hero);
      const lines = el('dl', 'quote-lines');
      for (const ld of summary?.lines ?? []) {
        const v = spine.doc[ld.field];
        if (!isMoney(v)) continue;
        const r = el('div', 'quote-line');
        r.append(el('dt', undefined, ld.label ?? labelOf(ld.field)), el('dd', undefined, format(v)));
        lines.append(r);
      }
      if (lines.children.length) quote.append(lines);
    } else {
      quote.append(el('p', 'quote-empty', 'Vul de onderdelen in — het totaal stelt zich samen uit de configuratoren.'));
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

  // a journey is a stepped WIZARD only when it has a step field driving >1 step; otherwise (a calculator,
  // or a composed journey with no step machine) it is a single page — no stepper, no stepped/single toggle.
  const hasStepper = !!stepField && steps.length > 1;

  return effect(() => {
    const rows = store.rows.value;
    const mode = hasStepper ? layout.value : 'single';
    const ae = document.activeElement as HTMLInputElement | null;
    const keepId = ae && ae.id && wrap.contains(ae) ? ae.id : null;
    const keepVal = keepId ? ae!.value : null;
    const keepStart = keepId ? ae!.selectionStart : null;
    const keepEnd = keepId ? ae!.selectionEnd : null;
    wrap.replaceChildren();
    const announceParts: string[] = [];
    const nowVisible = new Set<string>();
    let modeAnnounced = false;
    if (hasStepper) wrap.append(buildToggle(mode));
    if (focusToggle) {
      focusToggle = false;
      modeAnnounced = true;
      wrap.querySelector<HTMLElement>('.jt-opt[data-active="true"]')?.focus();
      live.textContent = mode === 'single' ? 'Weergave: alles op één pagina.' : 'Weergave: stapsgewijs.';
    }
    if (!rows.length) {
      wrap.append(el('div', 'empty', 'Geen aanvragen.'));
      return;
    }

    for (const spineRow of rows) {
      const spinePlan = spineDoc ? resolvePlan({ collection: spineDoc, types: model.types, vocab, overrides, viewer, audience: { l10n, docs }, row: spineRow }) : undefined;
      const spineByField = byFieldOf(spinePlan?.fields ?? []);
      const stepVal = stepField && spineRow.doc[stepField]?.t === 'enum' ? (spineRow.doc[stepField] as { v: string }).v : steps[0]?.id;

      const card = el('article', summary ? 'journey-card composed-card' : 'journey-card');
      if (spinePlan) {
        card.dataset.renderFamily = spinePlan.family;
        if (spinePlan.variant) card.dataset.variant = spinePlan.variant;
      }
      const main = el('div', 'jc-main');
      card.append(main);

      if (mode === 'stepped') {
        card.setAttribute('aria-label', `Aanvraag — stap ${labelOfStep(stepVal ?? '')}`);
        const idx = Math.max(0, steps.findIndex((s) => s.id === stepVal));
        const step = steps[idx];
        const ctx = step ? resolveStep(step, spineRow, spineByField) : null;
        const rawFields = step?.fields ?? [];
        const nonTotal = rawFields.filter((f) => f !== totalField);
        const isLedger = !!ctx && nonTotal.length > 0 && nonTotal.every((f) => !ctx.byField.get(f)?.editable);
        const stepFields = isLedger ? rawFields : nonTotal.length ? nonTotal : rawFields;

        if (stepField) {
          const nav = el('nav');
          nav.setAttribute('aria-label', 'Voortgang');
          const ol = el('ol', 'stepper');
          steps.forEach((s, i) => {
            const li = el('li', 'step');
            li.dataset.state = i < idx ? 'positive' : i === idx ? (spineByField.get(stepField)?.state ?? 'info') : 'muted';
            if (i === idx) { li.dataset.current = 'true'; li.setAttribute('aria-current', 'step'); }
            li.append(document.createTextNode(s.label ?? s.id));
            li.append(hidden(i < idx ? ' (voltooid)' : i === idx ? ' (huidige stap)' : ' (nog te doen)'));
            ol.append(li);
          });
          nav.append(ol);
          main.append(nav);
        }
        const head = el('div', 'jc-step-head');
        if (stepVal) { head.dataset.section = stepVal; nowVisible.add(stepVal); }
        head.append(el('span', 'jc-step-eyebrow', `Stap ${idx + 1} van ${steps.length}`));
        head.append(el('h2', 'jc-step-title', labelOfStep(stepVal ?? '')));
        main.append(head);

        const grid = el('div', 'journey-fields');
        if (isLedger) grid.classList.add('is-ledger');
        if (ctx) for (const field of stepFields) { const c = fieldCell(ctx.fstore, ctx.row, ctx.byField, field, isLedger); if (c) grid.append(c); }
        main.append(grid);
        // a terminal step (no collection, no fields) — the aanvraag is complete
        if (step && !step.collection && (step.fields ?? []).length === 0) {
          const done = el('div', 'jc-complete');
          done.append(el('span', 'jc-complete-mark', '✓'), el('span', 'jc-complete-text', 'Uw aanvraag is compleet — controleer het overzicht.'));
          main.append(done);
        }

        const navBar = el('div', 'journey-nav');
        navBar.setAttribute('role', 'group');
        navBar.setAttribute('aria-label', 'Stapnavigatie');
        if (idx > 0) {
          const back = el('button', 'j-btn j-back', `← ${labelOfStep(steps[idx - 1].id)}`) as HTMLButtonElement;
          back.type = 'button';
          back.addEventListener('click', () => go(spineRow.id, steps[idx - 1].id));
          navBar.append(back);
        }
        for (const act of spineRow.actions ?? []) {
          if (act.field !== stepField) continue;
          const btn = el('button', 'j-btn j-next', `${labelOfStep(act.to)} →`) as HTMLButtonElement;
          btn.type = 'button';
          btn.dataset.state = act.enabled ? 'ready' : 'blocked';
          btn.disabled = !act.enabled;
          btn.setAttribute('aria-disabled', String(!act.enabled));
          if (!act.enabled) btn.title = 'Rond deze stap eerst af';
          btn.addEventListener('click', () => act.enabled && go(spineRow.id, act.to));
          navBar.append(btn);
        }
        main.append(navBar);
      } else {
        card.setAttribute('aria-label', 'Aanvraag — alles op één pagina');
        main.append(el('h2', 'jc-page-title', view.title ?? 'Uw aanvraag'));
        for (const step of steps) {
          if (step.repeat && step.collection) { renderRepeat(main, step, spineRow, nowVisible); continue; } // to-many section
          const ctx = resolveStep(step, spineRow, spineByField);
          if (!ctx) continue;
          const inputs = (step.fields ?? []).filter((f) => f !== totalField);
          if (!inputs.some((f) => ctx.byField.get(f)?.editable)) continue; // skip info-only (ledger/terminal) sections
          if (!sectionUnlocked(spineRow, step.gate)) continue; // progressive reveal
          const section = el('section', 'jc-section');
          section.dataset.section = step.id;
          nowVisible.add(step.id);
          section.setAttribute('aria-label', step.label ?? step.id);
          section.append(el('h3', 'jc-section-title', step.label ?? step.id));
          const grid = el('div', 'journey-fields');
          for (const field of inputs) { const c = fieldCell(ctx.fstore, ctx.row, ctx.byField, field, false); if (c) grid.append(c); }
          section.append(grid);
          main.append(section);
        }
        // the terminal (done / submit) belongs only to a real WIZARD — a journey with a step machine
        // driving >1 step. A step-field-less journey (a compiled L2 pakket, or a single-step calculator)
        // is a live form: no submit, no false "afgerond" — the rail already shows the result.
        if (hasStepper) {
          const lastStepId = steps[steps.length - 1]?.id;
          if (stepVal === lastStepId) {
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
            const ok = readyToSubmit(spineRow);
            submit.dataset.state = ok ? 'ready' : 'blocked';
            submit.disabled = !ok;
            submit.setAttribute('aria-disabled', String(!ok));
            if (!ok) submit.title = confirmField ? 'Vul alle stappen in en accepteer de voorwaarden' : 'Bevestig elke sectie';
            submit.addEventListener('click', () => ok && walkToEnd(spineRow.id, stepVal ?? steps[0]?.id ?? ''));
            navBar.append(submit);
            main.append(navBar);
          }
        }
      }

      if (summary) card.append(renderRail(spineRow)); // inline rail; without a summary the drawer carries the premium
      const tv = spineRow.doc[totalField];
      if (isMoney(tv)) announceParts.push(`${labelOf(totalField)}: ${format(tv)}`);
      wrap.append(card);
    }

    const announce = announceParts.join('; ');
    if (!modeAnnounced && lastAnnounce !== null && announce !== lastAnnounce) live.textContent = announce;
    lastAnnounce = announce;

    if (keepId && !modeAnnounced) {
      const back = wrap.querySelector<HTMLInputElement>('#' + CSS.escape(keepId));
      if (back) {
        if (keepVal != null && back.value !== keepVal) back.value = keepVal;
        back.focus({ preventScroll: true });
        try { if (keepStart != null) back.setSelectionRange(keepStart, keepEnd ?? keepStart); } catch { /* number inputs */ }
      }
    }
    if (!firstRender && !modeAnnounced) {
      const appeared = [...nowVisible].find((id) => !prevVisible.has(id));
      if (appeared) {
        const target = wrap.querySelector<HTMLElement>(`[data-section="${appeared}"]`);
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        target?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        if (mode === 'single') live.textContent = `${labelOfStep(appeared)} — nu beschikbaar.`;
      }
    }
    prevVisible = nowVisible;
    firstRender = false;
  });
};
