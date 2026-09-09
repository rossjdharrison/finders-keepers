// The browser's QuickJS runtime loader — the one place that knows how to bring a WASM engine up in
// this environment. It hands createSealedCore a resolved QuickJSWASMModule; the sealed core and the
// host stay environment-neutral (the .NET/Python hosts supply their own Wasmtime the same way).
//
// We use the SYNC, release, separate-.wasm variant: sync because the sealed core injects synchronous
// extern callbacks; separate-.wasm so the 491 kB QuickJS engine is a real, cacheable network request
// you can watch load in the Network tab — the tangible proof the browser is running wasm.

import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
// Vite resolves the package's "./wasm" export to dist/emscripten-module.wasm, then ?url emits it as
// an asset and returns the served URL — that URL is what makes the .wasm a separate fetch.
import wasmLocation from '@jitl/quickjs-wasmfile-release-sync/wasm?url';

/** Build a browser QuickJS module whose .wasm is fetched as a real, separate network request. */
export function createBrowserQuickJS(): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(newVariant(releaseSyncVariant, { wasmLocation }));
}
