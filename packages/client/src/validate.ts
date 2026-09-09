// Input validation DERIVED FROM the value type (+ an optional declared format/range). There is no
// regex op in the formula engine, so structural validation lives here, in the client, keyed off the
// field's own type: a num must be a number (and honour min/max), money must be ≥ 0, a text field with
// format 'kenteken' must be a valid Dutch plate, 'postcode' a valid NL postcode. Everything else is
// accepted. On invalid input the cell shows the message + aria-invalid and does not commit.

import { isValidKenteken, formatKenteken } from './kenteken.ts';

export interface FieldConstraint {
  min?: number;
  max?: number;
  format?: 'kenteken' | 'postcode';
}

const POSTCODE = /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/;

/** An error message for invalid input, or null if acceptable (empty is always acceptable — not
 * "invalid", just incomplete). Derived from the value kind + the optional constraint. */
export function checkInput(raw: string, kind: string, c?: FieldConstraint): string | null {
  const s = raw.trim();
  if (s === '') return null;
  if (kind === 'num' || kind === 'money') {
    const n = Number(s);
    if (!Number.isFinite(n)) return kind === 'money' ? 'Voer een geldig bedrag in.' : 'Voer een geldig getal in.';
    if (kind === 'money' && n < (c?.min ?? 0)) return 'Bedrag kan niet negatief zijn.';
    if (c?.min !== undefined && n < c.min) return `Minimaal ${c.min}.`;
    if (c?.max !== undefined && n > c.max) return `Maximaal ${c.max}.`;
    return null;
  }
  if (kind === 'text') {
    if (c?.format === 'kenteken' && !isValidKenteken(raw)) return 'Voer een geldig Nederlands kenteken in (bijv. 48-ZG-BT).';
    if (c?.format === 'postcode' && !POSTCODE.test(s)) return 'Voer een geldige postcode in (bijv. 1011 AB).';
  }
  return null;
}

/** Normalize an accepted text value to its canonical display form (kenteken hyphens, postcode case). */
export function canonicalize(raw: string, kind: string, c?: FieldConstraint): string {
  if (kind !== 'text') return raw;
  if (c?.format === 'kenteken') return formatKenteken(raw) ?? raw;
  if (c?.format === 'postcode') return raw.trim().toUpperCase().replace(/^(\d{4})\s?([A-Z]{2})$/, '$1 $2');
  return raw;
}
