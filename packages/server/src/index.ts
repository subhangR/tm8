// @tm8/server — graph engine, HTTP/WS facade, event mapper, identity block,
// derived-truth assembly, sidecar lifecycle, scheduler. Runs under NODE, never bun.
// Serves the built web UI (AM-1: no desktop shell).
//
// State: the HTTP/WS FRAME is real (catalog-driven router, DEV-6 envelope,
// DEV-8 error taxonomy, honest-501 handler registry, WS scaffold, static
// seam). Semantics are not — the handler registry is empty, so every
// operation answers 501 not_implemented. W2 fills it in.

import { pathToFileURL } from 'node:url';
import { main } from './main.js';

export const SERVER_PORT = 4610;
export const SIDECAR_PG_PORT = 5442;

export * from './http/index.js';
export * from './facade/index.js';
export * from './events/index.js';
export { bootstrap, main, type BootstrapOptions, type BootstrappedServer } from './main.js';

// Start only when executed directly (`node dist/index.js`), never on import —
// tests and the future in-process compositions import this module.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
