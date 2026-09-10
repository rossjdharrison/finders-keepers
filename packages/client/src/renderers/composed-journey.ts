// The COMPOSED journey renderer — the prototype that makes the intra-cassette decomposition
// viewable and workable. Where the flat journey renders one collection's field-groups, this renders
// ONE application (the activity spine) beside its configurator CHILDREN, each a different collection
// (vehicles / drivers / covers) resolved via the app relation. Each section edits its child row; the
// rail shows the application's rolled-up premium. It reuses the same seam — resolvePlan → plan →
// mountCell → hooks/CSS — just fanned across collections through the workspace. Proof that a
// multi-configurator journey feels identical to the flat one, backed by relations + rollup in wasm.

import { effect } from '@preact/signals-core';
import type { Value } from '@core/values';
import type { CollectionDoc, EnumOption, WorkspaceStore } from '../types.ts';
import { resolvePlan, overridesFrom, type RenderVocabulary, type PresentationOverride } from '../resolve.ts';
import { mountCell } from '../cells.ts';
import { format } from '../format.ts';

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const isMoney = (v: Value | undefined): v is Value & { t: 'money' } => !!v && v.t === 'money';

export interface ComposedSection {
  id: string;
  label: string;
  collection: string; // the configurator collection this section edits
  childField: string; // the field on that collection's row that refs the spine (the relation's childField)
  fields: string[];
}
export interface ComposedSummary {
  total: string; // the spine's headline money field (e.g. the rolled-up premium)
  per?: string; // a per-period suffix shown beside the total (e.g. "per maand")
  lines?: { field: string; label?: string }[]; // the breakdown (spine fields, e.g. rollup subtotals)
}
export interface ComposedConfig {
  workspace: WorkspaceStore;
  appColl: string; // the spine collection (the relations' parent)
  sections: ComposedSection[];
  summary?: ComposedSummary; // the rail — headline total + breakdown, read from the cassette (not hardcoded)
  collections: CollectionDoc[]; // the model collections (for resolvePlan)
  types: Record<string, { specializes: string[] }>;
  vocab: RenderVocabulary;
  overrides: PresentationOverride[];
  labels: Record<string, string>;
  enums: Record<string, EnumOption[]>;
  title: string;
}

export function mountComposedJourney(mount: HTMLElement, cfg: ComposedConfig): () => void {
  const appStore = cfg.workspace.collection(cfg.appColl)!;
  const overrides = overridesFrom(cfg.overrides);
  const l10n = new Map(Object.entries(cfg.labels));
  const collById = new Map(cfg.collections.map((c) => [c.id, c]));
  const labelOf = (f: string): string => cfg.labels[f] ?? f;

  mount.replaceChildren();
  const wrap = el('div', 'journey');
  mount.append(wrap);

  return effect(() => {
    const app = appStore.rows.value[0];
    wrap.replaceChildren();
    if (!app) {
      wrap.append(el('div', 'empty', 'Geen aanvraag.'));
      return;
    }

    const card = el('article', 'journey-card composed-card');
    const main = el('div', 'jc-main');
    card.append(main);
    main.append(el('h2', 'jc-page-title', cfg.title));

    for (const section of cfg.sections) {
      const childStore = cfg.workspace.collection(section.collection);
      const collDoc = collById.get(section.collection);
      if (!childStore || !collDoc) continue;
      // the configurator's row is the child of THIS application, joined via the relation's childField
      const jf = section.childField;
      const row = childStore.rows.value.find((r) => r.doc[jf]?.t === 'ref' && (r.doc[jf] as { id: string }).id === app.id);
      if (!row) continue;
      const plan = resolvePlan({ collection: collDoc, types: cfg.types, vocab: cfg.vocab, overrides, audience: { l10n }, row });
      const byField = new Map(plan.fields.map((f) => [f.node.slice(f.node.indexOf('.') + 1), f]));

      const sec = el('section', 'jc-section');
      sec.dataset.section = section.id;
      sec.setAttribute('aria-label', section.label);
      sec.append(el('h3', 'jc-section-title', section.label));
      const grid = el('div', 'journey-fields');
      for (const field of section.fields) {
        const fp = byField.get(field);
        if (!fp || fp.hidden) continue;
        const prop = childStore.propOf(field);
        const options = prop && prop.valueType.k === 'enum' ? cfg.enums[prop.valueType.set] : undefined;
        const inputId = `c-${section.collection}-${row.id}-${field}`;
        const isBool = !!prop && prop.valueType.k === 'bool';
        const willEdit = !!prop && fp.editable && prop.valueType.k !== 'ref';

        const cell = el('div', 'jf');
        cell.dataset.role = fp.role;
        cell.dataset.provenance = prop?.source === 'computed' ? 'derived' : 'authored';

        if (!willEdit) {
          cell.classList.add('jf-readout');
          cell.append(el('span', 'jf-rolabel', fp.label), el('span', 'jf-rovalue', format(row.doc[field], options) || '—'));
        } else if (isBool) {
          cell.classList.add('jf-bool');
          const box = el('span', 'jf-check');
          mountCell(box, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => childStore.setField(row.id, field, v), id: inputId });
          const lab = el('label', 'jf-boollabel') as HTMLLabelElement;
          lab.htmlFor = inputId;
          lab.textContent = fp.label;
          cell.append(box, lab);
        } else {
          const lab = el('label', 'jf-label') as HTMLLabelElement;
          lab.htmlFor = inputId;
          lab.textContent = fp.label;
          const host = el('div', 'jf-input');
          mountCell(host, { value: row.doc[field], prop: prop!, options, refOptions: undefined, readOnly: false, onEdit: (v) => childStore.setField(row.id, field, v), id: inputId });
          cell.append(lab, host);
        }
        grid.append(cell);
      }
      sec.append(grid);
      main.append(sec);
    }

    // the rail: the spine's rolled-up total, composed from the configurators via relations + rollup in
    // the sealed core. Both the headline field and the breakdown lines are read from the cassette's
    // journey.summary — no hardcoded field ids, so any composed cassette renders its own rail.
    const totalField = cfg.summary?.total ?? 'premium';
    const rail = el('aside', 'jc-rail');
    rail.setAttribute('aria-label', labelOf(totalField));
    const quote = el('div', 'quote');
    quote.append(el('div', 'quote-eyebrow', labelOf(totalField)));
    const total = app.doc[totalField];
    if (isMoney(total)) {
      const hero = el('div', 'quote-hero');
      hero.append(el('span', 'quote-amount', format(total)));
      if (cfg.summary?.per) hero.append(el('span', 'quote-per', cfg.summary.per));
      quote.append(hero);
      const lines = el('dl', 'quote-lines');
      for (const ld of cfg.summary?.lines ?? []) {
        const v = app.doc[ld.field];
        if (!isMoney(v)) continue;
        const r = el('div', 'quote-line');
        r.append(el('dt', undefined, ld.label ?? labelOf(ld.field)), el('dd', undefined, format(v)));
        lines.append(r);
      }
      if (lines.children.length) quote.append(lines);
    } else {
      quote.append(el('p', 'quote-empty', 'Vul de onderdelen in — het totaal stelt zich samen uit de configuratoren.'));
    }
    rail.append(quote);
    card.append(rail);
    wrap.append(card);
  });
}
