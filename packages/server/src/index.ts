// @tm8/server — graph engine, HTTP/WS facade, event mapper, identity block,
// derived-truth assembly, sidecar lifecycle, scheduler. Runs under NODE, never bun.
// Serves the built web UI (AM-1: no desktop shell).
//
// State: the HTTP/WS FRAME is real (catalog-driven router, DEV-6 envelope,
// DEV-8 error taxonomy, honest-501 handler registry, WS scaffold, static
// seam). Semantics are not — the handler registry is empty, so every
// operation answers 501 not_implemented. W2 fills it in.

import { pathToFileURL } from 'node:url';
import { loadLocalEnv } from './local-env.js';
import { main } from './main.js';

export const SERVER_PORT = 4610;
export const SIDECAR_PG_PORT = 5442;

export { loadLocalEnv, LOCAL_ENV_FILE } from './local-env.js';
export * from './http/index.js';
export * from './facade/index.js';
export * from './events/index.js';
export { bootstrap, main, type BootstrapOptions, type BootstrappedServer } from './main.js';

// Start only when executed directly (`node dist/index.js`), never on import —
// tests and the future in-process compositions import this module.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  // Before main, because main reads the environment while it composes. Only
  // fills what the unit file left unset — see local-env.ts for why that is the
  // precedence and not the other way round.
  const added = loadLocalEnv({ logger: console });
  if (added.length > 0) console.info('server: loaded from .env.local', { names: added });
  void main();
}
