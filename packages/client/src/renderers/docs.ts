// The node doc-view renderer — docs as a PROJECTION, with a shape.
//
// A doc has two layers, and the split is the whole point (decision dec-doc-shape):
//   · WHAT  (derived)  — the mechanism, read from the model: a node's HQDM grounding
//                        chain, a computed field's formula in prose, a relation's edge.
//   · INTENT (authored) — the only hand-written prose (the doc-record's body).
// Because WHAT is derived here at render time, a doc can never drift ahead of the
// model the way a hand-authored mechanism paragraph can.

import { supertypesOf } from '@core/ontology';
import type { CollectionDoc, DocRecord, Property, Renderer, RelationMeta, TypeMap } from '../types.ts';
import { format } from '../format.ts';

const elem = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const CMP: Record<string, string> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', add: '+', sub: '−', mul: '×', div: '÷' };

// A formula AST -> a compact, readable expression. This is the derived "mechanism":
// it is READ from the stored formula, never typed by a doc author.
function describeFormula(node: unknown): string {
  const n = node as { op?: string; id?: string; value?: import('@core/values').Value; args?: unknown[]; via?: string; agg?: string; of?: unknown; table?: string; key?: unknown; key2?: unknown; cmp?: unknown; observable?: unknown; threshold?: unknown; pred?: unknown; evidence?: unknown; fn?: string; path?: string[] };
  if (!n || typeof n !== 'object') return String(node);
  switch (n.op) {
    case 'field': return n.id ?? '?';
    case 'lit': return format(n.value);
    case 'ref': return (n.path ?? []).join('.');
    case 'rollup': return `${n.agg}(${n.via}.${describeFormula(n.of)})`;
    case 'lookup': return `lookup(${n.table}, ${describeFormula(n.key)}${n.key2 ? `, ${describeFormula(n.key2)}` : ''})`;
    case 'build': return `predicate: ${describeFormula(n.observable)} ${CMP[String((n.cmp as { id?: string })?.id ?? '')] ?? describeFormula(n.cmp)} ${describeFormula(n.threshold)}`;
    case 'check': return `check(${describeFormula(n.pred)} against ${describeFormula(n.evidence)})`;
    case 'signal': return String((n as { name?: string }).name ?? '?');
    case 'call': return `${n.fn}(${(n.args ?? []).map(describeFormula).join(', ')})`;
    default:
      if (n.op && CMP[n.op] && n.args?.length === 2) return `${describeFormula(n.args[0])} ${CMP[n.op]} ${describeFormula(n.args[1])}`;
      return n.op ? `${n.op}(${(n.args ?? []).map(describeFormula).join(', ')})` : '—';
  }
}

export const docsRenderer: Renderer = (mount, { model }) => {
  const { collections, relations, types, docRecords } = model;
  const byId = new Map(collections.map((c) => [c.id, c]));
  const T = types as TypeMap;
  const chainStr = (sc: string): string => [sc, ...supertypesOf(sc, T)].join(' → ');

  // classify a home into (kind, groupKey) and produce its derived "what"
  type Kind = 'collection' | 'field' | 'relation';
  const describe = (home: string): { kind: Kind; group: string; what: HTMLElement } => {
    // relation:via
    if (home.startsWith('relation:')) {
      const via = home.slice('relation:'.length);
      const r = relations[via] as RelationMeta | undefined;
      const what = elem('div', 'doc-what-body');
      what.textContent = r
        ? `A many-to-one relation: each ${r.childColl} names its ${r.parentColl} through the ${r.childField} field.`
        : `An unresolved relation '${via}'.`;
      return { kind: 'relation', group: 'relations', what };
    }
    // coll.field
    const dot = home.indexOf('.');
    if (dot > 0 && byId.has(home.slice(0, dot))) {
      const coll = home.slice(0, dot);
      const field = home.slice(dot + 1);
      const prop = (byId.get(coll)?.properties ?? []).find((p) => p.id === field) as Property | undefined;
      const what = elem('div', 'doc-what-body');
      if (!prop) {
        what.textContent = `A field '${field}' of ${coll} (not found in the current schema).`;
      } else {
        const kindStr = prop.valueType.k === 'ref' ? `ref → ${(prop.valueType as { collection?: string }).collection}` : prop.valueType.k;
        what.append(elem('div', undefined, `A ${prop.source ?? 'stored'} field of ${coll}, valued ${kindStr}.`));
        if (prop.category) what.append(elem('div', 'doc-ground', `HQDM: ${chainStr(prop.category)}`));
        if (prop.source === 'computed' && prop.formula) what.append(elem('div', 'doc-formula', `= ${describeFormula(prop.formula)}`));
        if (prop.availableWhen) what.append(elem('div', 'doc-gated', 'in play only when its availableWhen guard holds (category-gated)'));
      }
      return { kind: 'field', group: coll, what };
    }
    // collection
    const c = byId.get(home) as CollectionDoc | undefined;
    const what = elem('div', 'doc-what-body');
    if (c) {
      const computed = (c.properties ?? []).filter((p) => p.source === 'computed').length;
      what.append(elem('div', undefined, `A collection — its members are classified as ${c.semanticClass}.`));
      what.append(elem('div', 'doc-ground', `HQDM: ${chainStr(c.semanticClass)}`));
      what.append(elem('div', undefined, `${c.properties?.length ?? 0} properties (${computed} computed).`));
    } else {
      what.textContent = `A node '${home}'.`;
    }
    return { kind: 'collection', group: home, what };
  };

  mount.replaceChildren();
  const root = elem('div', 'docs-view');

  const header = elem('div', 'sp-header');
  header.append(elem('div', 'sp-title', 'Model docs'));
  header.append(elem('div', 'sp-sub', `${docRecords.length} docs, each homed on a model node (the Place law). Each has a shape:`));
  const legend = elem('div', 'docs-legend');
  legend.append(elem('span', 'docs-badge doc-what-badge', 'WHAT — derived from the model'));
  legend.append(elem('span', 'docs-badge doc-intent-badge', 'INTENT — the only authored prose'));
  header.append(legend);
  root.append(header);

  // group docs by home-collection (relations last), collections in schema order
  const groups = new Map<string, DocRecord[]>();
  for (const d of docRecords) {
    const g = describe(d.home).group;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(d);
  }
  const order = [...collections.map((c) => c.id), 'relations'];
  const groupKeys = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  for (const gk of groupKeys) {
    const section = elem('div', 'docs-section');
    section.append(elem('div', 'docs-section-head', gk === 'relations' ? 'relations' : gk));
    for (const d of groups.get(gk)!) {
      const { kind, what } = describe(d.home);
      const card = elem('div', 'doc-card');
      const subj = elem('div', 'doc-subject');
      subj.append(elem('span', 'sp-mono doc-home', d.home));
      subj.append(elem('span', `doc-kind doc-kind-${kind}`, kind));
      card.append(subj);
      card.append(elem('div', 'doc-title', d.title));

      const whatBlock = elem('div', 'doc-layer');
      whatBlock.append(elem('div', 'doc-layer-label doc-what-label', 'what · derived'));
      whatBlock.append(what);
      card.append(whatBlock);

      const intentBlock = elem('div', 'doc-layer');
      intentBlock.append(elem('div', 'doc-layer-label doc-intent-label', 'intent · authored'));
      intentBlock.append(elem('div', 'doc-intent-body', d.body));
      card.append(intentBlock);

      section.append(card);
    }
    root.append(section);
  }

  mount.append(root);
  return () => undefined;
};
