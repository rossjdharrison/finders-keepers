// A thin, pure reader over the HQDM lattice. The core is DATA; a domain model
// passes its OWN types (declared by `specializes`) as `extra`, and every function
// resolves them merged over the core — so a domain class's neutral category is
// INFERRED by climbing the lattice, never hardcoded.
//
// `reduces(id)` is the reducibility predicate: a type reduces to HQDM iff it is
// known and specializes (transitively) up to the root `thing`. That is the check
// the workspace enforces on every collection's semanticClass.

import { CORE, ROOT } from './hqdm-core.ts';
import type { RenderHint } from './hqdm-core.ts';

export type TypeMap = Record<string, { specializes: string[] }>;

const merged = (extra?: TypeMap): TypeMap => (extra ? { ...CORE.types, ...extra } : CORE.types);

/** Ordered supertypes, nearest → root, deduped (BFS). Cycle-safe. */
export function supertypesOf(id: string, extra?: TypeMap): string[] {
  const M = merged(extra);
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = [...(M[id]?.specializes ?? [])];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of frontier) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      const p = M[s]?.specializes;
      if (p) next.push(...p);
    }
    frontier = next;
  }
  return out;
}

/** Does `id` specialize (transitively) `target`? */
export function isA(id: string, target: string, extra?: TypeMap): boolean {
  return id === target || supertypesOf(id, extra).includes(target);
}

export const isKnownType = (id: string, extra?: TypeMap): boolean => id in merged(extra);

/**
 * The reducibility invariant: `id` is a known type AND climbs to the HQDM root.
 * A domain class that specializes a real HQDM category (e.g. Feature → activity)
 * reduces; one that dangles on an unknown parent, or a typo, does not.
 */
export function reduces(id: string, extra?: TypeMap): boolean {
  return isKnownType(id, extra) && isA(id, ROOT, extra);
}

/** The nearest type (self or ancestor) that carries a render hint; else null. */
export function leafCategoryOf(id: string, extra?: TypeMap): string | null {
  if (CORE.renderHints[id]) return id;
  for (const s of supertypesOf(id, extra)) if (CORE.renderHints[s]) return s;
  return null;
}

/** The render hint for a type, resolved by climbing; null if none. */
export function renderOf(id: string, extra?: TypeMap): RenderHint | null {
  const c = leafCategoryOf(id, extra);
  return c ? CORE.renderHints[c] : null;
}

export { ROOT } from './hqdm-core.ts';
export type { HqdmType, RenderHint, HqdmCore } from './hqdm-core.ts';
export { CORE } from './hqdm-core.ts';
