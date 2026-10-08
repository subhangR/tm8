# Living Atlas map studio

Six WebGL maps consume the same `MapModel`: hub, Taskland, Office, Library, Code Factory and Completed Town. `StoryGame` offers an explicit **Explore map atlas** switch; entity inspection and child-story entry use the existing application ports. Return to walking view restores the existing game component and saved position.

The standalone studio uses synthetic deterministic fixtures. The balanced scene covers all map roles; nested adds five task levels; dense has 120 tasks. Space/story filtering is explicit. A local JSON picker accepts normalized `{entities,edges,scope}`, a scoped graph projection, or `{id,kind:'story',page}`. Imported snapshots remain in browser memory and are never bundled or committed. The source scope and snapshot provenance are visible; model warnings report truncation and scope mismatch. This is a visual preview, not a live event engine or backend replacement.

## Run and build

From the repository root, install the frozen workspace dependencies and build their entry points first:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/contract build
bun run --cwd packages/prompt build
node packages/tm8-ui/node_modules/vite/bin/vite.js --config packages/tm8-ui/src/story/game/maps/studio.vite.config.ts
```

Open `http://127.0.0.1:4625/map-studio-dev.html`. Query parameters `?map=taskland&preset=nested` can select a starting scene.

```sh
node packages/tm8-ui/node_modules/vite/bin/vite.js build --config packages/tm8-ui/src/story/game/maps/studio.vite.config.ts
```

The untracked `packages/tm8-ui/dist-map-studio/` contains a standalone build. Serve it with a static HTTP server and open `map-studio-dev.html`. GLBs remain normal reusable files under `public/game/cc0`. For tm8 artifacts, the coordinator's packaging step injects `globalThis.__TM8_GAME_ASSETS__` data URLs before the entry module and removes binary files from the publication directory. The normal registry remains unchanged.

## Browser evidence

```sh
CHROMIUM_PATH=/path/to/chrome node packages/tm8-ui/src/story/game/maps/capture-studio.mjs /absolute/evidence-directory /optional/private-snapshot.json
```

Use `STUDIO_URL` to target a static build. On a machine with the matching Playwright browser installed, omit `CHROMIUM_PATH`. Minimal Linux environments may require `LD_LIBRARY_PATH` pointing to installed/extracted browser dependencies. The capture script uses no-sandbox, single-process, no-zygote and ANGLE SwiftShader for reproducible software WebGL in the worker environment.

Evidence includes all six maps, story-scope Taskland, a level-three parent with its descendant subtree, the imported asset gallery, 120-task dense view, a resized reduced-motion Office, and the optional actual story snapshot. JSON records browser version, page/console errors, request failures, draw calls, triangles, rolling median/p95 frame interval and provenance. Each capture waits for at least 15 measured frames. SwiftShader measurements reflect software rendering and are **not hardware GPU performance claims**. Software rendering disables dynamic shadow maps and uses contact discs; normal hardware rendering keeps dynamic shadows. The visible model remains identical.

## Art and semantics

`MapAsset` maps shared semantic keys to the downloaded asset registry. Construction uses authoritative model stages; blocked adds a status flag and never selects rubble. KayKit workers use the supported `WORKER_POSES` clips and honor reduced motion. Imported geometry retains normalized pivots and embedded materials/textures. Decorative campus landmarks give each map its identity.

Roles without matching imported art use the existing production procedural kit: document lecterns, drawing easels, artifact vitrines, file crates, PR tollgates, commit milestones, worktree branches and session plaques. The sidebar explicitly reports these procedural types. Missing imported files use the same reported fallback path. The imported gallery displays only actual manifest entries, with CC0 provenance in the ledger.

Camera orbit/pan/zoom, fit, subtree focus, hover, selection, entity details, lighting, hierarchy boundaries and footprint diagnostics are available. Construction/status overrides exist only in the synthetic studio and are labelled as visual previews. DOM labels project through the actual camera and cull collisions, avoiding separate React roots inside Three's renderer.

## Focused checks

```sh
node packages/tm8-ui/node_modules/vitest/vitest.mjs run --root packages/tm8-ui src/story/game/maps/MapStudio.test.tsx src/story/game/maps/StoryMapView.test.tsx src/story/game/StoryGame.test.tsx src/story/game/StoryGame.drill.test.tsx
```

The navigation checks cover original entity IDs, story scope, child-story routing and the existing walking-view interactions. Model and imported-asset suites are owned alongside their modules.

## Shared walking renderer

`WalkingMapView` accepts `model`, `start`, optional `camera`, `onPosition`, `onCamera`, `onInspect`, `onEnterPortal` and optional `onBack`. `MapCameraState` contains orthographic zoom, position and target tuples. Map selection and browser persistence belong to the host. The renderer has no route or store coupling; a map id change remounts its player, while save callbacks never reapply the initial pose.

Walking uses the retained player, controls and controlled minimap with the imported `MapScene` assets. Clicking a portal walks to it; Enter/E or its accessible Enter button performs travel. Inspection passes the original entity id. WebGL context loss exposes an accessible list with equivalent entity and portal actions. Back/Escape pop one map through the host callback; editable and dialog content retain their Escape handling.

Use the pure helpers in `map-model/walking-world.ts` for navigation validation: `walkingBounds(model)` includes the origin, entrance zone and four-unit margin; `walkingEntrance(model)` is clear of all occupied model geometry; `isWalkingPositionSafe(model, point)` checks finite coordinates, playable bounds and occupied footprints with player clearance. Compound bounds contain walkable streets, so they are not colliders. An invalid initial pose falls back to the entrance and discards its stale camera. Position and camera saves are throttled to once a second and flushed when the player unmounts.

The existing story scene now implements `MapRenderer<ReactNode, SceneProps>` and gets its unchanged geometry from `walkingMapModel`/`walkingWorld`. Its navigation metadata, discovery, encounters and child-story actions stay intact. Geometry equality and override tests cover that boundary.

For synthetic browser checks, run the Vite config `maps/walking.vite.config.ts`, then `node packages/tm8-ui/src/story/game/maps/capture-walking.mjs /absolute/evidence-dir`. `WALKING_URL` can target a built harness; optional `BASELINE_URL` captures an isolated main story scene for visual comparison. The harness contains synthetic fixtures only and is not included in the production app. Software WebGL screenshots verify rendering and behavior; they do not establish native GPU frame rates.
