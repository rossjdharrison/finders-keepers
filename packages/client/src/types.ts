// Client-side mirrors + the view-engine contracts, against the WorkspaceDO wire
// contract in packages/server/src/workspace-do.ts.

import type { Value, ValueType } from '@core/values';
import type { ViewSpec } from '@core/query';
import type { ReadonlySignal } from '@preact/signals-core';

// --- wire --------------------------------------------------------------------
export interface RowStateWire {
  coll: string;
  id: string;
  doc: Record<string, Value>;
  deleted: boolean;
  seq: number;
}
export interface Property {
  id: string;
  valueType: ValueType;
  source?: 'stored' | 'computed';
  formula?: unknown;
  category?: string; // optional HQDM class for this field's values (must reduce)
}
export interface CollectionDoc {
  id: string;
  properties: Property[];
  semanticClass: string; // the HQDM class records are classified by (must reduce)
}
/** Domain classes declared by `specializes`, merged over the HQDM core lattice. */
export type TypeMap = Record<string, { specializes: string[] }>;
export interface RelationMeta {
  parentColl: string;
  childColl: string;
  childField: string;
}

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
  labels?: Record<string, string>;
  enums?: Record<string, EnumOption[]>;
  refs?: Record<string, { collection: string; labelField: string }>; // ref field -> parent collection + its label field
  groupField?: string;
  columns?: string[];
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

// --- stores ------------------------------------------------------------------
export type ConnStatus = 'connecting' | 'open' | 'closed';

/** One collection's live rows + editing. */
export interface CollectionStore {
  readonly id: string;
  readonly rows: ReadonlySignal<RowStateWire[]>;
  propOf(field: string): Property | undefined;
  labelOf(rowId: string, labelField: string): string; // for ref display
  setField(row: string, field: string, value: Value): void;
}

/** The whole workspace: all collections behind one socket. */
export interface WorkspaceStore {
  readonly status: ReadonlySignal<ConnStatus>;
  readonly collectionIds: string[];
  collection(id: string): CollectionStore | undefined;
  close(): void;
}

export interface RenderCtx {
  store: CollectionStore; // the active collection
  view: ViewDoc;
  workspace: WorkspaceStore; // for cross-collection ref pickers
}
export type Renderer = (mount: HTMLElement, ctx: RenderCtx) => () => void;
