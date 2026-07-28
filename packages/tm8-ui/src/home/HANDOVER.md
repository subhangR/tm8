# HANDOVER — T5-1 Home / Dashboard

**status-as-of:** `02830c6` · seat: surface-wave `home` (`sess_1785277826542_cewey296u`) · authored 2026-07-29 (UTC 2026-07-28T22:52Z)

**Scope delivered:** the T5-1 Home/Dashboard screen at LINK-LEVEL COMPLETENESS — the anatomy frame whole, the first-run frame, the 320-floor behaviour, dark. It becomes the `dashboard` rail route. Fidelity is explicitly deferred to the parity seat; nothing below claims pixel parity.

**Everything is NEW and everything is under `packages/tm8-ui/src/home/`. No existing file anywhere was edited.** Mount instructions are §7; the coordinator holds the wiring seat.

---

## 1. Oracle enumeration (the first deliverable, restated)

Oracle: `T0-1 workspace structure review (1)/T5-1 Home Dashboard Hi-Fi.dc.html` — 355 lines, **3** `data-screen-label` frames, read whole.

| # | Frame | What it is | Built? |
|---|---|---|---|
| 1 | `T5-1 — Home / Dashboard anatomy` (L21–200) | The product frame. Two `sc-if` states (`populated` / `firstRun`, mutually exclusive per the dc script L345–352) + a `nice`/`worst` title tweak. | **Yes**, both states. |
| 2 | `T5-1 — Where Home lives, three options` (L203–257) | RATIONALE, not product UI. **A · SHIPPED** = menu destination, view ref `dashboard`, route `#/s/{s}/home`. **B** pinned tab REJECTED, **C** empty-centre REJECTED, reasons drawn on each. | **Nothing to build** — it rules the mount point (§7) and forbids B and C. |
| 3 | `T5-1 — Dark + 320 floor` (L260–343) | Dark = token swap only. Floor = one column, order NEEDS YOU → live → tasks → mentions → activity; quick actions compact to glyphs; nothing hidden, everything ellipsizes. | **Yes.** |

Frame 1's anatomy, and where each piece lives now:

- serif page title + mono dateline (`mon 27 jul · atelier · you are @ada`) → `HomeScreen` header
- three quick actions (`＋ New task` · `▸ Launch session` · `Workspace ⌘`) → `QuickAction`, §3
- left tile `⌂ My work` with `● N live`, sections NEEDS YOU / MY LIVE SESSIONS / MY TASKS / MENTIONS & ASSIGNMENTS, footer `every row opens its Z3 panel (C1)` + `all tasks ↗` → `composeMyWork` + `SectionBlock`
- right tile `◷ Space activity` with `all ▾`, day markers, actor·verb·entity·recency rows, footer `↓ load earlier` → `home-activity.ts` + the activity column
- first-run: `Nothing pulled yet.` + three keyboard-hinted rows (`c` / `▸` / `g t`) + the grammar caption; activity `Quiet so far…` → `FirstRun`

---

## 2. Files (all new)

| File | Lines | What |
|---|---|---|
| `src/home/home-model.ts` | 402 | Pure composition: registry-capability kind selection, row projection, the four sections, the triage order. No React, no seam, no DOM. |
| `src/home/home-activity.ts` | 198 | Durable-event → activity row projection, day buckets, recency, the rolling window. |
| `src/home/useHomeData.ts` | 191 | The three reads Home needs (`identity` / `inbox` / `onEvent`) + the two filtered `rowsFor` calls. Defines the narrow port `HomeScreenData`. |
| `src/home/HomeScreen.tsx` | 529 | The screen. |
| `src/home/home.css` | 576 | Tokens only. Zero new custom properties, zero per-theme overrides. |
| `src/home/index.ts` | 36 | Barrel; imports the stylesheet (the `kit/`, `panels/`, `authoring/` convention). |
| `src/home/home.test.tsx` | 529 | 31 tests. |
| `src/home/home-guards.test.ts` | 139 | 6 tests — this lane's own §15.2 + §14 guards (see §6). |
| `src/home/HANDOVER.md` | — | This file. |

