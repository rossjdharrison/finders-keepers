// The cassette registry — DERIVED from the cassette files, not hand-authored. Vite globs every JSON in
// cassettes/ at build time; dropping a new cassette in (via bundle-model) makes it appear in the
// catalogue and loadable by ?cassette=<id> with NO code change. This is the "the model is the app,
// different models load in" seam: the player + catalogue read this, never a hardcoded import.

import type { Cassette } from '@app/core-runtime';

const modules = import.meta.glob('./cassettes/*.json', { eager: true }) as Record<string, { default: unknown }>;

export interface CassetteMeta {
  id: string;
  title: string;
  doc?: string;
  shape: 'flat' | 'composed'; // composed = the journey spans child collections (has relations)
  klass: string; // the spine's HQDM class (what the journey is ABOUT)
  collections: number;
  hasSteps: boolean;
}

const spineOf = (c: Cassette): string => {
  const rels = Object.values(c.relations ?? {});
  const childColls = new Set(rels.map((r) => r.childColl));
  return rels.map((r) => r.parentColl).find((p) => !childColls.has(p)) ?? c.collections[0]?.id;
};

export const REGISTRY: Record<string, Cassette> = {};
export const CATALOGUE: CassetteMeta[] = [];

for (const m of Object.values(modules)) {
  const c = m.default as Cassette;
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
CATALOGUE.sort((a, b) => a.title.localeCompare(b.title));

/** The presentation donor: a cassette can lean on another's theme/l10n/enums (e.g. the composed variant
 * reuses the flat one's brand). Returns the richest-presentation cassette when the target has none. */
export function presentationDonor(target: Cassette): Cassette {
  if (target.theme && target.l10n) return target;
  const donor = Object.values(REGISTRY).find((c) => c.id !== target.id && c.theme && c.l10n);
  return donor ?? target;
}
