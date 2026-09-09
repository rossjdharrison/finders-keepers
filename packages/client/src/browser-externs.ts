// The browser's externs — the sealed core's egress in this tab. The core calls externs SYNCHRONOUSLY
// during recompute, but a real API (RDW) is async, so we bridge with a CACHE: the extern reads the
// cache synchronously (blank if a plate hasn't been fetched yet); the host prefetches into the cache
// asynchronously and then re-applies the field to trigger a recompute that now sees the value. Region
// is a deterministic local mock (a real deployment would swap in a rating/geo service the same way).

import type { Externs } from '@app/core-runtime';
import type { Value } from '@core/values';
import { normalizeKenteken } from './kenteken.ts';
import { lookupVehicle, type VehicleInfo } from './rdw.ts';

const text = (v: string): Value => ({ t: 'text', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const BLANK: Value = { t: 'blank' };

function regionOf(pc: string): { band: Value; city: Value } {
  const d = pc.trim()[0];
  if (d === '1') return { band: en('regionBand', 'high'), city: text('Amsterdam') };
  if (d === '3') return { band: en('regionBand', 'mid'), city: text('Utrecht') };
  if (!/[0-9]/.test(d ?? '')) return { band: BLANK, city: BLANK };
  return { band: en('regionBand', 'low'), city: text('Overig Nederland') };
}

export interface BrowserExterns extends Externs {
  cache: Map<string, VehicleInfo>;
  has(rawPlate: string): boolean;
  /** Fetch a plate's vehicle into the cache (real RDW → demo → unknown). Resolves true if now cached. */
  prefetch(rawPlate: string): Promise<boolean>;
}

export function browserExterns(): BrowserExterns {
  const cache = new Map<string, VehicleInfo>();
  return {
    cache,
    clock: () => ({ today: 20000, nowMs: 20000 * 86_400_000 }), // fixed for reproducibility
    has: (raw) => cache.has(normalizeKenteken(raw)),
    async prefetch(raw) {
      const k = normalizeKenteken(raw);
      if (cache.has(k)) return true;
      const info = await lookupVehicle(k);
      if (info) cache.set(k, info);
      return cache.has(k);
    },
    api(name, params) {
      if (name === 'rdwDesc' || name === 'rdwValue') {
        const plate = params.plate?.t === 'text' ? params.plate.v : '';
        const hit = cache.get(normalizeKenteken(plate));
        if (!hit) return BLANK; // not fetched yet — host prefetches, then re-triggers recompute
        return name === 'rdwValue' ? hit.value : hit.desc;
      }
      if (name === 'regionBand' || name === 'regionCity') {
        const pc = params.postcode?.t === 'text' ? params.postcode.v : '';
        if (!pc) return BLANK;
        const r = regionOf(pc);
        return name === 'regionBand' ? r.band : r.city;
      }
      return { t: 'error', code: '#NA', detail: `no such extern: ${name}` };
    },
  };
}