Total **2600** lines across the eight source/test files.

**Note on this file's location.** The worker brief §4.7 says a new non-source artifact goes OUTSIDE `src/`; my spawn directive named `packages/tm8-ui/src/home/HANDOVER.md` explicitly. I followed the directive and checked the controls it lands in front of: the vitest include glob is `src/**/*.{test,spec}.{ts,tsx}` (a `.md` is invisible to it), `hex-ban.test.ts` filters to `.css`/`.ts`/`.tsx` (likewise), and `tsc` compiles neither. It is inert to every control. Flagging the tension rather than resolving it unilaterally — move it if the brief's rule is meant to win.

---

## 3. Every control the canvas draws, and what it does in this build

R7 posture: **no control is hidden and no control is live-but-inert.** The disabled ones use `panels/honesty`'s `DisabledIconControl` / `DisabledAction` — `aria-disabled`, `tabIndex=0`, reason wired through `aria-describedby` (D28: a natively `disabled` button leaves the tab order and takes its own explanation with it).

| Control | State | Through what |
|---|---|---|
| `＋ New task` | **Wired** when the host passes `newTask`; otherwise disabled-with-reason. Also renders the authoring lane's own `unavailable` reason when it has one. | `authoring`'s `NewTaskHandle` (structurally typed as `HomeNewTask`) → `seam.commands.createTask` |
| `▸ Launch session` | **Wired** when `onLaunch` is passed AND there is a task to launch on; otherwise disabled with the true reason. The subject is the top MY TASKS row and the control's `title` NAMES it. | the shipped D44/D51 door (`useLaunchSheet.open`) — never a second launch surface |
| `Workspace ⌘` | **Wired** via `onOpenWorkspace`. | nav |
| every row (all four sections) | **Wired** — C1, opens the Z3 panel. | `onOpenEntity` |
| `all tasks ↗` | **Wired** via `onOpenKind`; the kind comes from the registry (`assignableKinds()[0]`), never a literal. | nav |
| `● N live` | **Live**, from the seam verdicts only. | `livenessOf` |
| activity rows | **Live**, streaming from `seam.onEvent`; a row whose event names an entity opens it, a row that names none is inert *and looks inert*. | `seam.onEvent` |
| `all ▾` (activity scope) | **Disabled-with-reason** — the durable stream takes no scope parameter, and filtering client-side while calling it a filter is the honesty failure this is avoiding. | — |
| `↓ load earlier` | **Disabled-with-reason**, carrying BOTH facts: the cause is this build's (no space-scoped history read exists behind the seam), the remedy line is D7.1's measured node-side gap, verbatim from `homeActivityLoadEarlierReason`. | consumes the constant `GateApp.tsx:194` has been parking with the comment *"consumed by HomeView at fan-out"* |
| first-run rows `c` / `▸` / `g t` | The SAME three verbs as the quick actions — wired or refused identically, never a second code path. | as above |

Every section renders an `emptyNote` when it has no rows. **A section that renders nothing and says nothing is the defect this screen was graded on**, so `HomeSection.emptyNote` is non-optional in the type.

---

## 4. Divergences from the oracle — RULED vs DRIFT

**RULED (deliberate, with the authority):**

