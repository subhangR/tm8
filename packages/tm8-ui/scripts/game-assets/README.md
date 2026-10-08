# Imported game assets

The runtime uses 28 semantic asset IDs backed by 27 self-contained CC0 GLBs. The preferred crew is a blue-grey recoloured KayKit Knight with sword/shield/cape meshes removed; Quaternius RobotExpressive is a labelled fallback. Source packs never go in public or git. No Mixamo or Quaternius QAL files are included.

`../../src/story/game/imported-assets/index.ts` exports `LoadedGameAsset`, `getImportedAsset`, `IMPORTED_ASSETS`, `constructionAssetForStage`, `WORKER_POSES`, and `PROCEDURAL_ASSET_GAPS`. Models have centered X/Z pivots and minimum Y at ground. Default scale normalizes the larger X/Z dimension to 1; characters normalize height to 1. `scale` multiplies this. Bounds and offsets are measured from decoded THREE scenes, including skin bind matrices. Loader instances clone skeletons, reuse cached geometry/textures, dispose their own skeleton resources, and maintain separate animation mixers. Callers provide the existing procedural `fallback` for suspense/errors.

Use the model's authoritative construction stage. Progress-only helper thresholds are 0 lot, >0 foundation, .34 scaffolding, .67 walls, 1 topped out. Only explicit done state selects construction-done. Blocked is an overlay, and only cancelled uses rubble.

## Provenance and deliberate gaps

`../../public/game/cc0/LICENSES.json` records exact creator/source/download URLs, pinned source revisions, original paths, source/output hashes and sizes. `SOURCE-INPUTS.json` fingerprints all external BINs and textures too. `licences/` preserves the creators' licence statements. Runtime manifest also lists bounds, pivot/scale, clips and any role adaptation.

- KayKit Medieval Hexagon: actual downloaded official repository, commit `84fa4e91af6a88989be7c99e0891cede11f2ca38`.
- KayKit Adventurers: actual downloaded official repository, commit `672074b73ba276876a19e8816ecdc5241817ab47`.
- Kenney Fantasy Town 2.0: actual downloaded creator ZIP, selected cart, bench and rock.
- Quaternius RobotExpressive: actual downloaded three.js r180 GLB with its model-specific CC0 README.
- Mailbox and plaque retain procedural `task-mailbox` and `session-stele` shapes. They are explicitly exported gaps, not downloaded model claims.
- Desk reuses a wooden market bench. Office/Library/Code Factory/Shipping Yard reuse the fantasy tavern/church/blacksmith/market. These adaptations are marked in the manifest.
- KayKit worker retains Idle, Interact, PickUp, Use_Item, Walking_A, Cheer, Sit_Chair_Idle, Hit_A. It has no dedicated hammer or carry clip. `WORKER_POSES` uses Interact for work, Idle for waiting/blocked, Cheer for attention. `ROBOT_POSES` aliases this preferred map; `QUATERNIUS_ROBOT_POSES` is only for the fallback robot's 14 original clips. No combat clips play in the game.

## Repeatable conversion

Use an external scratch directory for source packs and conversion dependencies. The app dependency versions are unchanged. Tested tool versions: glTF Transform 4.5.1, meshoptimizer 1.3.0, sharp 0.35.5, three 0.180.0.

1. Clone the official repositories in the ledger as `raw/kaykit` and `raw/kaykit-characters`, and check out the pinned revisions.
2. Download/extract the Kenney ZIP as `raw/kenney`. Download RobotExpressive.glb and its README.md from `three.js/r180/examples/models/gltf/RobotExpressive/` into `raw/`.
3. Install the pinned tool packages in a separate `pipeline/` directory.
4. Set `ASSET_TOOL_ROOT` to the absolute pipeline path and `ASSET_SOURCE_ROOT` to the absolute raw path.
5. Run `node packages/tm8-ui/scripts/game-assets/import.mjs`, then `node packages/tm8-ui/scripts/game-assets/source-inputs.mjs`.

The importer embeds all textures/buffers, reduces palettes to 128x128 PNG, removes unused worker clips and their channels/samplers, deduplicates/welds/prunes, resamples animation keys and meshopt-compresses. It deliberately avoids flatten/join on skinned models. No external decoder CDN is needed: drei uses the installed meshopt decoder.

## Verification and gallery

- `ASSET_TOOL_ROOT=/absolute/pipeline node packages/tm8-ui/scripts/game-assets/verify.mjs` verifies every GLB hash, size, self-containment, decoded bounds, clip list, independently cloned skin hierarchy and actual transform motion in every retained clip. Its image bitmap stub does **not** verify pixels.
- `vitest run src/story/game/imported-assets/registry.test.ts` from tm8-ui checks stage thresholds, role mappings, supported poses, gaps and local URLs.
- `tsc -p packages/tm8-ui/scripts/game-assets/tsconfig.json` checks the isolated imported-assets code.
- `vite --config packages/tm8-ui/scripts/game-assets/gallery.vite.config.ts` serves the real AssetCatalog at `http://127.0.0.1:4627/asset-catalog-dev.html?sheet=imported`. Town, Construction, Landscape and Crew are actual R3F/GLTF renders. Procedural catalog sheets remain available.
- Build with the same config plus `build --outDir /absolute/disposable/gallery-build`.
- For a tm8 artifact host that rejects `.glb`, run `node packages/tm8-ui/scripts/game-assets/inline-artifact.mjs /absolute/disposable/gallery-build`. It embeds the **same** binaries in a bootstrap script and preserves licence evidence. Do not run on the source public directory. Runtime registry URLs otherwise respect Vite BASE_URL.

## Measured size (2026-10-08)

59 unique selected source files, including external BINs/textures: **5,954,892 bytes**. 27 normalized/compressed GLBs: **1,507,476 bytes** (74.7% reduction). Preferred KayKit worker: **352,064 bytes**; fallback Quaternius robot: **220,840 bytes**. The done alias reuses the task-building URL, so it does not duplicate a GLB. Assets load on demand; the entire catalog is not preloaded into each map.

The standalone gallery's initial production build is approximately 1,480.95 KB JS / 404.83 KB gzip, including React, THREE, loader, procedural kit and gallery. This is a whole dev-gallery bundle measurement, not incremental app overhead. Browser timings and screenshots are attached to the task/integration receipt; network timings on localhost/software rendering are not representative of a deployed mobile device.


Final browser pass: Chromium 153.0.8010.12, ANGLE SwiftShader, 1440x1000, localhost without network throttling. All four gallery sheets rendered; 27 unique GLB requests totalled 1,507,476 body bytes, with per-file transfers 6.3–35.0 ms. Navigation load event was 428.5 ms; this is not GPU first-frame time. Zero page/console errors and failed requests. Reviewed screenshots confirm textured buildings, terrain, stages and unarmed crew. The artifact-inline Crew pass also had zero errors/failures: 27 embedded models, 2,011,410-byte bootstrap, 113 ms bootstrap transfer and 624.6 ms navigation load event. Base64 overhead is confined to that disposable artifact export.

Reproduce browser evidence with `node packages/tm8-ui/scripts/game-assets/capture-gallery.mjs /absolute/evidence-dir URL`. This container required `CHROMIUM_PATH=/home/tm8/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` and `LD_LIBRARY_PATH=/home/tm8/.local/pw-min/lib`. The capture script uses no-zygote/single-process and software WebGL. `GALLERY_SHEETS=Crew` limits an inline-export smoke check. On a normal workstation, the default installed Playwright Chromium may be used.
