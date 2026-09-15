import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore, mockExterns } from '@app/core-runtime';
import { compileJourney, mergeJourney } from './compile-journey.ts';

const read = (f: string) => JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/' + f, import.meta.url), 'utf8'));
const money = (v: unknown) => (v as { minor?: unknown })?.minor !== undefined ? Number((v as { minor: unknown }).minor) / 100 : v;
const registry = () => ({ 'car-insurance': read('car-insurance.json'), financing: read('financing.json'), voertuig: read('voertuig.json'), adres: read('adres.json'), individual: read('individual.json') });
// the autopakket is now authored as a PROPOSITION (composition) + a JOURNEY (interaction); merge them to the
// compile IR exactly as the registry resolver does at runtime.
const autoPackage = () => mergeJourney(read('auto-package.json'), read('auto-package-aanvraag.json'));

test('L2 compile: the 4-configurator autopakket composes; the car value AND the region CLASS flow across seams', () => {
  const composed = compileJourney(autoPackage() as never, registry() as never);
  const core = createCore(mockExterns());
  core.load(composed); // buildPrepared must accept it: types reduce, no cycle, typechecks (incl. the enum seam)

  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings').find((r) => r.id === 'fin-1')!;
  const ins = core.read('ins__applications').find((r) => r.id === 'ins-1')!;
  const adr = core.read('adr__addresses')[0];

  // ONE car choice (voertuig polo €22.000) is reused by TWO consumers — the financing principal and the
  // insurance value — via two money seams: functional decomposition, composed by binding.
  assert.equal(money(fin.doc.principal), 22000, 'principal = the chosen car catalogue value');
  assert.equal(money(ins.doc.vehicleValue), 22000, 'insurance value = the same car');

  // the region is an ENUM (a category), and it crosses the adr→ins seam via a cardinality-1 min-rollup —
  // the address CLASSIFIES, the insurance PRICES it (the region rate table stays in the insurance).
  const enumV = (v: unknown): string | undefined => (v as { v?: string })?.v;
  assert.equal(ins.doc.regionBand?.t, 'enum', 'the region enum crossed the seam (no engine change)');
  assert.equal(enumV(ins.doc.regionBand), enumV(adr.doc.regionBand), 'ins region = adr region (categorical binding)');

  assert.equal(fin.doc.combinedMonthly?.t, 'money', 'combined monthly is money');
  assert.equal(money(fin.doc.combinedMonthly), Number(money(fin.doc.insPremium)) + Number(money(fin.doc.finMonthly)), 'combined = insurance + financing monthly');
});

test('L2 fleet: ONE proposition reuses the SAME configurators ×N; fleet monthly = sum of per-vehicle premiums', () => {
  // the fleet composes voertuig ×3 + car-insurance ×3 + adres + individual — no NEW configurator — proving the
  // proposition layer is genuine reuse. Region + driver profile are entered once and shared to all three; each
  // vehicle carries its own value + cover. The spine (ins1) sums the three premiums into the fleet total.
  const fleet = mergeJourney(read('fleet-package.json'), read('fleet-package-aanvraag.json'));
  const composed = compileJourney(fleet as never, registry() as never);
  const core = createCore(mockExterns());
  core.load(composed);
  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);

  const ins1 = () => core.read('ins1__applications')[0];
  const ins2 = core.read('ins2__applications')[0];
  const ins3 = core.read('ins3__applications')[0];
  const adr = core.read('adr__addresses')[0];
  const enumV = (v: unknown): string | undefined => (v as { v?: string })?.v;

  for (const ins of [ins1(), ins2, ins3]) assert.equal((ins.doc.premium as { t?: string })?.t, 'money', 'each vehicle premium is a real money amount');
  // the one shared address classifies all three insurances (the region enum crosses three seams)
  assert.equal(enumV(ins1().doc.regionBand), enumV(adr.doc.regionBand), 'ins1 region = the shared address region');
  assert.equal(enumV(ins3.doc.regionBand), enumV(adr.doc.regionBand), 'ins3 region = the shared address region');

  // the fleet total (on the spine ins1) is the SUM of the three per-vehicle premiums
  const p = (r: typeof ins2): number => Number(money(r.doc.premium));
  assert.equal(ins1().doc.fleetMonthly?.t, 'money', 'the fleet total is money');
  assert.equal(Number(money(ins1().doc.fleetMonthly)), p(ins1()) + p(ins2) + p(ins3), 'fleetMonthly = premium + prem2 + prem3');

  // LIVE across instances: raise vehicle 2 to a pricier cover → the shared fleet total climbs by the same delta
  const before = Number(money(ins1().doc.fleetMonthly));
  const p2before = p(ins2);
  core.apply('ins2__applications', [{ op: 'setField', row: 'ins2-1', field: 'cover', value: { t: 'enum', set: 'coverLevel', v: 'allrisk' } }]);
  const p2after = Number(money(core.read('ins2__applications')[0].doc.premium));
  assert.equal(Number(money(ins1().doc.fleetMonthly)), before + (p2after - p2before), 'changing one vehicle cover moves the fleet total by exactly its premium delta');
});