1. **The activity column is the live event stream, not a backfilled history.** Frame 1 draws TODAY/YESTERDAY rows implying history. There is no space-scoped activity READ behind this seam in either implementation (`seam.activity(id)` is entity-scoped, and `seam-fixture.ts:558` calls `requireSummary(id)`, which throws for a space id). Annotation 6 itself says the column is "the event vocabulary rendered as rows" — i.e. `onEvent`. So the column is honest about its scope in the header/footer copy, and `↓ load earlier` refuses under **D7.1**, which is the ruling that reserved exactly this control. *A fixture array would have filled the column and been a lie on a triage screen.*
2. **NEEDS YOU is composed, not queried by preset.** See GAPS §5.1. Composition is registry + seam-honoured filters. Ruled by the honesty laws; **flagged as a ruling I made alone** — ratify or reverse.
3. **`Workspace ⌘` keeps a glyph at the floor rather than vanishing.** Frame 3's 320 specimen draws only `＋` and `▸`; its annotation says the menu goes behind `☰` (shell chrome, not mine). Dropping the third action entirely would be *hiding*, which R7 forbids, so it compacts to `⌗` with its accessible name intact. Minor; the parity seat may overrule.
4. **Two-row tile chrome, no third row.** Consistent with **D63.1** (the action bar rides inline; the standalone action row is retired).

**DRIFT (built ≠ oracle, not yet reconciled — the parity seat's list):**

| Oracle | Built | Where |
|---|---|---|
| MY TASKS rows carry a mono task ref column (`T-114`, `T-109`) | not rendered — `EntitySummary` carries no short ref field, and inventing one from the uuid would be a fabricated identifier | `HomeScreen.tsx` `Row` |
| MY TASKS eyebrow reads `MY TASKS · 3 PULLED` | reads `MY TASKS · 3` — "pulled" is `EntityBadges.pulls` state this build does not read | `home-model.ts` section label |
| mention rows carry provenance AVATARS (round human / rounded-square agent) | rendered as glyph + text; `kit/Avatar` is deliberately not wired yet | `notificationRows` |
| session rows carry a 16px kind badge square with the persona initial | rendered as the registry chip glyph | `homeRowOf` |
| exact geometry: row h 26–28, activity row 24, panel header 32, columns 1.25:1 | header 32 and 1.25:1 are built; row heights are padding-derived, not pinned | `home.css` |
| `every row opens its Z3 panel (C1)` footer copy | shortened to `every row opens its panel` (the "(C1)" is canvas annotation vocabulary, not product copy) | `HomeScreen.tsx` footer |

---

## 5. GAPS

### 5.1 The fixture seam silently ignores unknown query filters — **the one worth reading**

`CollectionQuery.filters` declares `needsActorId`, `inFlightForActorId`, `inReviewForActorId`, `mentionedActorId`, `readyToPull`, `axes` and `edge` (`packages/contract/src/contract.ts` §2.1), and the contract's own comment says the first two exist to make `getHome`'s preset queries reproducible — i.e. they were designed for THIS screen.

- The **real** seam passes `filters` through verbatim to `collections.query` (`src/data/real/ops.ts:147`), so on a node they work.
- The **fixture** seam's `query()` (`src/data/fixtures/seam-fixture.ts:488–504`) matches only `workStatus`, `sessionStatus`, `assigneeIds` and `deleted`, and **ignores every other key without erroring**. A `needsActorId` query therefore returns the UNFILTERED set.

That is a silent-fabrication hazard, not a missing feature: sending the designed filter would have made `NEEDS YOU · 12` out of every row in the space — a wrong number on the loudest line of the screen, in the one place a user acts on it. **So Home does not send it.** It composes the same meaning from facts BOTH implementations honour:

- the registry's own `list.needsAttentionGroup` predicate evaluated against `seam.liveness.statusOf` (live session whose agent went idle — literally the oracle's "scout — waiting on your approval" row), plus
- `filters: { assigneeIds: [me], workStatus: [<the wait-toned status>] }`, both of which the fixture matches and the real seam forwards.

**Ask for the bridge lane:** either implement the preset filters in the fixture seam, or make `query()` REFUSE an unrecognised filter key instead of dropping it. The second is the more valuable of the two — a filter the seam cannot honour should be `invalid_input`, not a quietly wider result set. Until one lands, Home should keep composing.

