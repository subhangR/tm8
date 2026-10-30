# @tm8/client-core

What the web app (`packages/tm8-ui`) and the phone app (`apps/mobile`) must compute identically, moved out of tm8-ui so both run the same files. It holds no DOM and no React, so the same code runs under Vite and Hermes. The design is s-lld §2 of the TM8 Mobile design (artifact 01a183d0-3d7a-7046-819b-b6ace2810a35). The move is task t-p0-client-core (01a18673-656d-7610-b3c8-f11eef868d84).

## Subpaths

| Subpath | What it computes | Moved from (tm8-ui `src/`) |
|---|---|---|
| `/routes` | parse, build and normalize `#/s/<space>/…`; the `q=` codec; redirects; the memory router target | `routes/{codec,q,redirects,types}.ts`; `RouterTarget`, `MemoryTarget` and `createMemoryTarget` from `routes/transport.ts` |
| `/kinds` | `KIND_CORE`: each kind's label, plural, slug, route strategy, group and drawn mark, for the 34 core kinds and the `c:*` fallback; `kindBySlug`; the vocabulary the codec reads | new `kinds.ts`, built from `domain/registry.ts`'s columns and the contract's kind groups; `KIND_ART` from `domain/kind-art.ts`; `ALL_MODES`, `VIEW_REF_ROUTE` and the contract-derived types from `domain/` |
| `/chat` | frames → parts → projected turns → steps → ledger → receipt | `chat-home/{wire,turn-model,ledger,turn-receipt,turn-steps,turn-step-lines,write-classifier,payload-walk,explanation-tools,entity-refs}.ts`; the render types of `chat-home/types.ts` |
| `/project` | the per-family event reducers; the optimistic journal keyed by `clientMutationId` | `data/project/{reducers,journal}.ts` |
| `/project/test-support` | contract-typed row builders for reducer and journal tests | `data/project/test-support.ts` |
| `/keys` | Esc, Tab, arrow and Ctrl byte sequences; the width verdict | `terminal/mobileKeys.ts` |
| `/time` | relative and absolute time words | the pure half of `kit/time.ts` (the clocks stay in each app) |

The moves are verbatim. Every changed line is either an import line or a `SPLIT` note at the top of a file that was split. The tests moved with their modules and run here.

## Laws it carries

- **L-A, same words as the web.** `KIND_CORE` is where a kind's words live. Both registries spread `KIND_CORE[kind]` into their rows. tm8-ui's `domain/kind-core.test.ts` holds the web registry equal to it, and `src/kinds/kinds.test.ts` holds it total over the contract's core kinds and equal to the contract's groups.
- **L-F, verbatim transplant.** Never edit a moved module's logic here "while you are there": a behaviour change is its own task.
- **No DOM, no React.** `tsconfig.json` compiles against `lib: ["ES2022"]` with no DOM, so `window`, `document`, `history`, `localStorage` and the DOM types do not compile. `src/platform.d.ts` declares the five web-platform globals both runtimes provide (`btoa`, `atob`, `TextEncoder`, `TextDecoder`, `URL#host`). `eslint.config.js` names the DOM globals and bans `react`, `react-dom`, `react-native` and any import of tm8-ui.

## How each app reads it

`package.json` `exports` lists each subpath with a `tm8-source` condition first, then `types` and `default`, both pointing at `dist/`.

- **tm8-ui** sets the `tm8-source` condition: `customConditions` in its tsconfig, `resolve.conditions` and `ssr.resolve.conditions` in `vite.config.ts`. It reads the TypeScript source, so its build, dev server and suite, check.sh and the deploy scripts need no build of this package.
- **The phone app**, its tsc, jest, Metro and Node don't know that condition, so they get `dist/`, built by `tsc -b packages/client-core`. Run it after `tsc -b packages/contract packages/prompt` and before Metro, jest or tsc. Metro can't read the TypeScript sources directly (probe F 4).
- `dist/` keeps the source's extensionless relative imports, so it is for bundlers and jest (Metro, Vite, jest-expo, bun). Plain Node ESM can resolve the subpaths but can't load the files.

## Scripts

```bash
# From the repo root. The contract goes first: routes/codec.ts imports
# @tm8/contract/workspace, whose exports name dist/ only, so the suite needs it.
bun x tsc -b packages/contract packages/client-core
(cd packages/client-core && bun run test && bun run lint)
```

`tools/ci/affected.sh` maps this package to the `ui` module, so a change here selects tm8-ui's suite. Its own suite runs in `tools/ci/mobile-check.sh` (t-p0-ci-wiring). GitHub Actions doesn't run it (owner rulings Q11, Q12).
