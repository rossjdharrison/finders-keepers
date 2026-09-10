// The Loom's MACRO view — a cross-cassette L2 journey as a COMPOSITION graph.
//
// Where graph.ts draws ONE cassette's field-dependency graph (the micro altitude), this draws a
// JourneyDoc's model composition (the macro altitude): each product cassette is a BOX, each typed
// binding is a WIRE (upstream output → downstream input — the L2 seam), laid out by binding order
// (upstream left → downstream right, the spine carrying the total on the right). A box DRILLS into
// that product's own Loom (loom.html?cassette=<ref>), joining the two altitudes exactly as
// wasm-calculator's journey-loom drills into its value-graph loom. The seam rules live in the member
// products (edited via their own Loom), so this view is READ-ONLY over the composition itself.

import type { JourneyDoc } from '../compile-journey.ts';
import { mountCanvas } from './canvas.ts';

export interface JBox {
  alias: string;
  ref: string;
  label: string;
  isSpine: boolean;
  rank: number;
}
export interface JWire {
  id: string;
  from: string; // alias
  to: string; // alias
  provides: string; // e.g. "output:vehicleValue"
  requires: string; // e.g. "field:principal"
  info: string; // the friendly name of the value carried (the provided field) — shown on the wire
  critical: boolean; // carries a MONEY value — the primary value flow (vs a categorical/rate qualifier)
}
export interface JourneyGraph {
  boxes: JBox[];
  wires: JWire[];
  surface: { as: string; from: string; label: string }[];
  total: { field: string; label: string; per?: string; of: string[] };
  maxRank: number;
}

export interface JourneyGraphOpts {
  label: (id: string) => string; // resolves a model ref to a friendly title
  fieldLabel?: (id: string) => string; // resolves a field id to a friendly label (for wire labels)
  /** does this binding carry a MONEY value into its target? (the primary value flow — the critical path).
   * When omitted, falls back to "targets the spine". */
  targetIsMoney?: (binding: JourneyDoc['bindings'][number]) => boolean;
}

const localId = (s: string): string => s.split(':')[1] ?? s;

/** Build the composition graph for a journey doc. Pure — no DOM. Ranks models by the binding DAG
 * (a `to` sits one column right of its `from`); the spine is pinned to the last column. */
export function buildJourneyGraph(doc: JourneyDoc, opts: JourneyGraphOpts): JourneyGraph {
  const rank = new Map<string, number>();
  for (const m of doc.models) rank.set(m.as, 0);
  // relax edges a few times (models are few; a couple of passes settle the longest path)
  for (let pass = 0; pass < doc.models.length; pass++) {
    for (const b of doc.bindings) {
      const r = Math.max(rank.get(b.to) ?? 0, (rank.get(b.from) ?? 0) + 1);
      rank.set(b.to, r);
    }
  }
  let maxRank = 0;
  for (const r of rank.values()) maxRank = Math.max(maxRank, r);
  // pin the spine to the rightmost column (it carries the total)
  rank.set(doc.spine, maxRank);

  const boxes: JBox[] = doc.models.map((m) => ({
    alias: m.as,
    ref: m.ref,
    label: opts.label(m.ref),
    isSpine: m.as === doc.spine,
    rank: rank.get(m.as) ?? 0,
  }));
  const fieldLabel = opts.fieldLabel ?? ((id: string): string => id);
  const wires: JWire[] = doc.bindings.map((b) => ({
    id: b.id,
    from: b.from,
    to: b.to,
    provides: b.contract.provides.map((p) => p.source).join(', '),
    requires: b.contract.requires.map((r) => r.target).join(', '),
    // what information flows: the friendly name(s) of the provided value(s)
    info: b.contract.provides.map((p) => fieldLabel(localId(p.source))).join(', '),
    // the critical path = the MONEY value flow (e.g. the car value → premium AND → principal); a categorical
    // (region) or rate (loyalty) binding is a qualifier, not the primary flow. Fall back to "feeds the spine".
    critical: opts.targetIsMoney ? opts.targetIsMoney(b) : b.to === doc.spine,
  }));
  const surface = (doc.surface ?? []).map((s) => ({ as: s.as, from: s.from, label: s.label ?? s.as }));
  const total = { field: doc.total.field, label: doc.total.label ?? doc.total.field, per: doc.total.per, of: doc.total.of };
  return { boxes, wires, surface, total, maxRank };
}

