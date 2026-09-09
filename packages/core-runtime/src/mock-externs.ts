// The MOCK externs — the host-supplied imports the sealed core reaches out through.
// In a real deployment these become network calls (RDW kenteken lookup, a premium service);
// here they are mocked, and they record their calls so a test can prove the core reached the
// world ONLY through this boundary.

import type { Externs } from './types.ts';
import type { Value } from '@core/values';

const money = (eur: number): Value => ({ t: 'money', minor: String(Math.round(eur * 100)), ccy: 'EUR', scale: 2 });
const text = (v: string): Value => ({ t: 'text', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });

// A stand-in RDW (Dutch vehicle authority) register: kenteken → make/model + catalogue value.
const RDW: Record<string, { desc: Value; value: Value }> = {
  '12-ABC-3': { desc: text('Volkswagen Golf 2019'), value: money(18500) },
  '99-XYZ-1': { desc: text('Tesla Model 3 2022'), value: money(41000) },
  'AB-123-C': { desc: text('Fiat Panda 2015'), value: money(6800) },
  _default: { desc: text('Onbekend voertuig'), value: money(12000) },
};

// A stand-in postcode → region service: the leading digit picks a risk band + a city name.
// (Real deployment: a rating/geo API; here a deterministic mock so premiums are reproducible.)
function regionOf(postcode: string): { band: Value; city: Value } {
  const d = postcode.trim()[0];
  if (d === '1') return { band: en('regionBand', 'high'), city: text('Amsterdam') };
  if (d === '3') return { band: en('regionBand', 'mid'), city: text('Utrecht') };
  return { band: en('regionBand', 'low'), city: text('Overig Nederland') };
}

export interface MockExterns extends Externs {
  calls: { name: string; params: Record<string, Value> }[];
}

export function mockExterns(): MockExterns {
  const calls: MockExterns['calls'] = [];
  return {
    calls,
    clock: () => ({ today: 20000, nowMs: 20000 * 86_400_000 }), // fixed, deterministic
    api(name, params) {
      calls.push({ name, params });
      if (name === 'rdwValue' || name === 'rdwDesc') {
        const plate = params.plate && params.plate.t === 'text' ? params.plate.v : '';
        const rec = RDW[plate] ?? RDW._default;
        return name === 'rdwValue' ? rec.value : rec.desc;
      }
      if (name === 'regionBand' || name === 'regionCity') {
        const pc = params.postcode && params.postcode.t === 'text' ? params.postcode.v : '';
        const r = regionOf(pc);
        return name === 'regionBand' ? r.band : r.city;
      }
      return { t: 'error', code: '#NA', detail: `no such extern: ${name}` };
    },
  };
}
