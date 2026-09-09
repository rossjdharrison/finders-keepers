// The SEAL — the source of the vendored artifact. esbuild bundles this file (and everything it
// imports: @app/core-runtime → @core/{values,formula,ontology}) into one pure-JS file that runs
// inside a QuickJS wasm. It is the whole surface of the sealed core:
//
//   ENTRY   — the exported methods on globalThis.fk (init / load / apply / read / snapshot / restore).
//   EGRESS  — TWO host-injected functions, __fk_extern and __fk_clock, the ONLY way the core reaches
//             the world. The host (src/host.ts) defines them; the core cannot see anything else.
//
// Everything crosses the boundary as JSON strings — so the value domain (money.minor is a STRING,
// never an f64) survives the round-trip byte-for-byte, and the seam is language-agnostic: any host
// that can supply two string→string functions and call these methods can run this core.

import { createCore } from '@app/core-runtime';
import type { Core } from '@app/core-runtime';
import type { Value } from '@core/values';

// Injected by the host before this bundle is evaluated (see src/host.ts). Declared, never defined
// here — that is the point: the core's only reach outward is through these two host functions.
declare const __fk_extern: (name: string, paramsJson: string) => string;
declare const __fk_clock: () => string;

let core: Core | null = null;
const live = (): Core => {
  if (!core) throw new Error('core-wasm: call fk.init() before load/apply/read');
  return core;
};

(globalThis as unknown as { fk: Record<string, (...a: string[]) => string> }).fk = {
  // Build the core over externs that dispatch through the injected boundary. clock and api are the
  // engine's only host hooks; here each one is a JSON round-trip out to __fk_clock / __fk_extern.
  init(): string {
    core = createCore({
      clock: () => JSON.parse(__fk_clock()) as { today: number; nowMs: number },
      api: (name: string, params: Record<string, Value>): Value =>
        JSON.parse(__fk_extern(name, JSON.stringify(params))) as Value,
    });
    return 'ok';
  },
  load(cassetteJson: string): string {
    live().load(JSON.parse(cassetteJson));
    return 'ok';
  },
  apply(coll: string, opsJson: string): string {
    return JSON.stringify(live().apply(coll, JSON.parse(opsJson)));
  },
  read(coll: string): string {
    return JSON.stringify(live().read(coll));
  },
  snapshot(): string {
    return JSON.stringify(live().snapshot());
  },
  restore(snapJson: string): string {
    live().restore(JSON.parse(snapJson));
    return 'ok';
  },
};
