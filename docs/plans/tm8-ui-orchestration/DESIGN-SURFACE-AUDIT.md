# Design-Surface Coverage Audit — the suite vs `packages/tm8-ui`

**Companion file:** per-kind entity-page coverage ships separately in [`DESIGN-SURFACE-AUDIT-KINDS.md`](./DESIGN-SURFACE-AUDIT-KINDS.md) (user priority, delivered first).

**Snapshot marker:** `git log -1 --format=%h` → **`756a9b0`**, working tree dirty, audited as-is.
**The tree moved during the audit.** `src/auth/` (12 files) and `src/authoring/` (5 files) did not exist in my opening file listing and were present an hour later. Every count below is a reading of a moving tree, and the direction of travel is *more code landing, not more code wiring*.

**Method.** Surfaces extracted from the `.dc.html` canvases (parsed and read as text, not recalled from titles); implementation traced along the call graph from `main.tsx`. **A surface counts IMPLEMENTED only if I followed a path from the app entry to its render.** Where a file exists but nothing imports it, that is recorded as its own status, not as coverage.

---

## 0. The finding that reorganises the rest

The dominant failure mode in this build is **not** missing work. It is **finished work that nothing imports.**

Eight independent clusters are complete-with-tests on disk and unreachable from the running app:

| # | Cluster | Size | Importers outside its own dir | What the user loses |
|---|---|---|---|---|
| 1 | **`src/auth/`** — all 17 T3 frames + 37 KB CSS (**landing live during this audit**, see §2) | 14 files | **0** | The entire auth & onboarding suite |
| 1b | **`shell/CommandPalette.tsx`** + the **C6 keyboard controller** | palette + `keyboard/` | **0** | `/`, ⌘K, and every chord binding |
| 2 | **Five archetype bodies** — `SubtreeBody`, `ReaderBody`, `HubBody`, `ProfileBody`, `SessionAnatomy` (+ tests + CSS + handovers) | ~5 components | **0** | Per-kind detail UI for task/doc/channel/member/teammate |
| 3 | **`src/authoring/`** — `useNewTask`, `useTaskSave`, `commands.ts` | 607 lines | **0** | Create and save, everywhere |
| 4 | **`EntityListPanel.onCreate`** — `＋ New` button renders, calls `onCreate` | dead prop | never supplied | The create button is inert |
| 5 | **`LaunchSheet.refusal`** — in-sheet refusal card, the T5-5 anti-toast requirement | dead prop | never supplied | Refusals appear as the toast the canvas forbids |
| 6 | **`EntityView.onKindChange`** — passed by `GateApp:196` | dead prop | never rendered | No kind switcher on entity screens |
| 7 | **Seam `feed()` + `session_chat_v1`** — contract, real ops, fixture | full stack | **0 UI callers** | The chat feed |
| 8 | **Route grammar `home`/`feed`/`inbox`/`settings`** — parsed, built, unit-tested | codec + tests | no renderer | Four destinations resolve to the Workspace |

**The single highest-leverage line in the codebase** is the archetype switch at `EntityDetailPanel.tsx:305`. Five finished bodies deliver zero user-visible change until it is edited, and **no worker's DoD covers that edit** — each of the five handovers assigns it to "you".

### The app teaches keystrokes that do nothing

This is the sharpest honesty defect found, because the build's own copy makes a promise the build does not keep.

- `EmptyCenter.tsx:112` teaches, verbatim: **"`/` opens the palette."** No `/` handler exists.
- `SpaceTabBar.tsx:77-78` renders a **"/ palette · ⌘K"** button. Its `onClick` is `props.onOpenPalette`, and `GateApp.tsx:155-162` **never passes `onOpenPalette`**.
- `CommandPalette.tsx` is complete and unit-tested, has **zero product imports**, and is not exported from `shell/index.ts`.
- The **entire C6 keyboard controller** (`keyboard/controller.ts`, `keyboard/contract.ts` — chords `g i` inbox, `g ,` settings, `p` pin, marked `guaranteed:true`) **is never mounted**. `GateApp.tsx:115` carries a hand-rolled inline ⌘\ listener and nothing else, and its own comment says *"the full C6 controller is a separate lane."*

