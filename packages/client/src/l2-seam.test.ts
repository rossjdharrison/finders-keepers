import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore, mockExterns } from '@app/core-runtime';
import { compileJourney } from './compile-journey.ts';

const read = (f: string) => JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/' + f, import.meta.url), 'utf8'));
const money = (v: unknown) => (v as { minor?: unknown })?.minor !== undefined ? Number((v as { minor: unknown }).minor) / 100 : v;
const registry = () => ({ 'car-insurance': read('car-insurance.json'), financing: read('financing.json'), voertuig: read('voertuig.json'), adres: read('adres.json'), individual: read('individual.json') });

test('L2 compile: the 4-configurator autopakket composes; the car value AND the region CLASS flow across seams', () => {
  const composed = compileJourney(read('auto-package.json'), registry() as never);
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

test('L2 cascade is LIVE: an insurance cover change recomputes the combined monthly across cassettes', () => {
  const composed = compileJourney(read('auto-package.json'), registry() as never);
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
