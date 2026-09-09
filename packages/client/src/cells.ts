// The cell registry: render one value into a host element, editable for the
// stored scalar kinds (text/number/money/enum), read-only for computed columns
// and kinds without a v0 editor. Input<->Value conversion lives here (money:
// decimal input <-> minor units via moneyDec; enum: option id).

import type { Value } from '@core/values';
import { moneyDec, enumV, ref, BLANK } from '@core/values';
import { format } from './format.ts';
import { checkInput, canonicalize } from './validate.ts';
import type { EnumOption, Property } from './types.ts';

export interface CellArgs {
  value: Value | undefined;
  prop: Property;
  options?: EnumOption[]; // enum option labels
  refOptions?: EnumOption[]; // candidate parent rows for a ref field {id,label}
  readOnly: boolean;
  onEdit: (v: Value) => void;
  id?: string; // a11y: the form control's id, so a <label for> can associate with it
  describedBy?: string; // a11y: id(s) of help text describing this control (aria-describedby)
  pending?: { raw: string; msg: string }; // restore an uncommitted invalid edit across re-renders
  onValidity?: (state: { raw: string; msg: string } | null) => void; // report validity so the caller can persist it
  suggestions?: string[]; // datalist options for a text/number input (e.g. house numbers on a postcode)
}

const EDITABLE = new Set(['text', 'num', 'money', 'enum', 'bool']);

/** Whether a value kind renders an editable control (so a caller can pick <label> vs <div>). */
export const isEditableKind = (k: string): boolean => EDITABLE.has(k);

/** Tag a freshly-made control with the a11y hooks the caller supplied. */
function a11y(control: HTMLElement, a: CellArgs): void {
  if (a.id) control.id = a.id;
  if (a.describedBy) control.setAttribute('aria-describedby', a.describedBy);
}

export function mountCell(host: HTMLElement, a: CellArgs): void {
  host.replaceChildren();
  const v = a.value;
  const k = a.prop.valueType.k;

  // reference field -> a dropdown of parent rows (the relation editor)
  if (k === 'ref') {
    const target = a.prop.valueType.k === 'ref' ? a.prop.valueType.collection : '';
    const curId = v?.t === 'ref' ? v.id : '';
    const labelFor = (id: string): string => a.refOptions?.find((o) => o.id === id)?.label ?? id;
    if (a.readOnly) {
      const span = document.createElement('span');
      span.className = 'cell';
      span.textContent = curId ? labelFor(curId) : '';
      host.append(span);
      return;
    }
    const sel = document.createElement('select');
    sel.className = 'cell-input';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '—';
    sel.append(none);
    for (const o of a.refOptions ?? []) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      sel.append(opt);
    }
    sel.value = curId;
    sel.addEventListener('change', () => a.onEdit(sel.value ? ref(target, sel.value) : BLANK));
    a11y(sel, a);
    host.append(sel);
    return;
  }

  if (a.readOnly || !EDITABLE.has(k)) {
    const span = document.createElement('span');
    span.textContent = format(v, a.options);
    // the "derived" look is painted by the S hooks layer via td[data-provenance="derived"]
    // (a logic fact), NOT by a class here — so read-only-by-permission no longer looks computed
    span.className = v?.t === 'error' ? 'cell error' : 'cell';
    if (v?.t === 'error') span.setAttribute('aria-invalid', 'true');
    host.append(span);
    return;
  }

  if (k === 'enum') {
    const set = a.prop.valueType.k === 'enum' ? a.prop.valueType.set : v?.t === 'enum' ? v.set : '';
    const sel = document.createElement('select');
    sel.className = 'cell-input';
    for (const o of a.options ?? []) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      sel.append(opt);
    }
    if (v?.t === 'enum') sel.value = v.v;
    sel.addEventListener('change', () => a.onEdit(enumV(set, sel.value)));
    a11y(sel, a);
    host.append(sel);
    return;
  }

  if (k === 'bool') {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cell-check';
    box.checked = v?.t === 'bool' ? v.v : false;
    box.addEventListener('change', () => a.onEdit({ t: 'bool', v: box.checked }));
    a11y(box, a);
    host.append(box);
    return;
  }

  const input = document.createElement('input');
  input.className = 'cell-input';
  const constraint = a.prop.constraint;
  const ccy = a.prop.valueType.k === 'money' ? a.prop.valueType.ccy ?? 'EUR' : v?.t === 'money' ? v.ccy : 'EUR';
  const scale = v?.t === 'money' ? v.scale : 2;
  if (k === 'num') {
    input.type = 'number';
    input.value = v?.t === 'num' ? String(v.v) : '';
    if (constraint?.min !== undefined) input.min = String(constraint.min);
    if (constraint?.max !== undefined) input.max = String(constraint.max);
  } else if (k === 'money') {
    input.type = 'number';
    input.step = '0.01';
    input.value = v?.t === 'money' ? (Number(v.minor) / 10 ** v.scale).toFixed(v.scale) : '';
  } else {
    input.type = 'text';
    input.value = v?.t === 'text' ? v.v : '';
  }

  // validation derived from the type (+ constraint): show an inline error, never commit invalid.
  const err = document.createElement('p');
  err.className = 'cell-error';
  err.hidden = true;
  const errId = `${a.id ?? 'cell'}-err`;
  err.id = errId;
  const showError = (msg: string | null): void => {
    err.textContent = msg ?? '';
    err.hidden = !msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const ids = [a.describedBy, msg ? errId : undefined].filter(Boolean).join(' ');
    if (ids) input.setAttribute('aria-describedby', ids);
    else input.removeAttribute('aria-describedby');
  };
  input.addEventListener('change', () => {
    const raw = input.value;
    const msg = checkInput(raw, k, constraint);
    showError(msg);
    if (msg) {
      a.onValidity?.({ raw, msg }); // persist the invalid edit so it survives the next re-render
      return; // keep the invalid text visible for the user to fix, but don't commit it
    }
    a.onValidity?.(null); // cleared — the committed value below is the source of truth again
    if (raw.trim() === '') a.onEdit(BLANK);
    else if (k === 'num') a.onEdit({ t: 'num', v: Number(raw) });
    else if (k === 'money') a.onEdit(moneyDec(Number(raw), ccy, scale));
    else a.onEdit({ t: 'text', v: canonicalize(raw, 'text', constraint) });
  });
  a11y(input, a); // base id + describedBy; showError overrides describedBy when an error is present
  // a datalist of real options (e.g. the house/flat numbers on the entered postcode) — the user can
  // pick from the list or keep typing
  if (a.suggestions?.length) {
    const listId = `${a.id ?? 'cell'}-list`;
    const dl = document.createElement('datalist');
    dl.id = listId;
    for (const s of a.suggestions) {
      const o = document.createElement('option');
      o.value = s;
      dl.append(o);
    }
    input.setAttribute('list', listId);
    host.append(dl);
  }
  // restore an uncommitted invalid edit (the model still holds the last valid value; this keeps the
  // user's in-progress text + its error visible across the journey's full re-render)
  if (a.pending) {
    input.value = a.pending.raw;
    showError(a.pending.msg);
  }
  host.append(input, err);
}
