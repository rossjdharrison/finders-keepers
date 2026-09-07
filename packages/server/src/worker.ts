// The Worker entry: route /collections/:id/* to that collection's Durable Object,
// which is the single authority for the collection (log + SQLite + WS fanout).

import { CollectionDO } from './collection-do.ts';

export { CollectionDO };

export interface Env {
  COLLECTION: DurableObjectNamespace<CollectionDO>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/collections\/([^/]+)/);
    if (!m) return new Response('usage: /collections/:id/{collection,ops,query,ws}', { status: 404 });
    const stub = env.COLLECTION.get(env.COLLECTION.idFromName(m[1]));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;
