import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore, mockExterns } from '@app/core-runtime';
import { compileJourney } from './compile-journey.ts';

const read = (f: string) => JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/' + f, import.meta.url), 'utf8'));
const money = (v: unknown) => (v as { minor?: unknown })?.minor !== undefined ? Number((v as { minor: unknown }).minor) / 100 : v;

test('L2 compile: the bound principal = the insurance vehicleValue, and the combined monthly rolls up', () => {
  const registry = { 'car-insurance': read('car-insurance.json'), financing: read('financing.json') };
  const doc = read('auto-package.json');
  const composed = compileJourney(doc, registry as never);

  const core = createCore(mockExterns());
  core.load(composed); // buildPrepared must accept the compiled cassette (types reduce, no cycle, typechecks)

  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings').find((r) => r.id === 'fin-1')!;

  assert.equal(money(fin.doc.principal), 41000, 'principal locked = insurance vehicleValue (€41.000)');
  assert.equal(money(fin.doc.insPremium), 25.5, 'insurance premium surfaced (€25,50)');
  assert.equal(fin.doc.combinedMonthly?.t, 'money', 'combined monthly is money');
  // combined = premium 25.50 + finMonthly
  assert.equal(money(fin.doc.combinedMonthly), 25.5 + Number(money(fin.doc.finMonthly)), 'combined = insurance + financing monthly');
});

test('L2 cascade is LIVE: an insurance edit recomputes the combined monthly across cassettes', () => {
  const registry = { 'car-insurance': read('car-insurance.json'), financing: read('financing.json') };
  const composed = compileJourney(read('auto-package.json'), registry as never);
  const core = createCore(mockExterns());
  core.load(composed);
  for (const s of composed.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = () => core.read('fin__financings')[0];
  const before = money(fin().doc.combinedMonthly);
  // change a STORED insurance input (cover allrisk → wa): premium drops €7, so the surfaced insPremium and
  // the cross-cassette combinedMonthly must both drop €7 — proving the rollup binding cascades live.
  core.apply('ins__applications', [{ op: 'setField', row: 'ins-1', field: 'cover', value: { t: 'enum', set: 'coverLevel', v: 'wa' } }]);
  assert.equal(money(fin().doc.insPremium), 18.5, 'surfaced insurance premium recomputed (wa)');
  assert.equal(money(fin().doc.combinedMonthly), (before as number) - 7, 'combined monthly dropped €7 across the seam');
});
