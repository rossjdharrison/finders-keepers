// The COMPOSED journey renderer — the multi-configurator journey, now with the SAME control model as
// the flat journey (a stepped wizard OR a single progressive page, chosen by a persisted toggle). The
// step machine (the `step` enum + its guarded transitions + the ready gates) lives on the SPINE
// (applications) and is composed across collections by relations + rollup in the sealed core; each
// section's fields edit a CHILD row (vehicles/drivers/covers) joined to the spine via the relation's
// childField. It is presentation only: it reads the neutral RenderPlan + the engine's per-row `actions`
// (never evaluating a guard itself), and it drives entirely off the cassette's journey block.

import { effect, signal } from '@preact/signals-core';
import type { Value } from '@core/values';
import type { CollectionDoc, EnumOption, RowStateWire, WorkspaceStore } from '../types.ts';
import { resolvePlan, overridesFrom, type RenderVocabulary, type PresentationOverride } from '../resolve.ts';
import { mountCell, isEditableKind } from '../cells.ts';
import { format } from '../format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const hidden = (text: string): HTMLElement => { const s = el('span', 'visually-hidden'); s.textContent = text; return s; };
const isMoney = (v: Value | undefined): v is Value & { t: 'money' } => !!v && v.t === 'money';
const boolOf = (v: Value | undefined): boolean => !!v && v.t === 'bool' && v.v;

export interface ComposedStep {
  id: string;
  label: string;
  collection?: string; // the configurator collection this step edits (absent = a spine/terminal step)
  childField?: string; // how that collection's row refs the spine (the relation's childField)
  gate?: string; // a computed-bool field on the SPINE that unlocks this section (progressive disclosure)
  fields: string[];
}
export interface ComposedSummary {
  total: string; // the spine's headline money field (the rolled-up premium)
  per?: string; // a per-period suffix (e.g. "per maand")
  lines?: { field: string; label?: string }[]; // the breakdown (spine fields, e.g. rollup subtotals)
}
export interface ComposedConfig {
  workspace: WorkspaceStore;
  appColl: string; // the spine collection (the relations' parent)
  stepField?: string; // the enum field on the spine that tracks journey position
  steps: ComposedStep[]; // the full ordered journey (sections + any terminal step)
  summary?: ComposedSummary;
  collections: CollectionDoc[];
  types: Record<string, { specializes: string[] }>;
  vocab: RenderVocabulary;
  overrides: PresentationOverride[];
  labels: Record<string, string>;
  enums: Record<string, EnumOption[]>;
  title: string;
}

type Row = RowStateWire;
type Layout = 'stepped' | 'single';
const LAYOUT_KEY = 'fk-journey-layout'; // shared with the flat journey so the preference carries

