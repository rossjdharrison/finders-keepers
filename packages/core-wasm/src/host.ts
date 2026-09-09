// The HOST — the thin loader that runs the vendored core. This is the reference JS host (Node +
// browser); the .NET (Wasmtime) and Python (wasmtime) hosts implement the same three moves against
// the same seam (see README). It imports NOTHING at runtime — every import below is type-only and
// erased — so the core is the committed bundle, not a source dependency, and this file never pulls a
// wasm loader into anyone's bundle. The QuickJS runtime is INJECTED by the caller: Node/tests pass
// getQuickJS() from quickjs-emscripten; the browser passes a Vite-loaded variant. Exactly like the
// .NET/Python hosts supplying their own Wasmtime, the JS host takes the runtime as a parameter.
//
// Three moves:
//   1. inject the egress  — __fk_extern + __fk_clock, the core's only reach outward;
//   2. evaluate the bundle — which defines globalThis.fk inside the sandbox;
//   3. call fk.* over JSON — entry in, verdicts out, the value domain intact.

import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten';
// Type-only (erased at runtime): this makes the sealed core a provable drop-in for the in-process
// Core — same load/apply/read/snapshot/restore contract, so createBrowserHostOver accepts either.
import type { Cassette, Core, Externs, RowOp, RowState, Snapshot } from '@app/core-runtime';

/** The two functions the sealed core reaches the world through — the whole egress surface. */
export type SealedExterns = Externs;

/** The running sealed core: the exact Core contract, plus dispose() to free the wasm context. */
export type SealedCore = Core & { dispose(): void };

/**
 * Load the vendored core into a fresh QuickJS wasm context and wire the extern seam.
 * @param quickjs      a resolved QuickJS module — the caller owns wasm-loading (Node: getQuickJS();
 *                     browser: a Vite-loaded variant). The host itself never imports a wasm loader.
 * @param bundleSource the committed vendor/core.bundle.js, read as text by the caller
 * @param externs      the host's implementation of the egress (mocks in test; real API calls live)
 */
export async function createSealedCore(
  quickjs: QuickJSWASMModule,
  bundleSource: string,
  externs: SealedExterns,
): Promise<SealedCore> {
  const vm: QuickJSContext = quickjs.newContext();

  // QuickJS ships no console; the bundle may reference it. A no-op keeps the sandbox mute.
  vm.unwrapResult(vm.evalCode('globalThis.console={log(){},info(){},warn(){},error(){},debug(){}};')).dispose();

  // (1) the egress — the ONLY channel out. Each call is a JSON string round-trip, so no live host
  // object ever enters the sandbox: the core gets data back, never a reference it could reach through.
  const externFn = vm.newFunction('__fk_extern', (nameH, paramsH) => {
    const name = vm.getString(nameH);
    const params = JSON.parse(vm.getString(paramsH)) as Record<string, unknown>;
    return vm.newString(JSON.stringify(externs.api(name, params as Parameters<Externs['api']>[1])));
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
    load: (cassette: Cassette) => void call('load', JSON.stringify(cassette)),
    apply: (coll: string, ops: RowOp[]) => JSON.parse(call('apply', coll, JSON.stringify(ops))) as RowState[],
    read: (coll: string) => JSON.parse(call('read', coll)) as RowState[],
    snapshot: () => JSON.parse(call('snapshot')) as Snapshot,
    restore: (snap: Snapshot) => void call('restore', JSON.stringify(snap)),
    dispose: () => {
      fkH.dispose();
      vm.dispose();
    },
  };
}
