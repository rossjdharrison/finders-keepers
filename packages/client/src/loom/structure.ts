// The Loom's STRUCTURE projector — a schema-driven view of any cassette's shape.
//
// This lifts the projection logic that lived INSIDE docsRenderer.describe() (docs.ts) but was gated
// behind authored doc-records (empty for cassettes, so it drew nothing). Here it iterates the cassette's
// own collections / properties / relations DIRECTLY, so it works for every cassette with no authored
// docs. Every line is DERIVED from the model — the field's HQDM grounding chain, its source, its
// computed formula in prose (describeFormula), the relation edges — never hand-written. A cassette can
// never drift ahead of this view the way a prose paragraph can.

import { supertypesOf } from '@core/ontology';
import type { Cassette } from '@app/core-runtime';
import { describeFormula } from '../renderers/docs.ts';
import type { Property, RelationMeta, TypeMap } from '../types.ts';

export interface FieldNode {
  coll: string;
  id: string;
  label: string;
  source: 'stored' | 'computed' | 'extern';
  /** e.g. "money", "num", "enum · term", "ref → vehicles" */
  typeStr: string;
  category?: string; // HQDM class for this field's values
  chain?: string; // the HQDM grounding chain string
  formulaProse?: string; // describeFormula(formula), computed only
  gated: boolean; // an availableWhen guard is present
  constraintFmt?: string; // kenteken / postcode (a live external lookup key)
}

export interface CollNode {
  id: string;
  label: string;
  semanticClass: string;
  chain: string;
  fieldCount: number;
  computedCount: number;
  fields: FieldNode[];
}

export interface RelationEdge {
  via: string;
  parentColl: string;
  childColl: string;
  childField: string;
  prose: string;
}

export interface StructureModel {
  collections: CollNode[];
  relations: RelationEdge[];
}

export interface ProjectOpts {
  /** field/collection id → localized label (merged l10n) */
  label: (id: string) => string;
}

const typeStr = (vt: Property['valueType']): string => {
  if (vt.k === 'ref') return `ref → ${(vt as { collection?: string }).collection ?? '?'}`;
  if (vt.k === 'enum' || vt.k === 'enumset') return `${vt.k} · ${(vt as { set?: string }).set ?? '?'}`;
  if (vt.k === 'list') return `list · ${((vt as { of?: { k?: string } }).of?.k) ?? '?'}`;
  return vt.k;
};

/** Project a cassette into a pure, renderable structure. No DOM, no side effects — unit-testable. */
export function projectStructure(cass: Cassette, opts: ProjectOpts): StructureModel {
  const T = (cass.types ?? {}) as TypeMap;
  const chainStr = (sc: string): string => [sc, ...supertypesOf(sc, T)].join(' → ');
  const relations = (cass.relations ?? {}) as Record<string, RelationMeta>;

  const collections: CollNode[] = cass.collections.map((coll) => {
    const props = (coll.properties ?? []) as Property[];
    const fields: FieldNode[] = props.map((p) => {
      const source = (p.source ?? 'stored') as FieldNode['source'];
      return {
        coll: coll.id,
        id: p.id,
        label: opts.label(p.id),
        source,
        typeStr: typeStr(p.valueType),
        category: p.category,
        chain: p.category ? chainStr(p.category) : undefined,
        formulaProse: source === 'computed' && p.formula ? describeFormula(p.formula) : undefined,
        gated: !!p.availableWhen,
        constraintFmt: p.constraint?.format,
      };
    });
    return {
      id: coll.id,
      label: opts.label(coll.id),
      semanticClass: coll.semanticClass,
      chain: chainStr(coll.semanticClass),
      fieldCount: fields.length,
      computedCount: fields.filter((f) => f.source === 'computed').length,
      fields,
    };
  });

  const rels: RelationEdge[] = Object.entries(relations).map(([via, r]) => ({
    via,
    parentColl: r.parentColl,
    childColl: r.childColl,
    childField: r.childField,
    prose: `each ${opts.label(r.childColl)} names its ${opts.label(r.parentColl)} through ${r.childField}`,
  }));

  return { collections, relations: rels };
}

