// The cassette registry — DERIVED from the cassette files, not hand-authored. Vite globs every JSON in
// cassettes/ at build time; dropping a new cassette in (via bundle-model) makes it appear in the
// catalogue and loadable by ?cassette=<id> with NO code change. This is the "the model is the app,
// different models load in" seam: the player + catalogue read this, never a hardcoded import.

import type { Cassette } from '@app/core-runtime';
import { isJourneyDoc, type JourneyDoc } from './compile-journey.ts';

const modules = import.meta.glob('./cassettes/*.json', { eager: true }) as Record<string, { default: unknown }>;

export interface CassetteMeta {
  id: string;
  title: string;
  doc?: string;
  shape: 'flat' | 'composed' | 'journey'; // journey = a cross-cassette L2 doc compiled from several products
  klass: string; // the spine's HQDM class (what the thing is ABOUT); journeys group under "Pakket"
  collections: number; // for a journey doc: the number of composed models
  hasSteps: boolean;
}

const spineOf = (c: Cassette): string => {
  const rels = Object.values(c.relations ?? {});
  const childColls = new Set(rels.map((r) => r.childColl));
  return rels.map((r) => r.parentColl).find((p) => !childColls.has(p)) ?? c.collections[0]?.id;
};

export const REGISTRY: Record<string, Cassette> = {}; // product cassettes (have collections)
export const JOURNEYS: Record<string, JourneyDoc> = {}; // cross-cassette L2 journey docs (have models)
export const CATALOGUE: CassetteMeta[] = [];

const raws = Object.values(modules).map((m) => m.default);
// pass 1: product cassettes → REGISTRY (so a journey doc's referenced models are resolvable in pass 2)
for (const c of raws as Cassette[]) {
  if (!c || typeof c.id !== 'string' || !Array.isArray(c.collections)) continue;
  REGISTRY[c.id] = c;
  const spine = spineOf(c);
  CATALOGUE.push({
    id: c.id,
    title: c.title ?? c.id,
    doc: c.doc,
    shape: Object.keys(c.relations ?? {}).length ? 'composed' : 'flat',
    klass: c.collections.find((coll) => coll.id === spine)?.semanticClass ?? '—',
    collections: c.collections.length,
    hasSteps: !!c.journey?.steps?.length,
  });
}
// pass 2: cross-cassette L2 journey docs → JOURNEYS
for (const j of raws) {
  if (!isJourneyDoc(j)) continue;
  JOURNEYS[j.id] = j;
  CATALOGUE.push({ id: j.id, title: j.title ?? j.id, doc: j.doc, shape: 'journey', klass: 'Pakket', collections: j.models.length, hasSteps: false });
}
CATALOGUE.sort((a, b) => a.title.localeCompare(b.title));

/** The presentation donor: a cassette can lean on another's theme/l10n/enums (e.g. the composed variant
 * reuses the flat one's brand). Returns the richest-presentation cassette when the target has none. */
export function presentationDonor(target: Cassette): Cassette {
  if (target.theme && target.l10n) return target;
  const donor = Object.values(REGISTRY).find((c) => c.id !== target.id && c.theme && c.l10n);
  return donor ?? target;
}