// --- SVG rendering -------------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const BOX_W = 210;
const BOX_H = 92;
const H_GAP = 130;
const V_GAP = 26;
const PAD = 22;

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface RenderJourneyOpts {
  /** build the drill href into a member product's Loom */
  loomHref: (ref: string) => string;
}

/** Render the composition graph: model boxes in binding-order columns, binding wires between them,
 * each box a link into that product's Loom. Below the graph: the surfaced lines + the combined total. */
export function renderJourneyGraph(mount: HTMLElement, jg: JourneyGraph, opts: RenderJourneyOpts): void {
  mount.replaceChildren();

  const cols: JBox[][] = [];
  for (const b of jg.boxes) (cols[b.rank] ??= []).push(b);
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  cols.forEach((c, rank) => {
    if (!c) return;
    maxRows = Math.max(maxRows, c.length);
    c.forEach((b, i) => pos.set(b.alias, { x: PAD + rank * (BOX_W + H_GAP), y: PAD + i * (BOX_H + V_GAP) }));
  });
  const width = PAD * 2 + (jg.maxRank + 1) * BOX_W + jg.maxRank * H_GAP;
  const height = PAD * 2 + maxRows * BOX_H + Math.max(0, maxRows - 1) * V_GAP;

  // role="group" (not "img"): the boxes are real drill-in links, so the subtree must stay navigable to
  // assistive tech — an atomic role="img" would prune the very links a keyboard user can still tab to.
  const svg = svgEl('svg', { class: 'lm-jgraph-svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group' });
  svg.setAttribute('aria-label', 'Compositiegrafiek van het pakket: modellen als blokken, bindingen als verbindingen');

  // several bindings can run between the SAME two products (e.g. the individual feeds age/no-claim/km/usage
  // to the insurance). Their wires + labels would stack at one midpoint and become unreadable, so FAN each
  // parallel wire and STAGGER its label by its index within the pair.
  const pairTotal = new Map<string, number>();
  for (const w of jg.wires) { const k = `${w.from}->${w.to}`; pairTotal.set(k, (pairTotal.get(k) ?? 0) + 1); }
  const pairSeen = new Map<string, number>();

  interface WireEls { w: JWire; j: number; n: number; path: SVGPathElement; label: SVGTextElement }
  const FAN = 13; // vertical fan between parallel wires
  const LABEL_STAGGER = 9; // extra label separation on top of the fan
  const geom = (we: WireEls): { d: string; lx: number; ly: number } => {
    const a = pos.get(we.w.from)!;
    const b = pos.get(we.w.to)!;
    const off = (we.j - (we.n - 1) / 2) * FAN;
    const x1 = a.x + BOX_W;
    const y1 = a.y + BOX_H / 2 + off;
    const x2 = b.x;
    const y2 = b.y + BOX_H / 2 + off;
    const dx = Math.max(40, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2 - 7 + (we.j - (we.n - 1) / 2) * LABEL_STAGGER,
    };
  };

  const wireLayer = svgEl('g', { class: 'lm-jwires' });
  const byBox = new Map<string, WireEls[]>(); // alias → the wires touching it (re-routed on drag)
  for (const w of jg.wires) {
    if (!pos.get(w.from) || !pos.get(w.to)) continue;
    const key = `${w.from}->${w.to}`;
    const j = pairSeen.get(key) ?? 0;
    pairSeen.set(key, j + 1);
    const path = svgEl('path', { class: `lm-jwire ${w.critical ? 'lm-jwire-critical' : ''}` });
    const t = svgEl('title');
    t.textContent = `${w.info}: ${w.provides} → ${w.requires}${w.critical ? ' (kritieke waardestroom)' : ''}`;
    path.append(t);
    // mid-wire label: WHAT information is passed (the provided value); its full text on hover (it is truncated in place)
    const lbl = svgEl('text', { class: `lm-jwire-label ${w.critical ? 'lm-jwire-label-critical' : ''}`, 'text-anchor': 'middle' });
    lbl.textContent = truncate(w.info, 18);
    const lt = svgEl('title');
    lt.textContent = w.info;
    lbl.append(lt);
    const we: WireEls = { w, j, n: pairTotal.get(key) ?? 1, path, label: lbl };
    const gg = geom(we);
    path.setAttribute('d', gg.d);
    lbl.setAttribute('x', String(gg.lx));
    lbl.setAttribute('y', String(gg.ly));
    wireLayer.append(path, lbl);
    for (const alias of [w.from, w.to]) { const arr = byBox.get(alias) ?? []; arr.push(we); byBox.set(alias, arr); }
  }
  svg.append(wireLayer);

  // boxes (links)
  const boxLayer = svgEl('g', { class: 'lm-jboxes' });
  const boxEls = new Map<string, SVGAElement>();
  for (const b of jg.boxes) {
    const p = pos.get(b.alias)!;
    const a = svgEl('a', { class: `lm-jbox ${b.isSpine ? 'lm-jbox-spine' : ''}`, href: opts.loomHref(b.ref), transform: `translate(${p.x}, ${p.y})` });
    a.setAttribute('aria-label', `${b.label} (${b.isSpine ? 'spine' : 'toelevering'}) — open het waardemodel`);
    a.append(svgEl('rect', { class: 'lm-jbox-box', width: BOX_W, height: BOX_H, rx: 12 }));
    const role = svgEl('text', { class: 'lm-jbox-role', x: 14, y: 22 });
    role.textContent = b.isSpine ? 'spine · draagt het totaal' : 'toelevering';
    a.append(role);
    const name = svgEl('text', { class: 'lm-jbox-name', x: 14, y: 46 });
    name.textContent = truncate(b.label, 24);
    a.append(name);
    const alias = svgEl('text', { class: 'lm-jbox-alias', x: 14, y: 64 });
    alias.textContent = truncate(`${b.alias} · ${b.ref}`, 30);
    a.append(alias);
    const drill = svgEl('text', { class: 'lm-jbox-drill', x: 14, y: 82 });
    drill.textContent = '↳ open het waardemodel';
    a.append(drill);
    const t = svgEl('title');
    t.textContent = `Open het Loom-model van ${b.label}`;
    a.append(t);
    boxLayer.append(a);
    boxEls.set(b.alias, a);
  }
  svg.append(boxLayer);

  const scroller = document.createElement('div');
  scroller.className = 'lm-graph-scroll';
  scroller.append(svg);
  mount.append(scroller);

  // pan / zoom / drag: drag a product box to spread the composition out (re-routing its wires + labels), and
  // zoom the canvas (toolbar + ctrl/⌘-wheel) — so overlapping seams and the values they carry become readable.
  const setPos = (alias: string, x: number, y: number): void => {
    pos.set(alias, { x, y });
    boxEls.get(alias)!.setAttribute('transform', `translate(${x}, ${y})`);
    for (const we of byBox.get(alias) ?? []) {
      const gg = geom(we);
      we.path.setAttribute('d', gg.d);
      we.label.setAttribute('x', String(gg.lx));
      we.label.setAttribute('y', String(gg.ly));
    }
  };
  mountCanvas(scroller, svg, {
    baseWidth: width,
    baseHeight: height,
    nodes: jg.boxes.map((b) => ({ key: b.alias, el: boxEls.get(b.alias)! })),
    getPos: (k) => pos.get(k)!,
    setPos,
  });

  // the fold: surfaced lines + combined total
  const fold = document.createElement('div');
  fold.className = 'lm-jfold';
  const lines = document.createElement('div');
  lines.className = 'lm-jfold-lines';
  for (const s of jg.surface) {
    const row = document.createElement('div');
    row.className = 'lm-jfold-line';
    row.append(Object.assign(document.createElement('span'), { textContent: s.label }));
    row.append(Object.assign(document.createElement('span'), { className: 'lm-mono lm-jfold-src', textContent: `${s.from}.${s.as}` }));
    lines.append(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 'lm-jfold-total';
  totalRow.append(Object.assign(document.createElement('span'), { textContent: jg.total.label }));
  totalRow.append(Object.assign(document.createElement('span'), { className: 'lm-mono', textContent: `= ${jg.total.of.join(' + ')}${jg.total.per ? ` · ${jg.total.per}` : ''}` }));
  fold.append(lines, totalRow);
  mount.append(fold);
}
