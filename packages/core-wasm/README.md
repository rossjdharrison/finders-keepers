# @app/core-wasm — the sealed core, vendored

The `@core` engine, sealed into a portable artifact that runs inside a **prebuilt QuickJS wasm**.
There is **no wasm toolchain at the run site**: the target environment supplies a QuickJS wasm
runtime (e.g. `quickjs-emscripten`, which it already has via its package registry) *to the host as a
parameter*, plus the committed bundle in [`vendor/`](./vendor/). The host package itself has **no
runtime dependencies** — it is pure glue.

## The vendor model

We separate **build** from **run**, because the target environment can host wasm but cannot build it
(no `emcc`, no `javy`, an old .NET SDK without `dotnet workload`). So:

```
  UPSTREAM (here / CI)                          DOWNSTREAM (the target)
  ─────────────────────                         ───────────────────────
  esbuild bundles                               host.ts (or a .NET / Python
  seal-entry.ts + @core-runtime      commit     equivalent) loads the bytes
  + @core/{values,formula,ontology}  ───────▶   into QuickJS wasm and calls
  → vendor/core.bundle.js                        fk.load / apply / read
  (pure JS, ONE build step,                     (NO build step, ever)
   needs only esbuild)
```

Build once, on a capable machine; **commit `vendor/core.bundle.js`**; the target runs those exact
bytes. Refresh it whenever `@core` changes:

```bash
npm -w @app/core-wasm run build     # rebuild vendor/core.bundle.js
npm -w @app/core-wasm run verify    # rebuild + fail if the committed bytes drift (CI guard)
```

## The seam

The sealed core has exactly one way in and one way out — nothing else crosses the sandbox wall:

| Direction | Surface | Defined in |
|-----------|---------|------------|
| **Entry** (host → core) | `fk.init / load / apply / read / snapshot / restore`, all `string → string` | [`src/seal-entry.ts`](./src/seal-entry.ts) |
| **Egress** (core → host) | `__fk_extern(name, paramsJson)` and `__fk_clock()`, injected before the bundle runs | [`src/host.ts`](./src/host.ts) |

Everything crosses as **JSON strings**. Two consequences fall out of that:

- **The value domain survives byte-for-byte.** `money.minor` is a *string* (arbitrary precision,
  never an f64); it round-trips through the seam unchanged. The test asserts `typeof premium.minor
  === 'string'` on the value that came *back out of wasm*.
- **The seam is language-agnostic.** Any host that can supply two `string → string` functions and
  call the `fk.*` methods can run this core — see the alternative hosts below.

The core reaches the world *only* through the injected externs. In test they are `mockExterns()`
(RDW vehicle lookup + region rating); in production they become real API calls. The bundle is
**identical** either way — only the injected externs differ. `test/sealed-core.test.ts` proves the
egress by asserting the mock recorded exactly the `rdw*` / `region*` calls and nothing else.

## Hosts

The reference host is JS ([`src/host.ts`](./src/host.ts)), used by both Node and the browser. The
same three moves — inject the two egress functions, evaluate the bundle, call `fk.*` over JSON —
were validated on two other runtimes the target environment can provide:

- **.NET** — `Wasmtime` NuGet loads a wasm module, `linker.Define("host", …)` injects the egress,
  `instance.GetFunction(...)` calls in. (Confirmed against Wasmtime 44; the target had Wasmtime 48.)
- **Python** — the `wasmtime` package (confirmed installable as `wasmtime-48.0.0`) does the same.

> Note on runtimes: QuickJS wasm as shipped by `quickjs-emscripten` is Emscripten-glue wasm, run by
> the JS host. The .NET / Python paths above were validated with a WASI/standalone module; a
> standalone QuickJS-WASI build (e.g. via a vendored `wasmtime`-compatible module) is the bridge if
> the core must run under those hosts directly. For the app itself, the JS host is the live path.

## Layout

```
src/seal-entry.ts   the sealed ABI — bundled INTO the artifact (the core's whole surface)
src/host.ts         the loader — imports NOTHING at runtime (type-only); takes the QuickJS module as a param
scripts/build.mjs   the one build step (esbuild → vendor/core.bundle.js)
vendor/             the committed artifact (built upstream, run downstream)
test/               the vendor-model proof (premium, guards, hidden, snapshot — all through wasm)
```
