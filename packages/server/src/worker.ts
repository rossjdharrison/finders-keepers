// The Worker entry: route the whole workspace surface to a single WorkspaceDO
// (one DO per workspace holds all its collections + relations + SQLite + WS fanout).

import { WorkspaceDO } from './workspace-do.ts';

export { WorkspaceDO };

export interface Env {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_AUTH?: string | Record<string, unknown>; // auth anchor; the DO reads it (see workspace-do.ts)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (!/^\/(collections\/[^/]+|workspace)\b/.test(pathname)) {
      return new Response('usage: /workspace, /collections/:coll/{collection,ops,query}, /collections/:coll/ws', { status: 404 });
    }
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName('demo')); // one workspace for the demo
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;
