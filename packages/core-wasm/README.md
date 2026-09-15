# @app/core-wasm — the sealed core, vendored

The `@core` engine, sealed into a portable artifact that runs inside a **prebuilt QuickJS wasm**.
There is **no wasm toolchain at the run site**: the host supplies a QuickJS wasm runtime
*as a parameter*, plus the committed bundle in [`vendor/`](./vendor/). The host package itself
has **no runtime dependencies** — it is pure glue (every import is type-only).

## The vendor model

We separate **build** from **run**, because the target environment can host wasm but cannot
build it (no `emcc`, no `javy`, an old .NET SDK without `dotnet workload`). So:

```
  UPSTREAM (here / CI)                          DOWNSTREAM (the target)
  ─────────────────────                         ───────────────────────
  esbuild bundles                               host.ts (or a .NET / Python
  seal-entry.ts + @app/core-runtime  commit     equivalent) loads the bytes
  + @core/{values,formula,ontology}  ───────▶   into QuickJS wasm and calls
  → vendor/core.bundle.js                        fk.load / apply / read
  (pure JS, ONE build step,                     (NO build step, ever)
   needs only esbuild; ~32 kB)
```

Build once, on a capable machine; **commit `vendor/core.bundle.js`**; the target runs those
exact bytes. Refresh it whenever `@core` changes:

```bash
npm -w @app/core-wasm run build     # rebuild vendor/core.bundle.js (esbuild, one step)
npm -w @app/core-wasm run verify    # rebuild + `git diff --exit-code` on the bundle
```

`verify` is a **drift guard** — it fails if the committed bytes no longer match a fresh
build. Note it is **not currently wired into CI**: CI runs only `npm run check`
(gate + typecheck + tests), so refresh and commit the bundle yourself after any `@core`
change. (Extern or cassette changes need **no** rebuild — see below.)

## The seam

The sealed core has exactly one way in and one way out — nothing else crosses the sandbox wall:

| Direction | Surface | Defined in |
|-----------|---------|------------|
| **Entry** (host → core) | `fk.init / load / apply / read / snapshot / restore`, all `string → string` | [`src/seal-entry.ts`](./src/seal-entry.ts) |
| **Egress** (core → host) | `__fk_extern(name, paramsJson)` and `__fk_clock()`, injected before the bundle runs | [`src/host.ts`](./src/host.ts) |

Everything crosses as **JSON strings**. Two consequences fall out of that:

- **The value domain survives byte-for-byte.** `money.minor` is a *string* (arbitrary
  precision, never an f64); it round-trips through the seam unchanged. The test asserts
  `typeof premium.minor === 'string'` on the value that came *back out of wasm*.
- **The seam is language-agnostic.** Any host that can supply two `string → string`
  functions and call the `fk.*` methods can run this core — see the alternative hosts below.

The core reaches the world *only* through the injected externs, and **the extern names are
cassette data, not baked into the bundle** (grepping `vendor/core.bundle.js` for `rdw*`/
`kvk*`/`region*` finds nothing). The engine dispatches whatever `api` name a cassette
declares, so **adding or renaming an extern is host + cassette work with no rebuild** of the
sealed core; only a change to `@core` itself requires a rebuild.

## Externs — mock vs real

The bundle is **identical** in test and production; only the injected externs differ.

- **In tests**, `mockExterns()` (in `@app/core-runtime`) provides recording doubles for the
  whole demo set: `rdwValue`/`rdwDesc` (RDW vehicle register), `regionBand`/`regionCity`/
  `addrStreet` (postcode → risk band / city / street), and `kvkName`/`kvkRechtsvorm`/
  `kvkSector`/`kvkCity`/`kvkMedewerkers` (KvK company register). Any other name returns
  `{t:'error',code:'#NA'}`.
- **In the browser**, `browserExterns()` (in `@app/client`) is the production egress and is
  **not** a uniform "flip to real":
  - **RDW** (`rdw*`) — a **real**, keyless, CORS-open fetch to `opendata.rdw.nl`.
  - **PDOK** (`addrStreet`, `regionCity`) — a **real**, keyless, CORS-open fetch to
    `api.pdok.nl` (the Locatieserver / BAG) for street + city.
  - **`regionBand`** — a **local deterministic mock** (derived from the postcode's leading
    digit); a risk rating, never a public API even in production.
  - **KvK** (`kvk*`) — a **mock**. The Handelsregister API needs a key and sends no CORS
    headers, so it cannot be called from the browser; production must route it through a
    keyed server proxy.

The bundle never knows the difference — it just calls `__fk_extern(name, params)`.

## Tests

`test/` drives the exact committed bundle through QuickJS:

- `test/sealed-core.test.ts` — the vendor-model proof: premium, guards, hidden fields, and
  snapshot/restore all through wasm; it asserts the recorded egress **includes** the
  expected `rdw*`/`region*` calls (a presence check) and that a rejected guard surfaces as a
  thrown JS `Error` out of wasm.
- `test/composed-cassette.test.ts` — an intra-cassette decomposition (per-configurator
  rollup subtotals, the cross-collection recompute cascade, and HQDM-reduction refusal),
  all through the same sealed bundle.

## Hosts

The reference host is JS ([`src/host.ts`](./src/host.ts)). The **browser** boots QuickJS via
`quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` (a synchronous
release build with the wasm as a separate fetched file); **Node/tests** use the meta
`quickjs-emscripten` (`getQuickJS()`). The host is runtime-agnostic — it takes the QuickJS
module as a parameter — so the same three moves (inject the two egress functions, evaluate
the bundle, call `fk.*` over JSON) were also validated on:

- **.NET** — `Wasmtime` loads a wasm module, `linker.Define("host", …)` injects the egress,
  `instance.GetFunction(...)` calls in. (Confirmed against Wasmtime 44/48.)
- **Python** — the `wasmtime` package does the same.

> Note on runtimes: QuickJS wasm as shipped by `quickjs-emscripten` is Emscripten-glue wasm,
> run by the JS host. The .NET / Python paths were validated with a WASI/standalone module; a
> standalone QuickJS-WASI build is the bridge if the core must run under those hosts directly.
> For the app itself, the JS host is the live path.

## Layout

```
src/seal-entry.ts   the sealed ABI — bundled INTO the artifact (the core's whole surface)
src/host.ts         the loader — imports NOTHING at runtime (type-only); takes the QuickJS module as a param
scripts/build.mjs   the one build step (esbuild → vendor/core.bundle.js)
vendor/             the committed artifact (~32 kB; built upstream, run downstream)
test/               the vendor-model proofs (sealed-core + composed-cassette, all through wasm)
```
