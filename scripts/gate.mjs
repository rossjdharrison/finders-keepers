// The framework-contract gate — the seed's enforcement spine.
//
// It reads the model (data-only, under model/) and holds the constitution as THREE
// LAWS applied uniformly to every node (a collection, a property, a relation — at any
// level), plus two model-wide invariants:
//   A · GROUNDING    every type, semanticClass, and category reduces to HQDM
//   B · THE PLACE LAW  every edge to a node (ref, relation end, doc home, view) resolves
//   C · TYPED & TOTAL  every computed formula typechecks; availableWhen/guards are bool; no cycles
//   ·   NEUTRALITY    the model is data (JSON) only; the engine never imports the model
//   ·   COVERAGE      how much of the model is documented (a warning, not a failure)
//
// It is agent-agnostic: it runs in `npm run check` and CI, so a change that isn't
// model-first, grounded, and typed simply does not land — no prompt required.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduces } from '@core/ontology';
import { compile, topoOrCycle } from '@core/formula';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(ROOT, 'model');
const ENGINE_PKGS = ['values', 'formula', 'events', 'query', 'ontology', 'server'];

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ---- read the model ---------------------------------------------------------
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

const modelFiles = existsSync(MODEL) ? walk(MODEL) : [];

// NEUTRALITY (hard): the model is data only — no code may live under model/.
for (const p of modelFiles) {
  if (extname(p) !== '.json') err(`model is data-only: ${relative(ROOT, p)} is not .json`);
}

const collDir = join(MODEL, 'collections');
const collections = existsSync(collDir)
  ? readdirSync(collDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(collDir, f)))
  : [];
// The type lattice is data: each type is a row in the `types` collection (seed.json).
// Derive the reducibility map from those rows — the frozen HQDM CORE (in @core/ontology)
// supplies the genesis roots a type's `specializes` climbs to.
const seedOps = existsSync(join(MODEL, 'seed.json')) ? readJson(join(MODEL, 'seed.json')) : [];
const types = {};
for (const op of seedOps) {
  if (op.op === 'insert' && op.coll === 'types') {
    const s = op.values?.specializes;
    // specializes items are refs into `types` (id carries the parent type); text-tolerant
    types[op.row] = { specializes: s && s.t === 'list' ? s.items.map((i) => (i.t === 'ref' ? i.id : i.v)) : [] };
  }
}
const relations = existsSync(join(MODEL, 'relations.json')) ? readJson(join(MODEL, 'relations.json')) : {};
const docsDir = join(MODEL, 'docs');
const docRecords = existsSync(docsDir)
  ? readdirSync(docsDir).filter((f) => f.endsWith('.json')).flatMap((f) => readJson(join(docsDir, f)))
  : [];
const viewsDir = join(MODEL, 'views');
const views = existsSync(viewsDir)
  ? readdirSync(viewsDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(viewsDir, f)))
  : [];

const byId = new Map(collections.map((c) => [c.id, c]));
const propsOf = (coll) => new Map((byId.get(coll)?.properties ?? []).map((p) => [p.id, p]));
const schemas = new Map(collections.map((c) => [c.id, Object.fromEntries(c.properties.map((p) => [p.id, p.valueType]))]));

// ---- the node universe ------------------------------------------------------
// Collections, properties, and relations are all NODES. Every check below is one of
// THREE LAWS applied uniformly to nodes, at any level (a collection, a property, a
// relation — and, once the DO sources schema from rows, an instance too):
//   A · GROUNDING   a node's class reduces to the HQDM lattice
//   B · THE PLACE LAW   every edge to a node — a ref, a relation end, a doc's home,
//                       a view's collection — resolves to a real node
//   C · TYPED & TOTAL   a node's computed formula typechecks and the graph is acyclic
const nodes = new Set();
for (const c of collections) {
  nodes.add(c.id);
  for (const p of c.properties ?? []) nodes.add(`${c.id}.${p.id}`);
}
for (const via of Object.keys(relations)) nodes.add(`relation:${via}`);
const isNode = (id) => nodes.has(id); // a documentable/homeable node
const isColl = (id) => byId.has(id); // a node that is a collection

