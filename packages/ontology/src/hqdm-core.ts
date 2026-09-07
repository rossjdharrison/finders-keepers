// The domain-NEUTRAL upper lattice — a small, faithful core of HQDM (Matthew West's
// High Quality Data Model, a 4-dimensionalist upper ontology). It is DATA: domain
// models extend it by declaring their own types with `specializes`, and the reader
// (ontology.ts) infers a type's neutral category by climbing this lattice.
//
// `specialization` is the only relation interpreted here (isA / reduces climb it).
// Classification (record -> class), temporal_part_of (state -> individual),
// participant/association, etc. are real HQDM but are expressed elsewhere in the
// system (a collection's records are classified by its semanticClass; the event
// log's timestamps give states their 4-D temporal extent).

export interface HqdmType {
  specializes: string[];
}
export interface RenderHint {
  glyph?: string;
  render?: string;
  label?: string;
  hint?: string;
  authorable?: number;
}
export interface HqdmCore {
  types: Record<string, HqdmType>;
  renderHints: Record<string, RenderHint>;
}

export const ROOT = 'thing';

export const CORE: HqdmCore = {
  types: {
    thing: { specializes: [] },
    abstract_object: { specializes: ['thing'] },
    spatio_temporal_extent: { specializes: ['thing'] },
    class: { specializes: ['abstract_object'] },
    class_of_physical_object: { specializes: ['class'] },
    role: { specializes: ['class'] },
    individual: { specializes: ['spatio_temporal_extent'] },
    physical_object: { specializes: ['individual'] },
    ordinary_physical_object: { specializes: ['physical_object'] },
    physical_quantity: { specializes: ['abstract_object'] },
    amount_of_money: { specializes: ['physical_quantity'] },
    party: { specializes: ['individual'] },
    organization: { specializes: ['party'] },
    person: { specializes: ['party'] },
    activity: { specializes: ['individual'] },
    event: { specializes: ['individual'] },
    state: { specializes: ['individual'] },
    participant: { specializes: ['state'] },
    association: { specializes: ['individual'] },
    agreement: { specializes: ['activity'] },
    transfer_of_ownership: { specializes: ['activity'] },
    transfer_of_possession: { specializes: ['activity'] },
    sign: { specializes: ['abstract_object'] },
    period_of_time: { specializes: ['spatio_temporal_extent'] },
    point_in_time: { specializes: ['spatio_temporal_extent'] },
  },
  renderHints: {
    amount_of_money: { glyph: '¤', render: 'money', label: 'Amount of money', authorable: 2 },
    physical_quantity: { glyph: '#', render: 'quantity', label: 'Quantity or measure', authorable: 3 },
    class_of_physical_object: { glyph: '◈', render: 'hero', label: 'Physical thing', authorable: 1 },
    physical_object: { glyph: '◈', render: 'hero', label: 'Physical thing' },
    party: { glyph: '☺', render: 'party', label: 'Party', authorable: 6 },
    organization: { glyph: '⌂', render: 'party', label: 'Organisation', authorable: 7 },
    person: { glyph: '☺', render: 'party', label: 'Person' },
    activity: { glyph: '▷', render: 'step', label: 'Activity or service', authorable: 4 },
    agreement: { glyph: '§', render: 'contract', label: 'Agreement', authorable: 5 },
    sign: { glyph: '✎', render: 'signature', label: 'Sign or document' },
    state: { glyph: '◔', render: 'statechip', label: 'State' },
    association: { glyph: '⇄', render: 'relation', label: 'Association' },
    transfer_of_ownership: { glyph: '⇄', render: 'transfer', label: 'Transfer of ownership' },
    transfer_of_possession: { glyph: '⇄', render: 'transfer', label: 'Transfer of possession' },
  },
};
