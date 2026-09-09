// Dutch kenteken (number plate) formatting + validation — sidecodes 1–14.
//
// The identity of a plate is its 6-character ALPHANUMERIC sequence; the hyphens are pure display.
// Each sidecode (registration-era format) has a UNIQUE letter/digit signature, so a raw sequence maps
// to exactly one sidecode and therefore one hyphen placement — hyphens are fully derivable, never
// part of identity. So the user may type "99xyz1" or "99-XYZ-1"; we normalize to "99XYZ1" for the RDW
// API (which stores the bare uppercased form) and format to "99-XYZ-1" for display.

interface Sidecode {
  code: number;
  re: RegExp;
}

// X = letter, 9 = digit. Patterns cross-checked against the RDW register + nl.wikipedia sidecodes.
const SIDECODES: Sidecode[] = [
  { code: 1, re: /^([A-Z]{2})([0-9]{2})([0-9]{2})$/ }, // XX-99-99
  { code: 2, re: /^([0-9]{2})([0-9]{2})([A-Z]{2})$/ }, // 99-99-XX
  { code: 3, re: /^([0-9]{2})([A-Z]{2})([0-9]{2})$/ }, // 99-XX-99
  { code: 4, re: /^([A-Z]{2})([0-9]{2})([A-Z]{2})$/ }, // XX-99-XX
  { code: 5, re: /^([A-Z]{2})([A-Z]{2})([0-9]{2})$/ }, // XX-XX-99
  { code: 6, re: /^([0-9]{2})([A-Z]{2})([A-Z]{2})$/ }, // 99-XX-XX
  { code: 7, re: /^([0-9]{2})([A-Z]{3})([0-9]{1})$/ }, // 99-XXX-9
  { code: 8, re: /^([0-9]{1})([A-Z]{3})([0-9]{2})$/ }, // 9-XXX-99
  { code: 9, re: /^([A-Z]{2})([0-9]{3})([A-Z]{1})$/ }, // XX-999-X
  { code: 10, re: /^([A-Z]{1})([0-9]{3})([A-Z]{2})$/ }, // X-999-XX
  { code: 11, re: /^([A-Z]{3})([0-9]{2})([A-Z]{1})$/ }, // XXX-99-X
  { code: 12, re: /^([A-Z]{1})([0-9]{2})([A-Z]{3})$/ }, // X-99-XXX
  { code: 13, re: /^([0-9]{1})([A-Z]{2})([0-9]{3})$/ }, // 9-XX-999
  { code: 14, re: /^([0-9]{3})([A-Z]{2})([0-9]{1})$/ }, // 999-XX-9
];

/** Canonical API form: uppercase, alphanumerics only ("48-zg-bt" → "48ZGBT"). */
export function normalizeKenteken(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "48ZGBT" → "48-ZG-BT"; null if it matches no sidecode. */
export function formatKenteken(raw: string): string | null {
  const k = normalizeKenteken(raw);
  for (const { re } of SIDECODES) {
    const m = k.match(re);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

/** The sidecode number (1–14), or null. */
export function sidecodeOf(raw: string): number | null {
  const k = normalizeKenteken(raw);
  for (const { code, re } of SIDECODES) if (re.test(k)) return code;
  return null;
}

/** Structural validity only. The RDW API is the authority on whether a plate actually exists
 * (an unknown-but-well-formed plate returns []). Permissive by design: real plates omit some
 * letters, but the excluded set has shifted over eras, so we don't reject on letter identity. */
export function isValidKenteken(raw: string): boolean {
  return sidecodeOf(raw) !== null;
}
