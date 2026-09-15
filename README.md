# Computable Records

A typed, computed, HQDM-grounded engine where **the application is data, not code**.
Every value (money, date, duration, enum, reference) is first-class and exact, every
computed field is a **statically-typed formula**, every operation is **total** (errors
are values, never thrown), and every domain type **reduces to an HQDM upper ontology**.
A generic engine interprets the data; swap the data and you have a different application.

Two applications run on that one engine:

- **The Rowblaa Bank cassette player** — the deployed, public demo. A JSON "cassette"
  *is* an insurance/lending product; a sealed copy of the engine plays it inside a
  **QuickJS WebAssembly sandbox in the browser tab**, with no server round-trip for the
  maths. Live: <https://rowblaa-autoverzekering.pages.dev>.
- **The Computable Records database** — a server-backed, multi-collection, event-sourced
  database with live cross-collection rollups over WebSockets. It is **Notion's database
  half with a spreadsheet's brain** — deliberately *not* Notion's prose/blocks half.

Both are "the logic is data": the first plays **cassettes**, the second interprets a
**model**. Neither ships domain code — the same value/formula/ontology core runs under both.

---

## Two applications, one engine

### 1. The cassette player (deployed) — `catalogue.html` · `play.html` · `loom.html`

The public product. A **cassette** is a JSON document — typed collections, computed
formulas, lookup tables, relations, an authoring *journey*, and its own theme/labels —
that the sealed engine runs entirely client-side. Three surfaces, all client-only (no
server):

- **Catalogus** (`catalogue.html`) — the index of cassettes, derived from the files
  themselves. Cards are grouped into *Reizen* (composed products) and *Configuratoren*
  (reusable building blocks), ranked so the strongest demonstration leads.
- **Aanvraag** (`play.html?cassette=<id>`) — one player renders any cassette's journey
  as a stepped wizard or a single page. It boots the sealed `@core` in QuickJS wasm in
  the tab and recomputes live; money is exact to the cent.
- **Model / the Loom** (`loom.html`) — open the engine up: tabs for **Compositie**
  (the composed graph), **Structuur** (the schema), **Grafiek** (the dependency graph,
  re-derived from the formulas), **Regels** (edit rate tables/thresholds), and **JSON**
  (view/edit the effective model). Edits are validated in a throwaway core and saved to
  `localStorage`, which the player hot-reloads — change the logic with no code, no release.

The domain is **Rowblaa Bank**, a Dutch bank: car insurance (*autoverzekering*),
vehicle financing, a fleet product, and SME lending (*zakelijk krediet*). Products are
**composed** from reusable configurators (vehicle, address, individual, insurance,
financing) via a typed **L2 binding seam** (see below). A data-authored guided tour
(*Rondleiding*) and an *Uitleg* (Explain) mode narrate the site for business and
technical viewers alike.

### 2. The Computable Records database (server-backed) — `index.html`

