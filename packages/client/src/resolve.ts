// resolve() — the neutral waist of the client. It PROJECTS the model (logic rows ⋈
// presentation overrides ⋈ render-vocabulary) into a RenderPlan: a neutral description
// of what to show, naming only vocabulary members + node refs + values, never pixels
// and never field-name-specific logic. A renderer turns a plan into DOM with data-render-*
// hooks; CSS paints the hooks; an AI agent can consume the same plan directly. This is
// the D→P→R waist of dec-presentation.
//
// Two orthogonal seams are folded in from the start (grounded in HQDM's representation
// region — pattern / sign / recognizing_language_community):
//   · i18n/l10n  — labels are TOKENS (a `pattern`), resolved to a localized string (a
//                  `sign`) for the audience's locale; absent l10n, a humanized default.
//   · viewer     — the verified actor's scope decides affordance (editable vs read-only),
//                  never content confidentiality (that stays server-side).

import { supertypesOf, CORE } from '@core/ontology';
import type { CollectionDoc, Property, RowStateWire, TypeMap } from './types.ts';

/** A render pattern (a renderVocabulary row): an HQDM category's default presentation form. */
export interface RenderPattern {
  family: string;
  glyph?: string;
  label?: string;
}
/** category → its render pattern, built from the renderVocabulary rows (row-sourced, traceable). */
export type RenderVocabulary = Map<string, RenderPattern>;

/** The audience axis (i18n): a locale-community + the localized strings it recognizes. */
export interface Audience {
  locale?: string;
  l10n?: Map<string, string>; // labelToken → localized string (a `sign` for this community)
}
/** The viewer axis (permissions): the verified actor's coarse authority. */
export interface Viewer {
  canWrite?: boolean;
}

/** A P-layer override (a presentation/ record): references a subject node, carries only presentation. */
export interface PresentationOverride {
  id?: string;
  subject: string; // a logic node: "collection" or "collection.field"
  variant?: string;
  role?: string;
  label?: string; // a label-token override
  emphasis?: string;
  order?: number;
  stateRules?: Record<string, string>; // an enum value → a neutral state token (value-conditional style)
}

export interface FieldPlan {
  node: string; // the logic node this projects: "collection.field"
  cell: string; // the value-type widget kind (valueType.k)
  role: string; // neutral role: status / relation / measure / spec / text
  labelToken: string; // the stable, traceable token (default: the field id)
  label: string; // the resolved, localized label (i18n seam)
  state?: string; // a neutral state token for value-conditional style (e.g. an enum value; "blocked" when gated)
  emphasis?: string; // a neutral emphasis token (a presentation override)
  editable: boolean; // affordance (viewer seam): stored AND the viewer may write
  hidden: boolean; // availableWhen said not-in-play for this record
}
export interface RenderPlan {
  collection: string;
  family: string; // the collection-level renderer family, from HQDM classification
  variant?: string; // a presentation override (P layer); absent = the family's default
  fields: FieldPlan[];
}

export const UNIVERSAL_FAMILY = 'universal';

/** The collection's default family: climb `specializes` to the nearest category with a pattern. */
export function familyOf(semanticClass: string, types: TypeMap, vocab: RenderVocabulary): string {
  if (vocab.has(semanticClass)) return vocab.get(semanticClass)!.family;
  for (const s of supertypesOf(semanticClass, types)) if (vocab.has(s)) return vocab.get(s)!.family;
  return UNIVERSAL_FAMILY;
}

