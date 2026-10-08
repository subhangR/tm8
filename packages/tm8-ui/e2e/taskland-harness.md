Synthetic construction verification uses the production `buildMapModel`, `MapScene`, imported assets and integrated worker scene. No server or Space data is read.

From `packages/tm8-ui`, run `bun x vite --config e2e/taskland.vite.config.ts`, then `node e2e/taskland-check.mjs`. The checker defaults to port 4637; `TASKLAND_ORIGIN` and `TASKLAND_EVIDENCE` override the origin and output directory.

Every screenshot waits for asset loading to end, nonzero rendered frame metrics and a visible world label with its projected transform. The fixture exercises story and space scopes, acceptance progress, review/blocked status, surveyor removal after an estimate, independent child shipping and produced output, a shipped root marker with an open child, cancellation and exact 24-hour expiry. Browser errors and imported-asset HTTP failures fail the run.

Evidence records the actual WebGL renderer. SwiftShader evidence is synthetic software rendering and does not establish native GPU performance, real Space ingestion, or event delivery. Walking and exact local resume remain covered by `game-phase1-check.mjs` and the walking boundary tests. The visual helper owns no navigation or saved camera state.
