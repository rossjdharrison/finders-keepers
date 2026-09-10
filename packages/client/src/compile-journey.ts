// The cross-cassette L2 seam — a COMPILER. It takes a journey document that references SEPARATE product
// cassettes by id plus typed BINDINGS (upstream output → downstream input), and compiles them into ONE
// composed cassette that runs in the SAME sealed core with NO engine change. The seam is realised as a
// cardinality-1 ROLLUP: the downstream model becomes the PARENT of the upstream, and its bound input
// becomes a computed rollup of the upstream's provided value — that computed-ness IS the lock (the field
// is no longer user-editable), and it stays live through the engine's cascade (rollup edges are the only
// cross-record edges the recompute DAG tracks). A `total` folds the models' monthly figures into one.
//
// This keeps the products SEPARATE (their own files/registry entries), stitched declaratively by the
// journey doc, yet runs through the existing intra-cassette machinery (relations + rollup + the unified
// journey renderer). Reserve a multi-core orchestrator for models that must stay genuinely separate.

import type { Cassette, Collection } from '@app/core-runtime';
import type { Value } from '@core/values';

export interface JourneyBinding {
  id: string;
  from: string; // upstream alias
  to: string; // downstream alias
  contract: { provides: { as: string; source: string }[]; requires: { name: string; target: string }[] };
  mapping?: { to: string; from: unknown }[]; // optional transform; absent = pass through the single provided value
}
export interface JourneyDoc {
  kind: 'journey';
  id: string;
  title?: string;
  doc?: string;
  locale?: string;
  models: { ref: string; as: string }[];
  spine: string; // the alias whose collection is the journey spine (carries the total)
  bindings: JourneyBinding[];
  surface?: { as: string; from: string; field: string; label?: string }[]; // roll a child field up to the spine (for the rail)
  total: { field: string; of: string[]; label?: string; per?: string }; // spine field = sum of these spine fields
  sections: { model: string; label: string; fields: string[] }[]; // journey sections, one per model
}

const localId = (s: string): string => s.split(':')[1] ?? s;