// ---- LAW A · GROUNDING ------------------------------------------------------
for (const id of Object.keys(types)) {
  if (!reduces(id, types)) err(`type '${id}' does not reduce to HQDM (fix its 'specializes' chain)`);
}
for (const c of collections) {
  if (!c.semanticClass) err(`collection '${c.id}' declares no semanticClass (HQDM grounding is required)`);
  else if (!reduces(c.semanticClass, types)) err(`collection '${c.id}': semanticClass '${c.semanticClass}' does not reduce to HQDM`);
  for (const p of c.properties ?? []) {
    if (p.category && !reduces(p.category, types)) err(`'${c.id}.${p.id}': category '${p.category}' does not reduce to HQDM`);
  }
  for (const t of c.transitions ?? []) {
    if (t.category && !reduces(t.category, types)) err(`'${c.id}' transition '${t.id}': category '${t.category}' does not reduce to HQDM`);
  }
}

// ---- LAW B · THE PLACE LAW --------------------------------------------------
// One law over every edge to a node — the unification of relation-integrity,
// ref-integrity, the doc home, and view integrity: the target node must exist.
// relations: both ends are collections; the child field is a ref back to the parent.
for (const [via, r] of Object.entries(relations)) {
  if (!isColl(r.parentColl)) err(`relation '${via}': parent collection '${r.parentColl}' does not exist`);
  if (!isColl(r.childColl)) err(`relation '${via}': child collection '${r.childColl}' does not exist`);
  else {
    const cf = propsOf(r.childColl).get(r.childField);
    if (!cf) err(`relation '${via}': child field '${r.childColl}.${r.childField}' does not exist`);
    else if (cf.valueType?.k !== 'ref' || cf.valueType.collection !== r.parentColl)
      err(`relation '${via}': '${r.childColl}.${r.childField}' must be a ref to '${r.parentColl}'`);
  }
}
// ref (and list-of-ref) fields: the target collection exists.
for (const c of collections) {
  for (const p of c.properties ?? []) {
    const vt = p.valueType;
    if (vt?.k === 'ref' && !isColl(vt.collection)) err(`'${c.id}.${p.id}': ref target collection '${vt.collection}' does not exist`);
    if (vt?.k === 'list' && vt.of?.k === 'ref' && !isColl(vt.of.collection)) err(`'${c.id}.${p.id}': list ref target collection '${vt.of.collection}' does not exist`);
  }
}
// doc-records: every home resolves to a real node (+ dedupe ids, track coverage).
const documented = new Set();
const seenDocIds = new Set();
for (const d of docRecords) {
  if (!d.id) err(`a doc-record has no id (home '${d.home}')`);
  else if (seenDocIds.has(d.id)) err(`duplicate doc-record id '${d.id}'`);
  else seenDocIds.add(d.id);
  if (!d.home) { err(`doc-record '${d.id}' has no home (the Place law: every doc attaches to a model node)`); continue; }
  if (!isNode(d.home)) err(`doc-record '${d.id}' is homeless: '${d.home}' is not a model node — add the node or fix the home`);
  else documented.add(d.home);
}
// views: the collection exists; visible props + group field are real fields of it.
for (const v of views) {
  if (!isColl(v.collection)) { err(`view '${v.id}': collection '${v.collection}' does not exist`); continue; }
  const props = propsOf(v.collection);
  for (const f of v.visibleProps ?? []) if (!props.has(f)) err(`view '${v.id}': visibleProp '${f}' is not a field of '${v.collection}'`);
  const gf = v.config?.groupField;
  if (gf && !props.has(gf)) err(`view '${v.id}': groupField '${gf}' is not a field of '${v.collection}'`);
}

