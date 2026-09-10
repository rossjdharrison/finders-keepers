import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette } from '@app/core-runtime';
import { collectFormulaLiterals, setFormulaLiteral, tableCellMinor, setTableCell, previewCassette } from './model-edit.ts';

// the shipped flat cassette (the model). Read from core-runtime so the test exercises the REAL formulas.
const cass = JSON.parse(
  readFileSync(new URL('../../core-runtime/cassettes/car-insurance.json', import.meta.url), 'utf8'),
) as Cassette;
const composed = JSON.parse(
  readFileSync(new URL('../../core-runtime/cassettes/car-insurance-composed.json', import.meta.url), 'utf8'),
) as Cassette;
const minor = (v: unknown): string => String((v as { minor: unknown }).minor);
const COLL = cass.collections[0].id; // 'applications'
const propFormula = (id: string): unknown =>
  (cass.collections[0].properties.find((p) => p.id === id) as { formula?: unknown } | undefined)?.formula;

test('collectFormulaLiterals finds only the num/money thresholds & constants (never enum/blank/bool)', () => {
  // ageBand: if(age < 23, young, if(age < 65, standard, senior)) — two numeric thresholds, no enums
  const age = collectFormulaLiterals(propFormula('ageBand'));
  assert.deepEqual(age.map((l) => l.raw), [23, 65]);
  assert.ok(age.every((l) => l.valueType === 'num'));

  // sjBand: three numeric thresholds 5 / 10 / 15
  assert.deepEqual(collectFormulaLiterals(propFormula('sjBand')).map((l) => l.raw), [5, 10, 15]);

  // valueBand: two MONEY thresholds €10.000 / €25.000 (minor 1000000 / 2500000)
  const vb = collectFormulaLiterals(propFormula('valueBand'));
  assert.deepEqual(vb.map((l) => l.raw), [1000000, 2500000]);
  assert.ok(vb.every((l) => l.valueType === 'money'));

  // optLegalAidFee: if(optLegalAid, €3.00, €0.00) — two money constants, the bool field is NOT a literal
  assert.deepEqual(collectFormulaLiterals(propFormula('optLegalAidFee')).map((l) => l.raw), [300, 0]);

  // coverBase is a bare lookup — no editable literals
  assert.deepEqual(collectFormulaLiterals(propFormula('coverBase')), []);

  // vehicleReady: eq(vehicleConfirmed, true) — the bool lit is excluded
  assert.deepEqual(collectFormulaLiterals(propFormula('vehicleReady')), []);
});

test('setFormulaLiteral writes the right lit by its collected path, purely', () => {
  const [first, second] = collectFormulaLiterals(propFormula('ageBand'));
  const next = setFormulaLiteral(cass, COLL, 'ageBand', first.path, 25);
  // the edited cassette reflects 25 for the first threshold, 65 untouched for the second
  assert.deepEqual(collectFormulaLiterals(next.collections[0].properties.find((p) => p.id === 'ageBand')!.formula).map((l) => l.raw), [25, 65]);
  // second path still addresses 65
  assert.equal(second.raw, 65);
  // PURITY: the original cassette is unchanged
  assert.deepEqual(collectFormulaLiterals(propFormula('ageBand')).map((l) => l.raw), [23, 65]);
});

test('setFormulaLiteral preserves the money lit representation and rounds to integer minor', () => {
  const [fee] = collectFormulaLiterals(propFormula('optLegalAidFee'));
  const before = ((propFormula('optLegalAidFee') as { args: { value: { minor: unknown } }[] }).args[1].value.minor);
  const next = setFormulaLiteral(cass, COLL, 'optLegalAidFee', fee.path, 512); // €5.12
  const after = (next.collections[0].properties.find((p) => p.id === 'optLegalAidFee')!.formula as { args: { value: { minor: unknown } }[] }).args[1].value.minor;
  assert.equal(Number(after), 512);
  assert.equal(typeof after, typeof before); // representation (number vs string) preserved
});

test('setFormulaLiteral no-ops on a stale/invalid path instead of throwing', () => {
  const next = setFormulaLiteral(cass, COLL, 'ageBand', ['args', 99, 'args', 0], 1);
  assert.deepEqual(collectFormulaLiterals(next.collections[0].properties.find((p) => p.id === 'ageBand')!.formula).map((l) => l.raw), [23, 65]);
});

test('setFormulaLiteral keeps a STRING minor a string (canonical anti-f64 representation preserved)', () => {
  // this cassette's lits happen to use numeric minor; a hand-authored lit may use the canonical string.
  const synthetic = {
    collections: [{ id: 'c', properties: [{ id: 'f', formula: { op: 'lit', value: { t: 'money', minor: '300', ccy: 'EUR', scale: 2 } } }] }],
  } as unknown as Cassette;
  const next = setFormulaLiteral(synthetic, 'c', 'f', [], 512);
  const lit = (next.collections[0].properties.find((p) => p.id === 'f')!.formula as { value: { minor: unknown } }).value;
  assert.equal(lit.minor, '512');
  assert.equal(typeof lit.minor, 'string'); // representation preserved, integer kept
});

test('previewCassette computes the flat sample premium from the cassette example (€25,50)', () => {
  const res = previewCassette(cass);
  assert.equal(res.ok, true);
  assert.equal(minor(res.premium), '2550');
});

test('previewCassette computes the COMPOSED premium by applying the seed graph across collections (€25,50)', () => {
  const res = previewCassette(composed);
  assert.equal(res.ok, true, res.error);
  assert.equal(minor(res.premium), '2550'); // same rollup as the flat cassette — proves multi-collection preview
});

test('previewCassette reflects a composed rate edit (bandRate lives on the vehicles collection)', () => {
  // vehicles.bandRate.high drives the sample vehicle (value €41.000 → band high). Bump it +€10.
  const before = tableCellMinor(composed, 'vehicles', 'bandRate', 'high');
  assert.equal(before, 600); // €6.00 baseline (matches the composed test's vehicleSub)
  const edited = setTableCell(composed, 'vehicles', 'bandRate', 'high', 1600); // €16.00 (+€10)
  const res = previewCassette(edited);
  assert.equal(res.ok, true, res.error);
  assert.equal(minor(res.premium), '3550'); // €25,50 + €10 = €35,50
});

test('previewCassette surfaces an invalid composed edit as ok:false (throwaway core throws)', () => {
  const bad = structuredClone(composed) as unknown as { types: Record<string, unknown> };
  bad.types = { ...bad.types, Cover: { specializes: ['nowhere'] } }; // dangling HQDM type → buildPrepared throws
  const res = previewCassette(bad as unknown as Cassette);
  assert.equal(res.ok, false);
});

test('the slice-1 table ops still work (regression)', () => {
  const before = tableCellMinor(cass, COLL, 'coverRate', 'allrisk');
  const next = setTableCell(cass, COLL, 'coverRate', 'allrisk', 2000);
  assert.equal(tableCellMinor(next, COLL, 'coverRate', 'allrisk'), 2000);
  assert.equal(tableCellMinor(cass, COLL, 'coverRate', 'allrisk'), before); // purity
});