const smeRegistry = () => ({ bedrijf: read('bedrijf.json'), individual: read('individual.json'), 'zakelijk-krediet': read('zakelijk-krediet.json') });
const smePackage = () => mergeJourney(read('sme-lending.json'), read('sme-lending-aanvraag.json'));
const enumOf = (v: unknown): string | undefined => (v as { v?: string })?.v;
const numOf = (v: unknown): number => Number((v as { v?: unknown })?.v);

test('L2 sme-lending: KvK sector + business room flow into a transparent, live credit decision', () => {
  // a SECOND business proposition reusing the Individu block (director-as-guarantor) + a KvK company + a
  // facility — no shared config with the consumer products beyond Individu. The KvK sector crosses a
  // categorical seam and the facility prices it; the decision is a computed, traceable verdict.
  const composed = compileJourney(smePackage() as never, smeRegistry() as never);
  const core = createCore(mockExterns());
  core.load(composed);
  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);

  const fac = () => core.read('fac__facilities')[0];
  const co = core.read('co__companies')[0];

  // the mocked KvK register classified 69599084 as ICT; that enum crossed the co→fac seam
  assert.equal(enumOf(co.doc.sector), 'ict', 'the KvK lookup classified the company sector');
  assert.equal(enumOf(fac().doc.sector), 'ict', 'the sector enum crossed the seam to the facility (no engine change)');
  assert.ok(Math.abs(numOf(fac().doc.jaarrente) - 0.079) < 1e-9, 'jaarrente = base 6.9% (t60) + ICT opslag 1.0%');

  // the default (€150k, borg on, €96k result) is APPROVED, with a real max credit and no shortfall
  assert.equal(fac().doc.maandlast?.t, 'money', 'the monthly is money, not blank/error');
  assert.equal(enumOf(fac().doc.kredietoordeel), 'goedgekeurd', 'the default request is approved');
  assert.equal(fac().doc.maxKrediet?.t, 'money', 'a real maximum responsible credit amount is produced');
  assert.equal(fac().doc.tekort?.t, 'blank', 'no shortfall when the request fits');
  assert.equal((fac().doc.maandTotaal as { t?: string })?.t, 'money', 'the composed rail total (aflossing + rente) is money');
});

test('L2 sme-lending: the personal guarantee (party-in-role) tips a marginal decision', () => {
  const composed = compileJourney(smePackage() as never, smeRegistry() as never);
  const core = createCore(mockExterns());
  core.load(composed);
  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const verdict = (): string | undefined => enumOf(core.read('fac__facilities')[0].doc.kredietoordeel);

  // raise the loan so the business room alone no longer covers it comfortably
  core.apply('fac__facilities', [{ op: 'setField', row: 'fac-1', field: 'kredietbedrag', value: { t: 'money', minor: '30000000', ccy: 'EUR', scale: 2 } }]);
  const withBorg = verdict();
  // withdraw the director's personal guarantee — the same request, one party's commitment removed
  core.apply('fac__facilities', [{ op: 'setField', row: 'fac-1', field: 'persoonlijkeBorg', value: { t: 'bool', v: false } }]);
  const withoutBorg = verdict();

  assert.notEqual(withBorg, withoutBorg, 'removing the guarantee changes the verdict');
  assert.equal(withoutBorg, 'afgewezen', 'without the personal guarantee the marginal request is declined');
  assert.notEqual(core.read('fac__facilities')[0].doc.maandlast?.t, 'error', 'no #TYPE anywhere in the decision');
});

