import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette } from '@app/core-runtime';
import { createModelEditing } from './model-editing.ts';
import { collectFormulaLiterals } from '../model-edit.ts';

// Node has no localStorage — a minimal Map-backed stub so the session's persistence path is exercised.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const carIns = (): Cassette => JSON.parse(readFileSync(new URL('../../../core-runtime/cassettes/car-insurance.json', import.meta.url), 'utf8')) as Cassette;
const cellMinor = (c: Cassette, table: string, key: string): unknown =>
  ((c.collections[0].tables?.[table] as { map?: Record<string, { minor?: unknown }> } | undefined)?.map?.[key])?.minor;
const litRaw = (c: Cassette, propId: string): number => collectFormulaLiterals(c.collections[0].properties.find((p) => p.id === propId)!.formula)[0].raw;

test('ModelEditing: save persists the shared cassette and a fresh session reads it back', () => {
  store.clear();
  const ed = createModelEditing(carIns());
  assert.equal(ed.dirty(), false);
  assert.equal(ed.saved(), false, 'no override yet → shipped defaults');
  ed.applyTableCell('applications', 'coverRate', 'wa', 500); // €5,00
  assert.equal(ed.dirty(), true);
  assert.equal(ed.save().ok, true);
  assert.equal(ed.dirty(), false);
  assert.equal(ed.saved(), true);
  // a brand-new session (as a rebuilt tab would create) sees the persisted edit
  const reopened = createModelEditing(carIns());
  assert.equal(String(cellMinor(reopened.cass(), 'coverRate', 'wa')), '500');
});

test('ModelEditing: a batch rate edit + a later literal edit+save persist TOGETHER (the shared-state fix)', () => {
  // this is the exact interaction the old two-clone design lost: a not-yet-saved Regels rate change must NOT
  // be discarded when the Grafiek inspector saves a formula literal — both go through ONE session, so both land.
  store.clear();
  const ed = createModelEditing(carIns());
  ed.applyTableCell('applications', 'coverRate', 'wa', 777); // Regels-style batch edit, not yet saved
  const [fee] = collectFormulaLiterals(ed.cass().collections[0].properties.find((p) => p.id === 'optLegalAidFee')!.formula);
  ed.applyLiteral('applications', 'optLegalAidFee', fee.path, 400); // Grafiek-style edit
  assert.equal(ed.save().ok, true); // the inspector auto-saves the SHARED cassette

  const persisted = JSON.parse(store.get(ed.key)!) as Cassette;
  assert.equal(String(cellMinor(persisted, 'coverRate', 'wa')), '777', 'the earlier batch rate edit survived');
  assert.equal(litRaw(persisted, 'optLegalAidFee'), 400, 'and the literal edit was applied too');
});

test('ModelEditing: subscribers fire on save and revert; revert drops the override', () => {
  store.clear();
  const ed = createModelEditing(carIns());
  let notified = 0;
  ed.subscribe(() => { notified += 1; });
  ed.applyTableCell('applications', 'coverRate', 'wa', 600);
  ed.save();
  assert.equal(notified, 1, 'save notifies');
  assert.equal(ed.saved(), true);
  ed.revert();
  assert.equal(notified, 2, 'revert notifies');
  assert.equal(ed.saved(), false, 'the override is gone');
  assert.equal(ed.dirty(), false);
  // back to shipped defaults (coverRate.wa is the shipped €4,00 = 400)
  assert.equal(String(cellMinor(ed.cass(), 'coverRate', 'wa')), '400');
});