// --- rendering -----------------------------------------------------------------------------------

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const SOURCE_GLYPH: Record<FieldNode['source'], string> = { stored: '▢', computed: 'ƒ', extern: '☁' };
const SOURCE_LABEL: Record<FieldNode['source'], string> = { stored: 'invoer', computed: 'berekend', extern: 'extern' };

/** Render the structure model into `mount`. Pure projection of the schema; nothing authored. */
export function renderStructure(mount: HTMLElement, sm: StructureModel): void {
  mount.replaceChildren();
  const root = el('div', 'lm-structure');

  for (const c of sm.collections) {
    const card = el('section', 'lm-coll');

    const head = el('div', 'lm-coll-head');
    const titleWrap = el('div', 'lm-coll-title-wrap');
    titleWrap.append(el('span', 'lm-coll-title', c.label));
    if (c.label !== c.id) titleWrap.append(el('span', 'lm-mono lm-coll-id', c.id));
    head.append(titleWrap);
    const counts = el('div', 'lm-coll-counts');
    counts.append(el('span', 'lm-coll-count', `${c.fieldCount} velden`));
    counts.append(el('span', 'lm-coll-count lm-count-computed', `${c.computedCount} berekend`));
    head.append(counts);
    card.append(head);

    const cls = el('div', 'lm-coll-class');
    cls.append(el('span', 'lm-cls-name', c.semanticClass));
    cls.append(el('span', 'lm-chain', `↳ ${c.chain}`));
    card.append(cls);

    const list = el('div', 'lm-fields');
    for (const f of c.fields) {
      const row = el('div', `lm-field lm-src-${f.source}`);

      const badge = el('span', 'lm-src-badge', SOURCE_GLYPH[f.source]);
      badge.title = SOURCE_LABEL[f.source];
      badge.setAttribute('aria-label', SOURCE_LABEL[f.source]);
      row.append(badge);

      const main = el('div', 'lm-field-main');
      const line = el('div', 'lm-field-line');
      line.append(el('span', 'lm-field-label', f.label));
      line.append(el('span', 'lm-mono lm-field-type', f.typeStr));
      if (f.gated) {
        const g = el('span', 'lm-tag lm-tag-gated', 'voorwaardelijk');
        g.title = 'in beeld alleen als de availableWhen-voorwaarde geldt';
        line.append(g);
      }
      if (f.constraintFmt) line.append(el('span', 'lm-tag lm-tag-live', f.constraintFmt));
      main.append(line);

      if (f.formulaProse) {
        const fx = el('code', 'lm-mono lm-field-formula');
        fx.append(el('span', 'lm-eq', '= '));
        fx.append(document.createTextNode(f.formulaProse));
        main.append(fx);
      }
      if (f.chain) main.append(el('div', 'lm-field-ground', `HQDM: ${f.chain}`));

      row.append(main);
      list.append(row);
    }
    card.append(list);
    root.append(card);
  }

  if (sm.relations.length) {
    const relCard = el('section', 'lm-coll lm-relations');
    relCard.append(el('div', 'lm-coll-head', ''));
    (relCard.firstChild as HTMLElement).append(el('span', 'lm-coll-title', 'Relaties'));
    for (const r of sm.relations) {
      const row = el('div', 'lm-relation');
      row.append(el('span', 'lm-mono lm-rel-via', r.via));
      const edge = el('span', 'lm-rel-edge');
      edge.append(el('span', 'lm-rel-node', r.childColl));
      edge.append(el('span', 'lm-rel-arrow', '→'));
      edge.append(el('span', 'lm-rel-node', r.parentColl));
      row.append(edge);
      row.append(el('span', 'lm-rel-prose', r.prose));
      relCard.append(row);
    }
    root.append(relCard);
  }

  mount.append(root);
}