*Also worth naming:* `list.needsAttentionGroup` had **no consumer at all** before this screen (its docblock says "designed-but-dormant"). D39.2 rules dead registry data a defect class; this retires one instance of it. A D-entry text is offered in §8.

### 5.2 No space-scoped activity read

`seam.activity(id)` is entity-scoped. There is no `spaces.home` / space-activity read on the seam, so there is no backfill and no cursor. Handled as §4.1. If the bridge lane ever adds one, the column's empty state and `↓ load earlier` are the two sites to change and they are three lines apart.

### 5.3 The fixture inbox is empty by construction

`seam-fixture.ts:586` returns an empty page with the comment "the dataset carries no notification rows: the inbox is honestly empty". MENTIONS & ASSIGNMENTS therefore renders its measured-empty note on the fixture path — correct, and it will populate on a real node with no code change. `mentionsEmptyNote` keeps three facts apart (not-read / failed / genuinely empty) so an empty inbox never reads as a failed one.

### 5.4 `STATUS_FIELD` is duplicated

`home-model.ts` carries a copy of the `StatusSource → EntityState member` table that `panels/detail/chrome.tsx:193` keeps module-private. Two copies of a mapping is how a mapping drifts. **Promote it to `src/domain/`** and have both import it — a coordinator-sized change, one file each side, not mine to make.

### 5.5 The dateline's space label is injected

`spaceLabel` is a prop, because this screen does not know the space's display name and reaching for one would mean a fourth read. The shell has it. If it is not passed, the dateline simply omits that segment rather than printing a placeholder.

---

## 6. COLOR NEEDS — none

**Zero new tokens. `styles/canvas-extra.css` is untouched and needs no entry.** Every value the T5-1 oracle paints already has a token: paper/surface/card/hover/active, line/line-2, ink…ink-4, brand/brand-2/brand-soft (+ `--pn-brand-rgb` for the alphas), run/wait/block/info/idle, and `--pn-x-hairline-soft` for the sibling-row divider (the D-ledgered hairline rule: `--pn-line` BOUNDS a component, the soft one SEPARATES siblings — the tile borders and header rules use `--pn-line`, the tile footers use the soft one).

The one alpha the oracle measures and the ramp does not name — the NEEDS YOU row tint, `rgba(189,138,42,.07)` light / `rgba(217,170,73,.08)` dark — is expressed as `color-mix(in srgb, var(--pn-wait) 7%, transparent)`, which is a DERIVATION and re-themes for free. Both oracle values are that same mix over their respective wait tokens, so this is one rule where the canvas has two numbers.

**`home.css` contains not one `data-theme` selector, and a guard asserts it stays that way.** The oracle's dark annotation is "Token swap; the dashboard carries no extra chrome to re-skin — it is made of rows." If a per-theme override ever appears in this file it is evidence that a light rule above it is mis-tokenised, not that dark has a bug — which is why that is a test and not a review habit.

---

## 7. INTEGRATION NOTE — exactly how to wire it

**Mount point:** `src/views/GateApp.tsx`, a new branch in the same ladder as the `graph` one (D65: an activated menu view replaces the centre wholesale). It goes **above** the existing "unbuilt view refs" branch, which currently catches `dashboard` and renders the "isn't built yet" placeholder — that placeholder stops being true the moment this lands, so the branch order matters.

```tsx
import { HomeScreen } from '../home';

// … inside the ladder, beside the graph branch:
) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'dashboard' ? (
  <HomeScreen
    data={data}                                   // GateData satisfies HomeScreenData structurally
    spaceLabel={data.spaces.find((s) => s.id === data.spaceId)?.name}
    onOpenEntity={(id) => nav.push?.(id)}
    onOpenWorkspace={() => setActiveTarget({ type: 'view', ref: 'workspace' })}
    onOpenKind={(kind) => setActiveTarget({ type: 'kind', ref: kind })}
    onLaunch={(subjectId) => launch.open(subjectId)}
    newTask={/* the authoring lane's NewTaskHandle, when it is mounted */ undefined}
  />
) : /* … the existing branches … */
```

