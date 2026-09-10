// Generic auto-fill — the async-extern bridge, keyed off a field's `constraint.format`, for ANY
// collection. A field tagged 'kenteken' looks the vehicle up at the RDW; one tagged 'postcode' looks
// the address up at PDOK. The externs are SYNCHRONOUS (the sealed core requires it), so we prefetch the
// async result into the externs' cache and then re-set the (canonicalised) field to trigger a recompute
// that now resolves the derived externs (vehicleDesc/value, city/region). Replaces the per-player,
// per-collection copies in the flat and composed boots — the SAME code drives every cassette.

import { effect, type Signal } from '@preact/signals-core';
import type { CollectionDoc, WorkspaceStore } from './types.ts';
import { normalizeKenteken, formatKenteken, isValidKenteken } from './kenteken.ts';
import { normalizePostcode, formatPostcode, isValidPostcode } from './pdok.ts';

export interface AutofillExterns {
  hasVehicle(plate: string): boolean;
  prefetchVehicle(plate: string): Promise<boolean>;
  hasAddress(postcode: string): boolean;
  prefetchAddress(postcode: string): Promise<boolean>;
  addressNumbers(postcode: string): string[];
}

const fieldWithFormat = (coll: CollectionDoc, format: 'kenteken' | 'postcode'): string | undefined =>
  coll.properties.find((p) => p.constraint?.format === format)?.id;

/** Wire RDW + PDOK auto-fill across every collection that declares a kenteken/postcode field. Returns a
 * disposer. `suggestions` (optional) receives the house/flat numbers for the entered postcode, keyed by
 * the collection's own number field (a datalist source read by the renderer). */
export function wireAutofill(
  workspace: WorkspaceStore,
  collections: CollectionDoc[],
  externs: AutofillExterns,
  suggestions?: Signal<Record<string, string[]>>,
): () => void {
  const disposers: (() => void)[] = [];

  for (const coll of collections) {
    const store = workspace.collection(coll.id);
    if (!store) continue;
    const plateField = fieldWithFormat(coll, 'kenteken');
    const postcodeField = fieldWithFormat(coll, 'postcode');
    const numberField = coll.properties.find((p) => p.id === 'houseNumber')?.id; // datalist target, by convention

    if (plateField) {
      const seen = new Set<string>();
      disposers.push(effect(() => {
        for (const row of store.rows.value) {
          const pv = row.doc[plateField];
          if (pv?.t !== 'text' || !pv.v) continue;
          const norm = normalizeKenteken(pv.v);
          if (!isValidKenteken(norm)) continue;
          const canonical = formatKenteken(norm) ?? pv.v;
          if (!externs.hasVehicle(norm) && !seen.has(norm)) {
            seen.add(norm);
            void externs.prefetchVehicle(norm).then((ok) => {
              // guard the async write: only re-set if the user hasn't since changed the plate
              const live = store.rows.value.find((r) => r.id === row.id)?.doc[plateField];
              if (ok && live?.t === 'text' && normalizeKenteken(live.v) === norm) store.setField(row.id, plateField, { t: 'text', v: canonical });
            });
          } else if (externs.hasVehicle(norm) && pv.v !== canonical) {
            store.setField(row.id, plateField, { t: 'text', v: canonical }); // normalise the display form
          }
        }
      }));
    }

    if (postcodeField) {
      const seen = new Set<string>();
      disposers.push(effect(() => {
        for (const row of store.rows.value) {
          const pc = row.doc[postcodeField];
          if (pc?.t !== 'text' || !pc.v) continue;
          const norm = normalizePostcode(pc.v);
          if (!isValidPostcode(norm)) continue;
          const canonical = formatPostcode(norm);
          if (!externs.hasAddress(norm) && !seen.has(norm)) {
            seen.add(norm);
            void externs.prefetchAddress(norm).then((ok) => {
              if (!ok) return;
              // re-set (guarded on the live value) to trigger THIS row's recompute so its city/region
              // externs re-resolve from the now-filled cache — unconditional value-wise (host.apply
              // doesn't dedupe), because the derived fields may live on this same child row.
              const live = store.rows.value.find((r) => r.id === row.id)?.doc[postcodeField];
              if (!(live?.t === 'text' && normalizePostcode(live.v) === norm)) return;
              if (numberField && suggestions) suggestions.value = { ...suggestions.value, [numberField]: externs.addressNumbers(norm) };
              store.setField(row.id, postcodeField, { t: 'text', v: canonical });
            });
          } else if (externs.hasAddress(norm)) {
            if (numberField && suggestions) {
              const nums = externs.addressNumbers(norm);
              if (nums.length && suggestions.value[numberField] !== nums) suggestions.value = { ...suggestions.value, [numberField]: nums };
            }
            if (pc.v !== canonical) store.setField(row.id, postcodeField, { t: 'text', v: canonical });
          }
        }
      }));
    }
  }

  return () => disposers.forEach((d) => d());
}
