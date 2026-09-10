import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette } from '@app/core-runtime';
import { createCore, mockExterns } from '@app/core-runtime';
import { compileJourney, type JourneyDoc } from '../compile-journey.ts';
import { projectStructure } from './structure.ts';
import { buildGraph } from './graph.ts';
import { buildJourneyGraph } from './journey-graph.ts';
import { addBinding, removeBinding, setBindingMapping, setBindingCondition, setTotalOf, removeSurface, removeModel, previewJourney } from './journey-edit.ts';
import { neededFields } from './data-minimization.ts';

const read = (f: string): Cassette => JSON.parse(readFileSync(new URL('../../../core-runtime/cassettes/' + f, import.meta.url), 'utf8'));
const id = (s: string): string => s;

const carInsurance = (): Cassette => read('car-insurance.json');
const composed = (): Cassette => read('car-insurance-composed.json');
const journeyDoc = (): JourneyDoc => read('auto-package.json') as unknown as JourneyDoc;
// the auto-package now composes FIVE products: voertuig, adres, individual, car-insurance, financing
const registry = (): Record<string, Cassette> => ({ 'car-insurance': carInsurance(), financing: read('financing.json'), voertuig: read('voertuig.json'), adres: read('adres.json'), individual: read('individual.json') });
const compiledJourney = (): Cassette => compileJourney(journeyDoc(), registry());
// a core loaded with the compiled journey AND its seed applied (load() does not auto-seed — the host does),
// so a test can read the composed rows exactly as the running player would show them.
const seededJourney = (): ReturnType<typeof createCore> => {
  const compiled = compileJourney(journeyDoc(), registry());
  const core = createCore(mockExterns());
  core.load(compiled);
  for (const s of compiled.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  return core;
};

// --- structure -----------------------------------------------------------------------------------

test('projectStructure: a flat cassette projects one collection with its fields, sources and formulas', () => {
  const sm = projectStructure(carInsurance(), { label: id });
  assert.equal(sm.collections.length, 1, 'flat = one collection');
  assert.equal(sm.relations.length, 0, 'flat has no relations');
  const app = sm.collections[0];
  assert.ok(app.fieldCount > 0 && app.computedCount > 0, 'has stored + computed fields');
  assert.equal(app.computedCount, app.fields.filter((f) => f.source === 'computed').length, 'computed count matches');

  const premium = app.fields.find((f) => f.id === 'premium')!;
  assert.equal(premium.source, 'computed');
  assert.ok(premium.formulaProse && premium.formulaProse.length > 0, 'computed field carries its formula in prose');
  assert.ok(premium.chain?.includes('amount_of_money'), 'money field grounds into amount_of_money');

  // an extern field (host-filled) is projected as extern, and never carries a formula
  const extern = app.fields.find((f) => f.source === 'extern');
  assert.ok(extern, 'has at least one extern field (RDW/PDOK-filled)');
  assert.equal(extern!.formulaProse, undefined, 'extern fields carry no formula');
});

test('projectStructure: a composed cassette projects every collection + the relation edges', () => {
  const sm = projectStructure(composed(), { label: id });
  assert.ok(sm.collections.length > 1, 'composed = several collections');
  assert.ok(sm.relations.length >= 3, 'vehicles/drivers/covers relate to applications');
  for (const r of sm.relations) assert.ok(r.parentColl && r.childColl && r.childField, 'each relation names parent, child and childField');
});

// --- dependency graph (mirrors the engine collect()) --------------------------------------------

test('buildGraph: a flat cassette has field nodes, dependency edges, a highlighted output, and NO rollups', () => {
  const g = buildGraph(carInsurance(), { label: id, outputField: 'premium' });
  assert.ok(g.nodes.length > 10, 'a node per field');
  assert.equal(g.cycle.length, 0, 'a valid model has no cycle');
  assert.equal(g.edges.filter((e) => e.kind === 'rollup').length, 0, 'flat = no cross-collection rollups');
  assert.ok(g.edges.some((e) => e.kind === 'dep'), 'has same-collection dependency edges');

  const premium = g.nodes.find((n) => n.id === 'premium')!;
  assert.equal(premium.isOutput, true, 'the output field is flagged');
  assert.ok(premium.rank > 0, 'the output sits downstream of its inputs');

  // every edge endpoint resolves to a real node, and no self-edges
  const keys = new Set(g.nodes.map((n) => n.key));
  for (const e of g.edges) {
    assert.ok(keys.has(e.from) && keys.has(e.to), 'edge endpoints are real nodes');
    assert.notEqual(e.from, e.to, 'no self-edge');
  }
});

test('buildGraph: a composed cassette draws the cross-collection rollups as rollup edges', () => {
  const g = buildGraph(composed(), { label: id, outputField: 'premium' });
  const rollups = g.edges.filter((e) => e.kind === 'rollup');
  assert.ok(rollups.length >= 3, 'the child→parent rollups (vehicles/drivers/covers → applications) draw');
  // a rollup edge crosses collections: its endpoints live in different collections
  for (const e of rollups) {
    const from = g.nodes.find((n) => n.key === e.from)!;
    const to = g.nodes.find((n) => n.key === e.to)!;
    assert.notEqual(from.coll, to.coll, 'a rollup edge crosses collections');
    assert.ok(e.label && e.label.includes('·'), 'a rollup edge is labelled with its agg + relation');
  }
});

test('buildGraph: a compiled journey draws the L2 binding seam as a rollup edge into the total', () => {
  const cass = compiledJourney();
  const g = buildGraph(cass, { label: id, outputField: 'combinedMonthly' });
  const seam = g.edges.filter((e) => e.kind === 'rollup' && (e.label ?? '').includes('rel_vehToFinPrincipal'));
  assert.ok(seam.length >= 1, 'the critical value→principal binding is visible as a rollup edge');
  const output = g.nodes.find((n) => n.id === 'combinedMonthly')!;
  assert.equal(output.isOutput, true, "the journey's combined total is the highlighted output");
  assert.equal(g.cycle.length, 0, 'the compiled journey is acyclic');
});

// --- journey composition graph -------------------------------------------------------------------

test('buildJourneyGraph: five configurators become boxes, the spine sits downstream, every binding is a wire', () => {
  const jg = buildJourneyGraph(journeyDoc(), { label: id });
  assert.equal(jg.boxes.length, 5, 'voertuig, adres, individu, verzekering, financiering');
  const fin = jg.boxes.find((b) => b.alias === 'fin')!;
  const veh = jg.boxes.find((b) => b.alias === 'veh')!;
  assert.equal(fin.isSpine, true, 'the spine (financiering) carries the total');
  assert.ok(fin.rank > veh.rank, 'the upstream voertuig sits left of the downstream financing');
  assert.equal(jg.wires.length, 10, 'ten bindings');
  // the car value feeds BOTH insurance and financing; the individual feeds four driver facts to insurance and
  // three to financing (no-claim loyalty + gross income + monthly obligations → affordability)
  assert.equal(jg.wires.filter((w) => w.from === 'veh').length, 2, 'voertuig feeds two consumers');
  assert.equal(jg.wires.filter((w) => w.from === 'ind').length, 7, 'the individual feeds age/no-claim/km/usage → insurance and no-claim/income/obligations → financing');
  assert.equal(jg.total.field, 'combinedMonthly');
  assert.ok(jg.surface.length >= 1, 'the surfaced insurance premium line is present');
});

// --- compile-journey: multiple bindings between the same pair, + conditional bindings --------------

const num = (v: unknown): number => Number((v as { v?: unknown })?.v ?? v);
const minor = (v: unknown): number => Number((v as { minor?: unknown })?.minor);

test('compileJourney: a child bound to several parents gets one ref PER parent and is seeded once; loyalty flows', () => {
  const compiled = compileJourney(journeyDoc(), registry());
  // voertuig binds to BOTH insurance and financing — one __to ref per distinct parent, one seed row
  const veh = compiled.collections.find((c) => c.id === 'veh__vehicles')!;
  const refs = veh.properties.filter((p) => p.id.startsWith('__to_')).map((p) => p.id);
  assert.ok(refs.includes('__to_ins') && refs.includes('__to_fin'), 'voertuig names both parents it feeds');
  assert.equal(compiled.seed!.filter((s) => s.row === 'veh-1').length, 1, 'the child is seeded once, with all its parent refs');

  const core = createCore(mockExterns());
  core.load(compiled);
  for (const s of compiled.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings')[0];
  // schadevrijeJaren example = 6 → loyaltyYears bound to 6 → loyaltyDiscount 0.005 → annualRate = 0.079 − 0.005
  assert.equal(num(fin.doc.loyaltyYears), 6, 'loyaltyYears bound from the insurance no-claim years');
  assert.ok(Math.abs(num(fin.doc.annualRate) - 0.074) < 1e-9, 'effective rate = base 0.079 − loyalty 0.005');
});

test('compileJourney: two bindings between the SAME pair share one ref + seed row (dedup)', () => {
  const doc = {
    kind: 'journey', id: 't', locale: 'nl',
    models: [{ ref: 'voertuig', as: 'v' }, { ref: 'financing', as: 'f' }], spine: 'f',
    bindings: [
      { id: 'b1', from: 'v', to: 'f', contract: { provides: [{ as: 'a', source: 'output:catalogValue' }], requires: [{ name: 'a', target: 'field:principal' }] }, mapping: [{ to: 'principal', from: { op: 'field', id: 'a' } }] },
      { id: 'b2', from: 'v', to: 'f', contract: { provides: [{ as: 'b', source: 'output:catalogValue' }], requires: [{ name: 'b', target: 'field:downPayment' }] }, mapping: [{ to: 'downPayment', from: { op: 'field', id: 'b' } }] },
    ],
    total: { field: 'finMonthly', of: ['finMonthly'] },
    sections: [{ model: 'v', label: 'V', fields: ['merkModel'] }, { model: 'f', label: 'F', fields: ['finMonthly'] }],
  } as unknown as JourneyDoc;
  const compiled = compileJourney(doc, registry());
  const v = compiled.collections.find((c) => c.id === 'v__vehicles')!;
  assert.equal(v.properties.filter((p) => p.id === '__to_f').length, 1, 'one shared ref for two same-pair bindings');
  assert.equal(compiled.seed!.filter((s) => s.row === 'v-1').length, 1, 'the child is seeded once');
});

test('compileJourney: a conditional binding takes a typed zero when its condition is false', () => {
  const gated = structuredClone(journeyDoc());
  // gate the LOYALTY binding on an impossible no-claim threshold (example = 6) → never applies
  const loyalty = gated.bindings.find((b) => b.id === 'indToFinLoyalty')!;
  (loyalty as { condition?: unknown }).condition = { op: 'gte', args: [{ op: 'field', id: 'schadevrijeJaren' }, { op: 'lit', value: { t: 'num', v: 100 } }] };
  const compiled = compileJourney(gated, registry());
  const core = createCore(mockExterns());
  core.load(compiled);
  for (const s of compiled.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings')[0];
  assert.equal(num(fin.doc.loyaltyYears), 0, 'gated-off binding yields the typed zero, not the provided 6');
  assert.ok(Math.abs(num(fin.doc.annualRate) - 0.079) < 1e-9, 'the effective rate is the base rate');
});

// --- journey-edit ops (each validated by recompile, exactly as the editor does) ------------------

test('journey-edit: previewJourney compiles + totals the shipped journey', () => {
  const res = previewJourney(journeyDoc(), registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(res.total && res.total.t === 'money', 'a sample combined total is produced');
});

test('journey-edit: editing a binding mapping (finance half the car) lowers the combined total', () => {
  const base = previewJourney(journeyDoc(), registry());
  // the vehToFinPrincipal binding provides the seam var `vprin` (the car value); finance half of it
  const edited = setBindingMapping(journeyDoc(), 'vehToFinPrincipal', { op: 'mul', args: [{ op: 'field', id: 'vprin' }, { op: 'lit', value: { t: 'num', v: 0.5 } }] });
  const res = previewJourney(edited, registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(minor(res.total) < minor(base.total), 'financing half the catalogue value cuts the monthly');
});

test('journey-edit: removing a removable binding compiles (target reverts to its own source)', () => {
  // dropping adr→ins reverts insurance.regionBand to its own extern lookup — still compiles
  const res = previewJourney(removeBinding(journeyDoc(), 'adrToInsRegion'), registry());
  assert.equal(res.ok, true, res.error);
});

test('surface auto-synthesis: the insurance has NO binding to the spine, yet its premium surfaces (edit-safe)', () => {
  // no ins→fin binding exists in the shipped journey (loyalty flows ind→fin); the insPremium surface must
  // still reach the spine by synthesizing its own ins→spine relation — proven by the base compile + total
  const res = previewJourney(journeyDoc(), registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(res.total && res.total.t === 'money', 'the combined total includes the surfaced premium');
});

test('compileJourney: two models declaring the same enum set with DIFFERENT members are rejected', () => {
  // clone auto-package but corrupt voertuig to redeclare regionBand with different members
  const badVoertuig = structuredClone(read('voertuig.json')) as unknown as { enums: Record<string, { id: string; label: string }[]> };
  badVoertuig.enums.regionBand = [{ id: 'urban', label: 'Urban' }, { id: 'rural', label: 'Rural' }];
  const reg = { ...registry(), voertuig: badVoertuig as unknown as Cassette };
  assert.throws(() => compileJourney(journeyDoc(), reg as never), /enum set 'regionBand' is declared with different members/);
});

test('compileJourney: a conditional binding on a NON-numeric target is rejected with binding context', () => {
  const gated = structuredClone(journeyDoc());
  const region = gated.bindings.find((b) => b.id === 'adrToInsRegion')!;
  (region as { condition?: unknown }).condition = { op: 'gte', args: [{ op: 'field', id: 'houseNumber' }, { op: 'lit', value: { t: 'num', v: 0 } }] };
  assert.throws(() => compileJourney(gated, registry() as never), /binding adrToInsRegion has a condition but its target 'regionBand' is enum/);
});

test('journey-edit: addBinding is proven by recompile — a bad target fails cleanly, not by throwing', () => {
  const bad = addBinding(journeyDoc(), { from: 'ins', to: 'fin', fromField: 'premium', toField: 'doesNotExist' });
  const res = previewJourney(bad, registry());
  assert.equal(res.ok, false, 'an unknown target is rejected as data, not an exception');
  assert.ok(res.error && /doesNotExist/.test(res.error), 'the error names the offending target');
});

test('journey-edit: removeModel refuses to orphan the spine (no-op)', () => {
  assert.deepEqual(removeModel(journeyDoc(), 'fin'), journeyDoc(), 'removing the spine is refused');
});

// --- review fixes: conditional money binding, financed clamp, empty total, surface/total consistency ---

test('compile: a MONEY conditional binding compiles (ccy-neutral zero, not "branches disagree money vs money")', () => {
  // gate the money binding vehToFinPrincipal on one of ITS from-model (voertuig) fields; the else-branch
  // zero must unify with the mapped money type
  const gated = setBindingCondition(journeyDoc(), 'vehToFinPrincipal', { op: 'gte', args: [{ op: 'field', id: 'bouwjaar' }, { op: 'lit', value: { t: 'num', v: 0 } }] });
  const res = previewJourney(gated, registry());
  assert.equal(res.ok, true, res.error); // previously threw at load: branches disagree: money vs money
  assert.ok(res.total && res.total.t === 'money');
});

test('financing: financed clamps at zero when down-payment exceeds the principal (no negative monthly)', () => {
  const core = createCore(mockExterns());
  core.load(read('financing.json'));
  const [row] = core.apply('financings', [{ op: 'insert', row: 'f', values: {
    principal: { t: 'money', minor: '4100000', ccy: 'EUR', scale: 2 },
    downPayment: { t: 'money', minor: '5000000', ccy: 'EUR', scale: 2 },
    tradeIn: { t: 'money', minor: '0', ccy: 'EUR', scale: 2 },
    termMonths: { t: 'enum', set: 'term', v: 't48' },
    loyaltyYears: { t: 'num', v: 0 },
  } }]);
  assert.equal(minor(row.doc.financed), 0, 'financed clamped to 0, never negative');
  assert.equal(minor(row.doc.finMonthly), 0, 'and the monthly payment is 0, not below zero');
});

test('journey-edit: clearing every total line compiles to a €0 total, not a reduce-of-empty crash', () => {
  const res = previewJourney(setTotalOf(journeyDoc(), []), registry());
  assert.equal(res.ok, true, res.error);
  assert.equal(minor(res.total), 0, 'no lines → €0 total');
});

test('journey-edit: removeSurface also drops the line from total.of (stays self-consistent + compilable)', () => {
  const edited = removeSurface(journeyDoc(), 'insPremium');
  assert.ok(!edited.total.of.includes('insPremium'), 'the surfaced id is stripped from total.of');
  const res = previewJourney(edited, registry());
  assert.equal(res.ok, true, res.error);
});

// --- data minimization (privacy by design): collect only what the composition provably needs ----

test('data-minimization: the Individual collects only the consumed facts; the rest is hidden', () => {
  const min = neededFields(journeyDoc(), 'ind', registry());
  // insurance consumes age/annualKm/schadevrijeJaren/usage; financing additionally consumes grossIncome +
  // monthlyObligations (affordability) — so exactly those six are collected, derived from the composition.
  assert.deepEqual([...min.shown].sort(), ['age', 'annualKm', 'grossIncome', 'monthlyObligations', 'schadevrijeJaren', 'usage'], 'only what the journey pulls out of the individual');
  for (const secret of ['dateOfBirth', 'email', 'phone', 'occupation', 'firstName']) {
    assert.ok(min.hidden.includes(secret), `${secret} is collected-but-unused → hidden`);
  }
  assert.ok(!min.shown.includes('dateOfBirth'), 'we ask the age, not the date of birth');
});

test('data-minimization: the insurance shows its own choices, not the facts provided upstream', () => {
  const min = neededFields(journeyDoc(), 'ins', registry());
  assert.ok(min.shown.includes('cover'), 'the policy choice is entered here');
  assert.ok(min.shown.includes('premium'), 'the premium readout is shown');
  for (const bound of ['vehicleValue', 'regionBand', 'age', 'schadevrijeJaren', 'annualKm', 'usage']) {
    assert.ok(!min.shown.includes(bound), `${bound} is provided by a binding, so it is not collected in the insurance`);
  }
});

test('data-minimization: a mapping that reads an EXTRA from-field un-hides it (no false-hide)', () => {
  // edit vehToFinPrincipal's mapping to also read bouwjaar (a real voertuig field beyond the seam var)
  const edited = setBindingMapping(journeyDoc(), 'vehToFinPrincipal', { op: 'call', fn: 'if', args: [{ op: 'gte', args: [{ op: 'field', id: 'bouwjaar' }, { op: 'lit', value: { t: 'num', v: 2015 } }] }, { op: 'field', id: 'vprin' }, { op: 'field', id: 'vprin' }] });
  const min = neededFields(edited, 'veh', registry());
  assert.ok(min.shown.includes('bouwjaar'), 'the mapping now reads bouwjaar, so it is collected — not falsely hidden');
});

test('data-minimization: a binding CONDITION that reads an extra from-field un-hides it', () => {
  const edited = setBindingCondition(journeyDoc(), 'indToFinLoyalty', { op: 'gte', args: [{ op: 'field', id: 'driversLicenceSince' }, { op: 'lit', value: { t: 'num', v: 1 } }] });
  const min = neededFields(edited, 'ind', registry());
  assert.ok(min.shown.includes('driversLicenceSince'), 'the condition reads driversLicenceSince, so the gate input is collected');
});

test('data-minimization: minimal mode does NOT seed hidden fields (privacy integrity, not just hidden from view)', () => {
  const compiled = compileJourney(journeyDoc(), registry()) as unknown as { seed: { row: string; values: Record<string, unknown> }[] };
  const indSeed = compiled.seed.find((s) => s.row === 'ind-1')!;
  assert.ok(!('firstName' in indSeed.values) && !('email' in indSeed.values) && !('gender' in indSeed.values), 'the "niet verzameld" PII is genuinely absent from the record');
  assert.ok('age' in indSeed.values, 'a needed field is still seeded');
});

test('seam robustness: a MISSING upstream row rolls a money target up to BLANK, not num(0) → no #TYPE premium', () => {
  const compiled = compileJourney(journeyDoc(), registry());
  const core = createCore(mockExterns());
  core.load(compiled);
  // insert every seed row EXCEPT the voertuig row (simulates stale persistence missing the newer collection)
  for (const s of compiled.seed!) if (s.row !== 'veh-1') core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const ins = core.read('ins__applications')[0];
  const fin = core.read('fin__financings')[0];
  assert.notEqual((ins.doc.premium as { t?: string })?.t, 'error', `premium must not be a #TYPE error, got ${JSON.stringify(ins.doc.premium)}`);
  assert.notEqual((fin.doc.combinedMonthly as { t?: string })?.t, 'error', 'and the combined total must still be money, not an error');
});

test('compileJourney minimal: the compiled Individu step carries ONLY the needed fields (16 → 6)', () => {
  const stepsOf = (d: JourneyDoc): { id: string; fields: string[] }[] => (compileJourney(d, registry()) as unknown as { journey: { steps: { id: string; fields: string[] }[] } }).journey.steps;
  const on = stepsOf(journeyDoc()).find((s) => s.id === 'ind')!;
  // grossIncome + monthlyObligations now appear BECAUSE the financing binds them (affordability) — the
  // minimal set is derived from the composition, so adding the income seam surfaces exactly those inputs.
  assert.deepEqual([...on.fields].sort(), ['age', 'annualKm', 'grossIncome', 'monthlyObligations', 'schadevrijeJaren', 'usage'], 'minimal on → the 6 fields the journey provably needs');
  const off = stepsOf({ ...journeyDoc(), minimal: false }).find((s) => s.id === 'ind')!;
  assert.equal(off.fields.length, 16, 'minimal off → the full authored profile (16 fields)');
});

test('income→financing: the composed default is affordable, with a real max-financing amount & gross monthly', () => {
  const fin = seededJourney().read('fin__financings')[0].doc as Record<string, { t?: string; v?: string; minor?: string | number }>;
  // grossIncome €45.000 (from the Individu example) crosses the seam → gross monthly = €3.750
  assert.equal(fin.grossMonthly?.t, 'money', 'bruto maandinkomen is money, not blank/error');
  assert.equal(String(fin.grossMonthly?.minor), '375000', '€45.000 / 12 = €3.750,00');
  // maxFinancing is a real money ceiling (~€20.833 at 15% leennorm over 48mo @ 7,4%), and the default fits
  assert.equal(fin.maxFinancing?.t, 'money', 'maximaal te financieren is a money amount');
  assert.equal(fin.affordability?.t, 'enum', 'affordability is a categorical verdict');
  assert.equal(fin.affordability?.v, 'ok', 'financed €14.500 ≤ max ~€20.833 → past binnen uw inkomen');
  // affordable → no shortfall shown (blank), never a misleading € 0,00 or a #TYPE
  assert.equal(fin.financingShortfall?.t, 'blank', 'no shortfall when the financing fits');
  assert.notEqual(fin.maxFinancing?.t, 'error', 'and nothing rolled up to a #TYPE');
});

test('income→financing: a low income makes the SAME car unaffordable, surfacing the extra down payment needed', () => {
  const core = seededJourney();
  // drop the individual income to €18.000 → gross monthly €1.500 → max monthly credit €225 → max financing well
  // below the €14.500 financed: the verdict flips to "short" and the shortfall (extra aanbetaling) appears.
  core.apply('ind__individuals', [{ op: 'setField', row: 'ind-1', field: 'grossIncome', value: { t: 'money', minor: '1800000', ccy: 'EUR', scale: 2 } }]);
  const fin = core.read('fin__financings')[0].doc as Record<string, { t?: string; v?: string; minor?: string | number }>;
  assert.equal(fin.affordability?.v, 'short', 'low income → aanbetaling nodig');
  assert.equal(fin.financingShortfall?.t, 'money', 'the extra down payment needed is a real money amount');
  assert.ok(Number(fin.financingShortfall?.minor) > 0, 'and it is strictly positive');
  assert.notEqual(fin.combinedMonthly?.t, 'error', 'the total is still money, never a #TYPE');
});

test('income→financing: with NO income the verdict is "unknown", not a false "unaffordable" or a #TYPE', () => {
  const core = seededJourney();
  core.apply('ind__individuals', [{ op: 'setField', row: 'ind-1', field: 'grossIncome', value: { t: 'blank' } }]);
  const fin = core.read('fin__financings')[0].doc as Record<string, { t?: string; v?: string }>;
  assert.equal(fin.affordability?.v, 'unknown', 'no income → "vul inkomen in", not a misleading negative');
  assert.equal(fin.grossMonthly?.t, 'blank', 'gross monthly is blank, not num(0) or #TYPE');
  assert.equal(fin.maxFinancing?.t, 'blank', 'and so is the max financing');
  assert.notEqual(fin.finMonthly?.t, 'error', 'the actual monthly is unaffected and still money');
});

test('seam robustness (num): a CLEARED band input (annualKm/age) rolls up to BLANK → premium is incomplete, NOT a silent misprice', () => {
  // With agg=min for num too, clearing a user-entered driver field makes the composed premium BLANK (the
  // standalone cassette's own "incomplete" semantics) — instead of num(0), which would slip past the
  // if(eq(field,blank),…) surcharge guards and land in an extreme band (a cleared km reading as the cheapest,
  // a cleared age as the youngest/dearest): a plausible-but-wrong finished price with no error.
  for (const field of ['annualKm', 'age']) {
    const core = seededJourney();
    core.apply('ind__individuals', [{ op: 'setField', row: 'ind-1', field, value: { t: 'blank' } }]);
    const ins = core.read('ins__applications')[0].doc as Record<string, { t?: string }>;
    assert.equal(ins.premium?.t, 'blank', `clearing ${field} makes the premium incomplete (blank), not a computed misprice`);
  }
});

test('surface robustness: a BLANK surfaced premium (cover cleared) → the total is BLANK, not an add(num,money) #TYPE', () => {
  const core = seededJourney();
  // cover is an UNBOUND, editable insurance input; clearing it makes ins.premium BLANK. The surface rollup
  // must yield BLANK (agg=min), so combinedMonthly = add(insPremium, finMonthly) propagates BLANK — not
  // num(0)+money, which raised "#TYPE add(num, money)" at the journey's headline total.
  core.apply('ins__applications', [{ op: 'setField', row: 'ins-1', field: 'cover', value: { t: 'blank' } }]);
  const fin = core.read('fin__financings')[0].doc as Record<string, { t?: string }>;
  assert.notEqual(fin.combinedMonthly?.t, 'error', 'the combined total must not be a #TYPE');
  assert.equal(fin.combinedMonthly?.t, 'blank', 'it is an incomplete (blank) total while the premium is missing');
});

test('loyaltyDiscount guard: a cleared loyalty year gives 0% discount (full rate), never a false MAX discount', () => {
  const core = seededJourney();
  // schadevrijeJaren feeds fin.loyaltyYears; cleared → the seam rolls up to BLANK. Because blank sorts LAST,
  // an unguarded gte(loyaltyYears,10) would be TRUE and hand out the 1,0% max discount for entering nothing.
  // The blank guard pins it to 0% so annualRate stays the full base rate.
  core.apply('ind__individuals', [{ op: 'setField', row: 'ind-1', field: 'schadevrijeJaren', value: { t: 'blank' } }]);
  const fin = core.read('fin__financings')[0].doc as Record<string, { t?: string; v?: number }>;
  assert.equal(fin.loyaltyDiscount?.t, 'num', 'loyalty discount is a real number, not blank/error');
  assert.equal(fin.loyaltyDiscount?.v, 0, 'a missing loyalty input gives NO discount, not the maximum');
});

test('affordability tunable: the leennorm ratio (0.15) is a SINGLE editable knob — the clamp cannot desync', () => {
  // the clamp0 idiom on maxMonthlyCredit references the capacity from ONE field (creditCapacity), and the
  // ratio lives in ONE field (leennorm). So the Loom's per-literal editor exposes 0.15 exactly once; the
  // clamp guard and clamp value can no longer diverge into a negative/wrong capacity.
  const fin = read('financing.json');
  const countLit = (node: unknown, v: number): number => {
    let n = 0;
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      const o = x as { op?: string; value?: { t?: string; v?: number }; [k: string]: unknown };
      if (o.op === 'lit' && o.value?.t === 'num' && o.value.v === v) n++;
      for (const val of Object.values(o)) Array.isArray(val) ? val.forEach(walk) : walk(val);
    };
    walk(node);
    return n;
  };
  const props = fin.collections[0].properties as { id: string; formula?: unknown }[];
  const total = props.reduce((acc, p) => acc + countLit(p.formula, 0.15), 0);
  assert.equal(total, 1, 'the 15% leennorm literal appears exactly once (in the leennorm field), not duplicated across a clamp');
  const leennorm = props.find((p) => p.id === 'leennorm')!;
  assert.equal(countLit(leennorm.formula, 0.15), 1, 'and that single occurrence is the leennorm knob');
});

test('data-minimization: an author-declared COMPUTED readout is shown, but pulls in NO extra stored collection', () => {
  const finMin = neededFields(journeyDoc(), 'fin', registry());
  // the affordability readouts (computed) are shown because the fin section lists them...
  for (const readout of ['grossMonthly', 'maxFinancing', 'affordability', 'financingShortfall']) {
    assert.ok(finMin.shown.includes(readout), `${readout} is an author-declared readout, so it is shown`);
  }
  // ...yet the seam-provided inputs they read stay ABSENT from what fin collects (bound upstream, not entered here)
  assert.ok(!finMin.shown.includes('grossAnnualIncome') && !finMin.shown.includes('monthlyObligations'), 'the bound income inputs are never collected on the financing side');
});
