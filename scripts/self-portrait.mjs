// The self-portrait — the system describing itself, using itself.
//
// This is the dogfood proof of the thesis "documentation is a projection of the
// model": it reads three real sources of truth and PROJECTS an architecture map
// from them. Nothing on the diagram is hand-authored prose — every box traces to
// a row (or to a line of the gate / a package on disk). It emits both the SVG and
// a provenance manifest (element -> source) so that claim is checkable.
//
//   1. the MODEL   (model/**)          -> the layers, the grounding, the journey
//   2. the GATE    (scripts/gate.mjs)  -> the constitution's three laws
//   3. the REPO    (packages/*)        -> the engine (the interpreter)
//
// Banding is DERIVED, never hand-listed: a collection is metamodel when its
// semanticClass reduces to class_of_class / class_of_association; the rest split
// into relation-connected components — the one containing `intentions` is the
// dev-journey, the other is the domain demo.
//
// Usage:  node scripts/self-portrait.mjs [out.svg]
// Output: <out>.svg + <out>.manifest.json   (default: ./self-portrait.generated.svg)

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduces, isA, supertypesOf, CORE } from '@core/ontology';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(ROOT, 'model');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dir = (name) => {
  const d = join(MODEL, name);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(join(d, f))) : [];
};

// ---- 1 · read the MODEL -----------------------------------------------------
const collections = dir('collections');
const views = dir('views');
const docRecords = existsSync(join(MODEL, 'docs'))
  ? readdirSync(join(MODEL, 'docs')).filter((f) => f.endsWith('.json')).flatMap((f) => readJson(join(MODEL, 'docs', f)))
  : [];
const relations = existsSync(join(MODEL, 'relations.json')) ? readJson(join(MODEL, 'relations.json')) : {};
const seedOps = existsSync(join(MODEL, 'seed.json')) ? readJson(join(MODEL, 'seed.json')) : [];

// The domain type lattice, as rows (specializes = the isA edges). Merged over the
// frozen CORE inside reduces()/isA(); we pass it as `extra`, exactly like the gate.
const types = {};
for (const op of seedOps) {
  if (op.op === 'insert' && op.coll === 'types') {
    const s = op.values?.specializes;
    types[op.row] = { specializes: s && s.t === 'list' ? s.items.map((i) => (i.t === 'ref' ? i.id : i.v)) : [] };
  }
}

// rows actually present, per collection (the journey/domain instance counts)
const rowsByColl = {};
for (const op of seedOps) {
  if (op.op === 'insert') (rowsByColl[op.coll] ??= []).push(op);
}
const byId = new Map(collections.map((c) => [c.id, c]));

// ---- 2 · read the GATE (the constitution's own declared laws) ---------------
const gateSrc = readFileSync(join(ROOT, 'scripts', 'gate.mjs'), 'utf8');
// The three laws are declared in the gate header as "A · GROUNDING  <gloss>" (the
// name may carry '&', as in "TYPED & TOTAL"). The gloss is restated later in the
// source; keep the first occurrence of each id — that header block is authoritative.
const lawMatches = [...gateSrc.matchAll(/^\/\/\s+([ABC])\s+·\s+([A-Z &]+?)\s{2,}(.+)$/gm)]
  .map((m) => ({ id: m[1], name: m[2].trim(), gloss: m[3].trim() }));
