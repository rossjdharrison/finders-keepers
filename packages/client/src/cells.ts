// The cell registry: render one value into a host element, editable for the
// stored scalar kinds (text/number/money/enum), read-only for computed columns
// and kinds without a v0 editor. Input<->Value conversion lives here (money:
// decimal input <-> minor units via moneyDec; enum: option id).

import type { Value } from '@core/values';
import { moneyDec, enumV } from '@core/values';
import { format } from './format.ts';
import type { EnumOption, Property } from './types.ts';

export interface CellArgs {
  value: Value | undefined;
  prop: Property;
  options?: EnumOption[];
  readOnly: boolean;
  onEdit: (v: Value) => void;
}

const EDITABLE = new Set(['text', 'num', 'money', 'enum']);

export function mountCell(host: HTMLElement, a: CellArgs): void {
  host.replaceChildren();
  const v = a.value;
  const k = a.prop.valueType.k;

  if (a.readOnly || !EDITABLE.has(k)) {
    const span = document.createElement('span');
    span.textContent = format(v, a.options);
    span.className = a.readOnly ? 'cell computed' : v?.t === 'error' ? 'cell error' : 'cell';
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
    host.append(sel);
    return;
  }

  const input = document.createElement('input');
  input.className = 'cell-input';
  if (k === 'num') {
    input.type = 'number';
    input.value = v?.t === 'num' ? String(v.v) : '';
    input.addEventListener('change', () => a.onEdit({ t: 'num', v: Number(input.value) }));
  } else if (k === 'money') {
    const ccy = a.prop.valueType.k === 'money' ? a.prop.valueType.ccy ?? 'EUR' : v?.t === 'money' ? v.ccy : 'EUR';
    const scale = v?.t === 'money' ? v.scale : 2;
    input.type = 'number';
    input.step = '0.01';
    input.value = v?.t === 'money' ? (Number(v.minor) / 10 ** v.scale).toFixed(v.scale) : '';
    input.addEventListener('change', () => a.onEdit(moneyDec(Number(input.value), ccy, scale)));
  } else {
    input.type = 'text';
    input.value = v?.t === 'text' ? v.v : '';
    input.addEventListener('change', () => a.onEdit({ t: 'text', v: input.value }));
  }
  host.append(input);
}
