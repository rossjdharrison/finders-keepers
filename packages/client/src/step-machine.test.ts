import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore, mockExterns } from '@app/core-runtime';
import type { Value } from '@core/values';

// The composed journey's step machine: the `step` enum + guarded transitions live on the SPINE, but
// each step is confirmed on a CHILD row (vehicles/drivers/covers). A transition may only fire once the
// spine's ready gate — a rollup of the child's confirmation — is satisfied. This proves the whole
// cross-collection wizard advances through the SAME sealed core, with the guards the renderer reads.

const composed = JSON.parse(
  readFileSync(new URL('../../core-runtime/cassettes/car-insurance-composed.json', import.meta.url), 'utf8'),
);
const ref = (id: string): Value => ({ t: 'ref', collection: 'applications', id });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const num = (v: number): Value => ({ t: 'num', v });
const text = (v: string): Value => ({ t: 'text', v });
const bool = (v: boolean): Value => ({ t: 'bool', v });

function seeded() {
  const core = createCore(mockExterns());
  core.load(composed);
  core.apply('applications', [{ op: 'insert', row: 'a', values: { step: en('step', 'vehicle'), paymentTerm: en('paymentTerm', 'monthly') } }]);
  core.apply('vehicles', [{ op: 'insert', row: 'v', values: { app: ref('a'), plate: text('99-XYZ-1'), confirmed: bool(false) } }]);
  core.apply('drivers', [{ op: 'insert', row: 'd', values: { app: ref('a'), postcode: text('1011 AB'), age: num(40), schadevrijeJaren: num(6), annualKm: num(15000), usage: en('usage', 'commute'), confirmed: bool(false) } }]);
  core.apply('covers', [{ op: 'insert', row: 'c', values: { app: ref('a'), cover: en('coverLevel', 'allrisk'), optLegalAid: bool(true), confirmed: bool(false) } }]);
  return core;
}
const app = (core: ReturnType<typeof seeded>) => core.read('applications').find((r) => r.id === 'a')!;
const canGo = (core: ReturnType<typeof seeded>, to: string): boolean | undefined =>
  (app(core).actions ?? []).find((x) => x.field === 'step' && x.to === to)?.enabled;

test('the guarded step transition is BLOCKED until the child is confirmed, then advances (cross-collection)', () => {
  const core = seeded();
  assert.equal((app(core).doc.vehicleReady as { v: boolean }).v, false);
  assert.equal(canGo(core, 'driver'), false, 'toDriver blocked before confirm');

  core.apply('vehicles', [{ op: 'setField', row: 'v', field: 'confirmed', value: bool(true) }]);
  assert.equal((app(core).doc.vehicleReady as { v: boolean }).v, true, 'confirming the vehicle child flips the spine gate');
  assert.equal(canGo(core, 'driver'), true, 'toDriver now enabled');

  core.apply('applications', [{ op: 'setField', row: 'a', field: 'step', value: en('step', 'driver') }]);
  assert.equal((app(core).doc.step as { v: string }).v, 'driver');
  assert.equal(canGo(core, 'cover'), false, 'toCover blocked until the driver is confirmed');
});

test('the full journey walks vehicle → driver → cover → review, each gated by its own configurator', () => {
  const core = seeded();
  const confirmAdvance = (child: string, row: string, to: string): void => {
    core.apply(child, [{ op: 'setField', row, field: 'confirmed', value: bool(true) }]);
    assert.equal(canGo(core, to), true, `toward ${to} enabled after confirming ${child}`);
    core.apply('applications', [{ op: 'setField', row: 'a', field: 'step', value: en('step', to) }]);
    assert.equal((app(core).doc.step as { v: string }).v, to);
  };
  confirmAdvance('vehicles', 'v', 'driver');
  confirmAdvance('drivers', 'd', 'cover');
  confirmAdvance('covers', 'c', 'review');
  // reached the terminal step with a fully composed premium
  assert.equal(String((app(core).doc.premium as { minor: unknown }).minor), '2550');
});
