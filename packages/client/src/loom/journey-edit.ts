// Pure edit ops on a JourneyDoc — the "alter the composition" backbone for the Loom's Compositie tab.
// Each op clones and returns a new doc (never mutates), exactly like model-edit.ts does for cassettes.
// Nothing here validates: a candidate doc is proven by previewJourney (compile it, then load the compiled
// cassette in a throwaway core), so legality is delegated to the real compiler — zero parity risk. The
// edited doc is saved to localStorage (`fk-journey-doc-<id>`), which the player and the Loom load in
// preference to the shipped doc, recompiling it through the SAME sealed @core with no code change.

import type { Cassette } from '@app/core-runtime';
import type { Value } from '@core/values';
import { compileJourney, type JourneyDoc, type JourneyBinding } from '../compile-journey.ts';
import { previewCassette } from '../model-edit.ts';
import type { Node } from './expr.ts';

const clone = (doc: JourneyDoc): JourneyDoc => structuredClone(doc);
const localId = (s: string): string => s.split(':')[1] ?? s;

/** The single seam variable a binding provides (our bindings are cardinality-1: one provide/require). */
export function bindingVar(b: JourneyBinding): string {
  return b.contract.provides[0]?.as ?? 'v';
}
/** The field a binding targets on its `to` model (the downstream input it locks). */
export function bindingTarget(b: JourneyBinding): string {
  return localId(b.contract.requires[0]?.target ?? '');
}
/** The upstream field a binding reads from its `from` model. */
export function bindingSource(b: JourneyBinding): string {
  return localId(b.contract.provides[0]?.source ?? '');
}

// --- binding ops ---------------------------------------------------------------------------------

/** Set a binding's mapping expression for its (first) target — preserving any other targets' mappings
 * on a multi-require binding, rather than dropping them to pass-through. */
export function setBindingMapping(doc: JourneyDoc, bindingId: string, from: Node): JourneyDoc {
  const next = clone(doc);
  const b = next.bindings.find((x) => x.id === bindingId);
  if (b) {
    const target = bindingTarget(b);
    b.mapping = [{ to: target, from }, ...(b.mapping ?? []).filter((m) => m.to !== target)];
  }
  return next;
}

/** Set (or clear, with undefined) a binding's optional boolean condition. */
export function setBindingCondition(doc: JourneyDoc, bindingId: string, condition: Node | undefined): JourneyDoc {
  const next = clone(doc);
  const b = next.bindings.find((x) => x.id === bindingId);
  if (b) {
    if (condition) b.condition = condition;
    else delete b.condition;
  }
  return next;
}

const uniqueId = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
};

/** Add a cardinality-1 binding: the `from` model's `fromField` feeds the `to` model's `toField`
 * (pass-through mapping by default). The id and seam var are derived + de-duplicated. */
export function addBinding(doc: JourneyDoc, spec: { from: string; to: string; fromField: string; toField: string }): JourneyDoc {
  const next = clone(doc);
  const id = uniqueId(`bind_${spec.fromField}_${spec.toField}`, new Set(next.bindings.map((b) => b.id)));
  const asVar = spec.fromField;
  next.bindings.push({
    id,
    from: spec.from,
    to: spec.to,
    contract: { provides: [{ as: asVar, source: `output:${spec.fromField}` }], requires: [{ name: asVar, target: `field:${spec.toField}` }] },
    mapping: [{ to: spec.toField, from: { op: 'field', id: asVar } }],
  });
  return next;
}

export function removeBinding(doc: JourneyDoc, bindingId: string): JourneyDoc {
  const next = clone(doc);
  next.bindings = next.bindings.filter((b) => b.id !== bindingId);
  return next;
}

// --- model ops -----------------------------------------------------------------------------------

/** A short, unique alias for a newly-added model ref (used as the collection namespace + seam scope). */
export function aliasFor(ref: string, taken: Set<string>): string {
  const base = (ref.match(/[a-z]+/gi)?.[0] ?? ref).slice(0, 4).toLowerCase() || 'm';
  return uniqueId(base, taken);
}

/** Add a product cassette to the journey as a new model. Seeds a section listing its own fields. */
export function addModel(doc: JourneyDoc, ref: string, registry: Record<string, Cassette>): JourneyDoc {
  const next = clone(doc);
  const as = aliasFor(ref, new Set(next.models.map((m) => m.as)));
  next.models.push({ ref, as });
  const cass = registry[ref];
  const fields = cass ? sectionFieldsFor(cass) : [];
  next.sections.push({ model: as, label: cass?.title ?? ref, fields });
  return next;
}

/** Remove a model and everything that references it (bindings, surface, section, and any of its
 * surfaced ids still summed into the total). The spine is protected — reassigning it is a separate
 * op — so removing it returns an unchanged (cloned) doc. */
export function removeModel(doc: JourneyDoc, alias: string): JourneyDoc {
  const next = clone(doc);
  if (alias === doc.spine) return next; // never orphan the total (cloned, to keep the op pure)
  const droppedSurface = new Set((next.surface ?? []).filter((s) => s.from === alias).map((s) => s.as));
  next.models = next.models.filter((m) => m.as !== alias);
  next.bindings = next.bindings.filter((b) => b.from !== alias && b.to !== alias);
  next.surface = (next.surface ?? []).filter((s) => s.from !== alias);
  next.sections = next.sections.filter((s) => s.model !== alias);
  next.total = { ...next.total, of: next.total.of.filter((x) => !droppedSurface.has(x)) };
  return next;
}

