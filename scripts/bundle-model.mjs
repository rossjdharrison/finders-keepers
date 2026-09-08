// Bundle the file-based model into one JSON the browser client imports. The model
// under model/ is the single source of truth; this is the publish step that hands
// it to the view engine (mirrors how the model is PUT to the running WorkspaceDO).
// The output is generated + gitignored — never hand-edit it, edit model/.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE } from '@core/ontology';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(ROOT, 'model');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dir = (name) => {
  const d = join(MODEL, name);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(join(d, f))) : [];
};
const file = (name) => (existsSync(join(MODEL, name)) ? readJson(join(MODEL, name)) : {});

// The domain type lattice is DATA: each type is a row in the `types` collection.
// Derive the reducibility map the engine consumes from those rows (one source; the
// frozen HQDM CORE remains the genesis roots inside @core/ontology).
const specOf = (v) => (v && v.t === 'list' ? v.items.map((i) => (i.t === 'ref' ? i.id : i.v)) : []);
const typesFromSeed = (ops) => {
  const out = {};
  for (const op of ops) {
    if (op.op === 'insert' && op.coll === 'types') out[op.row] = { specializes: specOf(op.values?.specializes) };
  }
  return out;
};

// The frozen HQDM CORE lattice, projected into `types` rows so the WHOLE lattice is
// data (browsable, and `specializes` targets resolve). CORE stays authoritative in
// @core/ontology (reduces reads it directly); these rows are its derived reflection —
// never hand-authored, so they cannot drift.
const coreTypeRows = Object.entries(CORE.types).map(([id, def]) => ({
  op: 'insert',
  coll: 'types',
  row: id,
  values: {
    specializes: { t: 'list', of: { k: 'ref', collection: 'types' }, items: (def.specializes ?? []).map((s) => ({ t: 'ref', collection: 'types', id: s })) },
  },
}));

const seedOps = existsSync(join(MODEL, 'seed.json')) ? readJson(join(MODEL, 'seed.json')) : [];
const bundle = {
  collections: dir('collections'),
  views: dir('views'),
  relations: file('relations.json'),
  types: typesFromSeed(seedOps), // domain types only; CORE stays frozen under reduces()
  seedOps: [...coreTypeRows, ...seedOps], // full lattice as rows: CORE (derived) + domain (authored)
};

const out = join(ROOT, 'packages', 'client', 'src', 'model.data.json');
writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
process.stdout.write(`  bundled model -> packages/client/src/model.data.json (${bundle.collections.length} collections)\n`);
