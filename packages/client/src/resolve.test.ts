import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, resolvePlan, vocabularyFrom, type RenderVocabulary } from './resolve.ts';
import type { CollectionDoc, TypeMap } from './types.ts';

const types: TypeMap = { Decision: { specializes: ['activity'] }, Loose: { specializes: ['nowhere'] } };
const vocab: RenderVocabulary = new Map([
  ['activity', { family: 'step', glyph: '▷', label: 'Activity' }],
  ['class_of_state', { family: 'statechip' }],
]);

const decisions: CollectionDoc = {
  id: 'decisions',
  semanticClass: 'Decision',
  properties: [
    { id: 'title', valueType: { k: 'text' }, source: 'stored' },
    { id: 'status', valueType: { k: 'enum', set: 'decisionStatus' }, source: 'stored', category: 'class_of_state' },
    { id: 'optionCount', valueType: { k: 'num' }, source: 'computed', category: 'physical_quantity' },
    { id: 'chosen', valueType: { k: 'ref', collection: 'options' }, source: 'stored', category: 'association' },
  ],
} as CollectionDoc;

test('familyOf climbs specializes to the nearest render pattern, else the universal fallback', () => {
  assert.equal(familyOf('Decision', types, vocab), 'step'); // Decision → activity → step
  assert.equal(familyOf('activity', types, vocab), 'step');
  assert.equal(familyOf('Loose', types, vocab), 'universal'); // no hint up the chain → fallback
});

test('resolvePlan derives the family + per-field roles and humanized default labels', () => {
  const plan = resolvePlan({ collection: decisions, types, vocab });
  assert.equal(plan.family, 'step');
  const by = Object.fromEntries(plan.fields.map((f) => [f.node, f]));
  assert.equal(by['decisions.status'].role, 'status'); // class_of_state → status
  assert.equal(by['decisions.optionCount'].role, 'measure'); // physical_quantity → measure
  assert.equal(by['decisions.chosen'].role, 'relation'); // ref → relation
  assert.equal(by['decisions.title'].role, 'text');
  assert.equal(by['decisions.optionCount'].label, 'Option Count'); // default = humanized field id
});

test('the viewer seam decides affordance: canWrite gates editability; computed is never editable', () => {
  const ro = resolvePlan({ collection: decisions, types, vocab, viewer: { canWrite: false } });
  assert.equal(ro.fields.find((f) => f.node === 'decisions.title')!.editable, false);

  const rw = resolvePlan({ collection: decisions, types, vocab, viewer: { canWrite: true } });
  assert.equal(rw.fields.find((f) => f.node === 'decisions.title')!.editable, true);
  assert.equal(rw.fields.find((f) => f.node === 'decisions.optionCount')!.editable, false); // computed
});

test('the i18n seam: a label is a traceable token resolved to a localized string; token is preserved', () => {
  const l10n = new Map([['title', 'Titre']]);
  const plan = resolvePlan({ collection: decisions, types, vocab, labels: { title: 'title' }, audience: { locale: 'fr', l10n } });
  const title = plan.fields.find((f) => f.node === 'decisions.title')!;
  assert.equal(title.label, 'Titre'); // l10n resolves token → sign for the locale-community
  assert.equal(title.labelToken, 'title'); // the token stays (traceable); l10n is a swappable resource
});

test('a gated field surfaces as a blocked neutral state (availableWhen → presentation state)', () => {
  const row = { coll: 'decisions', id: 'd1', doc: {}, deleted: false, seq: 0, hidden: ['optionCount'] };
  const plan = resolvePlan({ collection: decisions, types, vocab, row });
  const oc = plan.fields.find((f) => f.node === 'decisions.optionCount')!;
  assert.equal(oc.hidden, true);
  assert.equal(oc.state, 'blocked');
});

test('vocabularyFrom reads the render vocabulary out of the seed insert-ops (row-sourced)', () => {
  const v = vocabularyFrom([
    { op: 'insert', coll: 'renderVocabulary', row: 'party', values: { family: { t: 'text', v: 'party' }, glyph: { t: 'text', v: '☺' } } },
    { op: 'insert', coll: 'types', row: 'Actor', values: {} }, // ignored
  ]);
  assert.equal(v.get('party')!.family, 'party');
  assert.equal(v.get('party')!.glyph, '☺');
  assert.equal(v.has('Actor'), false);
});

test('P overrides apply: a collection variant, and a value→state rule + label-token override on a field', () => {
  const overrides = {
    decisions: { subject: 'decisions', variant: 'compact' },
    'decisions.status': { subject: 'decisions.status', label: 'decisionStatus', stateRules: { accepted: 'positive', proposed: 'pending' } },
  };
  const row = { coll: 'decisions', id: 'd1', doc: { status: { t: 'enum' as const, set: 'decisionStatus', v: 'accepted' } }, deleted: false, seq: 0 };
  const plan = resolvePlan({ collection: decisions, types, vocab, overrides, row, audience: { l10n: new Map([['decisionStatus', 'Status']]) } });
  assert.equal(plan.variant, 'compact'); // collection-level override
  const status = plan.fields.find((f) => f.node === 'decisions.status')!;
  assert.equal(status.state, 'positive'); // stateRules mapped the enum value → a neutral token
  assert.equal(status.labelToken, 'decisionStatus'); // token override (traceable)
  assert.equal(status.label, 'Status'); // localized via the override token
});