A single Cloudflare **Durable Object** (`WorkspaceDO`) holds an entire workspace — many
collections plus the relations registry — in one embedded SQLite. It assigns a monotonic
`seq`, folds row-ops, runs a **rank-ordered recompute cascade** (edit a child, its
parents' rollups recompute transitively up a DAG), enforces **grant-based auth**, and
broadcasts touched rows over WebSockets. The browser view engine renders data-defined
views (table/board/docs) and reconciles rows by id per collection, so an edit in one tab
updates a rollup in another. Its seed models a **Dev Journey** decisions/knowledge
workspace (Intention → Requirement → Decision → Option → Observation).

> The two apps share `packages/client`: `index.html` → `src/main.ts` is the DB view
> engine (needs the server); `catalogue.html`/`play.html`/`loom.html` are the client-only
> cassette player (no server). The cassette player is what gets deployed.

---

## The repo is a seed

You build here by **editing the data, not the code** — a cassette (`packages/core-runtime/cassettes/*.json`)
or the database model (`model/`). A generic engine interprets it, and for the model the
docs are a projection of it, so they cannot drift.

For the **database model**, the rules that keep it honest are **enforced by code**:

- [`scripts/gate.mjs`](scripts/gate.mjs) — the contract, mechanized. Every type,
  `semanticClass`, and property `category` must **reduce to HQDM**; every computed
  column must **typecheck** and be acyclic; every relation/`ref` must point at a real
  collection; and every doc-record must be **homed on a real model node** (the Place
  law). It runs in `npm run check` and CI.
- [`scripts/hook.mjs`](scripts/hook.mjs) + `.claude/settings.json` — committed hooks that
  block code from being written into `model/` (and `presentation/`), block edits to the
  generated `model.data.json`, and run the gate on every model edit. Enforcement is
  **ambient** — an author is channelled into model-first whether or not they read the rules.
- [`AGENTS.md`](AGENTS.md) — the same contract in prose, plus how to author cassettes.

**Cassettes** are held to the same bar — reduce-to-HQDM, typecheck, acyclic — but by the
**engine itself** (`buildPrepared` refuses a cassette that doesn't), by the Loom's
`previewCassette` before any save, and by the test suite, rather than by `gate.mjs`
(which scans `model/`).

---

## Packages

The monorepo (`computable-records`, npm workspaces, Node 24) is a pure engine plus two hosts.

| Package | What it is |
|---|---|
| [`@core/values`](packages/values) | The canonical value domain — a tagged `Value` union (num, money, pct, dur, date, datetime, bool, text, enum, enumset, ref, list, predicate, blank, error) with a static `ValueType` mirror. **Integer-minor-unit money** whose `minor` is a **string** with BigInt arithmetic (never a float), civil-date math on epoch days, and a total `compare`/`equals`. **Errors and blanks are first-class values, never thrown.** |
| [`@core/formula`](packages/formula) | The formula engine — a JSON `{op,…}` AST (`lit`/`field`/`ref`/`rollup`/`lookup`/`signal`/`build`/`check`/`not`/`neg`/binary/`call`), a **static typechecker** that catches `money(EUR) + money(USD)` as `#CCY` at save time, `compile` (typecheck + dependency extraction), a Kahn **cycle guard**, and a **pure, total evaluator** that doubles as the test oracle. Also **lookup tables** (the configurator substrate) and a `signal`/`build`/`check` **criterion-predicate** subsystem. |
| [`@core/events`](packages/events) | The row change model — a 7-arm `RowOp` union (`insert`/`setField`/`clearField`/`addElement`/`removeElement`/`delete`/`restore`) + a **pure, seq-ordered reducer** (`applyOp`/`fold`); scalars are last-writer-by-seq, multi-value fields commute, `invert` powers undo. |
| [`@core/query`](packages/query) | The read path — compile a data-defined `ViewSpec` (filter/sort/group) into **parameterised SQL** over the shared `records` table; field ids are injection-guarded and money filters carry a same-currency guard. |
| [`@core/ontology`](packages/ontology) | The **HQDM upper lattice** as data (a faithful core of Matthew West's 4-D model) + a pure reader: `supertypesOf`, `isA`, **`reduces(id)`** (known and specializes up to `thing`), plus render hints. Self-contained — it depends on none of the other packages. Domain classes extend the lattice as data (`specializes`). |
| [`@app/core-runtime`](packages/core-runtime) | The **cassette runtime**: the `Cassette` type, the engine (`buildPrepared` validates + HQDM-reduces + compiles + rank-orders; a rank-ordered cross-collection recompute cascade), an in-memory store, the browser host, and mock externs. The in-browser core's write surface is **`insert` + `setField` only** — no delete; "removal" is a cassette-level soft-delete via an `actief` flag. Home of the demo `cassettes/`. |
| [`@app/core-wasm`](packages/core-wasm) | The **sealed core, vendored**: `@core` bundled by esbuild into a committed `vendor/core.bundle.js` and run inside a **prebuilt QuickJS wasm** with no wasm toolchain at the run site. One `string → string` ABI (`fk.init/load/apply/read/snapshot/restore`) and one egress seam (`__fk_extern`, `__fk_clock`). The value domain survives byte-for-byte because everything crosses as JSON. |
| [`@app/server`](packages/server) | The **`WorkspaceDO`** — one Cloudflare Durable Object per workspace holds many collections + the relations registry in one embedded SQLite. It reduce-checks the whole workspace on `PUT` (rejecting anything that doesn't ground in HQDM), folds ops, runs the recompute cascade, enforces **grant-based auth** (token → actor → model-driven scopes, fail-closed), and broadcasts over WebSockets. Also does guarded transitions, `availableWhen` field-gating, and lookup tables. |
| [`@app/client`](packages/client) | The **browser front-ends** — the cassette player (`catalogue`/`play`/`loom`, running the sealed core in-tab via `createBrowserHostOver`) and the DB view engine (`index.html` over the `WorkspaceDO` socket). A renderer registry (`table`/`board`/`docs`/`self-portrait`/`journey`) and a cell registry keyed by value type. Vite + `@preact/signals-core`, no framework. |

`@core/values` has no dependencies; `@core/formula`, `@core/events`, and `@core/query`
type-import it; `@core/ontology` is standalone. `@app/core-runtime` is the cassette
engine over the `@core/*` packages; `@app/core-wasm` seals that engine into a portable
bundle; `@app/server` wires the engine into the Durable Object; `@app/client` is both
browser hosts.

## How it holds together

- **Everything reduces to HQDM.** A collection is a `class_of_X`, a `ref` is an
  `association`, a money value is an `amount_of_money`, an enum status is a `state`. Both
  hosts reject a class that doesn't reduce — the server on `PUT`, the cassette engine on load.
- **Errors are values, not exceptions.** One bad cell shows `#DIV0` in place; the rest of
  the row stays live. The evaluator never throws, so replay is exact and it is trivially
  testable as an oracle.
- **A real type system.** `money(EUR) + money(USD)`, an out-of-set enum, or a
  non-orderable comparison is a **compile error the author sees at save time**, not a
  per-row runtime surprise.
- **Money is exact.** Integer minor units (a string) + scale + ISO currency, with BigInt
  arithmetic. `0.10 + 0.20` is `0.30`, and a rollup over many rows does not drift a cent.
- **Composition is data.** A cassette **proposition** composes reusable configurators
  through a typed **L2 binding seam**: `compile-journey.ts` merges a proposition
  (composition) with a journey (interaction) into one runnable cassette, realising each
  binding as a cardinality-1 `rollup` — the computed-ness *is* the live, non-editable
  lock — with **no engine change**. Repeatable "N of the same thing" (a fleet) is instead
  a to-many relation + `sum` rollup inside one cassette.
- **The engine is sealed and portable.** `@app/core-wasm` runs the exact committed bundle
  inside QuickJS wasm; its only reach outward is two injected `string → string` functions,
  so the same bytes run in the browser, Node, or (validated) a .NET/Python wasm host.

## Quickstart

```bash
nvm use            # Node 24+ (native TypeScript type-stripping — tests run .ts directly)
npm install        # links the workspace packages
npm run gate       # enforce the model contract (reduces / typechecks / homed)
npm run check      # gate + typecheck + tests + server (workerd) tests — the full CI bar
```

`npm run bundle` publishes `model/` → `packages/client/src/model.data.json` **and** copies
`packages/core-runtime/cassettes/` → `packages/client/src/cassettes/` (both generated and
git-ignored); it runs automatically before `test`/`typecheck`/`dev`/`build`.

### Run the cassette player (client-only, no server)

```bash
cd packages/client && npm run dev
```

Open <http://localhost:5173/catalogue.html> — the Rowblaa Bank catalogue. Everything runs
in the tab on the sealed engine; there is no server to start.

### Run the database studio (two-tab, server + client)

```bash
# terminal 1 — the Durable Object worker
cd packages/server && npx wrangler dev --port 8787
# terminal 2 — the client (Vite proxies /collections + /workspace + ws to :8787)
cd packages/client && npm run dev
```

Open <http://localhost:5173/> in two tabs; edit a record in one and watch a rollup
recompute on the server and update the other tab — no formula code on the client.

## Deploy

The cassette player deploys to **Cloudflare Pages** (project `rowblaa-autoverzekering`).
It is a **manual** step — CI never deploys:

```bash
npm -w @app/client run deploy   # vite build → wrangler pages deploy dist
```

Cloudflare Pages serves **clean URLs** (`/catalogue`, not `/catalogue.html`), and
`public/_redirects` rewrites `/` → `/catalogue.html` (a 200 rewrite; the URL stays `/`).
Code that matches on the current page must therefore key on *identity*, not the path
spelling — the guided tour matches by surface + query for exactly this reason.

## Repository layout

```
model/                the database application, as data (the DB half's source of truth)
  collections/*.json    typed + computed columns (semanticClass, HQDM category tags)
  relations.json        many-to-one links (parent ← child.field)
  docs/*.json           doc-records, each homed on a model node (the Place law)
  seed.json             example rows + the domain type rows (the `types` collection)
presentation/         the presentation (P) layer, a build input
  views/*.json          table/board/docs view specs
  overrides/*.json      per-node presentation deltas
packages/
  values formula events query ontology   the pure @core engine
  core-runtime          the cassette engine + the demo cassettes/*.json
  core-wasm             the sealed engine, vendored into a QuickJS-run bundle
  server                the WorkspaceDO (Durable Object)
  client                both browser hosts (cassette player + DB view engine)
scripts/gate.mjs      the model contract, enforced
scripts/bundle-model.mjs  publish model/ + cassettes → the client
scripts/hook.mjs      committed hooks (block code in model/, run the gate)
wasm-lab/             experimental scratch (C/emcc, C#/Wasmtime, QuickJS sealing) — not a
                      workspace member, not built or tested by CI; fed into core-wasm
```

Tests run under `node:test` directly on `.ts` (Node 24 type-stripping); the `WorkspaceDO`
tests run inside **workerd** via `@cloudflare/vitest-pool-workers` (`npm run test:server`).
CI (`.github/workflows/ci.yml`) runs `npm run check` on every push to `main` and every PR.

## Status

- **Deployed and active:** the Rowblaa Bank cassette player — catalogue/player/Loom,
  reusable configurators composed via the L2 seam into propositions and journeys
  (car insurance, financing, a fixed and a dynamic-N fleet, SME lending), a live editable
  Loom, and a data-authored guided tour. All recent work is here.
- **Live but stable (a parked foundation):** the `WorkspaceDO` database + view engine and
  the `model/` seed (now a Dev Journey decisions workspace), with grant-based auth,
  guarded transitions, `availableWhen` gating, and lookup tables built and tested.

Deliberately **not** building: a rich-text block-tree editor, string/date value types the
engine can't compute, CRDTs, or side-effecting automations.

## License

MIT © rossjdharrison
