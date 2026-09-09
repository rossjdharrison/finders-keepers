import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore } from '../src/core.ts';
import { mockExterns } from '../src/mock-externs.ts';
import type { Cassette } from '../src/types.ts';
import type { Value } from '@core/values';

const cassette = JSON.parse(readFileSync(new URL('../cassettes/car-insurance.json', import.meta.url), 'utf8')) as Cassette;
const text = (v: string): Value => ({ t: 'text', v });
const num = (v: number): Value => ({ t: 'num', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const bool = (v: boolean): Value => ({ t: 'bool', v });
const minor = (v: unknown): number => Number((v as { minor: string }).minor);
const sv = (v: unknown): string => (v as { v: string }).v;

// Tesla €41,000 (band high), allrisk, Amsterdam (region high), age 40 (standard), 15,000 km
// (mid), commute, 6 claim-free years (sjBand mid), + legal aid, monthly.
const full: Record<string, Value> = {
  step: en('step', 'vehicle'), plate: text('99-XYZ-1'), vehicleConfirmed: bool(true),
  postcode: text('1011 AB'), age: num(40), schadevrijeJaren: num(6), annualKm: num(15000),
  usage: en('usage', 'commute'), driverConfirmed: bool(true), cover: en('coverLevel', 'allrisk'), coverConfirmed: bool(true),
  optLegalAid: bool(true), paymentTerm: en('paymentTerm', 'monthly'),
};

test('the aanvragen premium is an additive money breakdown, vehicle + region from externs', () => {
  const core = createCore(mockExterns());
  core.load(cassette);
  const [row] = core.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);
  assert.equal(sv(row.doc.vehicleDesc), 'Tesla Model 3 2022'); // RDW extern
  assert.equal(sv(row.doc.city), 'Amsterdam'); // region extern
  assert.equal(minor(row.doc.gross), 2650); // 11+6 + 0+1.5 + 4+1 + 3.0 = 26.50
  assert.equal(minor(row.doc.noClaimDiscount), 150); // sjBand mid → €1.50
  assert.equal(minor(row.doc.premium), 2550); // 26.50 − 1.50 + 0.50 (monthly billing) = 25.50
});

test('extern-only egress: the core reaches the world only through the RDW + region mocks', () => {
  const ext = mockExterns();
  const core = createCore(ext);
  core.load(cassette);
  core.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);
  const names = new Set(ext.calls.map((c) => c.name));
  for (const n of ['rdwDesc', 'rdwValue', 'regionBand', 'regionCity']) assert.ok(names.has(n), `expected extern ${n}`);
});

test('the journey advances only through guarded step transitions (the verification seam)', () => {
  const core = createCore(mockExterns());
  core.load(cassette);
  core.apply('applications', [{ op: 'insert', row: 'a1', values: { step: en('step', 'vehicle'), plate: text('99-XYZ-1') } }]);
  const stepOf = (): string => sv(core.read('applications').find((r) => r.id === 'a1')!.doc.step);
  const set = (field: string, value: Value): unknown => core.apply('applications', [{ op: 'setField', row: 'a1', field, value }]);

  assert.throws(() => set('step', en('step', 'driver'))); // vehicle→driver blocked: not confirmed
  set('vehicleConfirmed', bool(true));
  set('step', en('step', 'driver'));
  assert.equal(stepOf(), 'driver');

  assert.throws(() => set('step', en('step', 'coverage'))); // driver→coverage blocked: not confirmed
  set('age', num(40));
  set('annualKm', num(15000));
  set('driverConfirmed', bool(true));
  set('step', en('step', 'coverage'));
  assert.equal(stepOf(), 'coverage');

  assert.throws(() => set('step', en('step', 'quote'))); // coverage→quote blocked: not confirmed
  set('coverConfirmed', bool(true));
  set('step', en('step', 'quote'));
  assert.equal(stepOf(), 'quote');
});

test('availableWhen: confirm-the-vehicle appears only once a vehicle is found (vehicleDesc set)', () => {
  const core = createCore(mockExterns());
  core.load(cassette);
  const [blank] = core.apply('applications', [{ op: 'insert', row: 'b', values: { step: en('step', 'vehicle') } }]);
  assert.ok((blank.hidden ?? []).includes('vehicleConfirmed')); // no plate → no vehicle → confirm hidden
  const [found] = core.apply('applications', [{ op: 'insert', row: 'v', values: { step: en('step', 'vehicle'), plate: text('99-XYZ-1') } }]);
  assert.ok(!(found.hidden ?? []).includes('vehicleConfirmed')); // RDW resolved vehicleDesc → confirm in play
});

test('availableWhen: the no-claim protector is in play only with ≥5 claim-free years', () => {
  const core = createCore(mockExterns());
  core.load(cassette);
  const low = core.apply('applications', [{ op: 'insert', row: 'lo', values: { schadevrijeJaren: num(2) } }]);
  const high = core.apply('applications', [{ op: 'insert', row: 'hi', values: { schadevrijeJaren: num(8) } }]);
  assert.ok((low[0].hidden ?? []).includes('optNoClaimProtect')); // < 5 → gated off
  assert.ok(!(high[0].hidden ?? []).includes('optNoClaimProtect')); // ≥ 5 → in play
});

test('the engine surfaces step actions with the guard verdict — one conditional function, as data', () => {
  const core = createCore(mockExterns());
  core.load(cassette);
  core.apply('applications', [{ op: 'insert', row: 'a1', values: { step: en('step', 'vehicle'), plate: text('99-XYZ-1') } }]);
  const toDriver = (): { enabled: boolean } | undefined => (core.read('applications').find((r) => r.id === 'a1')!.actions ?? []).find((a) => a.to === 'driver');
  assert.equal(toDriver()?.enabled, false); // the advance guard (vehicleReady) is not satisfied yet
  core.apply('applications', [{ op: 'setField', row: 'a1', field: 'vehicleConfirmed', value: bool(true) }]);
  assert.equal(toDriver()?.enabled, true); // same applicable() verdict, now true — surfaced for the button
});

test('the core validates any cassette: a dangling type is refused at load', () => {
  const core = createCore(mockExterns());
  const bad = { ...cassette, types: { ...cassette.types, Application: { specializes: ['nowhere'] } } } as Cassette;
  assert.throws(() => core.load(bad));
});
