// The renderer registry — the heart of "views are data". A View doc names a
// renderer by id; the switcher looks it up here and mounts it. Adding a view type
// is one entry, exactly like the PoC editor-engine's widget registry lifted to
// whole collections.

import type { Renderer } from './types.ts';
import { tableRenderer } from './renderers/table.ts';
import { boardRenderer } from './renderers/board.ts';
import { selfPortraitRenderer } from './renderers/self-portrait.ts';
import { docsRenderer } from './renderers/docs.ts';

export const RENDERERS: Record<string, Renderer> = {
  table: tableRenderer,
  board: boardRenderer,
  'self-portrait': selfPortraitRenderer,
  docs: docsRenderer,
};
