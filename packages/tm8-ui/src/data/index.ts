/**
 * tm8-ui data layer entry point (LLD §3).
 *
 * The seam interface itself lives in ./seam.ts (co-owned, dual-consensus
 * locked — LLD C-2). This module exposes the implementations.
 */
export type * from './seam';
export { createFixtureSeam, FIXTURE_NODE_BOOT_ID } from './fixtures/seam-fixture';
// createRealSeam (HTTP + WS against the tm8 node) lands in Phase 1 integration (post-baseline).