test('fleet-n: an intra-cassette to-many fleet sums N vehicles via a rollup; add + remove are live', () => {
  // the "N vehicles" style: ONE cassette, a fleet parent + a to-many vehicles child, summed by rollup —
  // NOT the fixed-alias L2 seam. Dynamic N, no engine change. (Runs as a plain cassette, no compile.)
  const cass = read('fleet-n.json');
  const core = createCore(mockExterns());
  core.load(cass);
  for (const s of cass.seed) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);

  const fleet = () => core.read('fleets')[0];
  const vehicles = () => core.read('vehicles');
  const m = (v: unknown): number => Number(money(v));

  // two seeded vehicles → aantal 2, a money total
  assert.equal(numOf(fleet().doc.aantal), 2, 'two vehicles counted by the count rollup');
  assert.equal(fleet().doc.fleetMonthly?.t, 'money', 'the fleet total is money (not a num(0) from an empty sum)');
  const base = m(fleet().doc.fleetMonthly);

  // ADD a third vehicle (an insert) → the sum + count grow live
  core.apply('vehicles', [{ op: 'insert', row: 'veh-3', values: { polis: { t: 'ref', collection: 'fleets', id: 'f-1' }, actief: { t: 'bool', v: true }, merkModel: { t: 'enum', set: 'merkModel', v: 'polo' }, cover: { t: 'enum', set: 'coverLevel', v: 'wa' } } }]);
  assert.equal(numOf(fleet().doc.aantal), 3, 'three vehicles after add');
  const withThree = m(fleet().doc.fleetMonthly);
  assert.ok(withThree > base, 'adding a vehicle raises the fleet total');

  // REMOVE (soft) the second vehicle → excluded from the sum + count live
  core.apply('vehicles', [{ op: 'setField', row: 'veh-2', field: 'actief', value: { t: 'bool', v: false } }]);
  assert.equal(numOf(fleet().doc.aantal), 2, 'back to two active after a soft-remove');
  const afterRemove = m(fleet().doc.fleetMonthly);
  assert.ok(afterRemove < withThree, 'removing a vehicle lowers the fleet total');

  // the total reconciles: Σ (active vehicle premiums) + the shared context total
  const activePrem = vehicles().filter((v) => (v.doc.actief as { v?: boolean })?.v && (v.doc.premium as { t?: string })?.t === 'money').reduce((a, v) => a + m(v.doc.premium), 0);
  assert.ok(Math.abs(afterRemove - (activePrem + m(fleet().doc.contextTotaal))) < 0.001, 'fleet = Σ active premiums + context total');
  assert.notEqual(fleet().doc.fleetMonthly?.t, 'error', 'no #TYPE anywhere in the fleet total');
});

test('fleet-n: an empty fleet (zero vehicles) is a BLANK total, not a num(0)+money #TYPE', () => {
  // the model-level guard (fleetMonthly gated on aantal>0) makes the total self-safe: an empty premium sum
  // is num(0), which would #TYPE against the money context — the guard returns blank instead. Reachable by
  // driving the core directly (the shipped UI keeps >=1 vehicle); the model shouldn't rely on that.
  const cass = read('fleet-n.json');
  const core = createCore(mockExterns());
  core.load(cass);
  core.apply('fleets', [{ op: 'insert', row: 'f-1', values: { postcode: { t: 'text', v: '3511 AB' }, bestuurderLeeftijd: { t: 'num', v: 45 }, schadevrijeJaren: { t: 'num', v: 8 } } }]);
  const fleet = core.read('fleets')[0];
  assert.equal(numOf(fleet.doc.aantal), 0, 'no vehicles → count 0');
  assert.notEqual(fleet.doc.fleetMonthly?.t, 'error', 'an empty fleet must not #TYPE');
  assert.equal(fleet.doc.fleetMonthly?.t, 'blank', 'an empty fleet total is blank (incomplete), never a wrong or errored number');
});

test('L2 cascade is LIVE: an insurance cover change recomputes the combined monthly across cassettes', () => {
  const composed = compileJourney(autoPackage() as never, registry() as never);
  const core = createCore(mockExterns());
  core.load(composed);
  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = () => core.read('fin__financings')[0];
  const before = money(fin().doc.combinedMonthly) as number;
  // change a STORED insurance input (cover allrisk → wa): coverBase €11 → €4, so premium drops €7, so the
  // surfaced insPremium and the cross-cassette combinedMonthly must both drop €7 — the rollup cascades live.
  core.apply('ins__applications', [{ op: 'setField', row: 'ins-1', field: 'cover', value: { t: 'enum', set: 'coverLevel', v: 'wa' } }]);
  assert.equal(money(fin().doc.combinedMonthly), before - 7, 'combined monthly dropped €7 across the seam');
});
