// The cassette registry — DERIVED from the cassette files, not hand-authored. Vite globs every JSON in
// cassettes/ at build time; dropping a new cassette in (via bundle-model) makes it appear in the
// catalogue and loadable by ?cassette=<id> with NO code change. This is the "the model is the app,
// different models load in" seam: the player + catalogue read this, never a hardcoded import.

import type { Cassette } from '@app/core-runtime';
import {
  isProposition, isJourneySource, mergeJourney,
  type JourneyDoc, type Proposition, type Journey, type TargetMarket,
} from './compile-journey.ts';

const modules = import.meta.glob('./cassettes/*.json', { eager: true }) as Record<string, { default: unknown }>;

export interface CassetteMeta {
  id: string;
  title: string;
  doc?: string;
  shape: 'flat' | 'composed' | 'journey'; // journey = a PROPOSITION compiled (via a journey) from several products
  klass: string; // the spine's HQDM class (what the thing is ABOUT); propositions group under "Pakket"
  collections: number; // for a proposition: the number of composed models
  hasSteps: boolean;
  run?: string; // for a proposition: the id of the journey that runs it (Aanvraag/Model route through this)
  targetMarket?: TargetMarket; // for a proposition: its declared segment/suitability (the commercial layer)
}

const spineOf = (c: Cassette): string => {
  const rels = Object.values(c.relations ?? {});
  const childColls = new Set(rels.map((r) => r.childColl));
  return rels.map((r) => r.parentColl).find((p) => !childColls.has(p)) ?? c.collections[0]?.id;
};

export const REGISTRY: Record<string, Cassette> = {}; // product cassettes / configurators (have collections)
export const PROPOSITIONS: Record<string, Proposition> = {}; // commercial compositions (models + typed seams)
export const JOURNEYS: Record<string, Journey> = {}; // customer interactions over a proposition (sections/party)
export const CATALOGUE: CassetteMeta[] = [];

const raws = Object.values(modules).map((m) => m.default);
// pass 1: product cassettes → REGISTRY (so a proposition's referenced models are resolvable when merged)
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
// pass 2: the authored layers — propositions (composition) and journeys (interaction)
for (const p of raws) if (isProposition(p)) PROPOSITIONS[p.id] = p;
for (const j of raws) if (isJourneySource(j)) JOURNEYS[j.id] = j;
// pass 3: catalogue entries for propositions — the browsable products. Each routes through its DEFAULT
// journey (the runnable interaction); a proposition with no journey is still listed but not runnable yet.
for (const p of Object.values(PROPOSITIONS)) {
  CATALOGUE.push({
    id: p.id,
    title: p.title ?? p.id,
    doc: p.doc,
    shape: 'journey',
    klass: 'Pakket',
    collections: p.models.length,
    hasSteps: false,
    run: defaultJourneyOf(p.id),
    targetMarket: p.targetMarket,
  });
}
// Catalogue ordering — lead with the strongest demonstration, demote superseded/thinner variants. Kept
// DATA-DRIVEN (no hardcoded ids): a DYNAMIC to-many version (add/remove N rows at runtime — detected by a
// `repeat` journey step) is the flagship and leads. A FIXED-cardinality composition (the same configurator
// pinned N times — detected by a repeated model ref) is superseded by it, and is demoted TOGETHER WITH
// anything lacking a composition (a "compositie"); the real compositions (genuine L2 seams) rank above them.
const hasRepeatStep = (id: string): boolean =>
  !!REGISTRY[id]?.journey?.steps?.some((s) => (s as { repeat?: boolean }).repeat);
const isFixedMultiple = (id: string): boolean => {
  const refs = PROPOSITIONS[id]?.models?.map((m) => m.ref);
  return !!refs && new Set(refs).size < refs.length; // a repeated model ref = a fixed ×N composition
};
const hasComposition = (m: CassetteMeta): boolean => m.shape === 'journey' && !!m.run; // opens a Compositie tab
const catalogueRank = (m: CassetteMeta): number => {
  if (hasRepeatStep(m.id)) return 0; // the predominant, dynamic version (fleet-n): add/remove vehicles live
  if (hasComposition(m) && !isFixedMultiple(m.id)) return 1; // real compositions (auto-package, sme-lending)
  return 2; // fixed ×N composition + anything lacking a compositie: demoted together, ordered by title
};
CATALOGUE.sort((a, b) => catalogueRank(a) - catalogueRank(b) || a.title.localeCompare(b.title));

/** The default (first, by id) journey that runs a proposition — what the catalogue's Aanvraag/Model open. */
export function defaultJourneyOf(propId: string): string | undefined {
  return Object.values(JOURNEYS).filter((j) => j.proposition === propId).map((j) => j.id).sort()[0];
}

/** A journey's display title (its own, else its proposition's, else its id). */
export function journeyTitle(id: string): string {
  const j = JOURNEYS[id];
  return j?.title ?? (j ? PROPOSITIONS[j.proposition]?.title : undefined) ?? id;
}

/** Resolve a journey id to the compile IR: merge its interaction with its proposition's composition.
 * Returns undefined for an unknown journey or a dangling proposition ref (caller shows "unknown"). */
export function resolveJourneyDoc(id: string): JourneyDoc | undefined {
  const j = Object.hasOwn(JOURNEYS, id) ? JOURNEYS[id] : undefined;
  if (!j) return undefined;
  const prop = Object.hasOwn(PROPOSITIONS, j.proposition) ? PROPOSITIONS[j.proposition] : undefined;
  if (!prop) return undefined;
  return mergeJourney(prop, j);
}

/** The presentation donor: a cassette can lean on another's theme/l10n/enums (e.g. the composed variant
 * reuses the flat one's brand). Returns the richest-presentation cassette when the target has none. */
export function presentationDonor(target: Cassette): Cassette {
  if (target.theme && target.l10n) return target;
  const donor = Object.values(REGISTRY).find((c) => c.id !== target.id && c.theme && c.l10n);
  return donor ?? target;
}
