import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supertypesOf, isA, isKnownType, reduces, leafCategoryOf, CORE } from './ontology.ts';
import type { TypeMap } from './ontology.ts';

test('supertypes climb the lattice to the root, nearest first', () => {
  assert.deepEqual(supertypesOf('amount_of_money'), ['physical_quantity', 'abstract_object', 'thing']);
});

test('isA is transitive specialization', () => {
  assert.ok(isA('amount_of_money', 'physical_quantity'));
  assert.ok(isA('amount_of_money', 'thing'));
  assert.ok(isA('activity', 'activity'));
  assert.ok(!isA('amount_of_money', 'activity'));
});

test('a domain class reduces when it specializes a real HQDM category', () => {
  const types: TypeMap = {
    Widget: { specializes: ['activity'] },
    PurchasePrice: { specializes: ['amount_of_money'] },
    StoryPoints: { specializes: ['physical_quantity'] },
  };
  assert.ok(reduces('Widget', types));
  assert.ok(reduces('PurchasePrice', types));
  assert.ok(isA('PurchasePrice', 'thing', types));
  // the inferred neutral category (for rendering / taxonomy)
  assert.equal(leafCategoryOf('PurchasePrice', types), 'amount_of_money');
  assert.equal(leafCategoryOf('Widget', types), 'activity');
});

test('reducibility FAILS for a dangling parent, a typo, or an unknown class', () => {
  assert.ok(!reduces('Ghost', { Ghost: { specializes: ['nowhere'] } })); // parent not in lattice
  assert.ok(!reduces('activitiy')); // typo — not a known type
  assert.ok(!isKnownType('activitiy'));
});

test('cycles are handled without hanging, and never reduce', () => {
  const cyclic: TypeMap = { A: { specializes: ['B'] }, B: { specializes: ['A'] } };
  assert.deepEqual(new Set(supertypesOf('A', cyclic)), new Set(['B', 'A']));
  assert.ok(!reduces('A', cyclic)); // never reaches `thing`
});

test('every core type itself reduces to the root', () => {
  for (const id of Object.keys(CORE.types)) assert.ok(reduces(id), `${id} should reduce`);
});

test('the intention chain: a plan is an intended possible world; a requirement spec is a class', () => {
  assert.ok(isA('plan', 'possible_world'));
  assert.ok(isA('plan', 'spatio_temporal_extent'));
  assert.ok(isA('requirement_specification', 'class'));
  assert.ok(isA('requirement_specification', 'abstract_object'));
  assert.ok(isA('part_of_plan', 'association'));
});
