# TM8 Mobile (`@tm8/mobile`)

The TM8 phone app: React Native on Expo, TypeScript strict, in the tm8 bun workspace beside `apps/desktop`. The spec is the TM8 Mobile design artifact (`01a183d0-3d7a-7046-819b-b6ace2810a35`), section 08 (s-lld §1–§20); the bar is the DoD (`01a183f2-4714-7b4a-9d8f-305c86f1bd9e`). Deviations from s-lld are rows in the doc "TM8 Mobile — LLD deltas" (`01a183f9-b939-7ee4-bae8-ce8d36da9224`).

This folder was scaffolded by task `01a18673-5c67-7410-b346-9323194314d8` (P0). It holds the toolchain and one placeholder route; the shell, the registry, theme tokens and every screen arrive with later lanes.

## Versions (read from npm on 2026-10-29 at 11:43 UTC)

`npm view expo dist-tags` gave `latest: 58.0.21` (published 2026-10-28 15:36 UTC). That is Expo SDK 58, the SDK the current Expo Go runs.

| | Version | Why |
|---|---|---|
| Expo SDK | **58** (`expo` 58.0.21) | the latest SDK at scaffold time (s-lld §1; LLD deltas X-000) |
| react-native | **0.88.1** | `bundledNativeModules.json` of `expo@58.0.21`; New Architecture only |
| react / react-dom | **19.3.0** exact | the version react-native 0.88.1's prebuilt renderer was built for (see "The React split") |
| expo-router | **58.0.28** | `bundledNativeModules.json` (`~58.0.28`); expo-router now versions with the SDK |
| TypeScript | **5.9.3** | the repo's compiler, not the template's 6.0.3 (see "TypeScript") |
| bun | **1.3.14** | every install, typecheck, test and export claim was proven under it, isolated linker (`bun.lock` `configVersion: 1`) |
| node | 22.23.2 | the build node's |
| Expo CLI / Metro / Hermes | `@expo/cli` 58.1.17, `metro` 0.87.1, Hermes bytecode | from the SDK |

Every library s-lld §1 names is installed up front, so no later lane touches `bun.lock`. Expo's `bundledNativeModules.json` pins the version where it has an entry; where it has none, the version is npm `latest` within the major s-lld names, and the reason is a row in the LLD deltas doc.

| Package | Spec | Installed | Expo pins | Note |
|---|---|---|---|---|
| expo-router | `~58.0.28` | 58.0.28 | `~58.0.28` | typed routes (`experiments.typedRoutes`) |
| expo-constants, expo-linking | `~58.0.14`, `~58.0.15` | 58.0.14, 58.0.15 | yes | expo-router's required peers |
| react-native-screens | `~4.30.0` | 4.30.1 | `~4.30.0` | native stacks under expo-router |
| @expo/metro-runtime | `~58.0.15` | 58.0.15 | yes | expo-router on web |
| @tanstack/react-query | `^5.105.0` | 5.105.0 | — | v5 |
| zustand | `^5.0.14` | 5.0.14 | — | v5 (vanilla stores); the version the workspace already locks for tm8-ui, so tm8-ui's resolution does not move |
| expo-secure-store | `~58.0.2` | 58.0.2 | yes | tokens only (L-H) |
| expo-sqlite | `~58.0.14` | 58.0.14 | yes | cache, outbox, kv-store |
| @shopify/flash-list | `2.3.2` | 2.3.2 | yes | v2 |
| react-native-reanimated, react-native-worklets | `4.7.1`, `0.13.0` | 4.7.1, 0.13.0 | yes | |
| react-native-gesture-handler | `~3.3.0` | 3.3.0 | yes | **v3**: s-lld §1 said 2; SDK 58 ships 3 |
| @gorhom/bottom-sheet | `^5.2.14` | 5.2.14 | — | v5; its peer range admits RNGH 3, runtime proof is t-p1-ui-kit's |
| react-native-webview | `14.0.1` | 14.0.1 | yes | the terminal page |
| react-native-svg | `15.16.0` | 15.16.0 | yes | icon art |
| react-native-safe-area-context | `~5.10.1` | 5.10.1 | yes | |
| expo-notifications | `~58.1.7` | 58.1.7 | yes | remote push needs a development build on Android (not Expo Go) |
| expo-haptics, expo-localization, expo-updates | `~58.0.7`, `~58.0.5`, `~58.0.19` | 58.0.7, 58.0.5, 58.0.19 | yes | |
| @react-native-community/netinfo | `12.0.1` | 12.0.1 | yes | |
| react-freeze | `^1.0.4` | 1.0.4 | — | frozen hidden screens |
| zod | `^3.23.0` | 3.25.76 | — | **v3**, @tm8/contract's major: `expo install zod` offered 4.6.7, which would mix v3 and v4 schema objects |
| ulid | `^3.0.2` | 3.0.2 | — | `clientMutationId` |
| expo-crypto | `~58.0.7` | 58.0.7 | yes | ulid 3 finds no `crypto.getRandomValues` on Hermes and throws `PRNGDetectFailure`; expo-crypto supplies the random bytes |
| expo-clipboard | `~58.0.4` | 58.0.4 | yes | s-lld §1 keeps the terminal's clipboard native |
| expo-system-ui | `~58.0.7` | 58.0.7 | yes | `userInterfaceStyle: automatic` on Android |
| expo-status-bar | `~58.0.4` | 58.0.4 | yes | template |
| react-native-web, react-dom | `~0.21.4`, `catalog:mobile` | 0.21.4, 19.3.0 | yes | the RN-web QA harness only |
| @tm8/contract, @tm8/prompt | `workspace:*` | — | — | imported from their built `dist/` |

