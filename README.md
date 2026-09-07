# Computable Records

A typed, computed, event-sourced database with a Notion-database-style multi-view
UX — but every column can be a **real, statically-typed formula**, every rich value
(money, date, duration, enum, reference) is first-class, and (later) every edit is
live across clients. It is **Notion's database half with a spreadsheet's brain** —
deliberately *not* Notion's prose/blocks half.

This repo begins with the one thing worth owning: the **typed formula engine**.

## Packages

| Package | What it is |
|---|---|
| [`@core/values`](packages/values) | The canonical value domain — a tagged `Value` union, its static `ValueType` mirror, **integer-minor-unit money** (never floats), civil-date math, and a total `compare`/`equals`. Errors and blanks are first-class values, never thrown. |
| [`@core/formula`](packages/formula) | The formula engine — a JSON `{op,args}` AST, a **static typechecker** (catches `money(EUR) + money(USD)` as `#CCY` at column save time), `compile` (typecheck + dependency extraction), a Kahn **cycle guard** (`#CYCLE`), and a **pure, total evaluator** that doubles as the test oracle. |
| [`@core/events`](packages/events) | The row change model — a `RowOp` union + a **pure, seq-ordered reducer** (`applyOp`/`fold`). Scalars are last-writer-by-seq; multi-value fields use commutative `addElement`/`removeElement`; `invert` powers undo. CRUD-with-history, not event-sourcing (that's a v2 concern). |
| [`@core/query`](packages/query) | The read path — compile a data-defined `ViewSpec` (filter/sort/group) into **parameterised SQL** over the records table. Money compares on integer minor units with a currency guard; dates on `epochDay`; field ids are validated against injection. |
| [`@core/ontology`](packages/ontology) | The **HQDM upper lattice** (a faithful core of Matthew West's 4-D model: `thing → physical_object/abstract_object/…`, `activity/state/association/amount_of_money/physical_quantity/sign/party/…`) + the reducibility reader: `supertypesOf`, `isA`, and **`reduces(id)`** — a type reduces iff it's known and specializes up to `thing`. Domain classes extend the lattice as data (`specializes`). |
| [`@app/server`](packages/server) | The **WorkspaceDO** — one Cloudflare Durable Object holds an entire workspace (many collections + the relations registry) in one embedded **SQLite**. It assigns a monotonic `seq`, folds ops with `@core/events`, and runs a rank-ordered **recompute cascade**: a `@core/formula` recompute of the edited row, then every row that **rolls it up**, transitively, until stable (a task's hours ripple to its feature's `effort` and up to the initiative). Terminates structurally — the cross-collection rollup graph is a DAG. Broadcasts recomputed rows (tagged by collection) over WebSockets. |
| [`@app/client`](packages/client) | The **view engine** — data-defined `View` docs rendered through a **renderer registry** (`table` + `board`) and a **cell registry** keyed by value type, incl. a **ref picker** (dropdown of parent rows). A signals-backed workspace store holds all collections behind one socket, edits optimistically, and **reconciles by id per collection** on the broadcast — so a task edit updates a feature's rollup in another tab. Vite + `@preact/signals-core`, no framework. |

`@core/values` has no dependencies; the other `@core/*` packages build on it; `@app/server` wires them into the Durable Object; `@app/client` is the browser view engine over the same wire contract.

**Relations + rollups.** Relations are ref-field (many-to-one): a child stores a `ref` to its parent, and a `via` in the workspace registry maps it to a relation. **Rollups are just computed columns** whose formula is a `rollup` AST node — so `Feature.effort = sum(Tasks.hours)`, `Feature.progress = taskDone / taskCount` (computed-from-rollup), and `Initiative.shippedPoints = sum(Feature.shippedPoints)` (rollup-of-computed) all reuse the whole typecheck/eval path. The typechecker resolves a rolled-up field against the *child* collection; the resolver is collection-aware (VRef-based).

**Every model is HQDM-based from day one.** Each collection declares a `semanticClass`, and fields may carry an HQDM `category`; a workspace declares its domain `types` by `specializes`. `PUT /workspace` runs an enforced **reduce-check** (`@core/ontology`) that rejects — before persisting — any class that doesn't reduce to the HQDM lattice. So the reduction is real and guaranteed: a **collection** is a `class_of_X` and its records are individuals; a **`ref`** is an `association`; a **money/quantity** value is an `amount_of_money`/`physical_quantity`; an **enum status** is a `state` (and the event log's timestamps give it its 4-D temporal extent). In Product Studio, Initiatives/Features/Tasks are `activity`s and Docs are `sign`s.

The `@core/*` packages are pure and run under `node:test`; `@app/server` runs its Durable Object tests inside **workerd** via `@cloudflare/vitest-pool-workers` (`npm run test:server`).

## Design principles baked into the code

- **Errors are values, not exceptions.** Every operation is total: one bad cell
  shows `#DIV0` in place, the rest of the row and table stay live. The evaluator
  never throws, so replay is exact and it is trivially testable as an oracle.
- **A real type system.** `money(EUR) + money(USD)`, an out-of-set enum, or a
  non-orderable comparison is a **compile error the builder sees inline**, before
  any row runs — not a per-row runtime surprise.
- **Money is exact.** Integer minor units + scale + ISO currency. `0.10 + 0.20`
  is `0.30`, and a rollup over 50k rows does not drift a cent.
- **JSON all the way down.** Every `Value` is JSON-serialisable as-is, so the same
  shape travels the wire, the store, and the log (bigints are strings).
- **Pure, deterministic evaluation.** `evalRecord(cols, env, resolver, clock)` —
  the clock is injected so `today()`/`now()` stay deterministic in tests. This is
  the exact function the server and client share.

## Quickstart

```bash
nvm use            # Node 24+ (native TypeScript type-stripping — tests run .ts directly)
npm install        # links the workspace packages
npm test           # runs the node:test suites across both packages
npm run typecheck  # tsc --noEmit per package
```

`npm run check` runs typecheck + tests.

## Roadmap

**v1 in progress — relations + rollups shipped.** The engine, the persistence spine
(now a `WorkspaceDO`), the client view engine, **and row↔row relations + rollups**
are in place and verified end to end. The demo is **"Product Studio"** (product
development × Confluence): Initiatives → Features → Tasks (hierarchy via ref fields)
plus Docs (Confluence pages on an editorial board). Editing a Task's hours or status
ripples through the rollups (`effort`, `progress`, `shippedPoints`) up to the
Feature and Initiative, **live across every open tab**, with no formula code on the client.

### Run the two-tab demo

```bash
# terminal 1 — the Durable Object worker
cd packages/server && npx wrangler dev --port 8787
# terminal 2 — the client (Vite proxies /collections + /workspace + ws to :8787)
cd packages/client && npm run dev
```

Open http://localhost:5173 in two tabs. Switch one to **Tasks** and the other to
**Features**; change a task's hours or status — the feature's `effort`/`progress`
rollups (and the initiative's totals) recompute on the server and update both tabs.
- **v1 (the real MVP):** multiple collections, relations + rollups, real-time
  multi-user, auth, gallery + calendar views — "Notion-lite with a real type system".
- **v2 (the moat, once v1 has users):** event-sourced process instances, an optional
  ontology + derived taxonomy, cross-record incremental recompute.

Deliberately **not** building: a rich-text block-tree editor, string/date value
types the engine can't compute, CRDTs, or side-effecting automations.

## License

MIT © rossjdharrison
