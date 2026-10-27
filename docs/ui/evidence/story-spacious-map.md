# Spacious story maps and routed graph roads

Open this evidence when reviewing PR #1039 or changing world spacing, road geometry, camera framing or navigation. It records the final implementation, matched fixtures, reproducible checks and software-renderer limits.

Task: `01a108cd-a4c4-73e6-a8f6-7097fbefe291`. Baseline: `f8cec6f34ede7219373f1c1c833c0a145cf29e5f`. Implementation commits: `7db6c291a612ff280b34f4368e27492cc6c3c7b4` and `f825d3caed59123f357987ce4a90f9ea314abb13`. PR: <https://github.com/subhangR/tm8/pull/1039>.

## Behavior

Each occupied landmark footprint has at least six world units of clear land before the next footprint. Root territories grow outward; newer siblings claim nearer land first. Island radius follows both occupied bounds and entity count, including the inset of the irregular coast. Status, progress, runtime activity and feed changes leave layout and routes unchanged.

The generic `WorldSource` supplies graph relationships. The story adapter includes real root membership and child-story containment; placement-only anchor hints create no roads. Distinct relationship types remain present even between the same pair. Roads route around every footprint and connect at entrance aprons. Dependency edges retain timber decks and status-colored rails. Automatic travel follows those same road points, with clear ground routes for disconnected places and a distance-based speed budget of about eight seconds. WASD, entity opening, session duels and per-story saves remain intact.

Map overview is available by button, touch and M. Its framing follows world size and prioritizes root labels without overlapping them. Field notes retain all root names and navigation. Reveal range is 12 units; the walking camera shows more surrounding land. Reduced-motion camera changes are immediate. Runtime palette colors supply both themes, including bright illumination and dark ground shadows in dark mode.

Procedural scatter has at most 900 candidates, inset road decoration at most 1,800 candidates and roadside lanterns at most 120. Architecture and road details use eight instanced geometry batches, including two inexpensive flat road shapes. Coast rocks, clouds and ambient particles retain fixed budgets. Three.js remains lazy.

## Matched visual evidence

Gallery artifact: `01a108ed-2f4c-75de-a196-e9616f92c2d5`, revision 1, manifest `e36c77bf6a681667e7c9e1d879791eba325b69f109bcc3993fc9bfd84e56630c`. It includes WebP previews of matched PNG screenshots, bridge close-up, session duel, and light/dark desktop/mobile reduced-motion views. Original PNGs and JSON reports are retained under:

`/home/tm8/prod-data/scratch/01a108ce-2b12-7ede-9cac-8c9910e6a747/evidence/`

Final task attachments: overview `01a108ec-6ccf-7efa-a2c8-15f1025709ff`; bridge `01a108ec-70e4-7a7a-81b3-ddd28f04fb4f`.

| Places | Minimum center distance, before → after | Island radius, before → after | Final layout build in browser |
| --- | --- | --- | --- |
| 12 | 2.100 → 9.145 | 17.60 → 54.34 | 11.9 ms |
| 50 | 2.100 → 9.029 | 21.46 → 69.93 | 59.7 ms |
| 125 | 2.100 → 9.009 | 23.55 → 94.56 | 505.0 ms |

The baseline overview uses an audit-only camera adjustment because the old UI has no full-map control. New overview captures use the actual Map overview button. Ground captures use the same saved hub position and each version's normal walking camera. The fixture graphs are identical across versions. Creation dates on added nodes are fixed; original fixture dates are relative to module load but retain the same ordering.

## Verification — 2026-10-04

- `bun run test -- src/story src/hex-ban.test.ts src/panels/no-branching.test.ts src/panels/css-comments-do-not-eat-rules.test.ts`: 223 tests in 17 suites passed. Includes 12/50/125 spacing, count scaling, complete routed-segment clearance, deterministic layout/status stability, cycles, missing anchors, parallel dependencies, disconnected graphs and bounded scatter at 1,000 entities.
- `bun run typecheck:ui`: passed. `bun run build` in `packages/tm8-ui`: passed, separate lazy scene chunk retained. Existing chunk-size advisory remains.
- `check-story-views.mjs`: Graph/Tree/Game, desktop/mobile, light/dark, keyboard focus, exact open port, persisted modes/saves and lazy scene loading; zero errors.
- `check-story-tree.mjs`: 1440/1200/900/600/390px, both themes, draft retention, exact create/launch behavior and 1,224-entity paging/search; zero errors.
- `story-game-audit.mjs`: 50 places, movement persistence, reduced-motion palette, mobile overflow, context-loss fallback and exact entity opening. After unmount: zero retained geometries and textures. Zero errors.
- `story-spacious-navigation.mjs`: M and pointer overview, task travel and real session duel, E opens exact session, restored focus, bridge close-up, light/dark desktop/mobile reduced motion, context-loss fallback. Zero errors. Measured nearby trip including browser click handling: 8,607 ms on this software-rendered shared host.

All performance measurements below are **SwiftShader software rendering**, on a shared machine with variable concurrent load. They establish neither hardware/integrated-GPU 60 fps nor a controlled before/after speed comparison. Larger layouts still cost more to prepare: the 125-place initial layout took 505 ms in this browser run.

| Places | Before FPS | After FPS | After max draw calls | After max triangles | Drawing buffer |
| --- | --- | --- | --- | --- | --- |
| 12 | 4.32 | 6.41 | 59 | 30,836 | 1007×671 |
| 50 | 3.06 | 2.14 | 77 | 103,224 | 1007×671 |
| 125 | 3.21 | 1.27 | 77 | 206,904 | 1007×671 |

The separate existing 50-place game audit measured 3.78 fps, median 218.6 ms, p95 498 ms, max 50 draw calls and 93,032 triangles at 896×559. Its dataset and camera differ from the matched overview fixtures.

## Reproduction and publication boundary

Run Vite from `packages/tm8-ui`: `bun run dev --host 127.0.0.1 --port 4651 --strictPort`. Build workspace dependencies first in a fresh clone (`bun install --frozen-lockfile`, then root `bun run build`). Warm the lazy Game scene once before capture so Vite dependency optimization does not reload the page during the audit.

```sh
export LD_LIBRARY_PATH=/home/tm8/.local/chromium-libs/usr/lib/x86_64-linux-gnu
export SPACIOUS_BROWSER=/home/tm8/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
export SPACIOUS_URL='http://127.0.0.1:4651/story-dev.html?full=1'
export SPACIOUS_DIR=/tmp/story-spacious-evidence
SPACIOUS_PHASE=after node e2e/story-spacious-audit.mjs
node e2e/story-spacious-navigation.mjs
```

For the baseline, use a separate `f8cec6f3` checkout, copy the same `story-spacious-fixture.ts` and `story-spacious-audit.mjs` into its e2e directory, and run with `SPACIOUS_PHASE=before`. Separate Vite servers must have separate dependency caches. Other audits accept their existing `STORY_VIEWS_*`, `STORY_TREE_*` and `STORY_GAME_*` variables documented at their tops.

At the owner's request, the final UI-only build was repeated before merge: exit 0 in 37.28 seconds, source `f825d3caed59123f357987ce4a90f9ea314abb13`, `dist/index.html` SHA256 `1824b1a9b20ea7f9dcedf1395057519bed3ba7e1d35dee566b6ad62781f8154b`. The parent session `01a1087f-d376-79f9-8719-e6f5921df73b` owns static UI publication and server-unchanged verification. This worker neither modified nor restarted the production server. The subsequent evidence commit changes only docs and browser audit scripts; the built UI stays unchanged for publication.