**Props, exactly:**

| Prop | Type | Required | If omitted |
|---|---|---|---|
| `data` | `HomeScreenData` | **yes** | — |
| `onOpenEntity` | `(id: EntityId) => void` | **yes** | — |
| `onOpenWorkspace` | `() => void` | no | `Workspace` quick action renders disabled-with-reason |
| `onOpenKind` | `(kind: string) => void` | no | `all tasks ↗` and the `g t` first-run row render disabled-with-reason |
| `onLaunch` | `(subjectId: EntityId) => void` | no | `▸ Launch session` renders disabled-with-reason |
| `newTask` | `HomeNewTask` (`{ unavailable, create }`) | no | `＋ New task` renders disabled-with-reason |
| `now` | `Date` | no | `new Date()` |
| `spaceLabel` | `string` | no | that dateline segment is omitted, not placeheld |
| `forceNarrow` | `boolean` | no | measured (`useMeasuredWidth`, breakpoint `HOME_STACK_BREAKPOINT = 640`) |

`HomeScreenData` is `{ spaceId, seam, liveIds, livenessOf, rowsFor, activity }` — **`GateData` already satisfies it structurally, so `useGateData` needs no change at all.** `seam` is narrowed to `Pick<Seam, 'identity' | 'inbox' | 'onEvent'>`.

**Two things the coordinator should also do, both one-liners, both mine to flag and not to make:**

1. `GateApp.tsx:194`'s `void homeActivityLoadEarlierReason; // D7.1 — consumed by HomeView at fan-out.` can be **deleted**: the constant now has its real consumer, and retiring a placeholder IS the verification that its feature landed.
2. `CommandPalette`'s `paletteViews` list in `GateApp.tsx:217` names Workspace / Graph / Channels but not Dashboard. Adding `{ id: 'view:dashboard', label: 'Dashboard', glyph: '⌂' }` makes Home reachable from `/` as well as the rail. The glyph matches `VIEW_PRESENTATION.dashboard`.

---

## 8. D-entry texts offered (author: this seat — the coordinator ledgers or reverses)

**D<n> — Home composes NEEDS YOU rather than sending the preset filter the contract declares.**
Source: the home seat, from the fixture seam's filter behaviour. `CollectionQuery.filters.needsActorId` / `inFlightForActorId` are declared and forwarded by the real seam, but the fixture seam's `query()` matches four keys and drops every other one silently, so the designed query returns the unfiltered set. Ruling: Home does NOT send them; it composes the section from the registry's `list.needsAttentionGroup` predicate against `seam.liveness.statusOf`, plus `assigneeIds` + the wait-toned `workStatus`, all of which both implementations honour. Rationale: a wrong count on the screen's loudest line is worse than a section built from narrower but true facts, and the failure mode is invisible — the query succeeds. Corrective ask to the bridge lane: make `query()` refuse an unrecognised filter key rather than ignoring it; a filter the seam cannot honour is `invalid_input`, not a wider result set.

**D<n+1> — `list.needsAttentionGroup` gets its first consumer.**
Source: the home seat. The registry field was authored "designed-but-dormant (R8)" and had no reader anywhere, which D39.2 names as a defect class rather than a latent feature. T5-1's NEEDS YOU section is its designed consumer and now reads it. Rationale: recorded so the field's status in the ledger stops being "dormant" — and because D39.2's guard shape (derive the source set from the registry, assert a renderer handles each) is the right follow-up for the row-predicate family too.

**D<n+2> — Home's activity column is the durable event stream, scope stated, with D7.1's control consuming D7.1's reason.**
Source: the home seat, measured. There is no space-scoped activity read on the seam (`seam.activity` is entity-scoped; the fixture throws for a space id), so T5-1's activity column is `seam.onEvent` — which is what annotation 6 describes — showing events since the screen opened, with the scope stated in the footer. `↓ load earlier` renders disabled-with-reason carrying two facts: this build has nothing to page (cause), and D7.1's measured `spaces.home` token defect would block paging if it did (remedy). Rationale: D7.1 reserved this exact control and parked its reason string; this is the consumer it named.

