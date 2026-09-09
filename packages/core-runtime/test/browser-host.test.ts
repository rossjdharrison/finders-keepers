import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserHost } from '../src/browser-host.ts';
import type { Broadcaster, Persistence } from '../src/browser-host.ts';
import { mockExterns } from '../src/mock-externs.ts';
import type { Cassette, Snapshot } from '../src/types.ts';

const carInsurance = JSON.parse(readFileSync(new URL('../cassettes/car-insurance.json', import.meta.url), 'utf8')) as Cassette;
const text = (v: string) => ({ t: 'text' as const, v });
const num = (v: number) => ({ t: 'num' as const, v });
const enumV = (set: string, v: string) => ({ t: 'enum' as const, set, v });
const minor = (v: unknown): number => Number((v as { minor: string }).minor);

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
// a mock IndexedDB: one shared snapshot slot
function sharedPersistence(): Persistence {
  let saved: Snapshot | null = null;
  return { loadSnapshot: async () => saved, saveSnapshot: async (s) => void (saved = s) };
}

test('cross-tab: an edit in one host reaches another via the broadcaster (no server)', async () => {
  const hub = makeHub();
  const a = await createBrowserHost(carInsurance, mockExterns(), { broadcaster: hub.channel('A') });
  const b = await createBrowserHost(carInsurance, mockExterns(), { broadcaster: hub.channel('B') });

  a.apply('applications', [{ op: 'insert', row: 'a1', values: { plate: text('12-ABC-3'), cover: enumV('coverLevel', 'allrisk'), schadevrijeJaren: num(6) } }]);

  assert.equal(b.read('applications').length, 1);
  assert.equal(minor(b.read('applications')[0].doc.premium), 1050);
});

test('the computed snapshot travels, not the recipe: the receiving tab never re-runs the extern', async () => {
  const hub = makeHub();
  const aExterns = mockExterns();
  const bExterns = mockExterns();
  const a = await createBrowserHost(carInsurance, aExterns, { broadcaster: hub.channel('A') });
  const b = await createBrowserHost(carInsurance, bExterns, { broadcaster: hub.channel('B') });

  a.apply('applications', [{ op: 'insert', row: 'a1', values: { plate: text('99-XYZ-1'), cover: enumV('coverLevel', 'waplus'), schadevrijeJaren: num(3) } }]);

  assert.ok(aExterns.calls.length > 0); // A reached the RDW extern once
  assert.equal(bExterns.calls.length, 0); // B did NOT — it received the already-computed state
  assert.equal((b.read('applications')[0].doc.vehicleDesc as { v: string }).v, 'Tesla Model 3 2022');
});

test('durability: a fresh host restores prior state from persistence (no server, no replay)', async () => {
  const persistence = sharedPersistence();
  const a = await createBrowserHost(carInsurance, mockExterns(), { persistence });
  a.apply('applications', [{ op: 'insert', row: 'a1', values: { plate: text('AB-123-C'), cover: enumV('coverLevel', 'wa'), schadevrijeJaren: num(1) } }]);

  const reopened = await createBrowserHost(carInsurance, mockExterns(), { persistence });
  const [row] = reopened.read('applications');
  assert.equal((row.doc.vehicleDesc as { v: string }).v, 'Fiat Panda 2015');
  // wa 4.00 + low 1.00 (6,800 < 10,000), no discount (1 < 5) = 5.00
  assert.equal(minor(row.doc.premium), 500);
});
