# The contract

This repo is a **seed**: a generic engine plus a model. You build applications by
**editing the model, not the code**. The model IS the application; the docs are a
projection of the model. This file is the contract every author — human or agent —
works under. It is not advisory: [`scripts/gate.mjs`](scripts/gate.mjs) enforces it,
committed hooks run it on every model edit, and CI runs it on every push. A change
that breaks the contract does not land.

## Where things live

| You want to…                        | Edit…                                    |
| ----------------------------------- | ---------------------------------------- |
| add/shape a kind of record          | `model/collections/*.json`               |
| add a domain type                   | `model/types.json` (must reduce to HQDM) |
| relate two collections              | `model/relations.json`                   |
| add a computed column / rollup      | a property with `source: "computed"`     |
| document anything                   | `model/docs/*.json` (a **doc-record**)   |
| add/shape a view                    | `model/views/*.json`                     |
| seed example rows                   | `model/seed.json`                        |
| change the **engine**               | `packages/*/src` — framework work only   |

`model/` is **data only** (JSON). Domain behaviour is not code — it is a computed
column (a total formula AST) or a doc-record. `packages/{values,formula,events,query,ontology,server,client}`
is the **trusted engine**: generic, domain-free, and changed only for framework work.

## The rules (the gate checks each one)

1. **One truth.** Domain facts live in the model, once. No parallel copy in code or prose.
2. **Everything reduces.** Every type, every collection's `semanticClass`, and every
   property `category` climbs a `specializes` chain to an HQDM root. If it doesn't
   reduce, it isn't grounded — name it against `@core/ontology`, don't invent a root.
3. **The Place law.** Every doc-record has a `home` that is a real model node — a
   collection (`features`), a property (`features.effort`), or a relation
   (`relation:tasks`). *If the place doesn't exist, your model is missing something —
   add the node, or you're documenting in the wrong place.* Homeless docs fail the gate.
4. **Declarative & total.** Computed columns are formula ASTs over `@core/formula`
   (no I/O, no loops, no Turing-completeness). Errors are values, not exceptions.
5. **Typed & acyclic.** Every computed column typechecks against its schema and
   relations; the dependency graph has no cycles. The gate compiles them.
6. **Integrity.** Relations and `ref` fields point at collections that exist; a
   relation's `childField` is a `ref` to its `parentColl`.
7. **Neutrality.** The engine never imports from `model/`, and no domain type name
   appears in engine source. The model never contains code.

## How to work

- **Model-first.** Start from the model. If you reach for a `.ts` file to express a
  domain fact, stop — that fact belongs in the model.
- **Run the gate.** `npm run gate` after any model change (the hook does this for you).
  Green means grounded, typed, and homed. `npm run check` runs gate + typecheck + tests.
- **Document in place.** When you add or change a node, home its doc on that node.
  Coverage is reported; gaps are a nudge, homeless docs are a failure.

## Layout

```
model/            the application, as data (the single source of truth)
  types.json          domain types → HQDM (specializes chains)
  collections/*.json  typed + computed columns (semanticClass, category tags)
  relations.json      many-to-one links (parent ← child.field)
  docs/*.json         doc-records (the Place law)
  views/*.json        table/board projections
  seed.json           example rows
packages/         the generic engine (trusted core) + client/server host
scripts/gate.mjs  the contract, enforced
scripts/hook.mjs  the committed hooks (block code in model/, run the gate)
```
