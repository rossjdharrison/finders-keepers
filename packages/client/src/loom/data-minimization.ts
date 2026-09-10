// Data minimization — "privacy by design" as a COMPUTED property of the composition.
//
// A configurator (e.g. an Individual) may declare a rich schema, but a given journey only ever consumes
// a few of its fields. This derives, per model, the MINIMAL set of stored inputs the journey provably
// needs from it: walk backwards from what the journey EXPORTS out of that model — its binding sources,
// its surfaced fields, and (for the spine) its own total contributions — down to the stored inputs those
// values depend on, STOPPING at any field already supplied by an inbound binding (that value is provided
// upstream, so it is never collected here). Everything the walk never reaches is data you would collect
// but never use — so a minimal journey simply does not show it. Nothing is hand-listed; you cannot
// over-collect, because "needed" is derived from what the model's outputs actually depend on.

import type { Cassette } from '@app/core-runtime';
import type { JourneyDoc } from '../compile-journey.ts';
import type { Property } from '../types.ts';

const localId = (s: string): string => s.split(':')[1] ?? s;

/** The same-collection field ids a formula reads (field / ref / lookup keys / call+binary args). */
function formulaFieldDeps(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    const x = n as { op?: string; id?: string; path?: string[]; key?: unknown; key2?: unknown; cmp?: unknown; observable?: unknown; threshold?: unknown; pred?: unknown; evidence?: unknown; args?: unknown[] };
    if (!x || typeof x !== 'object') return;
    switch (x.op) {
      case 'field': if (x.id) out.push(x.id); return;
      case 'ref': if (x.path?.[0]) out.push(x.path[0]); return;
      case 'lit': case 'signal': case 'rollup': return; // rollup is cross-record, not a same-model input
      case 'lookup': walk(x.key); if (x.key2) walk(x.key2); return;
      case 'build': walk(x.cmp); walk(x.observable); walk(x.threshold); return;
      case 'check': walk(x.pred); walk(x.evidence); return;
      default: if (Array.isArray(x.args)) x.args.forEach(walk);
    }
  };
  walk(node);
  return out;
}

export interface Minimization {
  /** stored inputs the user must ENTER + the model's exported computed readouts (in schema order) */
  shown: string[];
  /** fields the journey never uses — collected-but-unused, so a minimal journey hides them */
  hidden: string[];
  /** the values the journey pulls OUT of this model (binding sources + surfaced + spine total terms) */
  exports: string[];
}

/** Derive the minimal field set a model must collect for a journey, and the fields it can safely omit. */
export function neededFields(doc: JourneyDoc, alias: string, registry: Record<string, Cassette>): Minimization {
  const ref = doc.models.find((m) => m.as === alias)?.ref;
  const cass = ref ? registry[ref] : undefined;
  const props = (cass?.collections[0]?.properties ?? []) as (Property & { params?: Record<string, string> })[];
  const byId = new Map(props.map((p) => [p.id, p]));

  // fields on this model that an inbound binding supplies — provided upstream, never collected here
  const boundTargets = new Set(doc.bindings.filter((b) => b.to === alias).flatMap((b) => b.contract.requires.map((r) => localId(r.target))));

  // what the journey exports OUT of this model
  const exports = new Set<string>();
  for (const b of doc.bindings) if (b.from === alias) {
    for (const p of b.contract.provides) exports.add(localId(p.source)); // the provided source fields
    // a binding's mapping/condition is evaluated on THIS (child) row, so any field it reads BEYOND the
    // declared seam vars is a genuine input of this model that the seam consumes — count it as an export,
    // else it would be false-hidden while the compiled seam still reads it.
    const seamVars = new Set(b.contract.provides.map((p) => p.as));
    for (const m of b.mapping ?? []) for (const r of formulaFieldDeps(m.from)) if (!seamVars.has(r)) exports.add(r);
    if (b.condition) for (const r of formulaFieldDeps(b.condition)) if (!seamVars.has(r)) exports.add(r);
  }
  for (const s of doc.surface ?? []) if (s.from === alias) exports.add(s.field);
  if (alias === doc.spine) for (const f of doc.total.of) if (byId.has(f)) exports.add(f); // the spine's OWN total terms
  // author-declared COMPUTED readouts: a computed field the author lists in this model's section is a derived
  // output they want displayed (e.g. an affordability verdict). Minimization here means "collect only what the
  // DISPLAYED outputs provably need": a readout is itself derived (stores nothing), and the walk below pulls in
  // exactly the stored inputs that readout DEPENDS ON — no more. Those inputs are genuinely needed (you cannot
  // show the readout without them), so this never over-collects relative to what is shown. In this journey the
  // readouts read only bound targets (income/obligations, provided upstream) + already-needed fields, so nothing
  // NEW is collected on this side; a readout that read an unbound stored field WOULD (correctly) surface it as
  // needed. Gated to source==='computed' (never extern auto-fills or stored inputs) and never a bound target, so
  // it can never force-show a field a journey would otherwise hide (an extern's stored params, or a seam value).
  const section = doc.sections.find((s) => s.model === alias);
  if (section) for (const fid of section.fields) {
    const p = byId.get(fid);
    if (p && (p.source ?? 'stored') === 'computed' && !boundTargets.has(fid)) exports.add(fid);
  }

  // walk each export down to the stored inputs it depends on, stopping at bound (provided) fields
  const needed = new Set<string>();
  const seen = new Set<string>();
  const walk = (fid: string): void => {
    if (seen.has(fid)) return;
    seen.add(fid);
    if (boundTargets.has(fid)) return; // supplied by a binding — not entered here
    const p = byId.get(fid);
    if (!p) return;
    // a field's availableWhen GATE has its own inputs; if they were hidden the gate could never be
    // satisfied and the (shown) field would be permanently unreachable — so collect the gate's inputs too.
    if (p.availableWhen) for (const dep of formulaFieldDeps(p.availableWhen)) walk(dep);
    const src = p.source ?? 'stored';
    if (src === 'stored') { needed.add(fid); return; } // a real input the user must provide
    if (src === 'extern') { for (const dep of Object.values(p.params ?? {})) walk(dep); return; } // its params are its inputs
    if (src === 'computed' && p.formula) { for (const dep of formulaFieldDeps(p.formula)) walk(dep); return; }
  };
  for (const e of exports) walk(e);

  const exportComputed = props.filter((p) => exports.has(p.id) && (p.source ?? 'stored') !== 'stored').map((p) => p.id); // outputs, read-only
  const shownSet = new Set([...needed, ...exportComputed]);
  const shown = props.map((p) => p.id).filter((id) => shownSet.has(id));
  const hidden = props.map((p) => p.id).filter((id) => !shownSet.has(id) && !boundTargets.has(id));
  return { shown, hidden, exports: [...exports] };
}
