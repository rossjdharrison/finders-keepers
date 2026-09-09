// Deterministic agent-control hook (wired in .claude/settings.json). Unlike a
// skill, this is not model-invoked — the harness runs it on every edit, so an
// agent is channelled into model-first whether or not it read the contract.
//
//   pre:  block writing code into model/ (data-only) or hand-editing generated
//         files; warn when touching the immutable engine.
//   post: after any model/ edit, run the gate and surface violations immediately.
//
// Defensive by design: any unexpected error allows the action (exit 0) so a hook
// bug can never wedge the workspace.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { relative } from 'node:path';

function main() {
  const mode = process.argv[2]; // 'pre' | 'post'
  let ev;
  try {
    ev = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const abs = ev?.tool_input?.file_path || ev?.tool_input?.path || '';
  if (!abs) process.exit(0);
  let rel = relative(process.cwd(), abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) rel = String(abs).replace(/\\/g, '/');

  const inModel = /(^|\/)model\//.test(rel);
  const inPres = /(^|\/)presentation\//.test(rel); // the P layer tree, parallel to model/

  if (mode === 'pre') {
    if ((inModel || inPres) && !rel.endsWith('.json')) {
      process.stderr.write(`${inPres ? 'presentation/' : 'model/'} holds DATA only (JSON). Domain logic isn't code — express it as a model/presentation document, not a .ts file.\n`);
      process.exit(2);
    }
    if (rel.endsWith('model.data.json')) {
      process.stderr.write('model.data.json is generated from model/. Edit the model source; it regenerates on build.\n');
      process.exit(2);
    }
    if (/packages\/(values|formula|events|query|ontology|server)\/src\//.test(rel)) {
      process.stdout.write('Note: this is the immutable engine (trusted core). Domain behaviour belongs in model/; change the engine only for framework work.\n');
    }
    process.exit(0);
  }

  if (mode === 'post') {
    if (inModel || inPres) {
      try {
        process.stdout.write(execSync('node scripts/gate.mjs', { encoding: 'utf8' }));
      } catch (e) {
        process.stderr.write(`${e.stdout ?? ''}${e.stderr ?? ''}\nThe model gate failed after your edit — fix the violations above before continuing.\n`);
        process.exit(2);
      }
    }
    process.exit(0);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // never wedge the workspace on a hook bug
}