---

## 9. Red-first record

Every assertion below was made to FAIL against a restored broken state before being trusted green (the `rowsFor` precedent — the fix was already in tree, so the break was re-introduced). Captured output is in this session's scratchpad (`red/red1…red5*.txt`); the summaries:

**RED 1 — the verdict outranks the record + the two-source law.** Break: `homeRowOf` skips the `liveTreatment` branch and reads the record's status pill; `streaming` promotes any row to `pulse`.
```
FAIL  the verdict outranks the record > renders the STALE word over a record that still says running
      AssertionError: expected 'running' to contain 'stale'
FAIL  the verdict outranks the record > renders `unknown` as a refusal to claim life, never as running
      AssertionError: expected 'running' to contain 'unverified'
FAIL  the two-source law (F1) > cannot promote a stale verdict, however loud the byte signal is
      AssertionError: expected 'pulse' not to be 'pulse'
FAIL  composeMyWork > counts `live` from the VERDICT, never from the number of session rows
      AssertionError: expected +0 to be 1
FAIL  the screen > shows the live count from the seam verdicts
      AssertionError: expected '● 0 live' to contain '1'
      Tests  7 failed | 24 passed (31)
```
Note the shape of that red: it reproduces the exact R5 gate defect — a stale session reading `running`, and a live count disagreeing with the rows under it.

**RED 2 — the filter reaches the seam (D57.1).** Break: `useHomeData` calls `rowsFor(kind)()` with no argument — type-legal, runs, carries nothing.
```
FAIL  the filter reaches the seam > queries assignee = the member id `identity()` returned for THIS space
      AssertionError: expected false to be true
FAIL  the screen > opens a row’s Z3 panel on click (C1)
      Tests  2 failed | 29 passed (31)
```

**RED 3 — no silent voids.** Break: empty sections render `null`; unwired quick actions render `null` instead of disabled-with-reason.
```
FAIL  no silent voids > renders all three quick actions disabled-with-reason when nothing is wired
      AssertionError: expected null to be truthy
FAIL  no silent voids > renders every empty section’s note on screen
      TestingLibraryElementError: Unable to find an element by: [data-testid="home-empty-needs-you"]
FAIL  the screen > keeps the triage order in the DOM at the 320 floor
      TestingLibraryElementError: Unable to find a label with the text of: Launch session
      Tests  3 failed | 28 passed (31)
```

**RED 4 — the triage order.** Break: the live section emitted before NEEDS YOU.
```
FAIL  composeMyWork > keeps the oracle triage order — the law that survives the floor
      AssertionError: expected [ 'live', 'needs-you', … ] to deeply equal [ 'needs-you', 'live', 'tasks', 'mentions' ]
FAIL  the screen > keeps the triage order in the DOM at the 320 floor
      Tests  2 failed | 29 passed (31)
```

**RED 5 — the lane guards fire.** Break: a `'work_session'` literal appended to `home-model.ts`; a raw hex + a `data-theme` rule appended to `home.css`. All four guards reddened, **including the package-level `src/hex-ban.test.ts`** — which is the useful half of that result: it confirms the package guard already reaches this new directory, so my local echo is an echo and not the enforcement.
```
FAIL  src/hex-ban.test.ts > no stylesheet in the package carries a raw hex colour
      home/home.css → #B26A2B, #FFF
FAIL  src/home/home-guards.test.ts > §15.2 — no file in src/home names an entity kind
      home/home-model.ts → 'work_session'
FAIL  src/home/home-guards.test.ts > §14 — home.css resolves every colour through a token
FAIL  src/home/home-guards.test.ts > home.css introduces NO per-theme override
      Tests  4 failed | 6 passed (10)
```

