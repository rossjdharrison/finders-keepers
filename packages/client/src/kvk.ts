// KvK (Kamer van Koophandel) company lookup — the business analogue of the RDW plate lookup.
//
// IMPORTANT: unlike RDW, the KvK Handelsregister API is NOT free-and-CORS-open. Every endpoint needs an API
// key, and KvK sends no CORS headers, so a browser fetch is blocked. Production wires the keyed KvK API (or
// the KvK test environment) behind a small SERVER proxy that holds the key; the browser calls the proxy.
// Here we resolve against a local table of fictitious companies shaped like a KvK Basisprofiel, so the demo
// runs offline. To go live, swap the body of `lookupCompany` for `fetch('/api/kvk/' + k)` against that
// proxy — the returned shape is already the KvK shape (name / legal form / SBI sector / city / employees).

import type { Value } from '@core/values';

const text = (v: string): Value => ({ t: 'text', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const num = (v: number): Value => ({ t: 'num', v });
const BLANK: Value = { t: 'blank' };

export interface CompanyInfo {
  name: Value; // bedrijfsnaam (text)
  legalForm: Value; // rechtsvorm (enum: bv/eenmanszaak/vof/nv/stichting)
  sector: Value; // sector (enum, derived from the SBI code — the risk-relevant classification)
  city: Value; // vestigingsplaats (text)
  employees: Value; // medewerkers (num)
}

/** Canonical KvK-nummer form: exactly 8 digits, no separators. */
export const normalizeKvk = (raw: string): string => String(raw ?? '').replace(/[^0-9]/g, '');
/** Structural validity only (8 digits). The register is the authority on whether it actually exists. */
export const isValidKvk = (raw: string): boolean => /^[0-9]{8}$/.test(normalizeKvk(raw));
/** KvK numbers are shown as plain 8 digits — canonicalisation is just stripping separators. */
export const formatKvk = (raw: string): string => normalizeKvk(raw);

// Fictitious companies (a stand-in KvK Basisprofiel). Real KvK data is licensed, so a demo cannot ship it.
const DEMO: Record<string, CompanyInfo> = {
  '69599084': { name: text('Van der Berg Techniek B.V.'), legalForm: en('rechtsvorm', 'bv'), sector: en('sector', 'ict'), city: text('Utrecht'), employees: num(24) },
  '34567890': { name: text('Grand Café De Kade V.O.F.'), legalForm: en('rechtsvorm', 'vof'), sector: en('sector', 'horeca'), city: text('Amsterdam'), employees: num(12) },
  '12345678': { name: text('Bouwbedrijf Jansen'), legalForm: en('rechtsvorm', 'eenmanszaak'), sector: en('sector', 'bouw'), city: text('Rotterdam'), employees: num(4) },
  '81234567': { name: text('Meijer Retail Groep N.V.'), legalForm: en('rechtsvorm', 'nv'), sector: en('sector', 'detailhandel'), city: text('Eindhoven'), employees: num(140) },
};

/** Look up a company by KvK-nummer. Local table only (see the file header on why KvK can't be called from
 * the browser); a well-formed but unknown number resolves to a generic profile so the demo still moves. */
export async function lookupCompany(rawKvk: string): Promise<CompanyInfo | null> {
  const k = normalizeKvk(rawKvk);
  if (!isValidKvk(k)) return null;
  // Production: return await fetch(`/api/kvk/${k}`).then((r) => (r.ok ? r.json() : null));  // keyed proxy
  return DEMO[k] ?? { name: text('Onbekende onderneming'), legalForm: en('rechtsvorm', 'bv'), sector: en('sector', 'zakelijke-diensten'), city: text('Nederland'), employees: BLANK };
}
