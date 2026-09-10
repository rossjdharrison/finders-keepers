// The inline-editable formula renderer — the admin's "change the rules" surface for the constants
// that live INSIDE formulas (band thresholds like `age < 23`, fee amounts like `if(optLegalAid, €3, €0)`).
//
// It mirrors describeFormula's descent (docs.ts) but returns DOM instead of a string: at a SAFE literal
// (a num or money `lit`) it emits a bound <input> sitting exactly where the number reads in the formula,
// so you edit `if(age < [23], young, if(age < [65], …))` in place — the formula IS the label (the
// self-documenting-model idiom). Every other node — fields, enum band-names, the `blank` gate sentinels,
// bool comparators, lookups — renders as read-only text via describeFormula, so unsafe literals can never
// be edited (an enum edit would silently break a downstream lookup). Editing only a lit's number keeps
// its TYPE fixed, so buildPrepared can't start throwing; previewCassette is the backstop regardless.

import { CMP, describeFormula } from './docs.ts';
import type { FormulaPath } from '../model-edit.ts';

interface FxNode { op?: string; fn?: string; args?: unknown[]; value?: { t?: string; v?: number; minor?: number | string } }

export interface EditableFormulaOpts {
  /** called when an input commits a valid new value; wire to setFormulaLiteral + refreshPreview */
  onEdit: (path: FormulaPath, raw: number) => void;
  /** the computed field's label — the a11y fallback when a literal has no comparison context */
  subject: string;
}

const txt = (s: string): Text => document.createTextNode(s);

/** Build a <code> element rendering the formula with inline number inputs at editable literals.
 * Returns the element and the count of editable inputs it produced (0 → a purely derived formula). */
export function buildEditableFormula(formula: unknown, opts: EditableFormulaOpts): { el: HTMLElement; count: number } {
  const root = document.createElement('code');
  root.className = 'fx';
  let count = 0;

  const litInput = (t: 'num' | 'money', raw: number, path: FormulaPath, hint: string): HTMLElement => {
    const wrap = document.createElement('span');
    wrap.className = 'fx-lit';
    if (t === 'money') {
      const cur = document.createElement('span');
      cur.className = 'fx-cur';
      cur.textContent = '€';
      wrap.append(cur);
    }
    const input = document.createElement('input');
    input.className = 'fx-input';
    input.type = 'number';
    input.min = '0';
    input.step = t === 'money' ? '0.01' : '1';
    input.inputMode = t === 'money' ? 'decimal' : 'numeric';
    const display = (r: number): string => (t === 'money' ? (r / 100).toFixed(2) : String(r)); // r is num value or money minor
    let committed = raw; // last VALID raw this input holds — a rejected entry reverts HERE, not to the stale original
    input.value = display(committed);
    // hint identifies THIS literal among the formula's inputs (e.g. "grens voor young", "bedrag als optLegalAid"),
    // so two thresholds/amounts in one formula never share an accessible name; unit is appended for money.
    input.setAttribute('aria-label', `${opts.subject} — ${hint}${t === 'money' ? ' (euro)' : ''}`.trim());
    // content-box width sized to the (monospace) glyph count, +1ch slack for the caret / localized comma
    const sizeToContent = (): void => { input.style.width = `${Math.max(2, input.value.length) + 1}ch`; };
    sizeToContent();
    input.addEventListener('input', sizeToContent);
    input.addEventListener('change', () => {
      // valueAsNumber (NOT Number(value)) — it is NaN for an empty or invalid number field, whereas
      // Number("") is 0, which would silently commit a cleared/garbage input as zero.
      const num = input.valueAsNumber;
      if (!Number.isFinite(num) || num < 0) { input.value = display(committed); sizeToContent(); return; } // reject; revert to last good
      committed = t === 'money' ? Math.round(num * 100) : Math.round(num);
      input.value = display(committed); // normalize what's shown (e.g. "9" → "9.00") so a later reject reverts cleanly
      sizeToContent();
      opts.onEdit(path, committed);
    });
    wrap.append(input);
    return wrap;
  };

  const walk = (node: unknown, path: FormulaPath, hint: string, parent: HTMLElement): void => {
    const n = node as FxNode;
    if (!n || typeof n !== 'object') { parent.append(txt(String(node))); return; }

    // an editable literal → an input in place of the number
    if (n.op === 'lit' && (n.value?.t === 'num' || n.value?.t === 'money')) {
      const t = n.value.t;
      const raw = Number((t === 'money' ? n.value.minor : n.value.v) ?? 0);
      parent.append(litInput(t, raw, path, hint));
      count += 1;
      return;
    }

    // a structural node (call / comparison / arithmetic) → render operators, recurse into args
    if (Array.isArray(n.args)) {
      if (n.op === 'call') {
        const args = n.args;
        const isIf = n.fn === 'if' && args.length === 3;
        parent.append(txt(`${n.fn ?? 'call'}(`));
        args.forEach((a, i) => {
          if (i) parent.append(txt(', '));
          // for if(cond, then, else) give each arg a hint that UNIQUELY names its literal's role:
          //   cond → the band it selects (the then-result); then → "bedrag als <cond>"; else → "bedrag anders".
          // (a nested-if else recomputes its own hints, so deeper thresholds stay distinct too.)
          const h = isIf
            ? (i === 0 ? `grens voor ${describeFormula(args[1])}` : i === 1 ? `bedrag als ${describeFormula(args[0])}` : 'bedrag anders')
            : hint;
          walk(a, [...path, 'args', i], h, parent);
        });
        parent.append(txt(')'));
        return;
      }
      if (n.op && CMP[n.op] && n.args.length === 2) {
        // "age < [23]" — the threshold input keeps the hint the enclosing if handed down (the band it selects)
        walk(n.args[0], [...path, 'args', 0], hint, parent);
        parent.append(txt(` ${CMP[n.op]} `));
        walk(n.args[1], [...path, 'args', 1], hint, parent);
        return;
      }
      parent.append(txt(`${n.op}(`));
      n.args.forEach((a, i) => { if (i) parent.append(txt(', ')); walk(a, [...path, 'args', i], hint, parent); });
      parent.append(txt(')'));
      return;
    }

    // an opaque leaf (field, enum/blank/bool lit, lookup, rollup, ref, signal…) → read-only text
    parent.append(txt(describeFormula(n)));
  };

  walk(formula, [], opts.subject, root);
  return { el: root, count };
}