function humanize(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** A neutral role derived from the field's HQDM category (+ value type). Overridable by P. */
function deriveRole(p: Property, types: TypeMap): string {
  const k = (p.valueType as { k?: string }).k;
  if (k === 'ref') return 'relation';
  if (p.category) {
    const anc = [p.category, ...supertypesOf(p.category, types)];
    if (anc.includes('state') || anc.includes('class_of_state')) return 'status';
    if (anc.includes('physical_quantity')) return 'measure';
    if (anc.includes('sign')) return 'spec';
  }
  if (k === 'num' || k === 'money' || k === 'pct') return 'measure';
  return 'text';
}

const localize = (token: string, fieldId: string, aud?: Audience): string =>
  aud?.l10n?.get(token) ?? humanize(fieldId);

export interface ResolveInput {
  collection: CollectionDoc;
  types: TypeMap;
  vocab: RenderVocabulary;
  overrides?: Record<string, PresentationOverride>; // P layer, keyed by node ("collection" and "collection.field")
  labels?: Record<string, string>; // authored label-token overrides per field (falls back under an override)
  variant?: string; // authored variant override (falls back under a collection override)
  viewer?: Viewer;
  audience?: Audience;
  row?: RowStateWire; // for per-record state/hidden (optional)
}

/** Project a collection (+ optional record + P overrides) into a neutral RenderPlan. Pure. */
export function resolvePlan(input: ResolveInput): RenderPlan {
  const { collection, types, vocab, overrides, labels, variant, viewer, audience, row } = input;
  const family = familyOf(collection.semanticClass, types, vocab);
  const canWrite = viewer?.canWrite ?? true;
  const collOverride = overrides?.[collection.id];
  const fields: FieldPlan[] = (collection.properties ?? []).map((p) => {
    const node = `${collection.id}.${p.id}`;
    const ov = overrides?.[node];
    const k = (p.valueType as { k?: string }).k ?? 'text';
    const token = ov?.label ?? labels?.[p.id] ?? p.id;
    const hidden = row?.hidden?.includes(p.id) ?? false;
    const rawVal = row?.doc[p.id];
    const enumVal = rawVal && rawVal.t === 'enum' ? rawVal.v : undefined;
    // value → neutral state (CLOSED codomain): a gated field is "blocked"; else the override's
    // stateRules map the enum to a neutral token (e.g. accepted → positive). No rule → no state
    // (the raw domain enum must NEVER become a style hook), so S only ever sees neutral tokens.
    const state = hidden ? 'blocked' : enumVal !== undefined ? ov?.stateRules?.[enumVal] : undefined;
    return {
      node,
      cell: k,
      role: ov?.role ?? deriveRole(p, types),
      labelToken: token,
      label: localize(token, p.id, audience),
      state,
      emphasis: ov?.emphasis,
      editable: p.source !== 'computed' && canWrite,
      hidden,
    };
  });
  return { collection: collection.id, family, variant: variant ?? collOverride?.variant, fields };
}

/** The vocabulary straight from the frozen CORE.renderHints (category → render pattern). The
 * genesis source — the same values the bundle projects into renderVocabulary rows. A cassette
 * has no renderVocabulary rows of its own, so it uses this. */
export function coreVocabulary(): RenderVocabulary {
  const v: RenderVocabulary = new Map();
  for (const [cat, h] of Object.entries(CORE.renderHints)) v.set(cat, { family: h.render ?? UNIVERSAL_FAMILY, glyph: h.glyph, label: h.label });
  return v;
}

/** Index a list of P-layer overrides by their subject node (the shape resolvePlan wants). */
export function overridesFrom(list: PresentationOverride[]): Record<string, PresentationOverride> {
  return Object.fromEntries(list.map((o) => [o.subject, o]));
}

/** Build the row-sourced vocabulary from renderVocabulary insert-ops (the bundle's projection). */
export function vocabularyFrom(seedOps: { op: string; coll: string; row: string; values?: Record<string, { t?: string; v?: string }> }[]): RenderVocabulary {
  const v: RenderVocabulary = new Map();
  for (const op of seedOps) {
    if (op.op === 'insert' && op.coll === 'renderVocabulary') {
      const f = op.values?.family;
      v.set(op.row, {
        family: f && f.t === 'text' ? (f.v ?? UNIVERSAL_FAMILY) : UNIVERSAL_FAMILY,
        glyph: op.values?.glyph?.v,
        label: op.values?.label?.v,
      });
    }
  }
  return v;
}