/** A reasonable default field list for a model's section: its journey steps' fields, else all props. */
function sectionFieldsFor(cass: Cassette): string[] {
  const steps = (cass as { journey?: { steps?: { fields?: string[] }[] } }).journey?.steps;
  if (steps?.length) return steps.flatMap((s) => s.fields ?? []);
  return (cass.collections[0]?.properties ?? []).map((p) => p.id);
}

// --- surface / total / sections ------------------------------------------------------------------

export function addSurface(doc: JourneyDoc, spec: { from: string; field: string; label?: string }): JourneyDoc {
  const next = clone(doc);
  const surface = next.surface ?? (next.surface = []);
  const as = uniqueId(spec.field, new Set(surface.map((s) => s.as)));
  surface.push({ as, from: spec.from, field: spec.field, label: spec.label });
  return next;
}

export function removeSurface(doc: JourneyDoc, as: string): JourneyDoc {
  const next = clone(doc);
  next.surface = (next.surface ?? []).filter((s) => s.as !== as);
  next.total = { ...next.total, of: next.total.of.filter((x) => x !== as) }; // keep the total self-consistent
  return next;
}

/** Set which spine fields (surfaced ids or the spine's own money fields) sum into the combined total. */
export function setTotalOf(doc: JourneyDoc, of: string[]): JourneyDoc {
  const next = clone(doc);
  next.total = { ...next.total, of };
  return next;
}

export function setSectionFields(doc: JourneyDoc, model: string, fields: string[]): JourneyDoc {
  const next = clone(doc);
  const sec = next.sections.find((s) => s.model === model);
  if (sec) sec.fields = fields;
  return next;
}

/** Rename a section (its step label in the journey). */
export function setSectionLabel(doc: JourneyDoc, model: string, label: string): JourneyDoc {
  const next = clone(doc);
  const sec = next.sections.find((s) => s.model === model);
  if (sec) sec.label = label;
  return next;
}

/** Reorder a section by one place (dir −1 = earlier, +1 = later) — this is the STEP order the player
 * walks, since the compiled journey's steps are the sections in order. */
export function moveSection(doc: JourneyDoc, model: string, dir: -1 | 1): JourneyDoc {
  const next = clone(doc);
  const i = next.sections.findIndex((s) => s.model === model);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= next.sections.length) return next;
  [next.sections[i], next.sections[j]] = [next.sections[j], next.sections[i]];
  return next;
}

/** Toggle one field's presence in a section (add if absent, remove if present). */
export function toggleSectionField(doc: JourneyDoc, model: string, field: string): JourneyDoc {
  const sec = doc.sections.find((s) => s.model === model);
  const present = sec?.fields.includes(field);
  return setSectionFields(doc, model, present ? sec!.fields.filter((f) => f !== field) : [...(sec?.fields ?? []), field]);
}

/** Toggle data minimization (privacy by design): show only the fields the journey provably needs. */
export function setMinimal(doc: JourneyDoc, minimal: boolean): JourneyDoc {
  const next = clone(doc);
  next.minimal = minimal;
  return next;
}

export function setMeta(doc: JourneyDoc, meta: { title?: string; doc?: string }): JourneyDoc {
  const next = clone(doc);
  if (meta.title !== undefined) next.title = meta.title;
  if (meta.doc !== undefined) next.doc = meta.doc;
  return next;
}

// --- validate + persist --------------------------------------------------------------------------

export interface JourneyPreview {
  ok: boolean;
  error?: string;
  total?: Value; // the compiled journey's sample combined total (its summary.total field)
}

/** Prove a candidate journey doc: compile it (catches unknown refs/targets, bad bindings) then load the
 * compiled cassette in a throwaway core (HQDM reduce + typecheck + acyclicity + a sample total). */
export function previewJourney(doc: JourneyDoc, registry: Record<string, Cassette>): JourneyPreview {
  let compiled: Cassette;
  try {
    compiled = compileJourney(doc, registry);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const res = previewCassette(compiled);
  return { ok: res.ok, error: res.error, total: res.premium };
}

const KEY = (id: string): string => `fk-journey-doc-${id}`;

/** Load the edited journey doc from localStorage if present, else the shipped one. */
export function loadJourneyDoc(id: string, shipped: JourneyDoc): { doc: JourneyDoc; edited: boolean } {
  try {
    const ov = localStorage.getItem(KEY(id));
    if (ov) return { doc: JSON.parse(ov) as JourneyDoc, edited: true };
  } catch {
    /* fall back to shipped */
  }
  return { doc: shipped, edited: false };
}

export function saveJourneyDoc(id: string, doc: JourneyDoc): void {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(doc));
  } catch {
    /* private mode */
  }
}

export function clearJourneyDoc(id: string): void {
  try {
    localStorage.removeItem(KEY(id));
  } catch {
    /* ignore */
  }
}

export function hasJourneyOverride(id: string): boolean {
  try {
    return localStorage.getItem(KEY(id)) != null;
  } catch {
    return false;
  }
}
