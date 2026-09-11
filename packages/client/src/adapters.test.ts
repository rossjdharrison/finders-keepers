import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette, Snapshot } from '@app/core-runtime';
import { localStoragePersistence, snapshotSignature } from './adapters.ts';

// Node has no localStorage — a Map-backed stub so the persistence path is exercised.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const fin = (): Cassette => JSON.parse(readFileSync(new URL('../../core-runtime/cassettes/financing.json', import.meta.url), 'utf8')) as Cassette;
const SNAP = { seq: 3, rows: {} } as unknown as Snapshot;

test('snapshotSignature: stable across a formula-literal change; changes when a field or seed row is added', () => {
  const sigA = snapshotSignature(fin());

  // tuning a formula LITERAL (a rule) does not change the SHAPE → same signature (so editing a rate must
  // not wipe a user's persisted form state)
  const b = fin();
  (b.collections[0].properties.find((p) => p.id === 'leennorm') as { formula: { value: { v: number } } }).formula.value.v = 0.2;
  assert.equal(snapshotSignature(b), sigA, 'a tuned literal keeps the same shape signature');

  // adding a FIELD changes the shape → different signature
  const c = fin();
  (c.collections[0].properties as { id: string; valueType: { k: string }; source: string }[]).push({ id: 'newField', valueType: { k: 'num' }, source: 'stored' });
  assert.notEqual(snapshotSignature(c), sigA, 'a new field changes the signature');

  // adding a SEED ROW changes the shape → different signature (this is what a new configurator does)
  const d = fin();
  (d as { seed: { coll: string; row: string; values: Record<string, unknown> }[] }).seed.push({ coll: 'financings', row: 'fin-2', values: {} });
  assert.notEqual(snapshotSignature(d), sigA, 'a new seed row changes the signature');

  // renaming an ENUM OPTION id changes the signature — else a stored value pointing at the old option would
  // be restored and fall through a lookup default = a silent wrong price (the confirmed HIGH finding)
  const e = fin();
  const term = (e as { enums: Record<string, { id: string }[]> }).enums.term;
  term[0].id = 't11';
  assert.notEqual(snapshotSignature(e), sigA, 'a renamed enum option changes the signature');

  // changing a field's TYPE changes the signature (a restored value of the old type would be invalid)
  const f = fin();
  (f.collections[0].properties.find((p) => p.id === 'loyaltyYears') as { valueType: { k: string } }).valueType = { k: 'money' };
  assert.notEqual(snapshotSignature(f), sigA, 'a changed field type changes the signature');
});

test('localStoragePersistence: a signature mismatch (or a legacy un-stamped snapshot) is discarded', async () => {
  store.clear();
  const KEY = 'fk-cassette-adapters-test';

  // a legacy raw snapshot (written by the old unversioned path) is NOT restored under a signature
  await localStoragePersistence(KEY).saveSnapshot(SNAP);
  assert.equal(await localStoragePersistence(KEY, 'sigX').loadSnapshot(), null, 'a legacy un-stamped snapshot is discarded');

  // a stamped snapshot with a MATCHING signature is restored
  await localStoragePersistence(KEY, 'sigX').saveSnapshot(SNAP);
  assert.deepEqual(await localStoragePersistence(KEY, 'sigX').loadSnapshot(), SNAP, 'a matching signature restores the snapshot');

  // a CHANGED signature (the shape evolved) discards the old snapshot → the host re-seeds
  assert.equal(await localStoragePersistence(KEY, 'sigY').loadSnapshot(), null, 'a changed signature discards the old snapshot');

  // no signature → unchanged (unversioned) behaviour: a raw save round-trips as a raw snapshot
  const RAW_KEY = 'fk-cassette-adapters-raw';
  await localStoragePersistence(RAW_KEY).saveSnapshot(SNAP);
  assert.deepEqual(await localStoragePersistence(RAW_KEY).loadSnapshot(), SNAP, 'an unversioned reader still round-trips the raw snapshot');
});
