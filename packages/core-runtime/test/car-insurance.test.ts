import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore } from '../src/core.ts';
import { mockExterns } from '../src/mock-externs.ts';
import type { Cassette } from '../src/types.ts';

const cassette = JSON.parse(readFileSync(new URL('../cassettes/car-insurance.json', import.meta.url), 'utf8')) as Cassette;
const enumV = (set: string, v: string) => ({ t: 'enum' as const, set, v });
const num = (v: number) => ({ t: 'num' as const, v });
const text = (v: string) => ({ t: 'text' as const, v });
// @core stores money `minor` as a STRING (arbitrary precision — the reason f64 wasm was dropped).
const minor = (v: unknown): number => Number((v as { minor: string }).minor);

test('the sealed core loads the cassette, reaches the world only through the RDW extern, and computes a premium', () => {
  const host = mockExterns();
  const core = createCore(host);
  core.load(cassette);

  const [row] = core.apply('applications', [
    { op: 'insert', row: 'a1', values: { plate: text('12-ABC-3'), cover: enumV('coverLevel', 'allrisk'), schadevrijeJaren: num(6) } },
  ]);

  // the ONLY egress was the extern (mock API) — called for the vehicle lookup
  assert.ok(host.calls.some((c) => c.name === 'rdwValue' && c.params.plate?.t === 'text' && c.params.plate.v === '12-ABC-3'));
  assert.ok(host.calls.some((c) => c.name === 'rdwDesc'));

  // extern-sourced fields, from the mocked RDW register
  assert.equal((row.doc.vehicleDesc as { v: string }).v, 'Volkswagen Golf 2019');
  assert.equal(minor(row.doc.vehicleValue), 1850000); // EUR 18,500

  // the configurator: valueBand from the vehicle value; premium from cover x band, less no-claim discount
  assert.equal((row.doc.valueBand as { v: string }).v, 'mid'); // 10k <= 18.5k < 25k
  // allrisk 11.00 + mid 3.00 = 14.00 ; 6 claim-free years -> less allrisk discount 3.50 = 10.50
  assert.equal(minor(row.doc.premium), 1050);
  assert.equal((row.doc.premium as { ccy: string }).ccy, 'EUR');
});

test('a different choice recomputes; an unknown plate falls back; <5 claim-free years gets no discount', () => {
  const core = createCore(mockExterns());
  core.load(cassette);

  const [row] = core.apply('applications', [
    { op: 'insert', row: 'a2', values: { plate: text('ZZ-99-ZZ'), cover: enumV('coverLevel', 'wa'), schadevrijeJaren: num(2) } },
  ]);
  assert.equal(minor(row.doc.vehicleValue), 1200000); // default EUR 12,000
  assert.equal((row.doc.valueBand as { v: string }).v, 'mid');
  // wa 4.00 + mid 3.00 = 7.00, no discount (2 < 5)
  assert.equal(minor(row.doc.premium), 700);

  // change the cover -> premium recomputes through the same sealed boundary
  const [upgraded] = core.apply('applications', [{ op: 'setField', row: 'a2', field: 'cover', value: enumV('coverLevel', 'allrisk') }]);
  assert.equal(minor(upgraded.doc.premium), 1400); // allrisk 11 + mid 3, still no discount
});

test('the core validates any cassette it loads: a dangling type is refused (HQDM reducibility)', () => {
  const bad = { ...cassette, types: { ...cassette.types, Application: { specializes: ['nowhere'] } } };
  assert.throws(() => createCore(mockExterns()).load(bad as Cassette), /does not reduce to HQDM/);
});