So the palette is unreachable by **all three** of its advertised entry points, and every keybinding elsewhere in this audit described as "plumbing that points at a void" is in fact deader than that — it never fires at all. `p` pins and `Esc` closes are likewise taught by `EmptyCenter` with no controller behind them.

This upgrades §1's route-fall-through finding: it is not only that five menu destinations render the wrong screen, it is that the app **advertises affordances in its own visible copy that have no handler**. Everywhere else this build is scrupulous about disabled-with-reason; here it makes a plain promise and silently breaks it.

### The route-exists-but-lands-nowhere defect

`GateApp.tsx:174-198` dispatches exactly three ways: `view:'graph'` → `GraphScreen`, `type:'kind'` → `EntityView`, **everything else** → `WorkspaceView`. So five shipped menu rows — **Dashboard, Feed, Inbox, Channels, Settings** — silently render the Workspace. The plumbing to reach them is complete at three independent layers (menu row, URL codec, keybinding `g ,` marked `guaranteed:true` in `keyboard/contract.ts:189`) and all three point at a void. A user clicking "Settings" is not told anything is missing; they are shown a different screen.

---

## 1. Summary table

Status vocabulary: **IMPLEMENTED** (reachable from app entry) · **PARTIAL** · **BUILT-UNREACHABLE** (complete on disk, zero importers — the brief's file-exists-≠-reachable case, called out separately because it is neither "implemented" nor "missing") · **ABSENT** · **DEFERRED-BY-RULING** (charter R7/R8/R10 or a `DECISIONS.md` ruling).

| Surface | Canvas | Status | Evidence |
|---|---|---|---|
| Workspace master screen (3-panel) | T0-1 | IMPLEMENTED | `views/WorkspaceView.tsx` ← `GateApp.tsx:199` |
| Menu rail + collapse (⌘\) | T0-1, T1-1 | IMPLEMENTED | `shell/MenuRail.tsx`, `GateApp.tsx:165` |
| Space tab bar | T0-1 | IMPLEMENTED | `shell/SpaceTabBar.tsx:155` |
| Terminal + chrome strip, exited/stale fallbacks | T0-2 | IMPLEMENTED | `terminal/*`, `bodies/TerminalBody.tsx` |
| Live-session bar · roster · empty center | T0-5 | IMPLEMENTED | `shell/LiveSessionBar.tsx`, `RosterPopover.tsx`, `views/EmptyCenter.tsx` |
| Entity list panel + per-kind tiles/badges | T0-3 | IMPLEMENTED | `panels/EntityListPanel.tsx`, registry `list.tile.badges` |
| Lifecycle tiers (Open/Done/Archived) | T0-1 | IMPLEMENTED | `registry.ts:127-163` (D41/D56) |
| Detail panel chrome + 4 tabs | T0-4 | IMPLEMENTED | `panels/EntityDetailPanel.tsx`, `detail/chrome.tsx`, `detail/tabs.tsx` |
| **Per-kind detail bodies (14 kinds)** | T0-4 | **ABSENT → generic** | `EntityDetailPanel.tsx:305-329`; see companion file |
| **Archetype bodies subtree/reader/hub/profile** | T0-4 | **BUILT-UNREACHABLE** | `panels/bodies/*.tsx`, 0 importers |
| **Six Z4 per-archetype layouts** | T0-4 | ABSENT | `EntityView.tsx:14-16` — "a LATER PASS" |
| Z4 full-view shell (collapse/crumb/esc) | T0-4 | IMPLEMENTED | `EntityView.tsx:119-134` |
| Panel states (loading/error/tombstone/permission-lost/stale-pin) | T0-4, T4 | IMPLEMENTED | `detail/PanelStates.tsx`, `EntityDetailPanel.tsx:129-137,235-257` |
| **Command palette** | T1-2 | **BUILT-UNREACHABLE** | `shell/CommandPalette.tsx` complete; **0 product imports**, not exported from `shell/index.ts`, no `/` or ⌘K handler |
| ↳ its three advertised entry points | T0-1, T1-2 | **ALL DEAD** | top-bar button `SpaceTabBar.tsx:77` (`onOpenPalette` never passed), `/` and ⌘K (no handler) |
| **Keyboard controller (C6)** | T0-1 | **BUILT-UNREACHABLE** | `keyboard/controller.ts` + `contract.ts` complete; never mounted — `GateApp.tsx:115` has only an inline ⌘\ listener |
| Honesty vocabulary (disabled-with-reason, hollow value) | T1-4 | IMPLEMENTED | `panels/honesty/{DisabledWithReason,HollowValue}.tsx` (D28/D32) |
| Panel stacking + pin refusal | T1-5 | IMPLEMENTED | `shell/PanelStack.tsx`, `geometry.ts` (D14) |
| Graph screen | *(no canvas — stub file)* | IMPLEMENTED | `graph/` 1,254 lines ← `GateApp.tsx:179`; **built from `GRAPH-VIEW-PLAN.md`, not a canvas** |
| **Home / Dashboard** | T5-1 | **ABSENT** | no `HomeView`; `GateApp.tsx:150` `void homeActivityLoadEarlierReason` |
| **Board layout** | T5-2 | ABSENT (position visible-disabled) | `EntityListPanel.tsx:435` |
| **Feed layout** | T5-2 | ABSENT (not even a switcher position) | `SWITCHER_MODES` = 4 of 6, `EntityListPanel.tsx:407` |
| **Gallery layout** | T5-2 | ABSENT | `src/gallery/GalleryPage.tsx` is the **dev kit gallery**, not this |
| Tree layout | T5-2 | IMPLEMENTED | `views/EntityTree.tsx` ← `EntityView.tsx:141` |
| Launch sheet (T5-5, full config set) | T5-5 | IMPLEMENTED | `views/LaunchSheet.tsx` → `data.spawn` — **the only authoring path that reaches the seam** |
| ↳ in-sheet refusal card | T5-5 | **BUILT-UNREACHABLE** | `LaunchSheet.tsx:267-275`; `WorkspaceView` never passes `refusal` |
| **Doc edit mode + block editors + save states** | T5-3 | ABSENT | no `editMode`/`onSave`/mermaid/excalidraw trace |
| **Teammate authoring / invite** | T5-6 | ABSENT | no create form |
| **Generic create pattern (＋New)** | T5-6 | **INERT** | button renders, `onCreate` never supplied |
| Discussion tab (rows + empty) | T5-7 | PARTIAL | `detail/tabs.tsx:20-108` |
| ↳ **composer send** | T5-7 | **INERT** | `tabs.tsx:55-71` — no `onChange`/`onClick`/`onSubmit`, no state |
| ↳ send lifecycle (4 layers), day markers, load-earlier, anchors | T5-7 | ABSENT | no trace |
| **All T2 settings screens** (space settings, members/roles, invites, menu editor, profile lifecycle, custom-kind authoring) | T2 | **ABSENT** | `GateApp` has no `settings` branch |
| ↳ project trust read | T2-2 | PARTIAL | `domain/launch.ts:106-128`, read at launch only |
| ↳ untrusted consent modal | T2-2 | **BUILT-UNREACHABLE (domain)** | `launch.ts:332-436` `confirmUntrusted` implemented; no UI offers it |
| Session provenance strip (associated projects, launched-from) | T2-2 | PARTIAL/UNREACHABLE | `SessionAnatomy.tsx:124,150-164` — in the unwired cluster |
| **All 17 auth & onboarding frames** | T3 | **BUILT-UNREACHABLE** | `src/auth/` 3,313 lines, 0 importers; `App.tsx` mounts `GateApp` unconditionally |
| Files & attachments · Node settings · Inbox | T3-4/5/7 | *pending* | auditor report outstanding |
| Account menu + profile edit | T3-3 | PARTIAL | `AccountFrames.tsx` exists **unreachable**; `SpaceTabBar` `onOpenAccount` is wired to **`toggleTheme`** (`GateApp.tsx:161`), not a menu |
| Chat surface (anatomy, provenance, delivery, S01–S22) | T10 | DEFERRED-BY-RULING (R10) | spec §13 reserves 3 seams; all 3 implemented, rest correctly deferred |
| ↳ the 3 reserved seams | T10 | IMPLEMENTED | `routes/types.ts:16-57`, `terminal/ReservedToolbarSeam.tsx`, seam `feed()` |
| Delivery-facet visuals | T0-2, T4 | PARTIAL | handoff two-facet model in `fixtures/handoffs.ts` + `SessionAnatomy.tsx:231` (unwired) |
| NEEDS YOU / presence | T4 | DEFERRED-BY-RULING (R8) | predicate live at `registry.ts:229-230`, dormant on real data |
| Undo · version history · handoff withdraw · leaderboard · awards · saved-views · search results | T1-4, T5-2 | DEFERRED-BY-RULING (R7) | `ActionRef` R7 group `domain/types.ts:270-278`; rendered disabled-with-reason |
| Session `Terminal|Chat` switch | T10 | DEFERRED-BY-RULING (R10) | `ReservedToolbarSeam.tsx:11-23` |
| Server rail (multi-server) | T3 | DEFERRED-BY-RULING (R10) | `＋ add server` disabled-with-reason per D13 |

---

## 2. Per-canvas sections

*All twelve auditor reports returned. Claims I could verify are stated flat; claims resting on an auditor's read alone are attributed.*

### T0-1 Workspace Wireframes / Hi-Fi — the most-complete area
The three-panel workspace, rail, tab bar, panel stack, lifecycle tiers, tree guide-lines and honesty primitives are all reachable from `GateApp`. This is the part of the build the R5 gate was fought over and it shows.
The wireframe canvas's unique contribution is two **design-decision trios**, not runtime modes: structure (1a flush / 1b floating / 1c ink-stage) and task-row density (1d dense / 1e two-line / 1f cards). The code records which won — structure **1c** (ink-stage + dark session shell) with 1b's 8px gutter, density **1e** (two-line row, `tile-badges.ts`); `domain/types.ts:387` has no density field, so 1d/1f are not selectable and were never meant to be.
Two surfaces moved by ruling rather than being missing: the `◐` theme toggle (top bar → account menu, D1 — the canvas still draws it and the suite asserts its absence) and the share drop target (Sessions list → session toolbar seam).

### T0-2 / T0-5 Terminal & Live Session — built, with five dead verbs
`TerminalBody` is the one fully-built archetype; the always-dark shell law is panel-wide per D40; the five lifecycle strip states, stale/exited/unverified fallbacks and the needs-you banner all render.
**The 3-of-7 delivery-facet question is answered: the build is ahead of the canvas.** `panels/share/facets.ts` authors all nine states (delivery `preparing`/`sending`/`delivered ✓`/`refused ✗`/`unknown ⚠`; record `recording`/`recorded`/`record failed`/`withdrawn` + audit line), each with tone and an honest detail sentence, two pills always, never merged. The canvas froze only three. What is owed is *pixel* supply for the other six, not logic.
**Dead verbs, all from one omission:** `EntityDetailPanel.tsx:307-319` constructs `TerminalBody` without `onOpenTranscript` and without `compact`. Consequences: the strip's `transcript ↗` chip and the exited fallback's brass **"View transcript ↗"** both render and do nothing; the exited fallback shows no meta line (`exit code · ran · ended`); and the **320px-floor compaction never fires in the running app** — `compact` is threaded end-to-end and no caller sets it.
`LiveSessionBar` and `RosterPopover` are unmounted **by user ruling D64** (`WorkspaceView.tsx:185-190`) — intentional, not an oversight, though it does mean two of this canvas's five frames are invisible. `EmptyCenter` carries a flatter list than the designed grouped roster.

### T0-3 Entity List Panel — the best-honoured canvas in the suite
Per-kind list configuration is genuinely data-driven and present for **every** kind; a coverage test (`tile-badges.ts:271` `HANDLED_SOURCES`) asserts every declared badge source renders, so no kind can silently degrade to a bare title. T0-3's thesis — *"a new kind is a tile template + chips, nothing more"* — is the part of the design the build honours best. **The per-kind gap is on the detail side, not here.**
Real divergences are in *which facts* a kind shows: docs lack the drawn `v3 · 2h · @ada` version/recency/author meta; pulls have **no CI check-state source at all** (`✓ checks` / `2 warn` / `✗ e2e` exist nowhere); sessions have no LIVE/STALE section bands (only `task` declares `sections`).
**Config declared but never consumed:** `inlineEdit: {status, title}` is authored in the registry (`:291`) and typed (`types.ts:404`), and the status word renders as a **non-clickable span** (`EntityListPanel.tsx:1043`) — the T0-3 inline status-change popover does not exist. The per-row hierarchy caret is likewise absent, so the side-panel tree is permanently fully-expanded.

### T0-4 Entity Detail Panels — *see companion file*
Full treatment in `DESIGN-SURFACE-AUDIT-KINDS.md`. Headline: chrome and tabs implemented; **14 of 15 core kinds render `GenericBody`**; the six Z4 layouts are an explicit later pass; four archetype bodies are built-unreachable.

### T1-1 Menu rail — fully implemented
All three row grammars (group header, plain, caret-with-children), discrete widths M ∈ {48, 220}, collapsed corner marks with composed `aria-label`, live `● n` as dot **and** word, and a fail-closed resolver that falls back to the shipped default rather than rendering a blank row. One of the cleanest areas in the build.

### T1-2 Command palette — **built, complete, never mounted** (see §0)
Everything inside the component is right: fixed group order ENTITIES→VIEWS→ACTIONS→NOT AVAILABLE YET, arrow-nav skipping disabled rows, and R7 discovery rows **derived from the registry** rather than hardcoded. Two internal gaps: the drawn `⌘⏎ open+pin` footer hint has no handler, and no-results renders a bare paragraph instead of reusing the `EmptyBody` grammar. All moot until it is mounted.

### T1-3 Responsive — geometry real, mobile layer absent
The breakpoint classifier and grid reflow are genuine (`geometry.ts:378-402`, `solveWorkspace`, honest `belowFloors` overflow). What is missing is everything above bare reflow: panels reposition in the grid but are **not re-rendered as collapsible rows** keeping header + loudest state word, and the entire mobile sheet layer is absent — no one-at-a-time slide, no 280 ms transition, no swipe/back pop, no `☰` rail-as-drawer, no phone live-bar merge.

### T1-4 Honesty vocabulary — implemented and genuinely pervasive
Both disabled-with-reason forms (tooltip icon + inline caption), hollow-value with the dash≠zero rule, and the one-toast overflow notice are built and wired across a dozen call sites. The build even adds a state the canvas never drew — `CheckingPermission`, distinguishing *loading* from *refused*, which is the same instinct the canvas is teaching. This is the design language the codebase internalised best.

### T1-5 Panel stack on non-workspace views — peek yes, stack no
Peek aside (440 px), `⤢` promote into the Z4 shell and the Esc ladder all work. Absent: the **multi-depth stack visualization** the canvas draws — `‹ back`, breadcrumb, depth pips, "3 in stack" — because `EntityView`'s aside is single-depth. Touch gestures (swipe-right pop, click-dimmed-pops-all, source-card brass outline) have no trace.

### T4 State Matrix — four of seven cells solid, two with zero trace
Implemented: **Empty** (widely reused), **Loading** (geometry-true skeletons, no spinner), **Tombstone** (panel form), **Error** (contained, retry, chrome stays live), **Permission-lost** — which correctly short-circuits the entire panel rather than swapping the body (`EntityDetailPanel.tsx:124-129`), the exact leak the canvas warns about. The **share & handoff family is fully built** (drag ghost naming receiver and verb, two-facet result, withdrawal audit, `sourceMissing`).
**Two cells have zero UI trace:**
- **OFFLINE / reconnecting** — no banner, no "showing cached data from HH:MM · N sends queued", no disabled composer. Transport-level reconnect exists (`data/real/connection.ts`) and is never surfaced.
- **CONFLICT** — no "Edited by @noa just now" toast, and structurally impossible today: `NoticeTone` is only `'warn' | 'error'` (`notices.ts:15`), so the info-blue tone the canvas specifies **cannot be produced at all**.
Two partials: the stale-pin banner lacks its `diff v7 → v9` secondary and does not dim the body; the error path is **prop-driven, not a React error boundary** — no `componentDidCatch`/`getDerivedStateFromError` exists anywhere in `src`, so the "never white-screens" property is asserted but unproven.

### T2 Settings, Trust & Authoring — **entirely absent as UI**
No settings surface renders. Menu row (`menu.ts:89`), URL route (`routes/types.ts:46`, sections `projects`|`menu`) and keybinding (`keyboard/contract.ts:189`, `guaranteed:true`) all resolve to `WorkspaceView`. Absent: space settings, members & roles, invites, redeem landing, linked-projects management, project registry, menu editor, interaction-profile lifecycle, custom-kind authoring form.
Domain-layer support exists and is stranded: trust flags and `UNTRUSTED_REASON` (`launch.ts:106-128`), the full `confirmUntrusted` consent path (`launch.ts:332-436`) with **no UI that can satisfy it**, profile resolution (`launch.ts:153-237`), and menu validation with known-good fallback (`shell/menu-resolve.ts`).
*Correction to the auditor's report:* it stated `interaction_profile` has no registry row. It does — `registry.ts:692-726`, with `capabilityReasons` authored. Its *settings screen* is absent; its registry row is not.

### T3 Auth & Onboarding — **being written as this audit ran**
This canvas produced the audit's clearest demonstration that the tree is moving, and the timeline is worth recording because two auditors disagreed and **both were right when they looked**:

| Observation | What `src/auth/` contained |
|---|---|
| Auditor A (early) | **1 file** — `auth.test.tsx` only; reported the whole flow ABSENT, implementation "never created" |
| Auditor B (mid) | 4 files — `AuthCard`, `specimen`, `reasons`, the test; reported an unresolvable `./index` import |
| My re-check (late) | **14 files** — all 17 frames, `index.ts`, `types.ts`, and a 37 KB `auth.css`, timestamps `03:32`–`03:43` |

So this is **TDD landing in real time**: the spec test was written first, the frames filled in behind it. It is *not* abandoned work. `index.ts` exists and exports `AuthFlow`, `AUTH_FRAMES`, `DEV_BYPASS_NOTE`.

What remains true at every observation: **nothing imports it.** `App.tsx` renders `<GateApp />` unconditionally, and the dev-flag mount its own header anticipates does not exist. The module is scrupulous about its limits — `reasons.ts` catalogues each op the seam cannot perform (`REDEEM_INVITE`, `EDIT_PROFILE`, `MINT/REVOKE_TOKEN`), and the seam genuinely exposes only `identity()` as a read with **no auth command of any kind**. So most terminal verbs here are *meant* to render disabled-with-reason rather than function. Grade this as work-in-flight awaiting a mount point, not as a gap — but note the mount point is nobody's named deliverable, exactly as with the archetype switch.

### T3-3 Account Menu — the trigger is wired to the wrong verb
`AccountFrames.tsx` implements the menu and its profile-edit mode, inside the unmounted `src/auth/` module. Meanwhile the top-bar avatar — `aria-label="Account menu"` — has its `onClick` bound to **`toggleTheme`** (`GateApp.tsx:161`).
The provenance is defensible: D1 ruled that theme's one home is the account menu, and this is an interim shortcut to the thing inside it. The result is not: **a control announced to screen readers as "Account menu" opens no menu and silently changes the theme instead.** Identity, sign-out, access tokens and the three-way light/dark/system control all have no entry point. Worth fixing early — it is a one-line rebind once the menu is mounted, and until then it is an accessibility mislabel, not just a stub.

### T3-4 / T3-5 / T3-7 Files, Node & Inbox — three screens, none built
- **Files & attachments (T3-4)** — no upload UI at all: no drop zone, queue, per-file progress, size-cap refusal or retry. `attachments` exists in the data (`seam-fixture.ts:131`) and `GenericBody.tsx:91` **explicitly excludes it** from field rows, so attachment chips render nowhere. `FilePreviewBlock` shows a mime-gated *label* ("image preview · image/png"), not an actual image, and there is no preview overlay. The terminal's clipboard-image path is a session gesture, not this surface.
- **Node settings & status (T3-5)** — entirely absent: no subsystem health, no concurrency slots, no agent-command providers, no backup/restore. The phrase "node settings" appears in the build **only inside refusal-reason strings** (`registry.ts:679,684`) — a design target referenced by the copy that refuses on its behalf.
- **Inbox (T3-7)** — nav plumbing only (route, `g i` chord, menu row, glyph ◹); no component. Activating it highlights the rail row and shows the workspace.

### T5-1 Home / Dashboard — **absent**
Route grammar, menu rows and fixtures (`fixtures/honesty.ts` `homeActivityPage`) are all present; no `HomeView` component exists, and `GateApp.tsx:150` `void`s the Home fixture with the comment *"consumed by HomeView at fan-out."* The canvas's option-B (pinned tab) is correctly absent per its own ruling; option-C's "quiet ⌂ Home link" in the empty center is not present.

### T5-2 Board / Feed / Gallery — **three of six modes have no renderer**
The registry declares all six modes; the rendered switcher offers four (`EntityListPanel.tsx:407`) and only `list` has a body — `tree`/`board`/`graph` render disabled-with-reason, and **`feed` and `gallery` are not offered at all**, despite `message`/`commit` defaulting to `feed` and `file` defaulting to `gallery`. Those three kinds default to a mode that cannot render.
**Canvas is behind the code on one surface:** T5-2 draws Graph as deferred/disabled; `GraphScreen` has since shipped (menu revision 2).

### T5-3 Doc Authoring — **absent**
No edit mode, no Write⇄Preview, no block editors (mermaid/excalidraw), no save states, no conflict banner. `chrome.tsx:91` has a `contentEditable` title with **no commit handler**, so even the inline title does not persist. The read side (`ReaderBody.tsx`) is built-unreachable.

### T5-5 / T5-6 Launch & Authoring — **launch works; nothing else does**
Launch is the one authoring path that reaches the seam end-to-end, and it is substantially complete (FROM strip, teammates, M:N projects with trust refusal, profile resolution chain, capacity footer, spawn). Two defects: the **in-sheet refusal card is dead code** (refusals surface as the toast T5-5 forbids), and the teammate roster is fixtures, not live data. Teammate authoring and the generic create pattern are absent/inert.

### T5-7 Discussion Tab — **renders, cannot send**
Rows and empty state exist; the composer has no handlers and no dispatcher. Missing: reply-with-excerpt, day markers, "new since opened" divider, load-earlier pager, timestamps, and the four send layers.

### T10 Chat Surface — **correctly deferred**
The one canvas where absence is the right answer. The spec commits Phase 1 to three reserved seams; all three are implemented (per-panel `contentSurface` route slot with D12 preserve-and-clamp, the reserved toolbar row, the `session_chat_v1` feed op). S01 "Phase-1 reserved" *is* the current reality. Grade as intentionally-deferred. The Discussion tab is a different projection of the same store and must not be counted as chat coverage.

### T3-6 Graph Canvas + `Canvas.dc.html` — **empty stub files**
Both are 206-byte shells containing an empty `<x-dc>` element. **The suite is 16 drawn canvases, not 18.** `src/graph/` (1,254 lines, reachable) was therefore built against `GRAPH-VIEW-PLAN.md`/`GRAPH-VIEW-IDEAS.md`, and **there is no canvas to audit it against** — it cannot be graded for design conformance by this or any parity pass until one is drawn.

---

## 3. Ranked "not touched at all" — zero implementation trace

Ordered by user-visible importance. *Excludes* built-unreachable clusters (those are wiring, ranked separately in §0) and ruled-deferred items.

0. **Keyboard + palette access** *(ranked above everything: built, unmounted, and actively advertised)* — `/`, ⌘K, the top-bar palette button, `p`, `Esc`, and every `g` chord. The app's own copy teaches these and no handler exists. Cheapest fix in the audit, highest visible dishonesty.
1. **Home / Dashboard** — the space landing view. A shipped rail row that lands on the wrong screen; the first thing a user sees.
2. **All T2 settings screens** — space settings, members & roles, invites, redeem landing. No way to administer a space, add a person, or change anything about it.
3. **Doc edit mode** — docs are read-only. Creating knowledge is half the product's premise.
4. **Send a message** — the Discussion composer renders and cannot post. Arguably worse than absent: it invites an action it cannot perform.
5. **Create anything** — `＋ New` is inert; `entities.create` is never called from any `.tsx`.
6. **Board layout** — the tasks view the design leads with; visible-disabled, honest but empty.
7. **Menu editor** — the rail is the app's primary navigation and cannot be edited.
8. **Interaction-profile lifecycle** — governs how every launched session behaves; no draft→activate→retire UI.
9. **Feed + Gallery layouts** — three kinds default to a mode with no renderer.
10. **Inbox** — shipped rail row, no destination.
11. **Custom-kind authoring** — the generic render engine that would consume an authored schema is built; nothing can author one.
12. **Teammate authoring / invite** — teammates can be launched but not created.
13. **Project trust management UI** — safety-relevant; the consent path exists in the domain and no UI can reach it.
14. **Files & attachments surface** — upload/drop beyond the terminal clipboard path.
15. **`collection` kind detail** — blocked on design, not build (never drawn).

---

## 4. Honest coverage statement

**What this method can see.** Presence and reachability. Every IMPLEMENTED verdict follows a path I traced from `main.tsx` to a render. Every ABSENT verdict is backed by named search terms across `src/`. The BUILT-UNREACHABLE status exists precisely because the brief asked for the file-exists-vs-reachable distinction, and it turned out to be the audit's main result rather than a footnote.

**What it cannot see.**

1. **Pixel fidelity is out of scope.** A surface marked IMPLEMENTED is present, not correct. Whether it matches the canvas belongs to the parity sweep (D58), and D10 already rules that jsdom evidence is interim — real-browser acceptance is a named precondition of the gate. Nothing here substitutes for that.
2. **Nothing was rendered.** A live user session is running and the brief forbids driving a browser. A surface that mounts but throws at runtime reads as IMPLEMENTED here.
3. **The tree is moving underneath the audit.** `src/auth/` and `src/authoring/` landed *during* this session. The unwired-cluster census is the most perishable finding in the document — it changes the moment anyone lands a mount point, and it may already be stale.
4. **Eight of sixteen canvases are reported from my own spine tracing rather than a full canvas read** (marked *pending* in §2). Their table rows are conservative: I recorded what I could prove, so those sections under-report surfaces rather than over-report them.
5. **Auditor claims were checked, and several were wrong.** Corrected: `interaction_profile` and `channel` reported absent from the registry (both present — `registry.ts:692`, `:402`); Board reported IMPLEMENTED (it renders `DisabledIconControl` — only `list` is built, `EntityListPanel.tsx:431`); `src/auth/` reported non-existent (it was being written mid-audit). Findings I could not verify myself are attributed, not asserted.
6. **I corrected my own published table.** I first recorded the command palette as IMPLEMENTED on the strength of the component existing and being referenced in shell tests. An auditor challenged it; on re-check the component has zero product imports and no trigger. That error is instructive about this codebase's failure mode — **a complete, well-tested component is not evidence that a user can reach it**, and I made exactly the mistake the brief warned against before catching it.
6. **Two canvases are empty files**, so `src/graph/` has no design ground truth to be audited against at all — an absence of evidence, not evidence of conformance.
