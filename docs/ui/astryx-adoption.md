# Adopting Meta Astryx as tm8's design system

**Status:** Phase 1 implemented and verified on branch `feat/astryx-task-card` (base `origin/main` @ `ca8ae264`).
**Date:** 2026-08-28 · **Author:** Fable 5 1M Teammate (work session `01a04774-e5de-7182-ae58-c4d2272e13b6`)
**Ask (Tarkesh):** redesign the Task card with Meta's design system ([facebook/astryx](https://github.com/facebook/astryx)), check feasibility of adopting it across tm8, load it at the root, cover light AND dark, respect atoms/molecules structure and visual hierarchy, no overlay hacks.

**Update 2026-08-29 (branch `feat/kinetic-system`):** §9 added — type scale and motion checked against both loaded themes for value-identical bridging (one token, `--pn-fs-fine`, qualifies); G3 revised accordingly.

**Update 2026-08-29 (branch `feat/astryx-task-card-phase2`):** the Board v2 task-card shell now uses the official Astryx `Card` component (`variant="default"`, spacing-scale padding, low elevation) instead of a custom `article` surface. tm8 retains only drag/open/state behaviour and uses public Astryx color, shadow, and motion tokens for hover/focus states; reduced-motion and forced-colors treatments are explicit.

---

## 1 · Verdict

**Feasible, and phase 1 is done.** Astryx 0.5.0 (beta, MIT) installs cleanly, coexists with the whole existing UI by CSS-cascade construction, and its theming model composes *exactly* with tm8's scoped `data-theme` architecture. The two hard prerequisites were measured, not guessed:

| Prerequisite | Result |
|---|---|
| React 19 (`react`/`react-dom` >= 19.0.0 are hard peer deps) | tm8-ui migrated 18.3.1 → 19.2.8. Total code cost: **7 one-line `RefObject<T>` → `RefObject<T \| null>` widenings** in 6 files. Zero legacy API usage existed (no `ReactDOM.render`, `findDOMNode`, `defaultProps`, string refs, `react-dom/test-utils`). All tm8-ui deps already declare React 19 peer support. Vite build green; 4,562 of 4,573 vitest tests pass (§6). |
| Style-system collision (40,214 lines of existing CSS) | **None possible where both apply**: every byte of Astryx CSS lives in `@layer` (`reset` < `astryx-base` < `astryx-theme`); all existing tm8 CSS is un-layered, and un-layered rules beat layered ones regardless of specificity. Astryx styling reaches only (a) its own components' compiled classes and (b) tokens we explicitly bridge. |

## 2 · What Astryx actually is (measured from the shipped package, not the README)

- `@astryxdesign/core` 0.5.0: **125 subpath exports** — per-component ESM (`@astryxdesign/core/Badge`), pre-compiled StyleX. **No build plugin, no Babel/PostCSS config**; one global `dist/astryx.css` (155 KB) carries all component styles. No `.css` imports inside the JS (vitest-safe).
- Themes are separate packages (`theme-neutral`, `theme-gothic`, + butter/chocolate/matcha/stone/y2k), each a generated `theme.css` (~17–20 KB) that defines ~160 CSS custom properties **inside `@scope ([data-astryx-theme="<name>"]) to ([data-astryx-theme])`** — themes are *scoped by attribute*, nest, and stop at inner theme boundaries.
- **Dark mode is `light-dark()`** (99 token pairs) driven by the inheritable `color-scheme` property — not a class, not a media query. Whoever controls `color-scheme` controls dark.
- Components used so far verified **portal-free** (Badge, ProgressBar, Timestamp, Text, StatusDot): they render in place, inside our zoom and theme scope.

## 3 · Why it composes with tm8 (the load-bearing luck)

tm8's theming contract is already "custom properties on a `.cv2-root` scope, flipped by `data-theme` on that element" — the same shape as Astryx's. The composition is three small pieces (`src/styles/astryx-bridge.css`):

