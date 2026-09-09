// Dutch address lookup — the free, key-less, CORS-open PDOK Locatieserver (BAG/Kadaster data),
// callable directly from the browser like RDW. A bare postcode already yields street + city; a
// structured query lists every address (house + flat numbers) on that postcode.
//
// api.pdok.nl is the live host (the old geodata.nationaalgeoregister.nl was decommissioned 2023).

const PC_RE = /^[1-9]\d{3}[A-Z]{2}$/;

export function normalizePostcode(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase(); // "1011 ab" -> "1011AB" (strip the space!)
}
export function isValidPostcode(raw: string): boolean {
  return PC_RE.test(normalizePostcode(raw));
}
/** Canonical display form: "1011 AB". */
export function formatPostcode(raw: string): string {
  const pc = normalizePostcode(raw);
  return PC_RE.test(pc) ? `${pc.slice(0, 4)} ${pc.slice(4)}` : raw;
}

export interface AddressInfo {
  city: string;
  street: string;
  numbers: string[]; // every house/flat label on the postcode, e.g. ["105", "105-1", "105-2", "107"]
}

interface PdokDoc {
  huisnummer?: number;
  huisletter?: string;
  huistoevoeging?: string;
  straatnaam?: string;
  woonplaatsnaam?: string;
}

const labelOf = (d: PdokDoc): string =>
  `${d.huisnummer ?? ''}${d.huisletter ?? ''}${d.huistoevoeging ? '-' + d.huistoevoeging : ''}`.trim();

// numeric-then-suffix ordering so "9" sorts before "10" and "105" before "105-1"
const byNumber = (a: string, b: string): number => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b);

/** Look up a postcode's street + city and the full list of its addresses (house/flat numbers). */
export async function lookupAddress(rawPostcode: string): Promise<AddressInfo | null> {
  const pc = normalizePostcode(rawPostcode);
  if (!PC_RE.test(pc)) return null;
  try {
    const params = new URLSearchParams({
      q: `postcode:${pc} and type:adres`, // structured (exact) query, not the fuzzy free search
      fl: 'huisnummer,huisletter,huistoevoeging,straatnaam,woonplaatsnaam',
      rows: '100',
    });
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?${params.toString()}`;
    const docs = ((await fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json()))?.response?.docs ?? []) as PdokDoc[];
    if (!docs.length) return null;
    const first = docs[0];
    const numbers = [...new Set(docs.map(labelOf).filter(Boolean))].sort(byNumber);
    return { city: first.woonplaatsnaam ?? '', street: first.straatnaam ?? '', numbers };
  } catch {
    return null; // offline / blocked — the region band still works from the postcode digit
  }
}
