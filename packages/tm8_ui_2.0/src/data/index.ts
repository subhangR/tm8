/**
 * tm8-ui data layer entry point (LLD §3).
 *
 * The seam interface itself lives in ./seam.ts (co-owned, dual-consensus
 * locked — LLD C-2). This module exposes the implementations.
 */
export type * from './seam';
export { createFixtureSeam, FIXTURE_NODE_BOOT_ID } from './fixtures/seam-fixture';
/* Phase 1 integration: the real seam crosses this boundary EXPORT-ONLY — the
   flag-gated selection lives in views/ (off by default), so nothing here can
   reach the network without an explicit opt-in at the call site.
   (Brokered edit: bridge lane closed by user; authored by FE under master
   endorsement [master->fe 45], scope exactly this export surface.) */
export { createRealSeam } from './real/seam-real';
export type { RealSeamOptions, RealSeam, RealControls } from './real/seam-real';
export { browserWebSocketFactory } from './real/socket';
