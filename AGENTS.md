# The contract

This repo is a **seed**: a generic engine plus data. You build applications by **editing
the data, not the code**. There are two data surfaces, and one trusted engine:

1. **Cassettes** — `packages/core-runtime/cassettes/*.json`. Each is a self-contained
   product played by the sealed `@core` in the browser (the deployed Rowblaa Bank site).
2. **The database model** — `model/` + `presentation/`. Data-only JSON interpreted by the
   `WorkspaceDO` server + client view engine. For the model, **the docs are a projection
   of the data**, so they cannot drift.
3. **The engine** — `packages/{values,formula,events,query,ontology,core-runtime,core-wasm,server,client}/src`.
   Generic, domain-free; changed only for framework work.

The rules below are **not advisory**. For the model, [`scripts/gate.mjs`](scripts/gate.mjs)
enforces them, committed hooks run it on every model edit, and CI runs it on every push.
Cassettes are held to the same HQDM/typed/acyclic bar — but by the **engine itself**
(it refuses to load a cassette that fails), by the Loom's `previewCassette` before any
save, and by the test suite.

## Where things live

| You want to…                                | Edit…                                              |
| ------------------------------------------- | -------------------------------------------------- |
| add/shape a **cassette** product            | `packages/core-runtime/cassettes/*.json`           |
| add/shape a database **record kind**        | `model/collections/*.json`                         |
| add a domain **type**                       | a row in the `types` collection, in `model/seed.json` (must reduce to HQDM) |
| relate two collections                      | `model/relations.json`                             |
| add a **computed column / rollup**          | a property with `source: "computed"` + a formula   |
| **document** a model node                   | `model/docs/*.json` (a **doc-record**)             |
| add/shape a **view**                        | `presentation/views/*.json` (the P layer)          |
| tweak how a node is **shown**               | `presentation/overrides/*.json`                    |
| seed example rows                           | `model/seed.json`                                  |
| change the **engine**                       | `packages/*/src` — framework work only             |

`model/` and `presentation/` are **data only** (JSON); domain behaviour is a computed
formula or a doc-record, never code. `packages/*` is the **trusted engine**: generic,
domain-free, changed only for framework work.

> **Views live under `presentation/`, not `model/`.** There is no `model/views/`. The gate
> rejects presentation keys (renderer/label/glyph/…) that leak into `model/`.

## The rules (the gate checks each one, for the model)

1. **One truth.** Domain facts live in the data, once. No parallel copy in code or prose.
2. **Everything reduces.** Every type, every `semanticClass`, and every property
   `category` climbs a `specializes` chain to an HQDM root. If it doesn't reduce, name it
   against [`@core/ontology`](packages/ontology) — don't invent a root.
3. **The Place law.** Every doc-record has a `home` that is a real model node — a
   collection (`decisions`), a property (`decisions.status`), or a relation
   (`relation:options`). Homeless docs fail the gate; a missing place means a missing node.
4. **Declarative & total.** Computed columns are formula ASTs over
   [`@core/formula`](packages/formula) — no I/O, no loops. Errors are values, not exceptions.
5. **Typed & acyclic.** Every computed column typechecks against its schema and relations;
   the dependency graph has no cycles. The gate compiles them.
6. **Integrity.** Relations and `ref` fields point at collections that exist; a relation's
   `childField` is a `ref` to its `parentColl`.
7. **Neutrality.** The engine never imports from `model/`, and no domain type name appears
   in engine source. The data never contains code.

## Authoring cassettes

A cassette is JSON with `id`, `title`, domain `types` (→ HQDM), `collections` (typed
`properties` — `source: stored | computed | extern`), optional `relations`, a `journey`
(steps/summary), and client dimensions (`theme`, `l10n`, `enums`, `presentation`, `seed`).
Four kinds, distinguished exactly as `cassette-registry.ts` classifies them:

- **flat configurator** — one collection, no `relations` (e.g. `voertuig`, `adres`,
  `individual`, `financing`).
- **intra-cassette composed** — multiple collections wired by `relations` + a `rollup`
  (e.g. `fleet-n`, `car-insurance-composed`). Use this for **N of the same thing**.
- **proposition** (`kind: "proposition"`) — composes reusable configurators via `models` +
  typed `bindings` + `targetMarket` + a `spine` (e.g. `auto-package`, `sme-lending`). Use
  this for **cross-product** composition.
- **journey** (`kind: "journey"`) — the interaction over one proposition: a `proposition`
  ref + `sections` + `party` + `minimal` (e.g. `auto-package-aanvraag`).

Conventions the engine and existing cassettes rely on — preserve them:

- **Edit the originals.** `packages/client/src/cassettes/` is a **git-ignored copy**
  regenerated by `bundle-model.mjs`. Always edit `packages/core-runtime/cassettes/`.
- **No delete op.** The in-browser core is `insert` + `setField` only. "Remove a row" is a
  soft-delete: a stored `actief` bool set false, and the row's contributions compute to
  blank so it drops out of rollups.
- **Currency-agnostic zero.** Write a money zero as `mul(field, 0)`, not an EUR literal, so
  it unifies with currency-agnostic `money` fields (an EUR literal triggers a `#TYPE`).
- **Guard empty sums.** An empty `sum` rollup is `num(0)`, which collides with money typing
  downstream — guard it (e.g. `fleetMonthly` is blank when the count is 0).
- **L2 bindings roll up with `agg: "min"`.** Over one present child a `min` returns the
  value unchanged (so any typed value, including an enum, crosses the seam), and over an
  empty child it stays blank rather than becoming `num(0)`. `compile-journey.ts` does this.
- **Enum sets unify by name.** Two composed models sharing a set name must share its
  members; a divergent id silently falls to a lookup default (a wrong price).

Live-edit and validate cassettes in the **Loom** (`loom.html`): the **Regels** tab edits
rate tables/thresholds, **Compositie** edits a whole proposition's composition, and
**JSON** edits the effective model — each validated in a throwaway core (`previewCassette`
/ `previewJourney`) before it saves to `localStorage` that the player hot-reloads.

## How to work

- **Data-first.** Start from the data. If you reach for a `.ts` file to express a domain
  fact, stop — that fact belongs in a cassette or the model.
- **Run the checks.** `npm run gate` after any model change (the hook does this for you);
  `npm run check` runs gate + typecheck + tests + the workerd server tests. For cassettes,
  the relevant tests are `packages/client/src/*.test.ts` (e.g. `l2-seam.test.ts`) and
  `packages/core-runtime`/`core-wasm` tests.
- **Document in place.** When you add or change a model node, home its doc on that node.
- **Never hand-edit generated files.** `packages/client/src/model.data.json` and
  `packages/client/src/cassettes/` are produced by `bundle-model.mjs` (the hook blocks
  writing them).

## Layout

```
packages/core-runtime/cassettes/*.json   the cassette products (the deployed app), as data
model/            the database application, as data
  collections/*.json  typed + computed columns (semanticClass, category tags)
  relations.json      many-to-one links (parent ← child.field)
  docs/*.json         doc-records (the Place law)
  seed.json           example rows + the domain type rows (the `types` collection)
presentation/     the presentation (P) layer, a build input
  views/*.json        view specs        overrides/*.json   per-node deltas
packages/         the generic engine (trusted core) + client/server hosts
scripts/gate.mjs  the model contract, enforced
scripts/hook.mjs  the committed hooks (block code in model/ + presentation/, run the gate)
```
