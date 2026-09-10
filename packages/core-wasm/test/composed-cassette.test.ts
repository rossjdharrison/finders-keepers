// The intra-cassette decomposition proof. The SAME car-insurance quote, authored as FOUR collections
// (applications = the activity spine; vehicles / drivers / covers = configurators over their own HQDM
// individuals) composed via relations + rollup — and it runs through the EXACT SAME sealed wasm core
// (the committed vendor bundle), with NO engine change. If this passes, the thesis holds: decomposition
// is authoring, not engineering — the engine already composes across collections inside wasm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getQuickJS } from 'quickjs-emscripten';
import { createSealedCore } from '../src/host.ts';
import { mockExterns } from '@app/core-runtime';
import type { Value } from '@core/values';

const QuickJS = await getQuickJS();
const bundle = readFileSync(new URL('../vendor/core.bundle.js', import.meta.url), 'utf8');
const composed = JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/car-insurance-composed.json', import.meta.url), 'utf8'));

const text = (v: string): Value => ({ t: 'text', v });
const num = (v: number): Value => ({ t: 'num', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const bool = (v: boolean): Value => ({ t: 'bool', v });
const ref = (collection: string, id: string): Value => ({ t: 'ref', collection, id });
// coerce for comparison: a bare table lookup carries the JSON's numeric minor, arithmetic yields a
// string minor (BigInt) — both are valid money; moneyFormat coerces the same way for display.
const minor = (v: unknown): string => String((v as { minor: unknown }).minor);

// build one linked application (app + its vehicle, driver, cover) exactly as the flat cassette's fixture
async function seed() {
  const core = await createSealedCore(QuickJS, bundle, mockExterns());
  core.load(composed);
  core.apply('applications', [{ op: 'insert', row: 'app-1', values: { paymentTerm: en('paymentTerm', 'monthly') } }]);
  core.apply('vehicles', [{ op: 'insert', row: 'veh-1', values: { app: ref('applications', 'app-1'), plate: text('99-XYZ-1') } }]);
  core.apply('drivers', [{ op: 'insert', row: 'drv-1', values: { app: ref('applications', 'app-1'), postcode: text('1011 AB'), age: num(40), schadevrijeJaren: num(6), annualKm: num(15000), usage: en('usage', 'commute') } }]);
  core.apply('covers', [{ op: 'insert', row: 'cov-1', values: { app: ref('applications', 'app-1'), cover: en('coverLevel', 'allrisk'), optLegalAid: bool(true) } }]);
  return core;
}
const appRow = (core: Awaited<ReturnType<typeof seed>>) => core.read('applications').find((r) => r.id === 'app-1')!;

test('composed: the premium ROLLS UP from three configurators — same €25.50 as the flat cassette, in wasm', async () => {
  const core = await seed();
  const a = appRow(core);
  // each configurator computed its own subtotal from its OWN fields...
  assert.equal(minor(a.doc.vehicleSub), '600'); // vehicles: band(high) = €6.00
  assert.equal(minor(a.doc.driverSub), '500'); // drivers: km 1.50 + region 4.00 + usage 1.00 − noClaim 1.50 = €5.00
  assert.equal(minor(a.doc.coverSub), '1400'); // covers: allrisk 11.00 + legalAid 3.00 = €14.00
  // ...and the application composed them via rollup + the billing surcharge
  assert.equal(minor(a.doc.premium), '2550'); // €25.50 — identical to the single-collection cassette
  assert.equal(typeof (a.doc.premium as { minor: unknown }).minor, 'string'); // arithmetic result is a string (anti-f64), across the wasm seam
  core.dispose();
});

test('composed: editing a configurator recomputes the premium across collections (cascade in wasm)', async () => {
  const core = await seed();
  assert.equal(minor(appRow(core).doc.premium), '2550');
  // change the COVER configurator (a different collection) → the application premium must recompute
  core.apply('covers', [{ op: 'setField', row: 'cov-1', field: 'cover', value: en('coverLevel', 'wa') }]);
  // covers: wa 4.00 + legalAid 3.00 = €7.00 → premium 6.00 + 5.00 + 7.00 + 0.50 = €18.50
  assert.equal(minor(appRow(core).doc.coverSub), '700');
  assert.equal(minor(appRow(core).doc.premium), '1850');
  core.dispose();
});

test('composed: a dangling HQDM type is still refused at load (reduction holds for the decomposition)', async () => {
  const core = await createSealedCore(QuickJS, bundle, mockExterns());
  const bad = { ...composed, types: { ...composed.types, Cover: { specializes: ['nowhere'] } } };
  assert.throws(() => core.load(bad));
  core.dispose();
});