All breaks were restored from byte copies taken before each edit and the suite re-run green after each.

---

## 10. Wide check — timestamp · scope · instrument

**Instrument:** `bunx vitest run --exclude 'src/terminal/**'` and `bunx tsc --noEmit`, both run from `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` (NOT the repo root — root `bunx` resolves vitest 2.x against this v4 tree and every file dies at collect). Banner control confirmed: `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`.

**Typecheck — 2026-07-28T22:51:49Z:** `bunx tsc --noEmit` → **exit 0, no output. Clean.**

**Suite — 2026-07-28T22:51:14Z**, scope = whole package minus `src/terminal/**`:
```
Test Files  1 failed | 54 passed (55)
     Tests  3 failed | 1056 passed (1059)
```
**All 3 failures are in `src/settings-space/settings.test.tsx` — a SIBLING LANE'S directory, not mine.** They are also unstable between consecutive runs (3 failures, then a different 2 on the immediate re-run), and that directory's files carry mtimes inside the same minute as my runs (`MenuEditor.tsx` at 04:21:29 vs my run at 04:21:14) — i.e. a concurrent seat is mid-write. I did not investigate further; it is not my lane and touching it would be worse than reporting it.

**Suite — 2026-07-28T22:51:52Z**, scope = whole package minus `src/terminal/**` and minus the sibling's `src/settings-space/**`:
```
Test Files  52 passed (52)
     Tests  1001 passed (1001)
```

**My directory alone — same instrument:** `src/home` → **2 files, 37 tests, all passing** (31 behaviour + 6 guards).

**Tree state I did not cause, reported rather than assumed known:** besides `src/settings-space/`, files under `src/shell/`, `src/panels/` and `src/views/` (including `GateApp.tsx`, the wiring target) were modified during my window by other seats. I edited none of them; every file I created is new and under `src/home/`. Verified with a mtime sweep excluding the four known-active lanes.

---

## 11. NOT-CHECKED — stated plainly

1. **The screen has never been rendered in a real browser.** It is not mounted (my directive: create only under `src/home/`, edit no existing file), so `:4612` cannot reach it until the coordinator wires §7. **Everything about LAYOUT is therefore unverified**: column proportions, whether the two tiles' internal scroll actually resolves against their `min-height: 0`, whether the tile footers clip, whether the dateline ellipsizes before the quick actions wrap. jsdom cannot see any of it — every defect that reached HEAD in this program was found by rendering the thing, and none by a suite. **Treat §4's DRIFT table as incomplete until someone looks at it.**
2. **Dark has never been looked at.** The reasoning is strong (tokens only, zero per-theme rules, guard-asserted) but reasoning is not a measurement, and I am not calling it verified.
3. **The 320 floor is asserted structurally, not measured.** `forceNarrow` exercises the branch and pins the DOM order; the actual breakpoint behaviour under a real ResizeObserver, and whether titles ellipsize rather than collapse at 320, are unmeasured. `useMeasuredWidth` deliberately reports `null` in jsdom rather than shimming a width.
4. **Never run against the real seam.** All 37 tests use a hand-built port. The `assigneeIds` + `workStatus` filters are asserted to REACH `rowsFor` with the right payload; whether a real node returns what this screen expects for them is untested here.
5. **The activity column has never seen a real event.** Its projection is unit-tested per event type; end-to-end (launch a session from Home → the echo lands as an activity row) is exactly the check to run first once it is mounted, because it exercises the whole chain in one click.
6. **`onLaunch`'s subject choice is unreviewed.** Launching on "the top MY TASKS row" is my call; it is named in the control's title so it is not silent, but nobody has agreed it is the right behaviour.
7. **Performance not considered.** Two extra `query` calls per Home mount (one per live-shaped kind, two per assignable kind) on top of boot. Cheap on fixtures; unmeasured against a node.
8. **No screenshots, no git.** Per directive.
