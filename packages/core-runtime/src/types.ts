// The extern-function ABI — the wasm boundary, expressed in TS.
//
// A cassette is DATA (a JSON model interpreted through HQDM + @core). The Core is a sealed
// module: the ONLY way in is its exported methods; the ONLY way out to the world (time,
// external/API data) is the Externs the host supplies. In a later stage the same shape seals
// into wasm — Externs become wasm imports, the Core methods become wasm exports — with the
// host bridge unchanged.

import type { Value, ValueType } from '@core/values';
import type { RowState as EngineRow } from '@core/events';

/** A serializable snapshot of all rows — the browser host persists/broadcasts this (so externs
 * are never re-called on replay: the computed result travels, not the recipe). */
export interface Snapshot {
  seq: number;
  rows: Record<string, EngineRow[]>;
}

export interface Prop {
  id: string;
  valueType: ValueType;
  source?: 'stored' | 'computed' | 'extern';
  formula?: unknown; // computed: a @core formula AST
  category?: string; // optional HQDM class for the value (must reduce)
  api?: string; // extern: which host extern to call
  params?: Record<string, string>; // extern: extern-param name -> source field id
}
export interface Collection {
  id: string;
  semanticClass: string; // records classified by this HQDM class (must reduce)
  properties: Prop[];
  tables?: Record<string, unknown>; // lookup tables (configurator data)
}
/** A presentation override carried by a cassette (the P layer, as data). */
export interface CassetteOverride {
  subject: string; // a logic node: "collection" or "collection.field"
  variant?: string;
  role?: string;
  label?: string;
  emphasis?: string;
  order?: number;
  stateRules?: Record<string, string>; // enum value → a neutral state token
}

/** A loadable cassette: a model interpreted by the core through HQDM, PLUS the additional
 * dimensions (presentation / i18n / journey / seed) the client renders it with. The engine
 * consumes only types + collections + relations; the rest is carried for the client. */
export interface Cassette {
  id: string;
  locale?: string; // the cassette's default locale (e.g. "nl")
  types: Record<string, { specializes: string[] }>; // domain types → HQDM (must reduce)
  collections: Collection[];
  relations?: Record<string, { parentColl: string; childColl: string; childField: string }>;
  // --- additional dimensions (ignored by the engine; used by the client) ---
  presentation?: CassetteOverride[]; // the P layer
  l10n?: Record<string, Record<string, string>>; // locale → (labelToken → string)
  journey?: { field: string; steps: { id: string; label?: string }[] }; // the ordered wizard over a step field
  seed?: { coll: string; row: string; values: Record<string, Value> }[]; // example rows to apply when empty
}

/** The host-supplied imports — the ONLY egress from the sealed core. */
export interface Externs {
  clock(): { today: number; nowMs: number };
  /** an external/API call; the experiment MOCKS these. The core never does I/O itself. */
  api(name: string, params: Record<string, Value>): Value;
}

export type RowOp =
  | { op: 'insert'; row: string; values?: Record<string, Value> }
  | { op: 'setField'; row: string; field: string; value: Value };

export interface RowState {
  id: string;
  doc: Record<string, Value>;
  hidden?: string[]; // fields whose availableWhen is false for this record (not in play)
}

/** The sealed core — the ONLY entry. */
export interface Core {
  load(cassette: Cassette): void;
  apply(coll: string, ops: RowOp[]): RowState[];
  read(coll: string): RowState[];
  snapshot(): Snapshot;
  restore(s: Snapshot): void;
}
