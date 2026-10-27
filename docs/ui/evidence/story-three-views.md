# Graph, Tree and Game integration

The story page exposes **Graph · Tree · Game** in one persistent tab strip. Graph retains the existing graph and page sections; Tree restores the reviewed hierarchy workspace; Game retains the final diorama and duel implementation. The persisted `story` mode still selects Graph, and Tree selection never changes saved game progress.

## Sources

- Integration task: `01a108a0-53c0-7b6e-a9aa-d4eadc047a34`.
- Recovered Tree task: `01a0fe7a-f07a-72c9-bb6a-d9b0c0f93e02`.
- Previous Tree publication task: `01a10570-1e6b-7dee-9634-d9964c34ee62`, blocked on GitHub access after implementation was reviewed.
- Tree worker: `37f7df07f6b8877a9fe5d17b6c7c87fb10c61a31`; reviewed contrast follow-up: `dccfb84efd78fc5131f9e0571539f73c18d68eb3`.
- Final game commits: `e41d95c585fbf98f2a526a5afc12181fb8f8542e` and reduced-motion fix `b6a862dca4bea23d31b2f6a0034d3953f7459d26` (both ancestors of this integration).
- Screenshot artifact: `01a108af-3748-72fd-8806-d40e1d75de2c`, revision 1, manifest `e94c309b06540ae6c207cc65ed8a0880d51c583f111afe8b3eb0febb33a17aeb`.

## Behavior

The shared tab strip supports arrow keys and Home/End, retains focus when Game mounts, and labels the active tab panel. Tree reuses the reviewed paging, filters, drafts, document/task creation, launch subjects, connection chips, and bounded-read notices. Its folded breadcrumb and compact launch button keep the header usable in narrow panels. Every view opens entities through the existing page port. The three.js scene remains lazy; browser network assertions verify neither Graph nor Tree requests it.

Tree's original replacement page shell was adapted into a separate view so Graph retains its existing layout, route filters, action popovers and sections. No server API changed. The Tree browser header budget excludes the new view strip while retaining the prior compact-header limit.

## Verification — 2026-10-04

- Core build: `bun run build` from repository root — passed.
- UI typecheck: `bun run typecheck:ui` — passed.
- UI production build: `bun run build` from `packages/tm8-ui` — passed; game scene remains a separate lazy chunk. Existing chunk-size advisory remains.
- Focused tests: `bun run test -- src/story src/hex-ban.test.ts src/panels/no-branching.test.ts src/panels/css-comments-do-not-eat-rules.test.ts` — 214 tests in 15 suites passed.
- `e2e/check-story-views.mjs`: all three tabs at 1440px/390px in light/dark themes; keyboard focus, exact entity opening, persistence across reload, legacy mode compatibility, game-save preservation, lazy scene loading and zero horizontal overflow. Zero browser errors.
- `e2e/check-story-tree.mjs`: 1440/1200/900/600/390px in light/dark themes; inline draft survives kind/search/sort/live refresh, exact document creation and launch subjects, and 1,224-entity paging/search. Zero browser errors. Historical real-story snapshots were not recaptured in this integration run.
- `e2e/story-game-audit.mjs`: 50 places, movement persistence, reduced-motion palette, no mobile overflow, context-loss fallback, exact open port, and zero retained geometries/textures after unmount. Zero browser errors.

The final game audit used **SwiftShader software rendering**, measured 3.21 fps at adaptive 896×559, 52 maximum draw calls and 64,504 maximum triangles. Hardware/integrated-GPU 60 fps remains unverified and is not a passed acceptance claim.

## Reproduction and handoff

Checkout: `/home/tm8/prod-data/scratch/01a108a0-9627-73f7-b152-d4c87791c898/repo`, branch `feat/story-graph-tree-game`.

Use `bun run dev --host 127.0.0.1 --port 4641 --strictPort` in `packages/tm8-ui` for the fixture pages. Browser executable: `/home/tm8/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`. Set `LD_LIBRARY_PATH=/home/tm8/.local/chromium-libs/usr/lib/x86_64-linux-gnu`. Each browser script accepts its `STORY_VIEWS_*`, `STORY_TREE_*`, or `STORY_GAME_*` URL/browser/evidence environment variables documented at the script top. The game URL includes `/story-dev.html?full=1`; the Tree and views scripts take the origin.

Reports and screenshots: sibling `evidence/views/`, `evidence/tree/`, `evidence/game/`, and published `evidence/gallery/`. Logs are alongside `evidence/`. The Vite development scan also reports an unrelated pre-existing missing `ListViewSwitcher` export in `e2e/home-header-harness.tsx`; fixture tests and the production build complete successfully.

Release task `01a108aa-9c82-7f1f-9a34-7959d189c3b6` owns publication, current-main reconciliation, CI and merge. This integration does not deploy production.
