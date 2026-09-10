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
const compiledJourney = (): Cassette => compileJourney(journeyDoc(), { 'car-insurance': carInsurance(), financing: read('financing.json') } as never);

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
  const seam = g.edges.filter((e) => e.kind === 'rollup' && (e.label ?? '').includes('rel_valToPrincipal'));
  assert.ok(seam.length >= 1, 'the cross-cassette binding is visible as a rollup edge');
  const output = g.nodes.find((n) => n.id === 'combinedMonthly')!;
  assert.equal(output.isOutput, true, "the journey's combined total is the highlighted output");
  assert.equal(g.cycle.length, 0, 'the compiled journey is acyclic');
});

// --- journey composition graph -------------------------------------------------------------------

test('buildJourneyGraph: models become boxes, the spine sits downstream, every binding is a wire', () => {
  const jg = buildJourneyGraph(journeyDoc(), { label: id });
  assert.equal(jg.boxes.length, 2, 'two member products');
  const fin = jg.boxes.find((b) => b.alias === 'fin')!;
  const ins = jg.boxes.find((b) => b.alias === 'ins')!;
  assert.equal(fin.isSpine, true, 'the spine carries the total');
  assert.ok(fin.rank > ins.rank, 'the downstream spine sits right of its upstream supplier');
  assert.equal(jg.wires.length, 2, 'two bindings (value→principal and no-claim→loyalty)');
  for (const w of jg.wires) {
    assert.equal(w.from, 'ins');
    assert.equal(w.to, 'fin');
  }
  assert.equal(jg.total.field, 'combinedMonthly');
  assert.ok(jg.surface.length >= 1, 'the surfaced insurance premium line is present');
});

// --- compile-journey: multiple bindings between the same pair, + conditional bindings --------------

const num = (v: unknown): number => Number((v as { v?: unknown })?.v ?? v);

test('compileJourney: two bindings between the same pair share ONE ref/seed row; the loyalty rate flows', () => {
  const registry = { 'car-insurance': carInsurance(), financing: read('financing.json') };
  const compiled = compileJourney(journeyDoc(), registry as never);
  // exactly one __to_fin ref field on the child (not one per binding), and one seed row per model
  const child = compiled.collections.find((c) => c.id === 'ins__applications')!;
  const toRefs = child.properties.filter((p) => p.id === '__to_fin');
  assert.equal(toRefs.length, 1, 'the shared parent ref is declared once, not per binding');
  const insSeeds = compiled.seed!.filter((s) => s.row === 'ins-1');
  assert.equal(insSeeds.length, 1, 'the child is seeded once even though it binds twice');

  const core = createCore(mockExterns());
  core.load(compiled);
  for (const s of compiled.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings')[0];
  // schadevrijeJaren example = 6 → loyaltyYears bound to 6 → loyaltyDiscount 0.005 → annualRate = 0.079 − 0.005
  assert.equal(num(fin.doc.loyaltyYears), 6, 'loyaltyYears bound from the insurance no-claim years');
  assert.equal(num(fin.doc.loyaltyDiscount), 0.005, 'a 0.5% loyalty discount at 6 years');
  assert.ok(Math.abs(num(fin.doc.annualRate) - 0.074) < 1e-9, 'effective rate = base 0.079 − loyalty 0.005');
});

test('compileJourney: a conditional binding takes a typed zero when its condition is false', () => {
  const registry = { 'car-insurance': carInsurance(), financing: read('financing.json') };
  const gated = structuredClone(journeyDoc());
  // gate the loyalty binding on an impossible threshold (example schadevrijeJaren = 6) → never applies
  (gated.bindings[1] as { condition?: unknown }).condition = { op: 'gte', args: [{ op: 'field', id: 'schadevrijeJaren' }, { op: 'lit', value: { t: 'num', v: 100 } }] };
  const compiled = compileJourney(gated, registry as never);
  const core = createCore(mockExterns());
  core.load(compiled);
  for (const s of compiled.seed!) core.apply(s.coll, [{ op: 'insert', row: s.row, values: s.values }]);
  const fin = core.read('fin__financings')[0];
  assert.equal(num(fin.doc.loyaltyYears), 0, 'gated-off binding yields the typed zero, not the provided 6');
  assert.equal(num(fin.doc.loyaltyDiscount), 0, 'so no loyalty discount applies');
  assert.ok(Math.abs(num(fin.doc.annualRate) - 0.079) < 1e-9, 'the effective rate is the base rate');
});

// --- journey-edit ops (each validated by recompile, exactly as the editor does) ------------------

const registry = (): Record<string, Cassette> => ({ 'car-insurance': carInsurance(), financing: read('financing.json') });
const minor = (v: unknown): number => Number((v as { minor?: unknown })?.minor);

test('journey-edit: previewJourney compiles + totals the shipped journey', () => {
  const res = previewJourney(journeyDoc(), registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(res.total && res.total.t === 'money', 'a sample combined total is produced');
});

test('journey-edit: editing a binding mapping (finance half the car) lowers the combined total', () => {
  const base = previewJourney(journeyDoc(), registry());
  const edited = setBindingMapping(journeyDoc(), 'valToPrincipal', { op: 'mul', args: [{ op: 'field', id: 'vval' }, { op: 'lit', value: { t: 'num', v: 0.5 } }] });
  const res = previewJourney(edited, registry());
  assert.equal(res.ok, true, res.error);
  assert.ok(minor(res.total) < minor(base.total), 'financing half the catalogue value cuts the monthly');
});

test('journey-edit: removing a binding still compiles (target reverts to a stored input)', () => {
  const res = previewJourney(removeBinding(journeyDoc(), 'noClaimToLoyalty'), registry());
  assert.equal(res.ok, true, res.error);
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
  // gate the money binding valToPrincipal on a child field; the else-branch zero must unify with the mapped money
  const gated = setBindingCondition(journeyDoc(), 'valToPrincipal', { op: 'gte', args: [{ op: 'field', id: 'schadevrijeJaren' }, { op: 'lit', value: { t: 'num', v: 0 } }] });
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
