/// <reference types="vite/client" />

interface ImportMetaEnv {
  // The bearer token the client presents; the DO verifies it to an actor. Defaults to
  // the dev admin anchor. Set VITE_WORKSPACE_TOKEN to act as a different seeded actor.
  readonly VITE_WORKSPACE_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
