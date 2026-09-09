// The vendor-model proof: the COMMITTED artifact (vendor/core.bundle.js), loaded into a QuickJS
// wasm, driven only through injected externs, produces the same aanvragen quote as the in-process
// core — and the value domain (money.minor as a STRING) survives the wasm round-trip byte-for-byte.
//
// If this passes, the target environment can run the exact same bytes with no build step of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSealedCore } from '../src/host.ts';
import { mockExterns } from '@app/core-runtime';
import type { Value } from '@core/values';

const bundle = readFileSync(new URL('../vendor/core.bundle.js', import.meta.url), 'utf8');
const cassette = JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/car-insurance.json', import.meta.url), 'utf8'));

const text = (v: string): Value => ({ t: 'text', v });
const num = (v: number): Value => ({ t: 'num', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const bool = (v: boolean): Value => ({ t: 'bool', v });

// The same "full quote" fixture as packages/core-runtime/test/car-insurance.test.ts.
const full: Record<string, Value> = {
  step: en('step', 'vehicle'), plate: text('99-XYZ-1'), vehicleConfirmed: bool(true),
  postcode: text('1011 AB'), age: num(40), schadevrijeJaren: num(6), annualKm: num(15000),
  usage: en('usage', 'commute'), driverConfirmed: bool(true), cover: en('coverLevel', 'allrisk'), coverConfirmed: bool(true),
  optLegalAid: bool(true), paymentTerm: en('paymentTerm', 'monthly'),
};

test('vendored core: the aanvragen premium round-trips through the wasm seam, externs injected', async () => {
  const ext = mockExterns();
  const core = await createSealedCore(bundle, ext);
  core.load(cassette);
  const rows = core.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);
  const a = rows.find((r) => r.id === 'a1')!;

  assert.equal((a.doc.vehicleDesc as { v: string }).v, 'Tesla Model 3 2022'); // RDW extern, injected
  assert.equal((a.doc.city as { v: string }).v, 'Amsterdam'); // region extern, injected
  assert.equal((a.doc.premium as { minor: string }).minor, '2550'); // €25.50, same as in-process
  assert.equal(typeof (a.doc.premium as { minor: unknown }).minor, 'string'); // the value domain survived (anti-f64)

  // egress proof: the sealed core (inside wasm) reached the world ONLY through the injected externs.
  const names = new Set(ext.calls.map((c) => c.name));
  for (const n of ['rdwDesc', 'rdwValue', 'regionBand', 'regionCity']) assert.ok(names.has(n), `expected extern ${n}`);
  core.dispose();
});

test('vendored core: guarded step transitions still throw across the wasm seam', async () => {
  const core = await createSealedCore(bundle, mockExterns());
  core.load(cassette);
  core.apply('applications', [{ op: 'insert', row: 'a1', values: { step: en('step', 'vehicle'), plate: text('99-XYZ-1') } }]);
  // vehicle→driver is blocked until vehicleConfirmed — the guard rejection propagates out of wasm.
  assert.throws(() => core.apply('applications', [{ op: 'setField', row: 'a1', field: 'step', value: en('step', 'driver') }]));
  core.dispose();
});

test('vendored core: availableWhen verdicts (hidden) survive the seam as data', async () => {
  const core = await createSealedCore(bundle, mockExterns());
  core.load(cassette);
  const [lo] = core.apply('applications', [{ op: 'insert', row: 'lo', values: { schadevrijeJaren: num(2) } }]);
  const [hi] = core.apply('applications', [{ op: 'insert', row: 'hi', values: { schadevrijeJaren: num(8) } }]);
  assert.ok((lo.hidden ?? []).includes('optNoClaimProtect')); // < 5 claim-free years → gated off
  assert.ok(!(hi.hidden ?? []).includes('optNoClaimProtect')); // ≥ 5 → in play
  core.dispose();
});

test('vendored core: snapshot / restore round-trips the workspace through the seam', async () => {
  const a = await createSealedCore(bundle, mockExterns());
  a.load(cassette);
  a.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);
  const snap = a.snapshot();
  a.dispose();

  const b = await createSealedCore(bundle, mockExterns());
  b.load(cassette);
  b.restore(snap);
  const a1 = b.read('applications').find((r) => r.id === 'a1')!;
  assert.equal((a1.doc.premium as { minor: string }).minor, '2550'); // restored quote intact
  b.dispose();
});