// ---- LAW C · TYPED & TOTAL --------------------------------------------------
const typeResolver = {
  related: () => [],
  cell: () => ({ t: 'blank' }),
  columnType: (coll, col) => schemas.get(coll)?.[col],
};
for (const c of collections) {
  const columns = schemas.get(c.id) ?? {};
  const compileCtx = { columns, resolver: typeResolver, relations, tables: c.tables };
  const compiled = [];
  for (const p of c.properties ?? []) {
    if (p.source === 'computed' && p.formula) {
      const r = compile(p.id, p.formula, compileCtx);
      if ('errors' in r) err(`'${c.id}.${p.id}' does not typecheck: ${r.errors.map((e) => e.message).join('; ')}`);
      else compiled.push(r);
    }
    if (p.availableWhen) {
      const g = compile(`__avail_${p.id}`, p.availableWhen, compileCtx);
      if ('errors' in g) err(`'${c.id}.${p.id}' availableWhen does not typecheck: ${g.errors.map((e) => e.message).join('; ')}`);
      else if (g.type.k !== 'bool') err(`'${c.id}.${p.id}' availableWhen must be boolean, got ${g.type.k}`);
    }
  }
  const ordered = topoOrCycle(compiled);
  if ('cycle' in ordered) err(`'${c.id}' has a cyclic computed dependency: ${ordered.cycle.join(', ')}`);
  for (const t of c.transitions ?? []) {
    if (!columns[t.field]) err(`'${c.id}' transition '${t.id}': field '${t.field}' does not exist`);
    const g = compile(`__guard_${t.id}`, t.when, compileCtx);
    if ('errors' in g) err(`'${c.id}' transition '${t.id}' guard does not typecheck: ${g.errors.map((e) => e.message).join('; ')}`);
    else if (g.type.k !== 'bool') err(`'${c.id}' transition '${t.id}' guard must be boolean, got ${g.type.k}`);
  }
}

// ---- NEUTRALITY (engine never reaches into the model) -----------------------
const typeIds = Object.keys(types); // capitalized domain classes, e.g. Feature
for (const pkg of ENGINE_PKGS) {
  const src = join(ROOT, 'packages', pkg, 'src');
  if (!existsSync(src)) continue;
  for (const f of walk(src)) {
    if (!f.endsWith('.ts')) continue;
    const text = readFileSync(f, 'utf8');
    if (/from\s+['"][^'"]*model(\/|\.data|['"])/.test(text)) err(`neutrality: engine file ${relative(ROOT, f)} imports from the model`);
    for (const t of typeIds) {
      if (new RegExp(`\\b${t}\\b`).test(text)) warn(`neutrality: domain type '${t}' appears in engine file ${relative(ROOT, f)} — verify it is not a leak`);
    }
  }
}

// ---- COVERAGE (warning, not failure) ---------------------------------------
const pct = nodes.size ? Math.round((documented.size / nodes.size) * 100) : 100;
for (const c of collections) {
  const has = [...documented].some((h) => h === c.id || h.startsWith(`${c.id}.`));
  if (!has) warn(`coverage: collection '${c.id}' has no documentation`);
}

// ---- report -----------------------------------------------------------------
const line = (s) => process.stdout.write(s + '\n');
line('');
line(`  model: ${collections.length} collections · ${Object.keys(relations).length} relations · ${Object.keys(types).length} types · ${docRecords.length} docs · ${views.length} views`);
line(`  documentation coverage: ${documented.size}/${nodes.size} nodes (${pct}%)`);
for (const w of warnings) line(`  ⚠ ${w}`);
if (errors.length) {
  line('');
  for (const e of errors) line(`  ✗ ${e}`);
  line('');
  line(`  GATE FAILED — ${errors.length} violation(s). The model is not grounded/typed/homed; nothing lands until this is green.`);
  process.exit(1);
}
line('');
line('  ✓ gate passed — every model node reduces to HQDM, typechecks, and is homed.');
