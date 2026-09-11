import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Cassette } from '@app/core-runtime';
import { createModelEditing } from './model-editing.ts';
import { collectFormulaLiterals } from '../model-edit.ts';
import { parseExpr } from './expr.ts';

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

test('ModelEditing.trySetFormula: a valid structural edit commits; an invalid one is rejected and leaves state untouched', () => {
  store.clear();
  const ed = createModelEditing(carIns());
  // a VALID structural rewrite of optLegalAidFee (money → money, references the real bool field) commits + persists
  const ok = ed.trySetFormula('applications', 'optLegalAidFee', parseExpr('if(optLegalAid, €9, €0)'));
  assert.equal(ok.ok, true, 'a valid expression is accepted');
  assert.equal(litRaw(JSON.parse(store.get(ed.key)!) as Cassette, 'optLegalAidFee'), 900, 'the new €9 literal was persisted');
  // an INVALID rewrite (references a field that does not exist) is rejected; the committed formula is unchanged
  const bad = ed.trySetFormula('applications', 'optLegalAidFee', parseExpr('nonexistentField + €1'));
  assert.equal(bad.ok, false, 'an expression referencing an unknown field is rejected');
  assert.ok(bad.error && bad.error.length > 0, 'with an error message');
  assert.equal(litRaw(ed.cass(), 'optLegalAidFee'), 900, 'the shared cassette still holds the last VALID formula (€9), untouched by the bad edit');
});

test('ModelEditing.trySetFormula: a structural edit that changes the field TYPE is rejected (no silent re-type)', () => {
  store.clear();
  const ed = createModelEditing(carIns());
  // optLegalAidFee is declared money; a formula returning a num (not money) must be rejected, not silently
  // re-typing the field — otherwise downstream money arithmetic gets a num and misbehaves.
  const before = litRaw(ed.cass(), 'optLegalAidFee');
  const res = ed.trySetFormula('applications', 'optLegalAidFee', parseExpr('age + 1'));
  assert.equal(res.ok, false, 'a num-typed formula on a money field is rejected');
  assert.equal(litRaw(ed.cass(), 'optLegalAidFee'), before, 'and the field keeps its previous money formula');
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
