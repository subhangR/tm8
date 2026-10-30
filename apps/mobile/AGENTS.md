This is TM8 Mobile (`@tm8/mobile`), an Expo / React Native app inside the tm8 bun workspace. Read `README.md` in this folder first: it names the pinned versions, the scripts, the React split and the rules below in full. The design is the spec: the TM8 Mobile design artifact, section 08 (s-lld §1–§20).

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo, EAS or React Native API, read the major version of `expo` in `package.json` and use the matching docs: `https://docs.expo.dev/versions/v<major>.0.0/`, or https://docs.expo.dev/llms.txt as an index. Never answer from memory.

## Commands (run from this folder)

```bash
bun run typecheck     # builds @tm8/contract + @tm8/prompt, generates typed routes, tsc strict
bun run lint          # ESLint 9: kind literals (L-A), raw colours (L-C), DOM globals, the contract barrel
bun run test -- --maxWorkers=2
bun run export:web    # also export:ios, export:android: one platform per call
bun run doctor        # expo-doctor and expo install --check, gated as DoD G5 reads them
```

On the shared build node, wrap jest, Metro and `expo export` in `flock /home/tm8/prod-data/mobile-heavy.lock`.

## Rules

- Routes live in `app/` (s-lld §3), not `src/app/`. Non-route code lives in `src/`.
- Never add or upgrade a dependency, and never edit `package.json` or `bun.lock`: only the scaffold and a "deps" task the TM8 Mobile Lead opens may. A deps task uses `npx expo install <package>` so the version matches the SDK.
- Never change the `react`, `react-dom` or `react-native` versions, and never set Metro's `resolver.disableHierarchicalLookup` (README, "The React split").
- Import `@tm8/contract` by subpath (`@tm8/contract/<module>`), never the barrel.
- No kind literal outside `src/registry/`; no raw colour outside `src/theme/tokens.gen.ts`; no `window`, `document` or `localStorage` in `app/` or `src/`.
- `ios/` and `android/` are generated (Continuous Native Generation) and never committed. Configure native behaviour in `app.json` and config plugins.