export function mountComposedJourney(mount: HTMLElement, cfg: ComposedConfig): () => void {
  const appStore = cfg.workspace.collection(cfg.appColl)!;
  const overrides = overridesFrom(cfg.overrides);
  const l10n = new Map(Object.entries(cfg.labels));
  const collById = new Map(cfg.collections.map((c) => [c.id, c]));
  const labelOf = (f: string): string => cfg.labels[f] ?? f;
  const steps = cfg.steps;
  const stepField = cfg.stepField;
  const sectionSteps = steps.filter((s) => s.collection); // the configurator sections
  const stepProp = collById.get(cfg.appColl)?.properties.find((p) => p.id === stepField);
  const stepSet = stepProp && stepProp.valueType.k === 'enum' ? stepProp.valueType.set : 'step';
  const labelOfStep = (id: string): string => steps.find((s) => s.id === id)?.label ?? id;

  const go = (to: string): void => {
    const app = appStore.rows.value[0];
    if (app && stepField) appStore.setField(app.id, stepField, { t: 'enum', set: stepSet, v: to });
  };
  const walkToEnd = (fromStep: string): void => {
    // each step move is a guarded transition; if the engine rejects one (a gate not yet satisfied),
    // stop the walk rather than throw — the submit is only enabled once every gate holds anyway.
    const order = steps.map((s) => s.id);
    for (let i = order.indexOf(fromStep) + 1; i < order.length; i++) {
      try {
        go(order[i]);
      } catch {
        break;
      }
    }
  };
  const sectionUnlocked = (app: Row, gate?: string): boolean => !gate || boolOf(app.doc[gate]);
  const readyToSubmit = (app: Row): boolean => steps.every((s) => !s.gate || boolOf(app.doc[s.gate]));

  const loadLayout = (): Layout => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'single' ? 'single' : 'stepped'; } catch { return 'stepped'; }
  };
  const layout = signal<Layout>(loadLayout());
  let focusToggle = false;
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
  let prevVisible = new Set<string>();
  let firstRender = true;

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

  // one configurator section: its fields edit the CHILD row joined to the spine via childField
  const renderSection = (step: ComposedStep, app: Row): HTMLElement | null => {
    const childStore = cfg.workspace.collection(step.collection!);
    const collDoc = collById.get(step.collection!);
    if (!childStore || !collDoc) return null;
    const jf = step.childField ?? 'app';
    const row = childStore.rows.value.find((r) => r.doc[jf]?.t === 'ref' && (r.doc[jf] as { id: string }).id === app.id);
    if (!row) return null;
    const plan = resolvePlan({ collection: collDoc, types: cfg.types, vocab: cfg.vocab, overrides, audience: { l10n }, row });
    const byField = new Map(plan.fields.map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));

    const sec = el('section', 'jc-section');
    sec.dataset.section = step.id;
    sec.setAttribute('aria-label', step.label);
    sec.append(el('h3', 'jc-section-title', step.label));
    const grid = el('div', 'journey-fields');
    for (const field of step.fields) {
      const fp = byField.get(field);
      if (!fp || fp.hidden) continue;
      const prop = childStore.propOf(field);
      const options = prop && prop.valueType.k === 'enum' ? cfg.enums[prop.valueType.set] : undefined;
      const inputId = `c-${step.collection}-${row.id}-${field}`;
      const isBool = !!prop && prop.valueType.k === 'bool';
      const willEdit = !!prop && fp.editable && isEditableKind(prop.valueType.k);

      const cell = el('div', 'jf');
      cell.dataset.role = fp.role;
      cell.dataset.provenance = prop?.source === 'computed' ? 'derived' : 'authored';
      if (!willEdit) {
        cell.classList.add('jf-readout');
        cell.append(el('span', 'jf-rolabel', fp.label), el('span', 'jf-rovalue', format(row.doc[field], options) || '—'));
      } else if (isBool) {
        cell.classList.add('jf-bool');
        const box = el('span', 'jf-check');
        mountCell(box, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => childStore.setField(row.id, field, v), id: inputId });
        const lab = el('label', 'jf-boollabel') as HTMLLabelElement;
        lab.htmlFor = inputId;
        lab.textContent = fp.label;
        cell.append(box, lab);
      } else {
        const lab = el('label', 'jf-label') as HTMLLabelElement;
        lab.htmlFor = inputId;
        lab.textContent = fp.label;
        const host = el('div', 'jf-input');
        mountCell(host, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => childStore.setField(row.id, field, v), id: inputId });
        cell.append(lab, host);
      }
      grid.append(cell);
    }
    sec.append(grid);
    return sec;
  };

  const renderRail = (app: Row): HTMLElement => {
    const totalField = cfg.summary?.total ?? 'premium';
    const rail = el('aside', 'jc-rail');
    rail.setAttribute('aria-label', labelOf(totalField));
    const quote = el('div', 'quote');
    quote.append(el('div', 'quote-eyebrow', labelOf(totalField)));
    const total = app.doc[totalField];
    if (isMoney(total)) {
      const hero = el('div', 'quote-hero');
      hero.append(el('span', 'quote-amount', format(total)));
      if (cfg.summary?.per) hero.append(el('span', 'quote-per', cfg.summary.per));
      quote.append(hero);
      const lines = el('dl', 'quote-lines');
      for (const ld of cfg.summary?.lines ?? []) {
        const v = app.doc[ld.field];
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

  return effect(() => {
    const app = appStore.rows.value[0];
    // preserve focus/caret across the reactive rebuild (an async plate/postcode arrival must not yank it)
    const ae = document.activeElement as HTMLInputElement | null;
    const keepId = ae && ae.id && wrap.contains(ae) ? ae.id : null;
    const keepVal = keepId ? ae!.value : null;
    const keepStart = keepId ? ae!.selectionStart : null;
    const keepEnd = keepId ? ae!.selectionEnd : null;

    wrap.replaceChildren();
    const nowVisible = new Set<string>();
    let modeAnnounced = false;
    const mode = layout.value;
    if (steps.length > 1) wrap.append(buildToggle(mode));
    if (focusToggle) {
      focusToggle = false;
      modeAnnounced = true;
      wrap.querySelector<HTMLElement>('.jt-opt[data-active="true"]')?.focus();
      live.textContent = mode === 'single' ? 'Weergave: alles op één pagina.' : 'Weergave: stapsgewijs.';
    }
    if (!app) {
      wrap.append(el('div', 'empty', 'Geen aanvraag.'));
      return;
    }
    const stepVal = stepField && app.doc[stepField]?.t === 'enum' ? (app.doc[stepField] as { v: string }).v : sectionSteps[0]?.id;

    const card = el('article', 'journey-card composed-card');
    const main = el('div', 'jc-main');
    card.append(main);

    if (mode === 'stepped' && stepField) {
      // stepper over ALL steps (sections + terminal)
      const idx = Math.max(0, steps.findIndex((s) => s.id === stepVal));
      const nav = el('nav');
      nav.setAttribute('aria-label', 'Voortgang');
      const ol = el('ol', 'stepper');
      steps.forEach((s, i) => {
        const li = el('li', 'step');
        li.dataset.state = i < idx ? 'positive' : i === idx ? 'info' : 'muted';
        if (i === idx) { li.dataset.current = 'true'; li.setAttribute('aria-current', 'step'); }
        li.append(document.createTextNode(s.label));
        li.append(hidden(i < idx ? ' (voltooid)' : i === idx ? ' (huidige stap)' : ' (nog te doen)'));
        ol.append(li);
      });
      nav.append(ol);
      main.append(nav);

      const head = el('div', 'jc-step-head');
      head.dataset.section = stepVal ?? '';
      if (stepVal) nowVisible.add(stepVal);
      head.append(el('span', 'jc-step-eyebrow', `Stap ${idx + 1} van ${steps.length}`));
      head.append(el('h2', 'jc-step-title', labelOfStep(stepVal ?? '')));
      main.append(head);

      const cur = steps[idx];
      if (cur?.collection) {
        const sec = renderSection(cur, app);
        if (sec) main.append(sec);
      } else {
        // terminal step (no collection) — the application is composed; show a completion note
        const done = el('div', 'jc-complete');
        done.append(el('span', 'jc-complete-mark', '✓'), el('span', 'jc-complete-text', 'Uw aanvraag is compleet — controleer het overzicht.'));
        main.append(done);
      }

      // nav: back is free; forward is the engine's guarded transition (from the spine row's actions)
      const navBar = el('div', 'journey-nav');
      navBar.setAttribute('role', 'group');
      navBar.setAttribute('aria-label', 'Stapnavigatie');
      if (idx > 0) {
        const back = el('button', 'j-btn j-back', `← ${labelOfStep(steps[idx - 1].id)}`) as HTMLButtonElement;
        back.type = 'button';
        back.addEventListener('click', () => go(steps[idx - 1].id));
        navBar.append(back);
      }
      for (const act of app.actions ?? []) {
        if (act.field !== stepField) continue;
        const btn = el('button', 'j-btn j-next', `${labelOfStep(act.to)} →`) as HTMLButtonElement;
        btn.type = 'button';
        btn.dataset.state = act.enabled ? 'ready' : 'blocked';
        btn.disabled = !act.enabled;
        btn.setAttribute('aria-disabled', String(!act.enabled));
        if (!act.enabled) btn.title = 'Rond deze stap eerst af';
        btn.addEventListener('click', () => act.enabled && go(act.to));
        navBar.append(btn);
      }
      main.append(navBar);
    } else {
      // single page: every section stacked, progressively gated, one submit
      main.append(el('h2', 'jc-page-title', cfg.title));
      for (const step of sectionSteps) {
        if (!sectionUnlocked(app, step.gate)) continue;
        const sec = renderSection(step, app);
        if (!sec) continue;
        nowVisible.add(step.id);
        main.append(sec);
      }
      const lastId = steps[steps.length - 1]?.id;
      if (stepVal === lastId && readyToSubmit(app)) {
        const done = el('div', 'jc-complete');
        done.append(el('span', 'jc-complete-mark', '✓'), el('span', 'jc-complete-text', 'Uw aanvraag is afgerond.'));
        main.append(done);
      } else {
        const navBar = el('div', 'journey-nav');
        navBar.setAttribute('role', 'group');
        navBar.setAttribute('aria-label', 'Aanvraag afronden');
        const submit = el('button', 'j-btn j-next', 'Aanvraag afronden →') as HTMLButtonElement;
        submit.type = 'button';
        const ok = readyToSubmit(app);
        submit.dataset.state = ok ? 'ready' : 'blocked';
        submit.disabled = !ok;
        submit.setAttribute('aria-disabled', String(!ok));
        if (!ok) submit.title = 'Bevestig elke sectie';
        submit.addEventListener('click', () => ok && walkToEnd(stepVal ?? sectionSteps[0]?.id ?? ''));
        navBar.append(submit);
        main.append(navBar);
      }
    }

    card.append(renderRail(app));
    wrap.append(card);

    // announce the premium (screen readers), unless a layout switch already claimed the live region
    const p = app.doc[cfg.summary?.total ?? 'premium'];
    if (!modeAnnounced && isMoney(p)) live.textContent = `${labelOf(cfg.summary?.total ?? 'premium')}: ${format(p)}`;

    // restore focus/caret/uncommitted text
    if (keepId && !modeAnnounced) {
      const back = wrap.querySelector<HTMLInputElement>('#' + CSS.escape(keepId));
      if (back) {
        if (keepVal != null && back.value !== keepVal) back.value = keepVal;
        back.focus({ preventScroll: true });
        try { if (keepStart != null) back.setSelectionRange(keepStart, keepEnd ?? keepStart); } catch { /* number inputs */ }
      }
    }
    // center a section/step that just appeared (a reveal or a step change) — not on first paint or toggle
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
}
