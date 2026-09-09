// RDW vehicle lookup — the real, free, CORS-open RDW Open Data API (no key needed), with a demo
// fallback. A well-formed but unregistered plate returns [] from RDW; the fictional example plates
// fall back to a small table so the demo resolves offline too. Async — the host prefetches into a
// cache that the synchronous extern then reads.

import type { Value } from '@core/values';
import { normalizeKenteken, isValidKenteken } from './kenteken.ts';

const money = (eur: number): Value => ({ t: 'money', minor: String(Math.round(eur * 100)), ccy: 'EUR', scale: 2 });
const text = (v: string): Value => ({ t: 'text', v });

export interface VehicleInfo {
  desc: Value;
  value: Value;
}

// Fictional example plates — RDW returns [] for these, so the demo resolves them here.
const DEMO: Record<string, VehicleInfo> = {
  '99XYZ1': { desc: text('Tesla Model 3 (2022)'), value: money(41000) },
  '12ABC3': { desc: text('Volkswagen Golf (2019)'), value: money(18500) },
  AB123C: { desc: text('Fiat Panda (2015)'), value: money(6800) },
};

const title = (s: string): string => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
function describe(merk?: string, model?: string, iso?: string): string {
  const make = title(merk ?? '');
  const raw = (model ?? '').trim();
  // handelsbenaming often already leads with the make ("AUDI Q7") — avoid doubling it
  const name = raw && raw.toUpperCase().startsWith((merk ?? '').toUpperCase()) ? title(raw) : `${make} ${title(raw)}`.trim();
  const yr = iso ? iso.slice(0, 4) : '';
  return (yr ? `${name} (${yr})` : name) || make || 'Voertuig';
}

interface RdwRow {
  merk?: string;
  handelsbenaming?: string;
  catalogusprijs?: string;
  datum_eerste_toelating_dt?: string;
}

/** Look up make/model/catalogue-value by plate: real RDW first, then the demo table, then "unknown". */
export async function lookupVehicle(rawPlate: string): Promise<VehicleInfo | null> {
  const k = normalizeKenteken(rawPlate);
  if (!isValidKenteken(k)) return null;
  try {
    const select = 'merk,handelsbenaming,catalogusprijs,datum_eerste_toelating_dt';
    const url = `https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${k}&$select=${select}`;
    const rows = (await fetch(url).then((r) => r.json())) as RdwRow[];
    if (Array.isArray(rows) && rows.length) {
      const v = rows[0];
      const price = v.catalogusprijs ? Number(v.catalogusprijs) : NaN;
      return { desc: text(describe(v.merk, v.handelsbenaming, v.datum_eerste_toelating_dt)), value: Number.isFinite(price) ? money(price) : money(15000) };
    }
  } catch {
    /* offline / blocked — fall through to the demo table */
  }
  return DEMO[k] ?? { desc: text('Onbekend voertuig'), value: money(12000) };
}
