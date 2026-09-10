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

const read = (f: string): Cassette => JSON.parse(readFileSync(new URL('../../../core-runtime/cassettes/' + f, import.meta.url), 'utf8'));
const id = (s: string): string => s;

const carInsurance = (): Cassette => read('car-insurance.json');
const composed = (): Cassette => read('car-insurance-composed.json');
const journeyDoc = (): JourneyDoc => read('auto-package.json') as unknown as JourneyDoc;
// the auto-package now composes FOUR products: voertuig, adres, car-insurance, financing
const registry = (): Record<string, Cassette> => ({ 'car-insurance': carInsurance(), financing: read('financing.json'), voertuig: read('voertuig.json'), adres: read('adres.json') });
const compiledJourney = (): Cassette => compileJourney(journeyDoc(), registry());

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

test('buildJourneyGraph: four configurators become boxes, the spine sits downstream, every binding is a wire', () => {
  const jg = buildJourneyGraph(journeyDoc(), { label: id });
  assert.equal(jg.boxes.length, 4, 'voertuig, adres, verzekering, financiering');
  const fin = jg.boxes.find((b) => b.alias === 'fin')!;
  const veh = jg.boxes.find((b) => b.alias === 'veh')!;
  assert.equal(fin.isSpine, true, 'the spine (financiering) carries the total');
  assert.ok(fin.rank > veh.rank, 'the upstream voertuig sits left of the downstream financing');
  assert.equal(jg.wires.length, 4, 'four bindings');
  // the car value feeds BOTH insurance and financing (functional decomposition: one choice, two consumers)
  const vehWires = jg.wires.filter((w) => w.from === 'veh');
  assert.equal(vehWires.length, 2, 'voertuig feeds two consumers');
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
  const loyalty = gated.bindings.find((b) => b.id === 'insToFinLoyalty')!;
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

test('journey-edit: removing the only ins→spine binding still compiles — the surface synthesizes its own relation', () => {
  // insToFinLoyalty was the sole ins→fin relation the insPremium surface rode on; with surface
  // auto-synthesis, dropping it no longer orphans the surface (edit-safe composition editing)
  const res = previewJourney(removeBinding(journeyDoc(), 'insToFinLoyalty'), registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(res.total && res.total.t === 'money', 'the combined total still computes with the surfaced premium');
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
