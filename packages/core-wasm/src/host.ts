// The HOST — the thin loader that runs the vendored core. This is the reference JS host (Node +
// browser); the .NET (Wasmtime) and Python (wasmtime) hosts implement the same three moves against
// the same seam (see README). It imports NOTHING from @core at runtime — the core is the committed
// bundle, not a source dependency. Its only runtime dependency is quickjs-emscripten (the prebuilt
// QuickJS wasm), which the target environment already has.
//
// Three moves:
//   1. inject the egress  — __fk_extern + __fk_clock, the core's only reach outward;
//   2. evaluate the bundle — which defines globalThis.fk inside the sandbox;
//   3. call fk.* over JSON — entry in, verdicts out, the value domain intact.

import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { Value } from '@core/values';

/** The two functions the sealed core reaches the world through — the whole egress surface. */
export interface SealedExterns {
  clock(): { today: number; nowMs: number };
  api(name: string, params: Record<string, Value>): Value;
}

/** A row as the core returns it — the doc plus the engine's verdicts (hidden / actions). */
export interface SealedRow {
  id: string;
  doc: Record<string, Value>;
  hidden?: string[];
  actions?: { id: string; field: string; to: string; enabled: boolean }[];
}

/** The running sealed core. Same shape as an in-process Core, minus that it lives inside wasm. */
export interface SealedCore {
  load(cassette: unknown): void;
  apply(coll: string, ops: unknown[]): SealedRow[];
  read(coll: string): SealedRow[];
  snapshot(): unknown;
  restore(snap: unknown): void;
  dispose(): void;
}

/**
 * Load the vendored core into a fresh QuickJS wasm context and wire the extern seam.
 * @param bundleSource the committed vendor/core.bundle.js, read as text by the caller
 * @param externs      the host's implementation of the egress (mocks in test; real API calls live)
 */
export async function createSealedCore(bundleSource: string, externs: SealedExterns): Promise<SealedCore> {
  const QuickJS = await getQuickJS();
  const vm: QuickJSContext = QuickJS.newContext();

  // QuickJS ships no console; the bundle may reference it. A no-op keeps the sandbox mute.
  vm.unwrapResult(vm.evalCode('globalThis.console={log(){},info(){},warn(){},error(){},debug(){}};')).dispose();

  // (1) the egress — the ONLY channel out. Each call is a JSON string round-trip, so no live host
  // object ever enters the sandbox: the core gets data back, never a reference it could reach through.
  const externFn = vm.newFunction('__fk_extern', (nameH, paramsH) => {
    const name = vm.getString(nameH);
    const params = JSON.parse(vm.getString(paramsH)) as Record<string, Value>;
    return vm.newString(JSON.stringify(externs.api(name, params)));
  });
  vm.setProp(vm.global, '__fk_extern', externFn);
  externFn.dispose();

  const clockFn = vm.newFunction('__fk_clock', () => vm.newString(JSON.stringify(externs.clock())));
  vm.setProp(vm.global, '__fk_clock', clockFn);
  clockFn.dispose();

  // (2) evaluate the vendored bundle — it defines globalThis.fk.
  vm.unwrapResult(vm.evalCode(bundleSource)).dispose();
  const fkH: QuickJSHandle = vm.getProp(vm.global, 'fk');
  if (vm.typeof(fkH) !== 'object') {
    fkH.dispose();
    vm.dispose();
    throw new Error('core-wasm: the vendored bundle did not define globalThis.fk');
  }

  // (3) call fk.<method>(...string args) and return its string result — errors thrown inside the
  // core (e.g. a rejected step guard) surface here as thrown Errors, preserving the core's contract.
  const call = (method: string, ...args: string[]): string => {
    const fnH = vm.getProp(fkH, method);
    const argHs = args.map((a) => vm.newString(a));
    const res = vm.callFunction(fnH, fkH, ...argHs);
    argHs.forEach((h) => h.dispose());
    fnH.dispose();
    if (res.error) {
      const e = vm.dump(res.error);
      res.error.dispose();
      throw new Error(`core-wasm: ${typeof e === 'string' ? e : (e as { message?: string })?.message ?? JSON.stringify(e)}`);
    }
    const out = vm.getString(res.value);
    res.value.dispose();
    return out;
  };

  call('init');

  return {
    load: (cassette) => void call('load', JSON.stringify(cassette)),
    apply: (coll, ops) => JSON.parse(call('apply', coll, JSON.stringify(ops))) as SealedRow[],
    read: (coll) => JSON.parse(call('read', coll)) as SealedRow[],
    snapshot: () => JSON.parse(call('snapshot')) as unknown,
    restore: (snap) => void call('restore', JSON.stringify(snap)),
    dispose: () => {
      fkH.dispose();
      vm.dispose();
    },
  };
}
