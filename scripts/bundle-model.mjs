// Bundle the file-based model into one JSON the browser client imports. The model
// under model/ is the single source of truth; this is the publish step that hands
// it to the view engine (mirrors how the model is PUT to the running WorkspaceDO).
// The output is generated + gitignored — never hand-edit it, edit model/.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = join(ROOT, 'model');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dir = (name) => {
  const d = join(MODEL, name);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(join(d, f))) : [];
};
const file = (name) => (existsSync(join(MODEL, name)) ? readJson(join(MODEL, name)) : {});

const bundle = {
  collections: dir('collections'),
  views: dir('views'),
  relations: file('relations.json'),
  types: file('types.json'),
  seedOps: existsSync(join(MODEL, 'seed.json')) ? readJson(join(MODEL, 'seed.json')) : [],
};

const out = join(ROOT, 'packages', 'client', 'src', 'model.data.json');
writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
process.stdout.write(`  bundled model -> packages/client/src/model.data.json (${bundle.collections.length} collections)\n`);