1. `@layer reset, astryx-base, astryx-theme;` pins Astryx's internal precedence, then the three Astryx sheets are `@import`ed.
2. `color-scheme: light` on `.cv2-root`, `dark` under `[data-theme='dark']` — **pins every `light-dark()` token to tm8's own theme state**; the OS preference cannot leak in (index.html doctrine preserved). Nested always-dark islands (terminal, `alwaysDark` panels) already stamp `data-theme="dark"` on themselves, so they flip locally for free.
3. A **token bridge**: `--pn-paper → --color-background-body`, `--pn-ink → --color-text-primary`, `--pn-brand → --color-accent`, `run/wait/block/info/idle → success/warning/error/blue/gray` (+ their `-soft → *-muted` pairs), radii/shadows/durations/font-families likewise. The whole existing UI reskins through the tokens it already consumes — 3,218 `.cv2-root`-scoped rules untouched.

Activation is one attribute: `data-astryx-theme="neutral"` beside `cv2-root` (GateApp's three mounts). Remove the attribute → the atelier look returns intact. Swap `"neutral"` for `"gothic"` → different Astryx theme.

## 4 · Impact analysis — exactly what phase 1 touches

| Change | Files | Risk notes |
|---|---|---|
| React 19 + types | `packages/tm8-ui/package.json`, root `bun.lock` | `packages/ui` (legacy oracle, not built/served) stays pinned React 18; its own `@types/react` 18 nest keeps the gate's `tsc -b packages/ui` green. |
| Ref-type widenings | `chrome.tsx`, `LoopCreateControl.tsx`, `TranscriptSurface.tsx`, `useReasonDisclosure.ts` (×2), `MaestroTaskTile.tsx`, `EntityListPanel.tsx` | Semantics unchanged (`useRef(null)` always produced nullable refs at runtime). |
| Astryx packages | `@astryxdesign/core` + `@stylexjs/stylex` + `theme-neutral` + `theme-gothic` in tm8-ui deps | Pin-exact recommended while beta (§7-G7). |
| Bridge + load | **new** `src/styles/astryx-bridge.css`; `src/styles/tokens.css` gains one `@import` (byte-locked twin `test-references/tokens.reference.css` updated in the same commit, per the tokens-verbatim law) | Bridge selectors are (0,3,0) by doubled attribute — they beat every tokens.css block regardless of the @import cascade position. No hex (hex-ban clean); its 4-exclusion pin untouched. |
| Opt-in attribute | `src/views/GateApp.tsx` (3 mounts), `e2e/board-v2-harness.tsx`, `e2e/row-state-harness.tsx` | Registry untouched; no kind literals introduced anywhere (board card stays structural). |
| **Task card, board (organism)** | `src/board-v2/BoardV2Screen.tsx` `CardView` + `board.css` | Recomposed on the official Astryx `Card` organism plus atoms: priority → `Badge` (semantic word-map `urgent/high→error, medium→info, low→neutral`), due date → `Timestamp format="relative_short"` with a red `data-overdue` state (word + color, never color alone), acceptance → `ProgressBar` (label hidden, a11y label kept) + count, assignees → existing kit `AvatarStack` (provenance semantics Astryx lacks). `Card` owns the default surface, border, container radius, spacing-scale padding, and low elevation; public Astryx tokens provide the hover lift and focus treatment. `data-testid`/list/drag/focus/open hooks stay on the Card root and are covered by the board suite. |
| **Task tile, list** (29 px row) | *no structural change* | Reskinned via bridge only — deliberate. The row is guarded by text-scanning laws (`tile-fill-parity`, `row-height-parity`, `--pn-listrow-h` floor) and a density doctrine an Astryx `Card` cannot meet at 29 px. Its status dot already matches Astryx `StatusDot` semantics 1:1. |
| Entity detail panel | *no structural change* | Status pill, sections, buttons all token-driven → bridged. |

**Not touched:** `panels/` lane structure, registry (`domain/registry.ts`), all guard tests (they pass as-written), service worker plugin, deploy scripts, server/CLI packages, migrations. **Bundle:** +~190 KB CSS pre-gzip (astryx.css + 2 themes) into the precache; component JS is per-subpath and tree-shakes to what's imported.

## 5 · Atomic design mapping (what "atoms and molecules" means here)

| Level | Astryx | tm8 surface it serves |
|---|---|---|
| Tokens | `--color-*`, `--font-*`, `--radius-*`, `--shadow-*` via theme CSS | bridged into `--pn-*` (phase 1, done) |
| Atoms | `Badge`, `StatusDot`, `Timestamp`, `Text`, `Icon`, `Avatar`, `Spinner`, `Skeleton`, `Token`, `Kbd` | board-card chips (done); list-tile dot/badges, panel pills (phase 2) |
| Molecules | `ProgressBar`, `AvatarGroup`, `MetadataList`, `SegmentedControl`, `ButtonGroup`, `InputGroup`, `Field` | acceptance meter (done); theme toggle, filter bars, edit forms (phase 2) |
| Organisms | `Card`/`ClickableCard`, `Table`, `TreeList`, `List`, `CommandPalette`, `AppShell`, `SideNav`, `TabList` | board card (done); list panels, palette, shell chrome (phase 3) |
| Overlays | `Dialog`, `Popover`, `Tooltip`, `Toast`, `DropdownMenu`, `BottomSheet` | **blocked — see G5** |

Visual hierarchy on the card, top-down: title (weight + primary ink) → semantic chips (priority badge, overdue-aware due chip) → quantified progress (bar + count) → people (avatars). One surface, no nested boxes, no overlay dependence — drag, focus and open stay native to the card element.

## 6 · Verification evidence

- **Typecheck:** `tsc -p packages/tm8-ui/tsconfig.json --noEmit` → 0 errors (React 19 + Astryx imports). `tsc -b packages/ui` → green (kept React 18).
- **Build:** `vite build` green (43 s), service-worker precache intact.
- **Tests:** targeted `board-v2 + panels` → **149/149 pass** with Astryx components rendering under jsdom. Full suite: 4,562 pass / 9 fail in 5 files — the failures are in surfaces this branch does not touch (attribution run against clean `origin/main` in the PR description; the repo carries known host-dependent failures).
- **Pixels + computed styles, Firefox** (Chromium segfaults on this kernel): product app on the fixture seam, light AND dark — workspace, Board v2, tile harness. Probes confirm at runtime: `--pn-paper: light-dark(#f1f1f1, #1b1b1b)`, shell font `Figtree, -apple-system, …`, card radius `10px`, oklch Astryx shadow ramps, `colorScheme` flipping `light`↔`dark` with tm8's toggle, not the OS.

## 7 · Gaps — known, deliberate, or open

- **G1 · Figtree is not shipped.** Astryx's families reference Figtree with a system-stack fallback; no woff2 in any @astryxdesign package. Today the UI renders the system fallback (clean, Meta-ish). To pin the real face, self-host per `fonts.css`'s existing recipe (self-hosting doctrine: no third-party font round-trips).
- **G2 · `--pn-brand-rgb` unmapped.** It feeds `rgba(var(--pn-brand-rgb), α)` compositors; Astryx values sit inside `light-dark()` and cannot be var()'d into an rgb-triplet slot. A few alpha accents keep the brass tint. Phase-2 fix: `color-mix()` at each consumer, or a generated brand theme (G8).
- **G3 · Type sizes, line-heights, tracking and easings mostly stay canvas-measured — by design, now checked, not guessed.** See §9 "Typography + motion bridge" for the value-identical policy and the full per-token table. One token bridged (`--pn-fs-fine`); everything else in `--pn-fs-*`/`--pn-lh-*`/`--pn-track-*`/`--pn-ease-*` stays atelier because no Astryx var computes to an identical value under *both* loaded themes (neutral and gothic diverge from each other, e.g. `--font-size-base` is 14px under neutral but 16px under gothic — the earlier "14px equals tm8 body anyway" note in this doc was checked against neutral only and did not hold once gothic was checked too). Both systems still share the 4px spacing grid (unchanged, still unbridged by choice). Families (`--pn-ui`/`--pn-serif`/`--pn-mono`) follow Astryx as before.
- **G4 · Astryx reset.css not imported.** tm8 never set global `box-sizing: border-box`; adopting Astryx's reset would flip untold implicit content-box layouts across 96 CSS files. Components render correctly without it (verified). Revisit only with a dedicated layout-audit pass.
- **G5 · Overlay components are off-limits until the portal question is answered.** `src/` deliberately contains zero portals: `.cv2-root` is simultaneously zoom hook (1.1), theme scope and token scope, and anything portaled to `document.body` escapes all three. Astryx `Dialog`/`Popover`/`Toast`/`Tooltip` are unaudited for portaling. This also honors the "no overlays" instruction — phase 1 uses only in-flow components. Phase-3 options: audit Astryx's `Layer`/`Overlay` for container support, or mount a portal host *inside* the scope.
- **G6 · Standalone `.cv2-root` islands not yet attributed.** AuthFlow, FilesScreen/NodeRoom/FilesNodeBoard, SettingsBoard, GalleryPage, account preview, and ~13 dev entrypoints mount their own roots; where they render outside GateApp's subtree they keep the atelier look until given the attribute (one-line each). Inside GateApp's subtree, `@scope` + inheritance + the bridge's descendant selector already cover nested re-entries.
- **G7 · Astryx is beta.** 0.5.0; APIs may move before 1.0. Recommend exact-pinning all four packages and an upgrade note in this doc per bump. (This branch pins via `bun.lock`.)
- **G8 · A branded "tm8" Astryx theme does not exist yet.** Phase 1 ships stock `neutral` (+ `gothic` loaded as an alternative). The end state is `@astryxdesign/cli`'s `astryx theme build` generating a first-party tm8 theme (atelier warmth expressed as an Astryx theme, including a designed dark ramp) — then the bridge maps `--pn-*` to *tm8's own* Astryx theme.
- **G9 · Board v1 (`src/board/`) and home-page `hp-card` not recomposed.** They reskin via the bridge but keep their own anatomy. Board v1 is legacy (route-reachable only); fold or retire it in phase 2 to avoid a visible fork.
- **G10 · Default theme unchanged — owner decision needed.** Dark is fully supported and verified; the default remains light/system per the D1 three-way toggle. If "convert to dark" meant *dark by default*, it is a one-line change in `useTheme`'s initialiser — deliberately not made without an explicit product ruling.
- **G11 · Known-unrelated breakage observed at origin/main:** `e2e/home-header-harness.tsx` imports `ListViewSwitcher`, which `panels/index.ts` no longer exports — it fails vite's dep-scan (non-fatally) on every dev boot. Pre-existing; not addressed here.

## 8 · Roadmap

1. **Phase 2 — coverage:** attribute the G6 islands; Astryx `StatusDot`/`Badge` into `EntityControls` chips; `MetadataList` in panel headers; brand theme (G8); Figtree (G1); retire Board v1 (G9).
2. **Phase 3 — organisms:** `TreeList`/`Table` evaluation for `EntityListPanel`; `CommandPalette` vs shell palette; overlay strategy (G5) then `Dialog`/`Toast`.
3. **Phase 4 — consolidation:** re-express the parity/hex/scale guard invariants against Astryx tokens; retire bridged `--pn-*` aliases surface-by-surface; `docs/ui/` screenshot baselines refreshed in `gate-evidence/`.

## 9 · Typography + motion bridge (value-identical policy)

Extends §3's token bridge to the type scale and motion curves that phase 1 deliberately left canvas-measured (G3). The policy is stricter than the rest of the bridge: **a token is only bridged when the Astryx var it would resolve to computes to the exact same value as the current atelier constant, and does so under every loaded theme** — not just the one someone happens to be looking at. `astryx-bridge.css` loads both `theme-neutral` and `theme-gothic`, and their `--font-size-*`/`--text-*-leading` values diverge from each other (measured from `node_modules/@astryxdesign/{core,theme-neutral,theme-gothic}/dist/*.css`, not assumed), so "matches under neutral" is not sufficient — it must match under gothic too, or the character would visibly shift the moment `data-astryx-theme="gothic"` is set. Every fallback is the current atelier constant, so a missing var can never move a character either.

### 9.1 · Bridged

| `--pn-*` token | Atelier value | Astryx var | Neutral value | Gothic value | Bridge |
|---|---|---|---|---|---|
| `--pn-fs-fine` | `10px` | `--font-size-xs` | `0.625rem` = `10px` | `0.625rem` = `10px` | `var(--font-size-xs, 10px)` |

Only one token in the entire set qualifies. `--font-size-xs` is the single Astryx size that is byte-identical across both shipped themes *and* matches an atelier constant.

### 9.2 · Left unbridged (gap register) — with the Astryx values that diverged

Font sizes (Astryx `--font-size-*`, converted from `rem` at the browser default 16px root — no `html { font-size }` override exists anywhere in this repo, verified):

| `--pn-fs-*` | Atelier | Nearest Astryx var | Neutral | Gothic | Why not bridged |
|---|---|---|---|---|---|
| `--pn-fs-display` | 40px | `--font-size-5xl` | 42px | 61px | Diverges from atelier both themes; themes also diverge from each other |
| `--pn-fs-h1` | 28px | `--font-size-3xl` | 29px | 39px | Off by 1px under neutral, 11px under gothic |
| `--pn-fs-h2` | 22px | `--font-size-xl` | 20px | 25px | No identical match either theme |
| `--pn-fs-h3` | 18px | `--font-size-lg` | 17px | 20px | Off by 1px under neutral, 2px under gothic |
| `--pn-fs-title` | 15px | `--font-size-base` | 14px | 16px | Matches neither exactly |
| `--pn-fs-body` | 14px | `--font-size-base` | **14px (matches)** | 16px | Matches neutral only — gothic diverges, so it fails the both-themes test |
| `--pn-fs-sm` | 13px | `--font-size-sm` | 12px | **13px (matches)** | Matches gothic only — neutral diverges |
| `--pn-fs-label` | 12px | `--font-size-sm` | **12px (matches)** | 13px | Matches neutral only — gothic diverges |
| `--pn-fs-micro` | 11px | `--font-size-xs` | 10px | 10px | No Astryx size sits at 11px in either theme |
| `--pn-fs-tick` | 9px | `--font-size-2xs` | 8px | 8px | No Astryx size sits at 9px in either theme |
| `--pn-fs-mono` | 12.5px | — | — | — | No Astryx size is fractional; nothing near 12.5px |

Line-heights (Astryx `--text-*-leading`, unitless, per theme):

| `--pn-lh-*` | Atelier | Closest Astryx leading | Neutral | Gothic | Why not bridged |
|---|---|---|---|---|---|
| `--pn-lh-tight` | 1.18 | `--text-heading-1-leading` | 1.3333 | 1.4194 | No Astryx leading is near 1.18 in either theme |
| `--pn-lh-snug` | 1.35 | `--text-display-3-leading` | 1.3793 | 1.2308 | Close under neutral only, and not identical there either |
| `--pn-lh-body` | 1.5 | `--text-body-leading` | 1.4286 | **1.5 (matches)** | Matches gothic only — neutral diverges, fails both-themes test |

(The one leading value stable across both themes, `--text-heading-6-leading: 1.6` under neutral and gothic alike, has no atelier counterpart at all — 1.6 is not one of `--pn-lh-*`.)

Letter-spacing / tracking: Astryx ships **no letter-spacing custom properties whatsoever** — confirmed by grepping all three loaded sheets (`core/dist/astryx.css`, `theme-neutral/dist/theme.css`, `theme-gothic/dist/theme.css`) for `letter-spacing`/`tracking`; zero hits. `--pn-track-mega` (0.12em), `--pn-track-label` (0.06em) and `--pn-track-tight` (-0.01em) have nothing to bridge to and stay atelier.

Easing: Astryx ships exactly one easing var, theme-invariant (only in `core`, not overridden by either theme): `--ease-standard: cubic-bezier(0.24, 1, 0.4, 1)`. Compared against both atelier curves:

| `--pn-ease-*` | Atelier value | Astryx `--ease-standard` | Why not bridged |
|---|---|---|---|
| `--pn-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | `cubic-bezier(0.24, 1, 0.4, 1)` | Different curve, not identical |
| `--pn-ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | `cubic-bezier(0.24, 1, 0.4, 1)` | Different curve, not identical (Astryx's is closer in shape to an ease-out than to Material's ease-standard, but no digit matches) |

**Rollback:** remove `data-astryx-theme` attributes (visual), or revert the branch (total). The React 19 bump is independently keepable — it costs nothing and unblocks the ecosystem either way.
