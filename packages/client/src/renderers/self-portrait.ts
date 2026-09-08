// The self-portrait renderer — the system describing itself, LIVE in the browser.
//
// This is the in-app counterpart of scripts/self-portrait.mjs: it PROJECTS the
// loaded model (schema + relations + types + live rows) into the architecture map.
// Nothing here is hand-authored prose — every box is derived. Because it reads the
// live row signals, editing one of the platform's own rows (a requirement's
// priority, say) re-draws the relevant band in place.
//
// It is a strict projection of THE MODEL, so it draws what the model contains: the
// Model bands, the HQDM grounding, and the PROVENANCE of the constitution/engine
// (their decisions + requirements). The law bodies and engine internals live in
// code, outside the model — the boundary section says so. (The build-time script
// can additionally read the gate source and the package layout; the browser can't.)

import { effect } from '@preact/signals-core';
import { isA, supertypesOf, CORE } from '@core/ontology';
import type { Value } from '@core/values';
import type { CollectionDoc, Renderer, RelationMeta, TypeMap } from '../types.ts';

// scalar string behind a text/enum value (for reading live row fields)
const sv = (v: Value | undefined): string | undefined =>
  v && (v.t === 'text' || v.t === 'enum') ? v.v : undefined;

const elem = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const selfPortraitRenderer: Renderer = (mount, { workspace, model }) => {
  const { collections, relations, types, docRecords } = model;
  const byId = new Map(collections.map((c) => [c.id, c]));
  const T = types as TypeMap;

  // ---- derivation that depends only on the (static) schema --------------------
  const chain = (sc: string): string[] => [sc, ...supertypesOf(sc, T)];
  const chainStr = (sc: string): string => {
    const c = chain(sc);
    return c.length > 3 ? `${sc} → … → ${c[c.length - 1]}` : c.join(' → ');
  };
  const isMeta = (c: CollectionDoc): boolean =>
    isA(c.semanticClass, 'class_of_class', T) || isA(c.semanticClass, 'class_of_association', T);

  // relation-connected components over the non-meta collections (union-find)
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const c of collections) if (!isMeta(c)) parent.set(c.id, c.id);
  for (const r of Object.values(relations) as RelationMeta[]) {
    if (parent.has(r.parentColl) && parent.has(r.childColl)) parent.set(find(r.parentColl), find(r.childColl));
  }
  const journeyRoot = parent.has('intentions') ? find('intentions') : undefined;
  const bandOf = (c: CollectionDoc): 'meta' | 'journey' | 'domain' =>
    isMeta(c) ? 'meta' : parent.has(c.id) && find(c.id) === journeyRoot ? 'journey' : 'domain';

  const meta = collections.filter((c) => bandOf(c) === 'meta');
  const journey = collections.filter((c) => bandOf(c) === 'journey');
  const domain = collections.filter((c) => bandOf(c) === 'domain');

  const edgesWithin = (set: Set<string>): string =>
    (Object.entries(relations) as [string, RelationMeta][])
      .filter(([, r]) => set.has(r.parentColl) && set.has(r.childColl))
      .map(([via, r]) => `${r.parentColl}→${r.childColl} (${via})`)
      .join('  ·  ');

  const usedCore = new Set<string>();
  for (const c of collections) for (const t of chain(c.semanticClass)) if (t in CORE.types) usedCore.add(t);
  const coreUsed = [...usedCore].sort((a, b) => supertypesOf(a, T).length - supertypesOf(b, T).length);

  const docOn = (home: string): string | undefined => docRecords.find((d) => d.home === home)?.title;

  // ---- render (inside an effect so live counts / provenance rows track) -------
  const root = elem('div', 'sp');
  mount.append(root);

  const collChip = (c: CollectionDoc): HTMLElement => {
    const n = workspace.collection(c.id)?.rows.value.length ?? 0; // live
    const chip = elem('div', 'sp-chip');
    const head = elem('div', 'sp-chip-head');
    head.append(elem('span', 'sp-chip-title', c.id));
    if (n) head.append(elem('span', 'sp-count', String(n)));
    chip.append(head);
    chip.append(elem('div', 'sp-mono sp-cls', c.semanticClass));
    chip.append(elem('div', 'sp-chain', `↳ ${chainStr(c.semanticClass)}`));
    const intent = docOn(c.id);
    if (intent) chip.append(elem('div', 'sp-intent', intent));
    return chip;
  };

  const band = (title: string, tag: string, tagCls: string, colls: CollectionDoc[]): HTMLElement => {
    const b = elem('div', 'sp-band');
    b.append(elem('div', 'sp-band-head', title));
    b.append(elem('div', `sp-tag ${tagCls}`, tag));
    const grid = elem('div', 'sp-grid');
    for (const c of colls) grid.append(collChip(c));
    b.append(grid);
    const e = edgesWithin(new Set(colls.map((c) => c.id)));
    if (e) b.append(elem('div', 'sp-edges', `relations: ${e}`));
    return b;
  };

  return effect(() => {
    root.replaceChildren();

    // header
    const counts = {
      collections: collections.length,
      relations: Object.keys(relations).length,
      core: Object.keys(CORE.types).length,
      docs: docRecords.length,
    };
    const documented = new Set(docRecords.map((d) => d.home));
    const nodeCount = collections.reduce((a, c) => a + 1 + (c.properties?.length ?? 0), 0) + counts.relations;
    const h = elem('div', 'sp-header');
    h.append(elem('div', 'sp-title', 'Self-portrait'));
    h.append(elem('div', 'sp-sub', 'Generated in the browser from the loaded model. Every box is something the system holds about itself; nothing here is hand-authored.'));
    h.append(elem('div', 'sp-sub', `${counts.collections} collections · ${counts.relations} relations · ${coreUsed.length}/${counts.core} HQDM classes grounded into · ${counts.docs} home-docs · ${documented.size}/${nodeCount} nodes documented`));
    root.append(h);

    // THE MODEL
    const modelBand = elem('div', 'sp-super');
    modelBand.append(elem('div', 'sp-super-head', 'THE MODEL'));
    modelBand.append(elem('div', 'sp-super-sub', 'model/** — data only. Banded by HQDM grounding + relation-connectivity, not a hand-written list.'));
    modelBand.append(band('Reflective metamodel', 'the schema is data — semanticClass reduces to class_of_class / class_of_association', 'sp-meta', meta));
    modelBand.append(band('Dev-journey', 'the relation-component rooted at intentions — the platform’s own design, in itself', 'sp-journey', journey));
    modelBand.append(band('Domain demo', 'the other relation-component — a swappable example', 'sp-domain', domain));
    root.append(modelBand);

    // HQDM CORE
    const hq = elem('div', 'sp-band');
    hq.append(elem('div', 'sp-band-head', 'HQDM CORE'));
    hq.append(elem('div', 'sp-tag sp-core-tag', `the frozen genesis lattice — ${coreUsed.length} classes are grounded into; all climb to thing`));
    const coreGrid = elem('div', 'sp-core-grid');
    for (const t of coreUsed) {
      const cell = elem('div', t === 'thing' ? 'sp-core-cell sp-core-root' : 'sp-core-cell');
      cell.append(elem('span', 'sp-mono', t));
      coreGrid.append(cell);
    }
    hq.append(coreGrid);
    root.append(hq);

    // CONSTITUTION + ENGINE provenance (from live rows), mechanism noted as code
    const reqRows = workspace.collection('requirements')?.rows.value ?? [];
    const mustConstraints = reqRows.filter((r) => sv(r.doc.priority) === 'must' && sv(r.doc.kind) === 'constraint');
    const decRows = workspace.collection('decisions')?.rows.value ?? [];
    const dataModelDecisions = decRows.filter((d) => sv(d.doc.kind) === 'data-model');

    const prov = elem('div', 'sp-band');
    prov.append(elem('div', 'sp-band-head', 'CONSTITUTION & ENGINE — provenance in the model, mechanism in code'));
    prov.append(elem('div', 'sp-tag sp-law-tag', 'The gate’s laws and the engine’s internals live in code, outside the model. What the model DOES hold is why they exist:'));
    const provGrid = elem('div', 'sp-prov-grid');
    const provCard = (label: string, ids: string[], note: string): HTMLElement => {
      const c = elem('div', 'sp-prov');
      c.append(elem('div', 'sp-prov-label', label));
      c.append(elem('div', 'sp-mono sp-prov-ids', ids.length ? ids.join(', ') : '—'));
      c.append(elem('div', 'sp-chain', note));
      return c;
    };
    provGrid.append(provCard('Constitution — must/constraint requirements it discharges', mustConstraints.map((r) => r.id), 'enforced by the gate at build + CI (code, not in the model)'));
    provGrid.append(provCard('Engine — data-model decisions that shaped it', dataModelDecisions.map((d) => d.id), 'mechanism in @core/* + the WorkspaceDO (code)'));
    prov.append(provGrid);
    root.append(prov);

    // THE BOUNDARY — what the model does NOT contain (probed live, whole-word)
    const corpus = [
      ...collections.map((c) => c.id),
      ...['intentions', 'requirements', 'decisions'].flatMap((coll) =>
        (workspace.collection(coll)?.rows.value ?? []).flatMap((r) => Object.values(r.doc).map((v) => sv(v) ?? '')),
      ),
    ].join(' ');
    const mentions = (needle: string): boolean => new RegExp(needle, 'i').test(corpus);
    const boundary: string[] = [
      'the constitution’s law bodies run in scripts/gate.mjs (code); the model holds the requirements they discharge, not the checks',
      'the engine’s mechanism lives in the @core/* packages + the WorkspaceDO (code); the model holds the decisions that shaped it',
    ];
    const topics: [string, string[]][] = [
      ['authentication / access-control', ['authenticat', '\\bactor\\b', '\\bgrant\\b', '\\bacl\\b']],
      ['deployment', ['\\bdeploy', 'cloudflare', '\\bpages\\b']],
      ['a second real domain', ['admission', 'grant intake', 'second domain', '\\btenant']],
    ];
    for (const [label, needles] of topics) {
      if (!needles.some((n) => mentions(n))) boundary.push(`no node about ${label} — the outward turn is declared in prose, not yet in the model`);
    }
    const bd = elem('div', 'sp-band');
    bd.append(elem('div', 'sp-band-head', 'THE BOUNDARY — what this portrait cannot draw from the model'));
    bd.append(elem('div', 'sp-tag sp-domain-tag', 'The honest edge: an absent row is an absent claim. Derived by asking the model what it does NOT contain.'));
    for (const line of boundary) {
      const b = elem('div', 'sp-boundary');
      b.append(elem('span', 'sp-chain', `— ${line}`));
      bd.append(b);
    }
    root.append(bd);
  });
};
