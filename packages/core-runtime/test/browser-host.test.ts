import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserHost } from '../src/browser-host.ts';
import type { Broadcaster, Persistence } from '../src/browser-host.ts';
import { mockExterns } from '../src/mock-externs.ts';
import type { Cassette, Snapshot } from '../src/types.ts';
import type { Value } from '@core/values';

const cassette = JSON.parse(readFileSync(new URL('../cassettes/car-insurance.json', import.meta.url), 'utf8')) as Cassette;
const text = (v: string): Value => ({ t: 'text', v });
const num = (v: number): Value => ({ t: 'num', v });
const en = (set: string, v: string): Value => ({ t: 'enum', set, v });
const bool = (v: boolean): Value => ({ t: 'bool', v });
const minor = (v: unknown): number => Number((v as { minor: string }).minor);
const sv = (v: unknown): string => (v as { v: string }).v;
const full: Record<string, Value> = {
  step: en('step', 'quote'), plate: text('99-XYZ-1'), vehicleConfirmed: bool(true), postcode: text('1011 AB'),
  age: num(40), schadevrijeJaren: num(6), annualKm: num(15000), usage: en('usage', 'commute'), driverConfirmed: bool(true),
  cover: en('coverLevel', 'allrisk'), coverConfirmed: bool(true), optLegalAid: bool(true), paymentTerm: en('paymentTerm', 'monthly'),
};
const appById = (h: { read: (c: string) => { id: string; doc: Record<string, Value> }[] }, id: string) => h.read('applications').find((r) => r.id === id)!;

// a mock BroadcastChannel hub: post reaches every OTHER channel (never the sender), like the real one
function makeHub() {
  const listeners = new Map<string, (s: Snapshot) => void>();
  return {
    channel: (id: string): Broadcaster => ({
      post: (s) => { for (const [oid, cb] of listeners) if (oid !== id) cb(s); },
      onMessage: (cb) => void listeners.set(id, cb),
    }),
  };
}
function sharedPersistence(): Persistence {
  let saved: Snapshot | null = null;
  return { loadSnapshot: async () => saved, saveSnapshot: async (s) => void (saved = s) };
}

test('the cassette seeds itself when empty (an example quote renders with a premium)', async () => {
  const h = await createBrowserHost(cassette, mockExterns());
  const demo = appById(h, 'app-demo');
  assert.equal(sv(demo.doc.vehicleDesc), 'Tesla Model 3 2022');
  assert.equal(minor(demo.doc.premium), 2550); // the seeded scenario computes end-to-end
});

test('cross-tab: an edit in one host reaches another via the broadcaster (no server)', async () => {
  const hub = makeHub();
  const persistence = sharedPersistence(); // shared so neither re-seeds; A writes it first
  const a = await createBrowserHost(cassette, mockExterns(), { persistence, broadcaster: hub.channel('A') });
  const b = await createBrowserHost(cassette, mockExterns(), { broadcaster: hub.channel('B') });

  a.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);
  const onB = appById(b, 'a1');
  assert.equal(sv(onB.doc.vehicleDesc), 'Tesla Model 3 2022');
  assert.equal(minor(onB.doc.premium), 2550); // B holds the same computed premium as A
});

test('the computed snapshot travels, not the recipe: the receiving tab never re-runs the extern', async () => {
  const hub = makeHub();
  const aExterns = mockExterns();
  const bExterns = mockExterns();
  const a = await createBrowserHost(cassette, aExterns, { broadcaster: hub.channel('A') });
  const b = await createBrowserHost(cassette, bExterns, { broadcaster: hub.channel('B') });
  const before = bExterns.calls.length; // B ran externs only for its own seed

  a.apply('applications', [{ op: 'insert', row: 'a1', values: full }]);

  assert.ok(aExterns.calls.length > 0);
  assert.equal(bExterns.calls.length, before); // B did NOT re-run externs for A's edit
  assert.equal(sv(appById(b, 'a1').doc.city), 'Amsterdam');
});

test('durability: a fresh host restores prior state from persistence (no server, no replay)', async () => {
  const persistence = sharedPersistence();
  const a = await createBrowserHost(cassette, mockExterns(), { persistence });
  a.apply('applications', [{ op: 'insert', row: 'fiat', values: { ...full, plate: text('AB-123-C'), cover: en('coverLevel', 'wa') } }]);

  const reopened = await createBrowserHost(cassette, mockExterns(), { persistence });
  assert.equal(sv(appById(reopened, 'fiat').doc.vehicleDesc), 'Fiat Panda 2015');
});
