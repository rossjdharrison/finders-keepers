// The browser's externs — the sealed core's egress in this tab. The core calls externs SYNCHRONOUSLY
// during recompute, but the real APIs (RDW plate, PDOK address) are async, so each is bridged with a
// CACHE: the extern reads the cache synchronously (blank if a value hasn't been fetched yet); the host
// prefetches into the cache asynchronously and then re-applies the field to trigger a recompute.
//   - rdwDesc / rdwValue  ← RDW (make/model/catalogue value from the kenteken)
//   - regionCity / addrStreet ← PDOK Locatieserver (real city + street from the postcode)
//   - regionBand ← a deterministic local risk-rating mock (an insurance decision, not public data)

import type { Externs } from '@app/core-runtime';
import type { Value } from '@core/values';
import { normalizeKenteken } from './kenteken.ts';
import { normalizePostcode } from './pdok.ts';
import { lookupVehicle, type VehicleInfo } from './rdw.ts';
import { lookupAddress, type AddressInfo } from './pdok.ts';

const text = (v: string): Value => ({ t: 'text', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const BLANK: Value = { t: 'blank' };

// risk band from the postcode's leading digit — an insurance rating, kept as a deterministic mock
function regionBandOf(pc: string): Value {
  const d = pc.trim()[0];
  if (d === '1') return en('regionBand', 'high');
  if (d === '3') return en('regionBand', 'mid');
  if (!/[0-9]/.test(d ?? '')) return BLANK;
  return en('regionBand', 'low');
}

export interface BrowserExterns extends Externs {
  vehicles: Map<string, VehicleInfo>;
  addresses: Map<string, AddressInfo>;
  hasVehicle(rawPlate: string): boolean;
  prefetchVehicle(rawPlate: string): Promise<boolean>;
  hasAddress(rawPostcode: string): boolean;
  prefetchAddress(rawPostcode: string): Promise<boolean>;
  /** the house/flat numbers on a postcode (for a datalist); [] if not fetched */
  addressNumbers(rawPostcode: string): string[];
}

export function browserExterns(): BrowserExterns {
  const vehicles = new Map<string, VehicleInfo>();
  const addresses = new Map<string, AddressInfo>();
  return {
    vehicles,
    addresses,
    clock: () => ({ today: 20000, nowMs: 20000 * 86_400_000 }), // fixed for reproducibility
    hasVehicle: (raw) => vehicles.has(normalizeKenteken(raw)),
    async prefetchVehicle(raw) {
      const k = normalizeKenteken(raw);
      if (vehicles.has(k)) return true;
      const info = await lookupVehicle(k);
      if (info) vehicles.set(k, info);
      return vehicles.has(k);
    },
    hasAddress: (raw) => addresses.has(normalizePostcode(raw)),
    async prefetchAddress(raw) {
      const k = normalizePostcode(raw);
      if (addresses.has(k)) return true;
      const info = await lookupAddress(k);
      if (info) addresses.set(k, info);
      return addresses.has(k);
    },
    addressNumbers: (raw) => addresses.get(normalizePostcode(raw))?.numbers ?? [],
    api(name, params) {
      if (name === 'rdwDesc' || name === 'rdwValue') {
        const plate = params.plate?.t === 'text' ? params.plate.v : '';
        const hit = vehicles.get(normalizeKenteken(plate));
        if (!hit) return BLANK;
        return name === 'rdwValue' ? hit.value : hit.desc;
      }
      if (name === 'regionCity' || name === 'addrStreet') {
        const pc = params.postcode?.t === 'text' ? params.postcode.v : '';
        const hit = addresses.get(normalizePostcode(pc));
        if (!hit) return BLANK;
        return text(name === 'regionCity' ? hit.city : hit.street);
      }
      if (name === 'regionBand') {
        const pc = params.postcode?.t === 'text' ? params.postcode.v : '';
        return pc ? regionBandOf(pc) : BLANK;
      }
      return { t: 'error', code: '#NA', detail: `no such extern: ${name}` };
    },
  };
}
