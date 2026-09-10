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
 * Mount the request drawer: a subtle floating trigger + a slide-over that renders the live request,
 * expanding to full screen at the terminal step. Accessible (dialog, Escape, focus restore).
 */
export function initRequestDrawer(app: HTMLElement, store: CollectionStore, o: RequestOpts, isDone: (doc: Record<string, Value>) => boolean): void {
  const trigger = el('button', 'req-trigger') as HTMLButtonElement;
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'req-drawer');
  trigger.innerHTML = '<span class="req-trigger-ic" aria-hidden="true">▤</span><span class="req-trigger-tx">Aanvraag</span>';

  const backdrop = el('div', 'req-backdrop');
  backdrop.hidden = true;
  const drawer = el('aside', 'req-drawer') as HTMLElement;
  drawer.id = 'req-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Uw aanvraag');
  drawer.hidden = true;
  const head = el('div', 'req-head');
  head.append(el('h2', 'req-drawer-title', o.title));
  const close = el('button', 'req-close') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute('aria-label', 'Sluiten');
  close.textContent = '✕';
  head.append(close);
  const body = el('div', 'req-body');
  drawer.append(head, body);
  app.append(trigger, backdrop, drawer);

  let open = false;
  let autoOpened = false;
  let lastFocus: HTMLElement | null = null;

  const setOpen = (v: boolean): void => {
    open = v;
    drawer.hidden = !v;
    backdrop.hidden = !v;
    trigger.setAttribute('aria-expanded', String(v));
    if (v) {
      lastFocus = document.activeElement as HTMLElement;
      close.focus();
    } else {
      lastFocus?.focus?.();
    }
  };
  trigger.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));
  drawer.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !drawer.classList.contains('req-drawer--full')) setOpen(false);
  });

  // live: re-render the request whenever the core recomputes; auto-open full at the terminal step.
  effect(() => {
    const row = store.rows.value[0];
    const doc = row?.doc ?? {};
    body.replaceChildren(buildRequest(doc, o));
    const done = isDone(doc);
    drawer.classList.toggle('req-drawer--full', done);
    backdrop.classList.toggle('req-backdrop--full', done);
    trigger.hidden = done && open; // once full-screen, the trigger is redundant
    if (done && !autoOpened) {
      autoOpened = true;
      setOpen(true); // the whole-screen request at the end
    }
    if (!done) autoOpened = false; // allow re-auto-open if they go back then finish again
  });
}
