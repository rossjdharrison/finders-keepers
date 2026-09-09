// Build the VENDORED core artifact. This is the WHOLE build step of the vendor model, and it needs
// NO wasm toolchain — just esbuild. esbuild bundles the seal (src/seal-entry.ts) together with
// everything it imports (@app/core-runtime → @core/{values,formula,ontology}) into one self-contained
// pure-JS file. Run it on any capable machine (or CI); commit vendor/core.bundle.js; the target
// environment only RUNS it (inside QuickJS wasm), never rebuilds it.
//
//   Refresh:  npm -w @app/core-wasm run build
//   Verify :  npm -w @app/core-wasm run verify   (rebuilds and fails if the committed bytes drift)

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const banner = `/* VENDORED ARTIFACT — do not edit by hand.
 * The sealed @core: @app/core-runtime + @core/{values,formula,ontology} + the extern ABI,
 * bundled to one pure-JS file that runs inside a QuickJS wasm.
 * Regenerate:  npm -w @app/core-wasm run build
 * The ONLY egress is __fk_extern / __fk_clock, injected by the host (packages/core-wasm/src/host.ts). */`;

const result = await build({
  entryPoints: [resolve(pkg, 'src/seal-entry.ts')],
  bundle: true,
  format: 'iife', // globalThis.fk escapes the wrapper; nothing else leaks
  platform: 'neutral', // not node, not browser — QuickJS. no built-in polyfills, no host globals
  target: 'es2020', // QuickJS supports BigInt / Map / Set / optional chaining natively
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  outfile: resolve(pkg, 'vendor/core.bundle.js'),
  metafile: true,
});

const out = Object.values(result.metafile.outputs)[0];
console.log(`built vendor/core.bundle.js — ${(out.bytes / 1024).toFixed(1)} kB`);