const lawById = new Map();
for (const l of lawMatches) if (!lawById.has(l.id)) lawById.set(l.id, l);
const laws = ['A', 'B', 'C'].map((id) => lawById.get(id)).filter(Boolean);
// The packages the gate treats as the (neutral) engine.
const enginePkgsMatch = gateSrc.match(/ENGINE_PKGS\s*=\s*\[([^\]]*)\]/);
const enginePkgs = enginePkgsMatch ? [...enginePkgsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

// ---- 3 · read the REPO (each engine package's declared name) ----------------
const pkgName = (p) => {
  const f = join(ROOT, 'packages', p, 'package.json');
  return existsSync(f) ? (readJson(f).name ?? p) : p;
};
const engine = [...enginePkgs, 'client'].map((p) => ({ dir: p, name: pkgName(p) }));

// ---- derive the bands (grounding + relation-connectivity) -------------------
const groundingChain = (sc) => [sc, ...supertypesOf(sc, types)]; // nearest → root
const isMeta = (c) => isA(c.semanticClass, 'class_of_class', types) || isA(c.semanticClass, 'class_of_association', types);

// union-find over the relation graph, for non-meta collections
const parent = new Map();
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
const union = (a, b) => { parent.set(find(a), find(b)); };
for (const c of collections) if (!isMeta(c)) parent.set(c.id, c.id);
for (const r of Object.values(relations)) {
  if (parent.has(r.parentColl) && parent.has(r.childColl)) union(r.parentColl, r.childColl);
}
const journeyRoot = find('intentions');
const band = (c) => {
  if (isMeta(c)) return 'meta';
  return parent.has(c.id) && find(c.id) === journeyRoot ? 'journey' : 'domain';
};

const meta = collections.filter((c) => band(c) === 'meta');
const journey = collections.filter((c) => band(c) === 'journey');
const domain = collections.filter((c) => band(c) === 'domain');

// relation edges internal to a set of collections (for drawing the graph)
const edgesWithin = (set) => Object.entries(relations)
  .filter(([, r]) => set.has(r.parentColl) && set.has(r.childColl))
  .map(([via, r]) => ({ via, from: r.parentColl, to: r.childColl }));

// the HQDM classes the domain/journey types actually ground into (the used lattice)
const usedGroundings = new Set();
for (const c of collections) for (const t of groundingChain(c.semanticClass)) usedGroundings.add(t);
const coreUsed = [...usedGroundings].filter((t) => t in CORE.types);

// constitution provenance: the must/constraint requirements the laws discharge
const reqRows = (rowsByColl.requirements ?? []).map((op) => ({ id: op.row, ...op.values }));
const mustConstraints = reqRows.filter((r) => r.priority?.v === 'must' && r.kind?.v === 'constraint');
const decRows = (rowsByColl.decisions ?? []).map((op) => ({ id: op.row, ...op.values }));
const dataModelDecisions = decRows.filter((d) => d.kind?.v === 'data-model');

// what the portrait CANNOT draw from the model — the honest boundary.
// Probe the model for whole-word signals of the outward-turn topics. Whole-word,
// NOT substring: 'auth' would match 'author'/'authored' in the seed prose and hide
// a real gap — the exact drift the doc-shape principle forbids.
const seedRaw = JSON.stringify(seedOps);
const mentions = (needle) => new RegExp(needle, 'i').test(seedRaw);
const boundary = [];
boundary.push(`the gate's ${laws.length} law bodies run in scripts/gate.mjs (code); the model holds the requirements they discharge, not the checks`);
boundary.push(`the engine's mechanism lives in ${engine.length} packages (code); the model holds the decisions that shaped it, not its internals`);
const outwardTopics = [
  ['authentication / access-control', ['authenticat', '\\bactor\\b', '\\bgrant\\b', '\\bacl\\b']],
  ['deployment', ['\\bdeploy', 'cloudflare', '\\bpages\\b']],
  ['a second real domain', ['admission', 'grant intake', 'second domain', '\\btenant']],
];
for (const [label, needles] of outwardTopics) {
  if (!needles.some((n) => mentions(n))) boundary.push(`no node about ${label} — the outward turn is declared in prose, not yet in the model`);
}

// ---- render the SVG (positions computed; substance is all derived) ----------
const W = 1200;
const PAD = 28;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
let y = 0;

const bandHead = (title, sub) => {
  out.push(`<text x="${PAD}" y="${y + 26}" class="h">${esc(title)}</text>`);
  if (sub) out.push(`<text x="${PAD}" y="${y + 45}" class="sub">${esc(sub)}</text>`);
};

// a chip = one collection: member class + its grounding chain + row count
const collChip = (c, x, cy, w, h) => {
  const n = (rowsByColl[c.id] ?? []).length;
  const chain = groundingChain(c.semanticClass);
  const root = chain[chain.length - 1];
  out.push(`<rect x="${x}" y="${cy}" width="${w}" height="${h}" rx="9" class="card"/>`);
  out.push(`<text x="${x + 12}" y="${cy + 22}" class="lbl">${esc(c.id)}</text>`);
  if (n) out.push(`<text x="${x + w - 12}" y="${cy + 22}" text-anchor="end" class="count">${n}</text>`);
  out.push(`<text x="${x + 12}" y="${cy + 40}" class="mono cls">${esc(c.semanticClass)}</text>`);
  out.push(`<text x="${x + 12}" y="${cy + 57}" class="chain">↳ ${esc(chain.length > 3 ? `${c.semanticClass} → … → ${root}` : chain.join(' → '))}</text>`);
};

// flow a set of collection chips into rows, drawing relation arrows beneath
const flowBand = (colls, edges, accent) => {
  const perRow = 4;
  const gap = 16;
  const boxW = Math.floor((W - PAD * 2 - gap * (perRow - 1)) / perRow);
  const boxH = 66;
  const rowGap = 20;
  const pos = new Map();
  colls.forEach((c, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = PAD + col * (boxW + gap);
    const cy = y + row * (boxH + rowGap);
    pos.set(c.id, { x, cy, cx: x + boxW / 2, boxW });
    collChip(c, x, cy, boxW, boxH);
  });
  const rows = Math.ceil(colls.length / perRow);
  y += rows * boxH + (rows - 1) * rowGap;
  // relation edges (only those whose endpoints are both on screen)
  const drawn = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  if (drawn.length) {
    y += 14;
    const labels = drawn.map((e) => `${e.from}→${e.to} (${e.via})`).join('    ·    ');
    out.push(`<text x="${PAD}" y="${y}" class="edge" fill="${accent}">relations: ${esc(labels)}</text>`);
  }
};

// ---- header -----------------------------------------------------------------
const counts = {
  collections: collections.length,
  relations: Object.keys(relations).length,
  domainTypes: Object.keys(types).length,
  coreTypes: Object.keys(CORE.types).length,
  docs: docRecords.length,
  views: views.length,
  laws: laws.length,
  packages: engine.length,
};
const documented = new Set(docRecords.map((d) => d.home).filter(Boolean));
const nodeCount = collections.reduce((a, c) => a + 1 + (c.properties?.length ?? 0), 0) + Object.keys(relations).length;

y = PAD;
out.push(`<text x="${PAD}" y="${y}" class="title">Computable Records — self-portrait</text>`);
y += 24;
out.push(`<text x="${PAD}" y="${y}" class="sub">Generated from the model by scripts/self-portrait.mjs. Every box below is something the system holds about itself; nothing here is hand-authored.</text>`);
y += 20;
out.push(`<text x="${PAD}" y="${y}" class="sub">${counts.collections} collections · ${counts.relations} relations · ${counts.domainTypes} domain types over ${counts.coreTypes} HQDM CORE types · ${counts.docs} home-docs · ${counts.views} views · ${documented.size}/${nodeCount} nodes documented</text>`);
y += 34;

// ---- THE MODEL --------------------------------------------------------------
bandHead('THE MODEL', 'model/** — data only; the single source of truth. Banded by HQDM grounding + relation-connectivity, not by a hand-written list.');
y += 58;
out.push(`<text x="${PAD}" y="${y}" class="tag meta-tag">reflective metamodel — the schema is data (semanticClass reduces to class_of_class / class_of_association)</text>`);
y += 12;
flowBand(meta, edgesWithin(new Set(meta.map((c) => c.id))), 'var(--meta)');
y += 26;
out.push(`<text x="${PAD}" y="${y}" class="tag journey-tag">dev-journey — the relation-component rooted at intentions (the platform's own design, captured in itself)</text>`);
y += 12;
flowBand(journey, edgesWithin(new Set(journey.map((c) => c.id))), 'var(--journey)');
y += 26;
out.push(`<text x="${PAD}" y="${y}" class="tag domain-tag">domain demo — the other relation-component (Product Studio; a swappable example)</text>`);
y += 12;
flowBand(domain, edgesWithin(new Set(domain.map((c) => c.id))), 'var(--domain)');
y += 40;

// ---- HQDM CORE --------------------------------------------------------------
bandHead('HQDM CORE', `the frozen genesis lattice under @core/ontology — ${coreUsed.length} of ${counts.coreTypes} classes are actually grounded into by the model above; all climb to thing.`);
y += 58;
{
  const perRow = 6;
  const gap = 12;
  const boxW = Math.floor((W - PAD * 2 - gap * (perRow - 1)) / perRow);
  const boxH = 30;
  const ordered = coreUsed.slice().sort((a, b) => supertypesOf(a, types).length - supertypesOf(b, types).length);
  ordered.forEach((t, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = PAD + col * (boxW + gap);
    const cy = y + row * (boxH + 10);
    const rootish = t === 'thing';
    out.push(`<rect x="${x}" y="${cy}" width="${boxW}" height="${boxH}" rx="7" class="${rootish ? 'core-root' : 'core'}"/>`);
    out.push(`<text x="${x + boxW / 2}" y="${cy + 20}" text-anchor="middle" class="mono core-lbl">${esc(t)}</text>`);
  });
  const rows = Math.ceil(ordered.length / perRow);
  y += rows * boxH + (rows - 1) * 10 + 40;
}

// ---- THE CONSTITUTION -------------------------------------------------------
bandHead('THE CONSTITUTION', 'scripts/gate.mjs — three laws, fail-closed, in CI. The law names below are read from the gate itself; the requirements are rows the laws discharge.');
y += 58;
{
  const perRow = 3;
  const gap = 16;
  const boxW = Math.floor((W - PAD * 2 - gap * (perRow - 1)) / perRow);
  const boxH = 62;
  laws.forEach((law, i) => {
    const x = PAD + i * (boxW + gap);
    out.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="9" class="law"/>`);
    out.push(`<text x="${x + 12}" y="${y + 24}" class="lbl">${esc(law.id)} · ${esc(law.name)}</text>`);
    out.push(`<text x="${x + 12}" y="${y + 44}" class="chain">${esc(law.gloss.length > 62 ? law.gloss.slice(0, 60) + '…' : law.gloss)}</text>`);
  });
  y += boxH + 14;
  const reqList = mustConstraints.map((r) => r.id).join(', ');
  out.push(`<text x="${PAD}" y="${y}" class="edge">must/constraint requirements the laws discharge: ${esc(reqList)}</text>`);
  y += 40;
}

// ---- THE ENGINE -------------------------------------------------------------
bandHead('THE ENGINE (the interpreter)', 'packages/* — generic, pure, total, domain-neutral. Mechanism is code; provenance is in the model (the data-model decisions).');
y += 58;
{
  const perRow = 4;
  const gap = 14;
  const boxW = Math.floor((W - PAD * 2 - gap * (perRow - 1)) / perRow);
  const boxH = 34;
  engine.forEach((p, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = PAD + col * (boxW + gap);
    const cy = y + row * (boxH + 10);
    out.push(`<rect x="${x}" y="${cy}" width="${boxW}" height="${boxH}" rx="7" class="eng"/>`);
    out.push(`<text x="${x + boxW / 2}" y="${cy + 22}" text-anchor="middle" class="mono eng-lbl">${esc(p.name)}</text>`);
  });
  const rows = Math.ceil(engine.length / perRow);
  y += rows * boxH + (rows - 1) * 10 + 14;
  out.push(`<text x="${PAD}" y="${y}" class="edge">shaped by decisions: ${esc(dataModelDecisions.map((d) => d.id).join(', '))}</text>`);
  y += 40;
}

// ---- THE BOUNDARY (what the model cannot draw) ------------------------------
bandHead('THE BOUNDARY — what this portrait cannot draw from the model', 'The honest edge: absent rows mean an absent claim. This is derived by asking the model what it does NOT contain.');
y += 58;
for (const b of boundary) {
  out.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="30" rx="7" class="edge-box"/>`);
  out.push(`<text x="${PAD + 12}" y="${y + 20}" class="chain">— ${esc(b)}</text>`);
  y += 38;
}
y += PAD;

const H = Math.ceil(y);
const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
<style>
  :root{
    --bg:#f6f7f9; --card:#ffffff; --ink:#1b2230; --sub:#5b6472; --line:#d3d8e0;
    --meta:#2f7d6a; --journey:#a63d40; --domain:#6b7280; --core:#6b46c1; --law:#b7791f; --eng:#3457b2;
    --meta-bg:#e9f4f0; --journey-bg:#f8ecec; --domain-bg:#f1f2f4; --core-bg:#f0ecf9; --law-bg:#fbf4e6; --eng-bg:#eef1fb;
  }
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
    --bg:#12151b; --card:#1b2029; --ink:#e6e9ef; --sub:#9aa3b2; --line:#2c333f;
    --meta-bg:#14261f; --journey-bg:#291619; --domain-bg:#1c2129; --core-bg:#1e1830; --law-bg:#2a2211; --eng-bg:#151d33;
  }}
  :root[data-theme="dark"]{
    --bg:#12151b; --card:#1b2029; --ink:#e6e9ef; --sub:#9aa3b2; --line:#2c333f;
    --meta-bg:#14261f; --journey-bg:#291619; --domain-bg:#1c2129; --core-bg:#1e1830; --law-bg:#2a2211; --eng-bg:#151d33;
  }
  .title{ fill:var(--ink); font-size:24px; font-weight:700; }
  .h{ fill:var(--ink); font-size:15px; font-weight:700; letter-spacing:.03em; }
  .sub{ fill:var(--sub); font-size:12.5px; }
  .tag{ font-size:11.5px; font-weight:600; }
  .meta-tag{ fill:var(--meta); } .journey-tag{ fill:var(--journey); } .domain-tag{ fill:var(--domain); }
  .lbl{ fill:var(--ink); font-size:14px; font-weight:600; }
  .cls{ fill:var(--sub); font-size:11px; }
  .chain{ fill:var(--sub); font-size:10.5px; }
  .count{ fill:var(--sub); font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; }
  .edge{ fill:var(--sub); font-size:11px; }
  .mono{ font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .card{ fill:var(--card); stroke:var(--line); stroke-width:1; }
  .core{ fill:var(--core-bg); stroke:var(--core); stroke-width:1; } .core-root{ fill:var(--core); }
  .core-lbl{ fill:var(--ink); font-size:11px; }
  .law{ fill:var(--law-bg); stroke:var(--law); stroke-width:1; }
  .eng{ fill:var(--eng-bg); stroke:var(--eng); stroke-width:1; } .eng-lbl{ fill:var(--ink); font-size:12px; }
  .edge-box{ fill:var(--bg); stroke:var(--line); stroke-width:1; stroke-dasharray:4 3; }
</style>
<rect x="0" y="0" width="${W}" height="${H}" fill="var(--bg)"/>
${out.join('\n')}
</svg>
`;

// ---- provenance manifest (element -> source) --------------------------------
const manifest = {
  generatedBy: 'scripts/self-portrait.mjs',
  sources: { model: 'model/**', gate: 'scripts/gate.mjs', repo: 'packages/*' },
  counts,
  bands: {
    metamodel: meta.map((c) => ({ collection: c.id, semanticClass: c.semanticClass, source: `model/collections/${c.id}.json`, derivedBy: 'semanticClass reduces to class_of_class/class_of_association' })),
    devJourney: journey.map((c) => ({ collection: c.id, semanticClass: c.semanticClass, rows: (rowsByColl[c.id] ?? []).length, source: `model/collections/${c.id}.json`, derivedBy: 'relation-component of intentions' })),
    domain: domain.map((c) => ({ collection: c.id, semanticClass: c.semanticClass, rows: (rowsByColl[c.id] ?? []).length, source: `model/collections/${c.id}.json`, derivedBy: 'relation-component (not intentions)' })),
    hqdmCore: coreUsed.map((t) => ({ type: t, source: '@core/ontology CORE', groundsTo: 'thing' })),
    constitution: { laws: laws.map((l) => ({ ...l, source: 'scripts/gate.mjs header' })), discharges: mustConstraints.map((r) => ({ requirement: r.id, source: 'model/seed.json' })) },
    engine: engine.map((p) => ({ package: p.name, source: `packages/${p.dir}/package.json` })),
  },
  boundary,
};

const target = process.argv[2] ?? join(ROOT, 'self-portrait.generated.svg');
const manifestPath = target.replace(/\.svg$/, '') + '.manifest.json';
writeFileSync(target, svg);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(
  `  self-portrait -> ${target}\n` +
  `  manifest      -> ${manifestPath}\n` +
  `  bands: ${meta.length} metamodel · ${journey.length} dev-journey · ${domain.length} domain · ${coreUsed.length} HQDM classes used · ${laws.length} laws · ${engine.length} packages\n` +
  `  boundary: ${boundary.length} things the model cannot draw\n`,
);
