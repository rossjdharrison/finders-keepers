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
| [`@app/server`](packages/server) | The **CollectionDO** — one Cloudflare Durable Object per collection: it assigns a monotonic `seq`, folds ops with `@core/events`, **recomputes typed computed columns** with `@core/formula`, persists to embedded **SQLite**, serves `@core/query` reads strongly, and **broadcasts recomputed rows over WebSockets**. All the hard logic lives in the pure `@core` packages; the DO is the thin authority shell. |
| [`@app/client`](packages/client) | The **view engine** — data-defined `View` docs (`collection` + `ViewSpec` + `renderer` + `config`) rendered through a **renderer registry** (`table` + `board`) and a **cell registry** keyed by value type. A signals-backed store seeds, snapshots, edits optimistically, and **reconciles by id** on the WebSocket broadcast. Stored cells are editable; computed cells are read-only and update live. Vite + `@preact/signals-core`, no framework. |

`@core/values` has no dependencies; the other `@core/*` packages build on it; `@app/server` wires them into the Durable Object; `@app/client` is the browser view engine over the same wire contract.

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

**v0 walking skeleton — done.** The engine (`@core/values` + `@core/formula`), the
persistence spine (`@core/events` + `@core/query` + the `CollectionDO`), and the
client view engine (`@app/client`) are all in place and verified end to end: a
typed computed column recomputes on the server, renders through data-defined table
+ board views, and updates **live across two browser tabs** — editing `qty` in one
tab recomputes `lineTotal` and both tabs reflect it, with no formula code on the client.

### Run the two-tab demo

```bash
# terminal 1 — the Durable Object worker
cd packages/server && npx wrangler dev --port 8787
# terminal 2 — the client (Vite proxies /collections + ws to :8787, same-origin)
cd packages/client && npm run dev
```

Open http://localhost:5173 in two tabs. Edit a `qty` or `unit price` (or drag a card
between board columns); the server recomputes `lineTotal` and both tabs update live.
- **v1 (the real MVP):** multiple collections, relations + rollups, real-time
  multi-user, auth, gallery + calendar views — "Notion-lite with a real type system".
- **v2 (the moat, once v1 has users):** event-sourced process instances, an optional
  ontology + derived taxonomy, cross-record incremental recompute.

Deliberately **not** building: a rich-text block-tree editor, string/date value
types the engine can't compute, CRDTs, or side-effecting automations.

## License

MIT © rossjdharrison