/** Replace each `{op:'field', id:<seamVar>}` with the child's real source field, leaving other ops. */
function substSeam(node: unknown, seamSrc: Record<string, string>): unknown {
  const n = node as { op?: string; id?: string; args?: unknown[]; [k: string]: unknown };
  if (!n || typeof n !== 'object') return node;
  if (n.op === 'field' && typeof n.id === 'string' && n.id in seamSrc) return { op: 'field', id: seamSrc[n.id] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = Array.isArray(v) ? v.map((x) => substSeam(x, seamSrc)) : substSeam(v, seamSrc);
  return out;
}

/** Fold a list of money fields into one `add` chain (the combined total). */
function sumFields(fields: string[]): unknown {
  const terms: unknown[] = fields.map((f) => ({ op: 'field', id: f }));
  return terms.reduce((acc, t) => ({ op: 'add', args: [acc, t] }));
}

export function isJourneyDoc(x: unknown): x is JourneyDoc {
  const d = x as { kind?: string; models?: unknown };
  return !!d && d.kind === 'journey' && Array.isArray(d.models);
}

/** Compile a journey doc + the product cassettes into one composed cassette. Throws on an unknown ref. */
export function compileJourney(doc: JourneyDoc, registry: Record<string, Cassette>): Cassette {
  const cassOf = (alias: string): Cassette => {
    const ref = doc.models.find((m) => m.as === alias)?.ref;
    const c = ref ? registry[ref] : undefined;
    if (!c) throw new Error(`journey ${doc.id}: unknown model alias '${alias}' or ref`);
    return c;
  };
  const collections: Collection[] = [];
  const modelColl: Record<string, Collection> = {}; // alias → its (namespaced) collection
  const types: Record<string, { specializes: string[] }> = {};
  const l10n: Record<string, Record<string, string>> = {};
  const enums: Record<string, { id: string; label: string }[]> = {};

  // 1. namespace each model's single collection (id prefixed by alias) and union the presentation dimensions
  for (const m of doc.models) {
    const cass = cassOf(m.as);
    const src = structuredClone(cass.collections[0]) as Collection;
    src.id = `${m.as}__${src.id}`;
    modelColl[m.as] = src;
    collections.push(src);
    Object.assign(types, cass.types);
    for (const [loc, map] of Object.entries(cass.l10n ?? {})) l10n[loc] = { ...(l10n[loc] ?? {}), ...map };
    Object.assign(enums, cass.enums ?? {});
  }

  // 2. bindings: `from` becomes a CHILD of `to`; each required target on `to` becomes a rollup of the child's
  //    seam field (the mapping over the provided values) — the computed-ness is the lock.
  const relations: Record<string, { parentColl: string; childColl: string; childField: string }> = {};
  for (const b of doc.bindings) {
    const child = modelColl[b.from];
    const parent = modelColl[b.to];
    if (!child || !parent) throw new Error(`journey ${doc.id}: binding ${b.id} names an undeclared model`);
    const childField = `__to_${b.to}`;
    child.properties.push({ id: childField, valueType: { k: 'ref', collection: parent.id }, source: 'stored', category: 'association' } as Collection['properties'][number]);
    const rel = `rel_${b.id}`;
    relations[rel] = { parentColl: parent.id, childColl: child.id, childField };

    const seamSrc: Record<string, string> = {};
    for (const p of b.contract.provides) seamSrc[p.as] = localId(p.source);
    for (const r of b.contract.requires) {
      const target = localId(r.target);
      const map = (b.mapping ?? []).find((mm) => mm.to === target);
      const expr = map ? substSeam(map.from, seamSrc) : { op: 'field', id: seamSrc[r.name] ?? r.name };
      const tprop = parent.properties.find((p) => p.id === target);
      if (!tprop) throw new Error(`journey ${doc.id}: binding ${b.id} target field '${target}' not on model '${b.to}'`);
      const seamField = `__seam_${b.id}_${target}`;
      child.properties.push({ id: seamField, valueType: tprop.valueType, source: 'computed', formula: expr } as Collection['properties'][number]);
      // turn the bound input into a live, non-editable computed rollup (sum over the 1-row relation = the value)
      tprop.source = 'computed';
      (tprop as { formula?: unknown }).formula = { op: 'rollup', via: rel, agg: 'sum', of: { op: 'field', id: seamField } };
      delete (tprop as { constraint?: unknown }).constraint;
    }
  }

  // 3. surface: roll a child output up to the spine (for the rail breakdown lines)
  const spine = modelColl[doc.spine];
  if (!spine) throw new Error(`journey ${doc.id}: spine '${doc.spine}' is not a declared model`);
  for (const s of doc.surface ?? []) {
    const child = modelColl[s.from];
    const rel = Object.entries(relations).find(([, r]) => r.childColl === child?.id && r.parentColl === spine.id)?.[0];
    if (!child || !rel) throw new Error(`journey ${doc.id}: surface '${s.as}' has no relation from '${s.from}' to the spine`);
    spine.properties.push({ id: s.as, valueType: { k: 'money' }, source: 'computed', category: 'amount_of_money', formula: { op: 'rollup', via: rel, agg: 'sum', of: { op: 'field', id: s.field } } } as Collection['properties'][number]);
  }

  // 4. total: the combined figure on the spine
  spine.properties.push({ id: doc.total.field, valueType: { k: 'money' }, source: 'computed', category: 'amount_of_money', formula: sumFields(doc.total.of) } as Collection['properties'][number]);
  if (doc.total.label) (l10n[doc.locale ?? 'nl'] = l10n[doc.locale ?? 'nl'] ?? {})[doc.total.field] = doc.total.label;
  for (const s of doc.surface ?? []) if (s.label) (l10n[doc.locale ?? 'nl'] = l10n[doc.locale ?? 'nl'] ?? {})[s.as] = s.label;

  // 5. the journey block: one section per model + the summary rail (total + surfaced/own lines)
  const steps = doc.sections.map((s) => ({ id: s.model, label: s.label, collection: modelColl[s.model].id, fields: s.fields }));
  const summary = {
    total: doc.total.field,
    per: doc.total.per,
    lines: doc.total.of.map((f) => ({ field: f })),
  };

  // 6. seed: one spine row + one child row per binding, linked via the binding's childField; the child rows
  //    carry the upstream cassette's example INPUTS so the compiled journey shows a real total on load. Only
  //    stored fields are seeded — a binding target that became a computed rollup is engine-owned now.
  const storedOnly = (coll: Collection, example: Record<string, Value>): Record<string, Value> => {
    const stored = new Set(coll.properties.filter((p) => (p.source ?? 'stored') === 'stored').map((p) => p.id));
    return Object.fromEntries(Object.entries(example).filter(([k]) => stored.has(k)));
  };
  const seed: { coll: string; row: string; values: Record<string, Value> }[] = [];
  const spineCass = cassOf(doc.spine);
  seed.push({ coll: spine.id, row: `${doc.spine}-1`, values: storedOnly(spine, spineCass.example ?? {}) });
  for (const b of doc.bindings) {
    const child = modelColl[b.from];
    const childCass = cassOf(b.from);
    seed.push({
      coll: child.id,
      row: `${b.from}-1`,
      values: { ...storedOnly(child, childCass.example ?? {}), [`__to_${b.to}`]: { t: 'ref', collection: modelColl[b.to].id, id: `${b.to}-1` } as Value },
    });
  }

  return {
    id: doc.id,
    title: doc.title ?? doc.id,
    doc: doc.doc,
    locale: doc.locale ?? spineCass.locale ?? 'nl',
    types,
    collections,
    relations,
    l10n,
    enums,
    journey: { steps, summary }, // no step field → the renderer shows a single page (no wizard)
    seed,
  } as unknown as Cassette;
}
