// The request preview — a live projection of THE MODEL STATE (the wasm core's computed row) into a
// human-readable aanvraag plus the raw request JSON. It is "the request": everything gathered so far.
// A subtle floating trigger opens it as a side drawer during the journey; at the terminal step it
// takes the whole screen. Content re-renders reactively as the core recomputes — so what you see is
// exactly what the sealed core holds, grouped by the journey's own sections.

import { effect } from '@preact/signals-core';
import type { Value } from '@core/values';
import type { CollectionStore } from './types.ts';
import { format } from './format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

interface Prop { id: string; valueType: { k: string; set?: string } }
interface Step { id: string; label?: string; fields?: string[] }
const isReal = (v: Value | undefined): boolean => !!v && v.t !== 'blank' && v.t !== 'error';

export interface RequestOpts {
  props: Prop[];
  steps: Step[];
  labels: Record<string, string>;
  enums: Record<string, { id: string; label: string }[]>;
  stepField?: string;
  title: string;
}

/** Project one record's doc into the request document (grouped by journey section + raw JSON). Pure. */
export function buildRequest(doc: Record<string, Value>, o: RequestOpts): HTMLElement {
  const propById = new Map(o.props.map((p) => [p.id, p]));
  const labelOf = (id: string): string => o.labels[id] ?? id;
  const fmt = (id: string): string => {
    const p = propById.get(id);
    const opts = p?.valueType.k === 'enum' ? o.enums[p.valueType.set ?? ''] : undefined;
    return format(doc[id], opts);
  };

  const wrap = el('div', 'req');
  let any = false;
  const shown = new Set<string>([o.stepField ?? '']); // don't list the raw step marker as a line
  const premiumReady = isReal(doc.premium);
  for (const step of o.steps) {
    // hide the premium breakdown (the section carrying `premium`, incl. its €0 add-on lines) until
    // there are enough details to actually quote — no premium content before the premium exists.
    if ((step.fields ?? []).includes('premium') && !premiumReady) continue;
    const fields = (step.fields ?? []).filter((f) => !shown.has(f) && isReal(doc[f]) && fmt(f));
    for (const f of fields) shown.add(f);
    if (!fields.length) continue;
    const sec = el('section', 'req-sec');
    sec.append(el('h3', 'req-sec-title', step.label ?? step.id));
    const dl = el('dl', 'req-list');
    for (const f of fields) {
      any = true;
      const row = el('div', 'req-row');
      row.append(el('dt', undefined, labelOf(f)), el('dd', undefined, fmt(f)));
      dl.append(row);
    }
    sec.append(dl);
    wrap.append(sec);
  }
  if (!any) wrap.append(el('p', 'req-empty', 'Nog geen gegevens ingevuld. Begin met uw kenteken.'));

  // the raw request payload — the actual JSON the sealed core holds (only the values that are set)
  const payload: Record<string, Value> = {};
  for (const [k, v] of Object.entries(doc)) if (isReal(v)) payload[k] = v;
  const details = el('details', 'req-json') as HTMLDetailsElement;
  details.append(el('summary', undefined, 'Ruwe aanvraag (JSON)'));
  const pre = el('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  details.append(pre);
  wrap.append(details);
  return wrap;
}

/**
 * Mount the ONE collapsible right-hand pane. Collapsed it is a compact premium card (the only thing
 * shown at first); clicking it expands to the full "uw aanvraag" request in its side position; it goes
 * full-screen at the terminal step, and can collapse back. Accessible (Escape, focus restore).
 */
export function initRequestDrawer(app: HTMLElement, store: CollectionStore, o: RequestOpts, isDone: (doc: Record<string, Value>) => boolean): void {
  const label = (f: string): string => o.labels[f] ?? f;
  const backdrop = el('div', 'qp-backdrop');
  backdrop.hidden = true;

  const pane = el('aside', 'qp');
  pane.setAttribute('aria-label', 'Premie en aanvraag');
  // collapsed: a compact premium card, click to expand (filled reactively below)
  const collapsed = el('button', 'qp-collapsed') as HTMLButtonElement;
  collapsed.type = 'button';
  collapsed.setAttribute('aria-expanded', 'false');
  // expanded / full: the full request
  const panel = el('div', 'qp-expanded');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Uw aanvraag');
  const head = el('div', 'qp-head');
  head.append(el('h2', 'qp-title', o.title));
  const collapseBtn = el('button', 'qp-collapse') as HTMLButtonElement;
  collapseBtn.type = 'button';
  collapseBtn.setAttribute('aria-label', 'Inklappen');
  collapseBtn.textContent = '›';
  head.append(collapseBtn);
  const body = el('div', 'qp-body');
  panel.append(head, body);
  pane.append(collapsed, panel);
  app.append(backdrop, pane);

  type State = 'collapsed' | 'expanded' | 'full';
  let state: State = 'collapsed';
  let autoFull = false;
  let lastFocus: HTMLElement | null = null;
  const setState = (s: State): void => {
    const opening = state === 'collapsed' && s !== 'collapsed';
    const closing = state !== 'collapsed' && s === 'collapsed';
    state = s;
    pane.dataset.state = s;
    backdrop.hidden = s === 'collapsed';
    collapsed.setAttribute('aria-expanded', String(s !== 'collapsed'));
    if (opening) {
      lastFocus = document.activeElement as HTMLElement;
      collapseBtn.focus();
    } else if (closing) {
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
      else collapsed.focus();
    }
  };
  setState('collapsed');
  collapsed.addEventListener('click', () => setState('expanded'));
  collapseBtn.addEventListener('click', () => setState(state === 'full' ? 'expanded' : 'collapsed')); // full → side → collapsed
  backdrop.addEventListener('click', () => { if (state !== 'full') setState('collapsed'); });
  pane.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape' && state === 'expanded') setState('collapsed'); });

  // live: re-render the premium card + the request whenever the core recomputes; full at the terminal step.
  effect(() => {
    const doc = store.rows.value[0]?.doc ?? {};
    collapsed.replaceChildren();
    collapsed.append(el('span', 'qp-eyebrow', label('premium')));
    const prem = doc.premium;
    if (prem && prem.t === 'money') collapsed.append(el('span', 'qp-amount', format(prem)), el('span', 'qp-per', 'per maand'));
    else collapsed.append(el('span', 'qp-empty', 'Verschijnt zodra u genoeg gegevens invult.'));
    collapsed.append(el('span', 'qp-open', 'Aanvraag bekijken ›'));
    body.replaceChildren(buildRequest(doc, o));
    const done = isDone(doc);
    if (done && !autoFull) { autoFull = true; setState('full'); }
    if (!done) autoFull = false;
  });
}
