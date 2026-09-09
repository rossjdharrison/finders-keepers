// @app/core-runtime — the sealed, extern-controlled core, the shared workspace engine,
// and the browser host that replaces the server tier.
export { createCore } from './core.ts';
export { buildPrepared, createEngine } from './engine.ts';
export type { Store, Built, Engine } from './engine.ts';
export { createMemoryStore } from './memory-store.ts';
export { createBrowserHost, createBrowserHostOver } from './browser-host.ts';
export type { Broadcaster, BrowserHost, Persistence } from './browser-host.ts';
export { mockExterns } from './mock-externs.ts';
export type { Cassette, Collection, Core, Externs, Prop, RowOp, RowState, Snapshot } from './types.ts';
