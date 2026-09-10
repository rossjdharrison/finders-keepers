import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette } from '@app/core-runtime';
import { compileJourney, type JourneyDoc } from '../compile-journey.ts';
import { projectStructure } from './structure.ts';
import { buildGraph } from './graph.ts';
import { buildJourneyGraph } from './journey-graph.ts';

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

test('buildJourneyGraph: models become boxes, the spine sits downstream, the binding is a wire', () => {
  const jg = buildJourneyGraph(journeyDoc(), { label: id });
  assert.equal(jg.boxes.length, 2, 'two member products');
  const fin = jg.boxes.find((b) => b.alias === 'fin')!;
  const ins = jg.boxes.find((b) => b.alias === 'ins')!;
  assert.equal(fin.isSpine, true, 'the spine carries the total');
  assert.ok(fin.rank > ins.rank, 'the downstream spine sits right of its upstream supplier');
  assert.equal(jg.wires.length, 1, 'one binding');
  assert.equal(jg.wires[0].from, 'ins');
  assert.equal(jg.wires[0].to, 'fin');
  assert.equal(jg.total.field, 'combinedMonthly');
  assert.ok(jg.surface.length >= 1, 'the surfaced insurance premium line is present');
});
