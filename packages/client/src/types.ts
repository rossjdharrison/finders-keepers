// Client-side mirrors + the frozen view-engine contracts. The server package is
// not browser-bundleable (Durable Objects), so the wire shapes are re-declared
// here against the exact contract in packages/server/src/collection-do.ts.

import type { Value, ValueType } from '@core/values';
import type { ViewSpec } from '@core/query';
import type { ReadonlySignal } from '@preact/signals-core';

// --- wire (matches collection-do.ts RowStateWire / CollectionDoc) ------------
export interface RowStateWire {
  id: string;
  doc: Record<string, Value>;
  deleted: boolean;
  seq: number;
}
export interface Property {
  id: string;
  valueType: ValueType;
  source?: 'stored' | 'computed';
  formula?: unknown; // opaque on the client — the server owns computation
}
export interface CollectionDoc {
  id: string;
  properties: Property[];
}

// The subset of RowOp the client submits (mirror of @core/events, kept local so
// the client doesn't depend on that package).
export type RowOp =
  | { op: 'insert'; coll: string; row: string; values: Record<string, Value> }
  | { op: 'setField'; coll: string; row: string; field: string; value: Value }
  | { op: 'delete'; coll: string; row: string };

// --- views are data ----------------------------------------------------------
export interface EnumOption {
  id: string;
  label: string;
}
export interface ViewConfig {
  labels?: Record<string, string>; // field id -> column header
  enums?: Record<string, EnumOption[]>; // field id -> options (label + order)
  groupField?: string; // board: the enum field to group columns by
  columns?: string[]; // board: option-id column order
}
export interface ViewDoc {
  id: string;
  collection: string;
  title: string;
  renderer: 'table' | 'board';
  query: ViewSpec;
  visibleProps: string[];
  config?: ViewConfig;
}

// --- the store + renderer contracts ------------------------------------------
export type ConnStatus = 'connecting' | 'open' | 'closed';
export interface Store {
  readonly rows: ReadonlySignal<RowStateWire[]>; // live, deleted removed, server order
  readonly status: ReadonlySignal<ConnStatus>;
  propOf(id: string): Property | undefined;
  setField(row: string, field: string, value: Value): void;
  close(): void;
}
export interface RenderCtx {
  store: Store;
  view: ViewDoc;
}
export type Renderer = (mount: HTMLElement, ctx: RenderCtx) => () => void;