Dev: jest-expo `~58.0.13`, jest 30.5.2, @testing-library/react-native 14.1.0 (`render` is async: `await render(<X />)`), @types/jest 30, @types/node 22, @babel/runtime `^7.20.0` (Expo does not pin it, and npm `latest` is Babel 8), ESLint 9.39.5 with @eslint/js and typescript-eslint 8.72.1, expo-doctor 1.21.5 (pinned so the `doctor` gate is reproducible), playwright-core 1.58.2 (tm8-ui's Playwright, whose cached Chromium headless shell the QA harness drives), @xterm/xterm 6.0.0 and @xterm/addon-fit 0.11.0 (tm8-ui's versions; build inputs of the terminal WebView page).

Not installed on purpose: `expo-dev-client` (it switches `expo start` to development-build mode, and v1 opens in Expo Go until the release lane adds EAS builds, owner ruling Q3), and Maestro (a CLI on the owner's machine, not an npm package).

## Scripts

Run from `apps/mobile`. Every script first runs `build:shared` (`tsc -b packages/contract packages/prompt`; `packages/client-core` joins once it is on the integration branch), because those packages export only their built `dist/`, and Metro, jest and tsc all read it.

| Script | Does |
|---|---|
| `typecheck` | builds the shared packages, writes typed routes (`node scripts/typegen.cjs`), then `tsc -p . --noEmit` (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax) |
| `lint` | `eslint --max-warnings=0 .` (see "Lint") |
| `test` | jest with the jest-expo preset and RN Testing Library; pass `-- --maxWorkers=2` on the build node |
| `export:ios` · `export:android` · `export:web` | `expo export -p <platform> --output-dir dist-<platform>` with `NODE_OPTIONS=--max-old-space-size=3072`, one platform per call; add `--source-maps` to audit a bundle |
| `doctor` | expo-doctor and both forms of `expo install --check`, gated as DoD G5 reads them (see "Expo health") |
| `start` | `expo start`: Metro for Expo Go, a simulator or the web |
| `build:shared` | the pre-step above |

On the shared build node, wrap jest, Metro and every export in `flock /home/tm8/prod-data/mobile-heavy.lock …`, and keep caches and `TMPDIR` on `/home/tm8/prod-data` (`/` is nearly full).

## The React split

React 19 needs exact versions on both sides of the repo. react-native ships its renderer prebuilt, and each build records the React it was built against (`reconcilerVersion: "19.3.0"` in `Libraries/Renderer/implementations/ReactFabric-*.js`); react-dom only works with its own version. tm8-ui runs React 19.2.8 with react-dom 19.2.8. A single hoisted React breaks one of the two apps at runtime while tsc and jest stay green, which is how the trap hides.

The configuration (scaffold probe findings `01a1840d-bc79-7d26-9b27-5376e2bc7e69`, §B attempt 4):

- The root `package.json` has **no** `overrides` for react or react-dom (an override applies to every dependency spec in the workspace, so it can only force one React).
- Root `workspaces.catalogs`: `web` = react and react-dom 19.2.8, `mobile` = react and react-dom 19.3.0.
- `packages/tm8-ui` takes `catalog:web`; this app takes `catalog:mobile`.
- The root's own `devDependencies` hold react and react-dom at `catalog:web`. They keep the workspace root on tm8-ui's React when a hoisted layout (bun 1.2.x) would otherwise lift the app's React there and split tm8-ui into two Reacts.
- The types are split the same way: `@types/react` is `19.2.17` in `web` and `~19.3.0` in `mobile`, and each side takes its catalog. Bun dedupes a shared `@types/*` package across the split. Without the pin, tm8-ui's `^19.0.0` was lifted to the app's 19.3.0 types while its runtime stayed 19.2.8, so tm8-ui could have compiled against a React 19.3 API that does not exist at runtime.

What this lane changed in the existing workspaces is measured, not assumed: for every workspace on the base commit, each declared dependency resolves in `bun.lock` to the same version as before (the lockfile comparison is in the scaffold's hand-off on task `01a18673-5c67`).

The proof is `test/react-split.test.ts`. It asserts that the app's react, react-native's own react, the react-dom of the web harness and the react behind RN Testing Library's renderer all equal the renderer's built-for version. It also asserts that tm8-ui's react equals its react-dom and is the copy its react-dom and @testing-library/react load. It resolves with Node's own algorithm in a child process (`test/node-resolve.cjs`), because inside Jest even `createRequire` goes through `jest.config.js`'s `react` mapper and would always see the app's copy.

Never change these versions or move the React lines in any `package.json` outside a task that owns the split. When the app throws "Incompatible React versions" or an obscure renderer error at launch while the tests pass, this is the first thing to check.

## Metro

`metro.config.js` is Expo 58's `getDefaultConfig(__dirname)`. It detects the bun workspace, and with `experiments.autolinkingModuleResolution: true` in `app.json` it bundles exactly one react, react-dom, react-native, react-native-web and one copy of each native module (the app's) whichever linker laid out `node_modules`. Never set `resolver.disableHierarchicalLookup`: bun's isolated linker keeps transitive dependencies under `node_modules/.bun`, and only hierarchical lookup reaches them.

## TypeScript

The app uses the repo's TypeScript **5.9.3**, not the template's 6.0.3. Expo 58's `expo/tsconfig.base.json` needs nothing newer than TypeScript 5.5 (`module: "preserve"`, `${configDir}`), and the scripts' pre-step compiles `@tm8/contract` and `@tm8/prompt` with the same compiler the rest of the repo uses. Expo's versions API recommends `typescript ~6.0.3` for SDK 58, so the online `expo install --check` fails on that line alone; `package.json` lists typescript in `expo.install.exclude`, Expo's documented switch for a version chosen on purpose (LLD deltas). Move to 6 with the rest of the repo.

`tsconfig.json` extends `expo/tsconfig.base` and adds strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `types: ["jest", "node"]`. Expo's base includes the DOM lib, so the DOM is kept out of app code by ESLint rather than by types.

Typed routes: `expo start` writes `.expo/types/router.d.ts` and `expo-env.d.ts`, `expo export` does not, and Expo CLI 58 has no typegen command. `scripts/typegen.cjs` does what `expo start` does, and `typecheck` runs it first, so a bad `href` is a compile error on a clean checkout too. It calls a module internal to Expo; `scripts/typegen.test.ts` pins its path. Both outputs are gitignored.

## Lint

ESLint 9, flat config in `eslint.config.mjs`, scoped to this app (DoD D3):

- **L-A, no kind literals.** In `app/`, `src/` and `terminal-web/`, a string equal to one of the 33 core kinds (read from `@tm8/contract/kind-info`, so a new kind is banned the day it exists) is an error, and so is `kind === <any literal>`, `c:*` custom kinds included. `src/registry/**` and test fixtures (`__fixtures__/`, `fixtures/`, `*.fixture.ts`) may name kinds.
- **L-C, no raw colours** in any linted file except `src/theme/tokens.gen.ts`: a string that is a whole `#rgb`/`#rgba`, contains a `#rrggbb`/`#rrggbbaa`, or an `rgb()`/`hsl()` call. Shorter hex inside text ("PR #1383") stays legal. A deliberate literal, such as a generator's documented override, takes a one-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`; unused disables are errors.
- **D3, no DOM** in `app/` and `src/`: `window`, `document`, `localStorage` and `sessionStorage` are restricted globals; `react-dom` imports are restricted (it exists for the web harness only), and so are tm8-ui paths and `src`/`dist` deep paths into workspace packages. `terminal-web/` is the WebView page, a browser by design, and may use the DOM.
- **s-lld §13, the contract barrel.** `import … from '@tm8/contract'` is an error; import by subpath.
- Baseline: `@eslint/js` recommended and typescript-eslint recommended (no `any` without a reasoned disable).

`test/no-kind-literals.test.ts` is the jest port of tm8-ui's `src/files/no-kind-literals.test.ts`: a source scan of the app for kind literals, `kind ===` comparisons and raw hex, plus in-memory ESLint runs (`test/lint-cases.mjs`) proving each rule above fires where it should and stays quiet where it should not.

## Shared code

`@tm8/contract` and `@tm8/prompt` are `workspace:*` dependencies, and bun's isolated linker links a workspace package only into packages that declare it. Import `@tm8/contract` by subpath: its `package.json` maps `./*` to `./dist/*.js` with `./dist/*.d.ts` types, beside `.` and `./workspace`, so `@tm8/contract/kind-info` resolves in Metro, Hermes, jest and tsc without a `paths` entry. The barrel would bundle 66 modules into a 797 KB chunk (s-lld §13). `@tm8/client-core` (task t-p0-client-core) joins the same way: `workspace:*`, built `dist/`, subpath imports.

## Expo health

expo-doctor cannot pass in this workspace. On this tree it runs 20 checks and fails exactly one, "Check that no duplicate dependencies are installed". Under bun's isolated linker that check lists packages present once per peer set, every copy at the same version (`expo` 58.0.21, `react-native` 0.88.1, `expo-modules-core` 58.0.28 and ten more), and the bundles still carry one copy each. Under bun's hoisted linker it lists the intended react/react-dom split instead (probe §D). The check takes no exclusions.

`bun run doctor` (`scripts/doctor.cjs`) runs expo-doctor and both forms of `expo install --check`, prints all three, and passes only what DoD G5 allows. The duplicate check passes while every package it names has a single version, or is react/react-dom at exactly the two catalog versions. The SDK-versions check passes only while the offline check agrees, because Expo's versions API lags a fresh release. `EXPO_OFFLINE=1 expo install --check`, which compares against the SDK's own `bundledNativeModules.json`, must exit 0. The online form is reported and, with typescript excluded, exits 0 today.

## Opening the app (Expo Go)

1. At the repo root, with bun 1.3.x: `bun install`.
2. `cd apps/mobile && bun run start`. This builds the shared packages and starts Metro with a QR code.
3. Install **Expo Go** from the App Store or Google Play; the store build runs the latest SDK, 58.
4. Scan the QR code (iOS: the Camera app; Android: Expo Go's scanner) with the phone on the same network as the computer, or run `bun run start --tunnel` when it is not.

Everything in this scaffold runs in Expo Go: every library above is in Expo Go's bundled native modules. Remote push on Android needs a development build (an EAS build, which waits for the accounts of owner ruling Q3).

## Layout

- `app/`: expo-router routes (s-lld §3). Not `src/app/`, whatever Expo's template guidance says.
- `src/`: the spine, state, net, theme and UI kit (s-lld §2), built by later lanes; `src/registry/` is the only folder that may name a kind.
- `scripts/`: node tooling (`typegen.cjs`, `doctor.cjs`; the dev-node harness adds more), each with its test.
- `test/`: workspace-level invariants: the React split and the lint proofs.
- `app.json`: name TM8, scheme `tm8`, bundle id and package `sh.tm8.mobile` (Q3), `userInterfaceStyle: automatic` (light and dark from day one), `supportsTablet: false` (v1 designs phones), `runtimeVersion` by fingerprint (s-lld §1), typed routes and autolinking module resolution.

The template's MIT `LICENSE` is gone (the repo is AGPL-3.0-only), as are its `App.tsx`/`index.ts` entry (expo-router's `expo-router/entry` replaces it) and `.claude/settings.json`, which would change Claude Code's settings for any session started in this folder. `AGENTS.md` is rewritten for this repo.

## CI

`tools/ci/affected.sh` maps `apps/mobile` to no module (`[apps/mobile]=`, as `apps/desktop`), and nothing under `.github/workflows` runs this app: owner rulings Q11 and Q12 (2026-10-29) keep every check local. t-p0-ci-wiring adds `tools/ci/mobile-check.sh`, the one command for the mobile and client-core suites.
