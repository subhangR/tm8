# A (pass 2) — tm8 UI inventory: what exists, and what is alive against a real server

> ⚠️ **FILENAME NOTE.** This was commissioned as `A-inventory.md`. On arrival that path was
> **already being written by a concurrent peer auditor** (it grew 29 KB → 39 KB → 61 KB while
> this pass was in progress and ends on a `<!--NEXT-->` continuation marker mid-§4.3).
> Overwriting it would have destroyed live work, so this independent pass landed here instead.
> Treat the two as **cross-verification**: where they agree, the finding is confirmed twice by
> separate readings; where only this file has something, §10 lists it.

**Scope:** `/Users/subhang/Desktop/Projects/tm8/packages/ui` — `src/main.tsx`, `src/real/**`, `src/collab-v2/**`.
**Method:** read-only source inspection. No code changed, no git commands run.
**Date:** 2026-07-25.
**Nature:** a factual map. Where something is dead or unreachable that is stated as a fact with a citation, not as a judgement.

---

## 0. The verdict key

`src/real/RealFacade.ts` implements the 53-method `CollabFacade`. **19 methods are alive**;
34 are dead in one of three distinct ways. Every verdict below is scored against this table.

| Class | # | Methods (`RealFacade.ts` line) |
|---|---|---|
| **ALIVE** — real server data | 19 | `listSpaces`:147 · `getNavigation`:151 · `getEntity`:159 · `getHierarchy`:163 · `getConnections`:179 · `getActivity`:184 · `queryCollection`:211 · `getHome`:230 · `getMessages`:243 · `getSpaceActivity`:258 · `createTask`:295 · `patchTask`:303 · `createEntity`:311 · `patchEntity`:315 · `createEdge`:319 · `postMessage`:323 · `completeTask`:334 · `setWork`:342 · `subscribe`:446 |
| **SILENTLY EMPTY** — renders blank, no error, no console noise | 11 | `getVersions`:191 · `getPresence`:196 · `queryGraph`:225 · `getChannelTabs`:235 · `getInbox`:263 · `getLeaderboard`:264 · `getAwards`:265 · `getTaskAxes`:266 · `listSavedViews`:267 · `getSettings`:274 · `getActions`:288 |
| **THROWS** `CollabError('not_implemented')` | 21 | `search`:283 · `moveEntity`:348 · `deleteEntity`:349 · `patchEdge`:350 · `deleteEdge`:351 · `placements`:352 · `undo`:353 · `patchMessage`:354 · `deleteMessage`:355 · `setReaction`:356 · `grantPoints`:357 · `pullEntity`:358 · `linkPr`:359 · `trackingRefresh`:360 · `markNotificationRead`:382 · `createTaskAxis`:383 · `updateTaskAxis`:384 · `deleteTaskAxis`:385 · `createSavedView`:386 · `updateSavedView`:387 · `deleteSavedView`:388 |
| **SILENT NO-OP** — resolves, does nothing | 2 | `markRead`:379 · `subscribePresence`:460 |

Three alive methods are alive **by indirection**, which matters when reasoning about failure modes:

* `getConnections`:179 — `edges.list` is a 404, so connections are read off `getEntity().connections`. Real edges, different route (`RealFacade.ts:173-178`).
* `getSpaceActivity`:258 — no space-wide activity route; served from `getHome().activity`.
* `getSettings`:274 — only `name`/`description`/`githubRepo` come from `spaces.get`; `axes:[]` and `members:[]` are hard-coded blanks (`:277-279`).

And two are alive but **weaker than they look**:

* `subscribe`:446 is a **1500 ms poller**, not a socket (`events.ts:61`, `:114-146`). The file says so in its header.
* `completeTask`:334 throws `invalid_input` client-side unless `completerIds` is non-empty (`:335-338`).

### The fourth class — HOLLOW FIELDS

`real/capabilities.ts:84-98` registers 13 fields that are present, correctly typed, and
permanently `0`/`[]`/`null`. These are more dangerous than a 501: a 501 throws and something
catches it; a hollow field renders a confident zero with nothing to catch.

| Field | Value | Line |
|---|---|---|
| `channel.state.unreadCount` | 0 | 85 |
| `space.unreadTotal` | 0 | 86 |
| `navigation.unreadTotal` | 0 | 87 |
| `member.state.taskDoneCount` | 0 | 88 |
| `team_member.state.liveWork` | null | 89 |
| `channel.content.autoTabs` | [] | 90 |
| `channel.content.pinned` | [] | 91 |
| `member.content.teamMembers` | [] | 92 |
| `member.content.work` | [] | 93 |
| `team_member.content.equipped` | [] | 94 |
| `team_member.content.work` | [] | 95 |
| `work_session.content.workingOn` | [] | 96 |
| `work_session.content.transcriptDoc` | null | 97 |

### 🚩 FINDING 0.1 — the honesty register is never consulted by any UI code

`capabilities.ts` exists so a screen can disable a dead affordance (`isUnavailable`) or caption
a blank region (`isHollow`). A grep of the whole `src/` tree returns **two** consumers, neither
of which is a screen:

```
real/ModeBanner.tsx:13        import { unavailableCount } from './capabilities';
real/__tests__/mapping.test.ts:15  import { isHollow, hollowReason, isUnavailable } ...
```

`isUnavailable`, `isHollow` and `hollowReason` have **zero production call sites**. The cause is
structural: **`collab-v2` never imports anything from `real/`** (verified by grep — the only hit
is the word "real" in a comment at `CollabV2App.tsx:129`), and the register lives in `real/`.

Consequences:

* **Nothing is gated.** Every dead affordance in every screen renders fully enabled.
* **No emptiness is captioned.** An unbuilt leaderboard and a genuinely empty leaderboard are pixel-identical.
* The only honest signal that survives is one sentence in the mode banner: *"33 operations not
  built on this node — those panels are empty or disabled on purpose, never filled with
  placeholder data"* (`ModeBanner.tsx:56-61`; `unavailableCount()` = 12 reads + 21 writes = **33**).
  The clause "or disabled" is not true of the shipped UI.

---

# 1. Entry + integration

## 1.1 Files

| File | LOC | Role |
|---|---|---|
| `src/main.tsx` | 113 | Web entry: installs tm8 kinds, picks facade, owns the boot state machine. |
| `src/real/TmClient.ts` | 138 | HTTP transport: DEV-6 envelope unwrap, error-taxonomy mapping, connection flag. |
| `src/real/RealFacade.ts` | 476 | `CollabFacade` + `ConnectionControl` + `ExecutionControl`. |
| `src/real/events.ts` | 147 | `EventPoller`. |
| `src/real/capabilities.ts` | 127 | The gap register (unused — FINDING 0.1). |
| `src/real/ModeBanner.tsx` | 69 | Permanent REAL / MOCK / UNREACHABLE strip. |
| `src/real/SpacePicker.tsx` | 114 | Four pre-shell screens. |
| `src/real/SpawnDialog.tsx` | 256 | The entire agent-execution product surface. |
| `src/real/SessionTerminal.tsx` | 179 | xterm instance, sizing, input. |
| `src/real/tm8Kinds.tsx` | 250 | Runtime kind registration + the "Spawn agent" task action. |
| `src/real/terminal/ptyTransport.ts` | 534 | One WS per session, raw-byte offset resume. |
| `src/real/terminal/writeScheduler.ts` | 160 | rAF coalescing into `term.write`. |
| `src/real/terminal/visibilityDriver.ts` | 159 | Suspend offscreen terminals. |
| `src/real/terminal/runtime.ts` | 108 | Singleton wiring of the three above. |

## 1.2 What a user sees at `localhost:4611`

Host: `vite.config.ts:22-24` — port **4611**, `strictPort`, `127.0.0.1`.
Proxy: `vite.config.ts:30-31` — `/v2` and `/health` → `TM8_SERVER_ORIGIN`, **default
`http://127.0.0.1:4620`** (`:15-17` records that `:4610` "belongs to the CTO and must not be the
default" — so STATE.md's `:4610` and the UI's default disagree by design). `ws: true` on `/v2`
because it carries both the event socket and the per-session PTY socket.

| Step | Where | What renders |
|---|---|---|
| 0 | `main.tsx:28` | `installTm8Kinds()` **before first render** — mandatory, or a `work_session` chip white-screens the app. |
| 1 | `main.tsx:30` | `?mock` → mock branch (§1.5). |
| 2 | `main.tsx:39-61` | `Boot = {loading} \| {ready, spaces} \| {failed, message}`, driven by `listSpaces()`. |
| 3 | `main.tsx:63-64` | `ModeBanner` — always on screen, cannot be scrolled away. |
| 4a | `SpacePicker.tsx:43-45` | **loading** → "Connecting to the tm8 server…" |
| 4b | `SpacePicker.tsx:47-65` | **failed** → "Could not reach the tm8 server" + the raw error in a `<pre>` + the 4620 hint + Retry. |
| 4c | `SpacePicker.tsx:79-93` | **zero spaces** → "No spaces on this node… This is an empty database, not a failed request." + `Create a space`. |
| 4d | `SpacePicker.tsx:95-113` | **spaces exist** → "Choose a space" (name + member count) + `New space`. |
| 5 | `main.tsx:53-55` | Deep link `#…space=<uuid>` is **validated against the server's list** before use. |
| 6 | `main.tsx:81-91` | `CollabV2App` + `SpawnDialog` as siblings. |

`SpacePicker` and `ModeBanner` are hand-styled with inline `React.CSSProperties` and do **not**
use the `--pn-*` token system. They are visually a different application from the shell below them.

## 1.3 The transplant seam

* `collab-v2` → `real/`: **zero imports**.
* `real/` → `collab-v2`: exactly three points — types + the interface (`RealFacade.ts:47-48`),
  `KIND_REGISTRY`/`KIND_ORDER`/`registryFor`/`Pill` (`tm8Kinds.tsx:33-38`), and the component
  (`main.tsx:17`).
* `TRANSPLANT.md:32-46`: exactly **one** file inside the module was modified
  (`CollabV2App.tsx`, optional `{facade, spaceId, banner}`); the other 269 are byte-identical to
  snapshot SHA `b422978`.

## 1.4 `ExecutionControl` — beside the seam, not through it

The `execution.*` family has no home on the frozen `CollabFacade`, so it rides an optional
interface (`RealFacade.ts:101-116`) feature-detected by `hasExecutionControl()` (`:130-132`).
All seven methods are **ALIVE**.

| Method | Line | Wire | Note |
|---|---|---|---|
| `spawnSession` | 394 | `POST /v2/execution/spawn` | always `workdir:{mode:'project'}` — worktree mode is refused rather than silently downgraded (`:398-401`) |
| `promptSession` | 407 | `POST /v2/entities/:id/commands/prompt` | |
| `terminateSession` | 413 | `POST /v2/entities/:id/commands/terminate` | |
| `listProjects` | 419 | `GET /v2/projects` | |
| `createProject` | 429 | `POST /v2/projects` | defaults `trust:'trusted'` (`:423-428` explains why) |
| `linkProject` | 433 | `POST /v2/spaces/:id/projects` | |
| `createSpace` | 438 | `POST /v2/spaces` | |

### 🚩 FINDING 1.1 — the whole execution product is one modal, reachable exactly one way, with no way back

`SpawnDialog` is a **sibling of the shell** (`main.tsx:89`), not a screen. It renders `null` until
it receives a `window` CustomEvent `tm8:spawn-request` (`SpawnDialog.tsx:72-94`; name at
`tm8Kinds.tsx:41`), dispatched from exactly one place — the "Spawn agent" primary action appended
to the `task` kind at `tm8Kinds.tsx:234-244`.

Verified by grep: `SessionTerminal` has **one** usage in the entire tree (`SpawnDialog.tsx:225`).

* **There is no session list, no session screen, and no route back to a running session.** The
  session lives in local `useState` (`:68`) and is reset on every new request (`:76`). Press Close
  and the terminal is gone while the PTY keeps running server-side.
* **The visibility driver can never do its job.** `WARM_LRU_SIZE=3` plus the whole suspend/resume
  correctness seam (`visibilityDriver.ts:40-49`, `:105-112`) exists for N concurrent terminals;
  the app can mount one. STATE.md records this as a parked open item.
* Prompting is `window.prompt()` — twice (`SpawnDialog.tsx:131`, `tm8Kinds.tsx:149`).
* Session status is a **second, independent** 1500 ms `getEntity` loop (`SpawnDialog.tsx:98-107`),
  unrelated to `EventPoller`.
* The dialog does handle its own states well: untrusted projects render disabled with the reason
  (`:171-190`), single trusted project / single member auto-select (`:82-83`, `:89`), zero-projects
  and zero-members each get their own copy (`:169`, `:194-199`), errors render in a `role="alert"`
  `<pre>` (`:233-239`).

### 🚩 FINDING 1.2 — the `work_session` panel denies the terminal exists

`tm8Kinds.tsx:109-115` renders inside the `work_session` Content tab, verbatim:

> *"No terminal stream: this tm8 node exposes no PTY route yet, so session output cannot be shown.
> Status above is polled from the entity itself."*

Stale. The PTY WebSocket shipped (`ptyTransport.ts`; STATE.md §"Live terminal — PROPER WS
STREAMING SHIPPED"). So the surface a user reaches by clicking a session entity actively denies
the feature that works two clicks away.

## 1.5 `?mock` — and a third, undocumented route

`main.tsx:94-107`. `?mock` renders `<CollabV2App/>` **with no props**, taking the snapshot's
original path (`CollabV2App.tsx:137-139`): `createSeededFacade()`, `spaceId` from `facade.ids.space`
(`:142`), and `createSimulation(mock)`.

| Reachable only under `?mock` | Where |
|---|---|
| The seeded in-memory world | `CollabV2App.tsx:137` |
| The **simulation driver** — floating ▶/◼ + `step/total` counter, bottom-right | `CollabV2App.tsx:180-200`; deliberately gated on `simulation !== null` so a "sim on/off" toggle never floats over live data |

| Reachable only under real mode | Where |
|---|---|
| `SpacePicker`, `SpawnDialog`, `SessionTerminal`, projects, real spawn | `main.tsx:71,89` |

**`#/gallery`** — `CollabV2App.tsx:102-110` + `:161-165` swap the entire shell for `<Gallery/>` +
`<ThreadGallery/>`, a kind × zoom × state QA matrix. Not linked from anywhere; not in `README.md`
or `TRANSPLANT.md`.

### 🚩 FINDING 1.3 — the mock world ships in the production bundle

`CollabV2App.tsx:95` is a **static top-level import**: `import { createSeededFacade, createSimulation } from './mock';`.
The call is conditional (`:137`), the import is not. `mock/world.ts` alone is 2 460 lines, plus
`seed.ts` 433, `MockFacade.ts` 276, `validate.ts` 350, `simulation.ts`, `internal.ts` 227 —
roughly 4 000 lines of fabricated data compiled into every real-mode page load. The
seeded entities are never *rendered* in real mode, but they are *present in memory* one mistaken
reference away, which is precisely the risk `CollabV2App.tsx:135-136` says it is avoiding.

## 1.6 Realtime, and error mapping

`events.ts` — `GET /v2/spaces/:id/events?since=<seq>` every `DEFAULT_INTERVAL_MS = 1500` (`:61`),
primed immediately on first subscribe (`:98`). `seq` is authoritative; the high-water mark is the
max seq observed, because the contract allows gaps and a gap must not shift the cursor (`:123-136`).
A failed poll warns and retries **from the same cursor** (`:137-142`). The AM-2 envelope is mapped
to the snapshot's `eventId` as `` `${spaceId}:${seq}` `` (`:49-54`) — the one sanctioned adaptation.
Presence/typing are filtered as non-durable (`:57-59`).

`TmClient.ts` — frozen `KNOWN_CODES` (11 codes, `:26-30`); tm8-only `limit_exceeded` → `rate_limited`
with the original preserved at `details.tm8Code` (`:40`, `:51-52`); unrecognised code →
`not_found` on 404 else `upstream_unavailable`, never coerced to something specific (`:56`);
transport failure flips the connection flag (`:103-110`); non-JSON → `upstream_unavailable` (`:118-120`).

---

# 2. Shell

## 2.1 Regions (flex row, `shell.css:3-13`)

| Region | Width | Line |
|---|---|---|
| IconRail | `56px`, `flex:none` | `shell.css:18-19` |
| LeftRail | `232px`, `flex:none` | `shell.css:83-84` |
| CenterHost | `flex:1; min-width:0` | `shell.css:153-154` |
| Pinned split | `flex:1 1 0; min-width:320px` | `shell.css:227` |
| Stacked Z3 panel | `440px`, `flex:none` | `shell.css:217-218` |
| Stack shim (depth > 1) | `8px` | `shell.css:209` |
| Palette | overlay, iff `paletteOpen` | `ShellLayout.tsx:92` |

`PanelStack` returns a **fragment** (`PanelStack.tsx:236-269`), which is how pinned panels become
siblings of the center column in the same flex row. Widest layout = center + `MAX_PINNED` = 4
columns (`MAX_SPLIT_COLUMNS`, `PanelStack.tsx:29`).

## 2.2 Nav destinations

**IconRail** (`IconRail.tsx:29-76`): wordmark `>···+` (`:30`, mono, brand) · one tile per space with
2-letter initials, brand marker bar when active, unread dot when inactive (`:32-50`) · spacer ·
**Home** (`:54-63`) · **Inbox** with unread dot (`:65-75`). **No Settings tile.**

**LeftRail** (`RAIL_SECTIONS`, `LeftRail.tsx:20-28`):

| # | View | Label | Icon | Badge |
|---|---|---|---|---|
| 1 | `home` | Home | `home` | — |
| 2 | `tasks` | Tasks | `list-checks` | `queryCollection({kinds:['task'],limit:1}).page.total` |
| 3 | `docs` | Docs | `file-text` | `kinds:['doc']` |
| 4 | `team` | Team | `users` | `kinds:['member','team_member']` |
| 5 | `tracking` | Tracking | `git-pull-request` | `kinds:['pull_request']` |
| 6 | `graph` | Graph | `share-2` | — |
| 7 | `leaderboard` | Leaderboard | `trophy` | — |
| + | `extraSections` prop | — | — | **no caller ever passes it** |

Header: `Eyebrow "space"` + name (`:81-83`), viewer display name + `unreadTotal` badge (`:84-89`).
Channels: recursive `ChannelRow` (`:30-56`), indent `10 + depth*12`, working dot when
`workingAgentCount>0`, unread badge. Empty: *"No channels yet — ⌘K to create one."* (`:120-122`).
A section is active iff `view===section.view && !entityId` (`:98`) — an entity Z4 route
de-highlights every section.

`inbox` and `settings` have **no left-rail entry**. Settings is reachable only via `g` `s` or a
typed URL.

### 🚩 FINDING 2.1 — three of the seven left-rail sections are cosmetic against the real server

* **Graph** — no screen registered (FINDING 2.2); and `queryGraph` returns fully empty anyway.
* **Leaderboard** — screen exists, both reads (`getLeaderboard`, `getAwards`) return empty pages.
* **Tracking** — screen exists and `queryCollection({kinds:['pull_request']})` is alive, but nothing
  on this node can create a `pull_request` (`linkPr` throws), so the badge is a permanent honest 0.

Channel unread badges (`LeftRail.tsx:33,49`) and the viewer's `unreadTotal` (`:87`) read
`channel.state.unreadCount` and `navigation.unreadTotal` — both **HOLLOW**. The badges never
appear, which is indistinguishable from "all caught up".

### 🚩 FINDING 2.2 — `graph` has no screen; `ProfileZ4View` is built and never mounted

`ViewRegistry` (`CollabV2App.tsx:82-93`) merges nine `*Views` fragments + `entity: EntityZ4Route`
= **10 of the 11 `VIEWS`** (`stores/nav.ts:20-23`). `graph` is absent, so `CenterHost.tsx:35`
falls through to `PlaceholderView`: an `Eyebrow "graph"`, the blurb *"Full-page canvas over the
seeded subgraphs."* (`placeholders.tsx:31`), a count of **tasks** (`VIEW_KINDS.graph=['task']`,
`:18`), and six clickable proof rows. Pressing **Graph** in the rail, or `g` `g`, lands on a stub.

Separately, `screens/team/index.ts:25` exports `profileViews = { entity: ProfileZ4View }` with the
comment "wire it only if no other screen claims that route". `CollabV2App.tsx:92` claims `entity`.
**`ProfileZ4View` is dead code.**

## 2.3 Router — the complete route grammar

Codec in `stores/nav.ts:128-174`; `router.ts` is transport only.

| Form | Meaning | Line |
|---|---|---|
| `#/` | no space | `nav.ts:130` |
| `#/s/{spaceId}/{view}` | primary view | `nav.ts:133` |
| `#/s/{spaceId}/e/{entityId}` | Z4 route — **both** `entity` and `channel` | `nav.ts:131-132` |
| `?p=id1.id2.id3` | Z3 stack, bottom→top, `.`-joined, each `encodeURIComponent`'d | `nav.ts:135`, `:63-64` |
| `?pin=id4.id5` | pinned splits, truncated to `MAX_PINNED` on hydrate | `nav.ts:136`, `:172` |
| `?t=id:tab,id2:tab2` | active tab per panel ∈ `content\|discussion\|connections\|activity` | `nav.ts:137-138`, `:15` |

`isRoutableHash` requires `segs[0]==='s' && segs[1]` (`router.ts:28-32`), so `#/` and `#/gallery`
are ignored by the router. `routeKey` (`router.ts:102-104`) deliberately excludes `paletteOpen`
and `selection`, so opening the palette or selecting rows does not push history — but every push,
pop, pin and promote does. A routable initial hash hydrates then **re-publishes normalised** with
`replace:true`, because hydration drops pins past the cap (`router.ts:126-133`).
`createMemoryTarget` (`:64-97`) is a real in-memory history stack with `back()`/`forward()`.
`buildHash` (`:170-187`) is a second codec for links/share menus — and it emits `p` and `pin` but
**has no `t=`**, which `toHash` does emit.

**Round-trip asymmetry:** `toHash` serialises `view:'channel'` as `#/s/{space}/e/{id}`
(`nav.ts:131-133`), but `hydrateFromHash` maps *any* `/e/{id}` back to `view:'entity'`
(`nav.ts:151-153`). `'channel'` is therefore **unreachable from a URL** — a channel deep link,
reload, or back/forward lands on `EntityZ4Route` instead of `ChannelHub`. An unrecognised view
segment silently coerces to `home` (`:154-156`).

Note also `main.tsx:75` writes `window.location.hash = 'space=<id>'`, a **non-routable** hash;
`ShellLayout.tsx:62-69` then calls `setSpace` and the router immediately overwrites it with
`#/s/…/home`. Two hash conventions coexist harmlessly.

## 2.4 The keyboard map — complete

| Keys | Action | Condition | Line |
|---|---|---|---|
| `⌘K` / `Ctrl-K` | `palette.toggle` | **everywhere**, incl. inside the composer; cancels a pending chord | 87-93 |
| any other ⌘/Ctrl/Alt combo | pass through | | 94 |
| `Esc` | `palette.close` | palette open | 96-102 |
| `Esc` | `panel.pop` | else, `stack.length > 0` | 104-109 |
| *(typing target)* | pass through, clear chord | checked **after** Esc, **before** chords | 113 |
| `g` `<key>` | `view.<name>` | second key of a live chord | 116-127 |
| `g` / `G` | `chord.start` | arms for `CHORD_TIMEOUT_MS = 1200` (`:33`) | 130-133 |
| `Backspace` | `panel.pop` | `stack.length > 0` | 136-142 |

`DEFAULT_VIEW_JUMPS` (`:21-31`): `g h` home · `g t` tasks · `g d` docs · `g m` team · `g k` tracking ·
`g g` graph · `g l` leaderboard · `g i` inbox · `g s` settings. Not chord-mapped: `channel`,
`entity` (both need an entity id). `isTypingTarget` (`:36-44`) matches `isContentEditable`,
`INPUT`/`TEXTAREA`/`SELECT`, `role="textbox"`.

The palette computes its own hint as `` `g ${view[0]}` `` (`subsystems/palette/actions.ts:364`),
which advertises **`g t` for both Team and Tracking** — disagreeing with the real table (`g m`, `g k`).

## 2.5 Panel-stack behaviours

`MAX_PINNED = 3` (`nav.ts:18`) → `MAX_SPLITS = 3`, `MAX_SPLIT_COLUMNS = 4` (`PanelStack.tsx:28-29`).

| Behaviour | Mechanics | Line |
|---|---|---|
| **Peek** | click a chip/card → `pushPanel({entityId})` → 440px panel over the right edge | `CenterHost.tsx:28-31`, `nav.ts:82-88` |
| **Stack** | click a chip *inside* a panel → stacks; duplicates de-duped and re-pushed to the top | `nav.ts:83-87` |
| **Replace** | `{replace:true}` swaps the top instead of growing | `nav.ts:84-86` |
| **Breadcrumb** | full trail for stacked panels; clicking crumb *i* pops down to it one at a time | `PanelStack.tsx:160-166`, `:228-231` |
| **Pin** 📌 | `pinPanel` moves the ref `stack`→`pinned`; returns `false` at the cap | `nav.ts:99-109` |
| **Pin rejection** | flashes `role="status"` *"3 splits max — unpin one first."* for 1600 ms | `PanelStack.tsx:97-104`, `:188-192` |
| **Unpin** | a pinned panel's Close unpins rather than pops | `nav.ts:111`, `PanelStack.tsx:92-95` |
| **Promote** ⤢ | unpins if pinned, then `view:'entity'` + entity set + ref removed from stack | `nav.ts:113-117`, `PanelStack.tsx:106-109` |
| **Collapse** | `window.history.back()` — promote pushed one entry, so back restores the pre-promote view *including its stack* | `CollabV2App.tsx:76` |
| **Swipe-right pop** | `SWIPE_POP_PX = 64`, horizontal-dominant, stacked only | `PanelStack.tsx:30`, `:113-126` |
| **Tabs** | `setPanelTab` updates the ref in **both** stack and pinned; lands in `?t=` | `nav.ts:94-97` |
| **Titles** | graph store first, lazily hydrated via `facade.getEntity`, falling back to the raw id | `PanelStack.tsx:33-45` |

**The stack has no depth cap**, and only its **top** is mounted (`PanelStack.tsx:233`, `:252`) —
a 3-deep stack renders one body plus a decorative 8px shim.

## 2.6 `useShellData` — the chrome's only facade reads

| Hook | Calls | Refetch | Verdict |
|---|---|---|---|
| `useSpaces` :64 | `listSpaces` | `[facade]` only — **never on events** | ALIVE |
| `useSpaceNavigation` :68 | `getNavigation` | `NAV_EVENTS` (`:56-62`) | ALIVE (`unreadTotal` hollow) |
| `useSectionCounts` :87 | 4 × `queryCollection(limit:1)` → `page.total` | any `entity.upsert`/`entity.deleted` | ALIVE |
| `useUnreadInbox` :104 | `getInbox` | `notification.created`/`.read` | **DEAD** — permanently 0, the IconRail inbox dot never appears |

`AsyncValue` exposes `{value, loading, error, reload}` — and **no shell consumer reads `error` or
calls `reload`** (`IconRail.tsx:25-26`, `LeftRail.tsx:69-71`, `placeholders.tsx:54,60,94` all
destructure `{value}` only). A failing `getNavigation` renders a permanently empty rail with no message.

## 2.7 `placeholders.tsx`

`PlaceholderView` (`:52-88`) is data-backed on purpose: `queryCollection({kinds, limit:6,
sort:'activityAt_desc'})` so switching views moves real numbers. `VIEW_BLURB` (`:25-37`) is the
module's own one-line spec of each screen and is worth preserving:

| view | blurb |
|---|---|
| home | "My work — ready to pull, in flight, needs me." |
| tasks | "Collection view, default Board; axis pivots; bulk ops." |
| docs | "Tree sidebar + Z4 reader with margin threads." |
| team | "Member cards with nested agent org-trees." |
| tracking | "PRs and commits linked by tracks edges." |
| graph | "Full-page canvas over the seeded subgraphs." |
| leaderboard | "Score rows, recent awards, completion moments." |
| inbox | "Cross-space notifications — click opens a panel." |
| settings | "Members, invites, task-axis management." |
| channel | "Channel hub — shelf, auto-tabs, thread, composer." |
| entity | "Generic entity Z4 route." |
| *(default)* | **"Screen arrives in wave 3."** (`:70`) |

`PlaceholderPanelBody` (`:91-124`) is **dead** in the app — `CollabV2App` always supplies
`renderPanel` (`:172`). `PLACEHOLDER_VIEWS` (`:127-130`) is an exported, never-imported constant.

## 2.8 `icons.tsx`

15 hand-drawn inline SVGs, `0 0 20 20`, `currentColor`, `strokeWidth 1.5`, `aria-hidden`, no icon
dependency: `home, list-checks, file-text, users, git-pull-request, share-2, trophy, inbox, hash,
pin, maximize-2, x, chevron-right, settings, square`. **`settings` and `square` are referenced
nowhere** — there is no settings entry point in either rail.

---

# 3. Screens — the alive/dead verdict

Nine directories, ~61 files. Every screen is a `ViewComponent` over `ShellViewProps`
(`shell/types.ts:14-24`). The complete facade-call map, grepped file by file:

| Screen | Facade calls (file:line) | Verdict vs the real server |
|---|---|---|
| **home** | `getNavigation` `useViewerActors.ts:25` · **`getLeaderboard`** `:28` · `getSpaceActivity` `ActivityFeed.tsx:48` · `subscribe` `:41` · **`pullEntity`** `HomeScreen.tsx:68` · `queryCollection`×3 via `useCollection` | **PARTIALLY POPULATED** |
| **inbox** | **`getInbox`** `InboxScreen.tsx:27` · `listSpaces` `:28` · `subscribe` `:21` · **`markNotificationRead`** `:45`, `:69` | **FULLY BLANK** |
| **tasks** | **`getTaskAxes`** `TasksScreen.tsx:32` · `queryCollection`+`subscribe` via `CollectionView` · `patchTask` / **`placements`** / **`moveEntity`** via `collections/mutations.ts:71,85,97,107` | **POPULATED, mutations half-dead** |
| **team** | `queryCollection` `useTeam.ts:26,34` · `subscribe` `:14` | **POPULATED but hollowed** |
| **channel** | `getNavigation` `ChannelHub.tsx:24` · `getEntity` `useChannelData.ts:57` · **`getChannelTabs`** `:63` · `subscribe` `:34` · thread reads/writes | **PARTIALLY POPULATED** |
| **docs** | `queryCollection` `useDocs.ts:26` · **`getVersions`** `:49` · `createEntity` `DocsScreen.tsx:51` | **PARTIALLY POPULATED** |
| **leaderboard** | **`getLeaderboard`** `useLeaderboard.ts:33` · **`getAwards`** `:38` · `subscribe` `:23` | **FULLY BLANK** |
| **settings** | **`getSettings`** `SettingsScreen.tsx:18` · **`createTaskAxis`** `TaskAxesSection.tsx:68` · **`updateTaskAxis`** `:94` · **`deleteTaskAxis`** `:95` | **MOSTLY BLANK** |
| **tracking** | `queryCollection` via `CollectionView` · `getConnections` `TrackingRow.tsx:37` · **`trackingRefresh`** `TrackingScreen.tsx:52` | **STRUCTURALLY ALIVE, EMPTY IN PRACTICE** |

**Bold = dead method.** Detail per screen:

### 3.1 `home/` — PARTIALLY POPULATED

Three work columns + an activity aside (`HomeScreen.tsx:91-133`), queries at `:51-64`:
`ready` = `{kinds:['task'], filters:{readyToPull:true, assigneeIds:actorIds}, sort:'priority'}`;
`inFlight` = `{filters:{assigneeIds:actorIds, workStatus:['pulled','working']}}`;
`needsMe` = `{filters:{inReviewForActorId: viewer?.id ?? ''}}`.

* The three `queryCollection`s are **ALIVE** — columns populate for the viewer's own tasks.
* `useViewerActors` derives `actorIds` from `getNavigation().viewer` **plus `getLeaderboard()`**
  (`useViewerActors.ts:28`, with the comment *"The leaderboard page IS the contract's actor
  roster"*). `getLeaderboard` returns an empty page, so `actors` is `[]` and `actorIds` collapses
  to `[viewer.id]` (`:41-45`). **Consequence: an agent's work never counts as its owner's work**,
  which is the stated purpose of the hook, and `OwnerAttribution` has an empty `byId` beyond the viewer.
* **PULL / RE-PULL throws.** `pullEntity` is dead; the failure is caught and toasted
  (`HomeScreen.tsx:68`). The button renders enabled on every row.
* `facade.getHome()` is **never called** by this screen (its header explains the presets were
  re-expressed as live `CollectionQuery`s), so the alive `getHome` route is used only indirectly,
  by `getSpaceActivity`.
* `ActivityFeed` has **no empty state and no error state** — a failed fetch renders an empty `<ol>` forever.

### 3.2 `inbox/` — FULLY BLANK

`getInbox` returns an empty page, so the `<ol>` is empty, the `{n} unread` counter is `0`, and
`mark all read` is disabled at zero. The screen renders its **"no notifications yet."** empty state
permanently. `markNotificationRead` throws, but is unreachable because there are no rows.
The kind table (`kinds.ts:15-22`) is 6 entries of pure data with an unknown-kind fallback (`:24-26`).
Error is not handled (`:27-28` destructures `{value, loading}` only).

### 3.3 `tasks/` — POPULATED, mutations half-dead

Three modes (`MODES`, `TasksScreen.tsx:19-23`): `board`, `tree`, `select` — 3 of the 6 layouts.
`queryCollection` is alive, so **board and tree genuinely render the space's tasks**. Then:

* `getTaskAxes` returns `[]` → the axis pivot silently degrades to the built-ins.
* **Board drag → `patchTask`** (`mutations.ts:71,85`) — **ALIVE**. Status changes work.
* **Assign drop → `placements({intent:'assign'})`** (`:97`) — **DEAD, throws**.
* **Tree drag → `moveEntity`** (`:107`) — **DEAD, throws**.
* `BulkBar` "move to {column}" uses `patchTask` — alive; partial failures toast
  *"{failed} of {n} didn't move — rolled back"*. `BulkBar.tsx:39` hardcodes an exclusion so you can
  bulk-assign but never bulk-**un**assign.
* Select mode has no empty state and no error handling (`SelectableTaskList.tsx:19`).

This is the healthiest screen in the app.

### 3.4 `team/` — POPULATED but hollowed

`queryCollection({kinds:['member']})` and `({kinds:['team_member']})` are alive, so member and
agent cards render. What is lost:

* `member.content.teamMembers` is **HOLLOW `[]`** → `AgentOrgTree` has nothing to nest; every
  member card shows `Agent team · 0`.
* `team_member.state.liveWork` is **HOLLOW `null`** → `isWorking` (`model.ts`) is always false →
  the header tally *"{h} human(s) · {a} agent(s) · {w} working"* reports **0 working, always**.
* `member.state.taskDoneCount` is **HOLLOW 0**.
* `+ Spawn` on a member card opens the palette scoped to that member, which calls
  `facade.getActions(memberId)` — returns `[]`.
* No pagination: capped at 100 members / 200 agents, `nextCursor` never read, so the tally
  under-reports silently past those bounds.
* `MemberCard`'s head is a `DropSurface` on the `'actor'` surface (drop a task on a person =
  assign) — that path is dead (§6).

### 3.5 `channel/` — PARTIALLY POPULATED

`getEntity` and `getNavigation` are alive so the channel header, topic and shelf render; the
**thread is fully alive** (`getMessages` + `postMessage`). What is lost:

* `getChannelTabs` returns `[]` **and** `channel.content.autoTabs` is HOLLOW `[]`
  (`capabilities.ts:90`) — belt and braces. **There are no auto-tabs**; only the feed tab exists.
* `channel.content.pinned` is HOLLOW → the shelf's pinned section is always empty.
* `channel.state.unreadCount` is HOLLOW → no unread affordance ever fires.
* The channel **Z4 route is unreachable by URL** (§2.3), so a reload of a channel lands on the
  generic entity view.

### 🚩 FINDING 3.1 — losing channel auto-tabs also removes three of the six collection layouts

`CollectionView`'s built-in layout switcher (`controls.tsx:12-16`: `list · board · tree · feed ·
gallery · graph`) only appears when `showControls` is left at its default `true`. Grepping every
call site: `TasksScreen.tsx:74` passes `showControls={false}`, `DocsScreen.tsx:79` `false`,
`MembersSection.tsx:39` `false`, `TrackingScreen.tsx:114` `false`. The **only** call site that
leaves the switcher on is `ChannelTabs.tsx:64` — inside an auto-tab pane.

Since there are no auto-tab panes on the real server, the layout switcher never renders, and
therefore **`FeedLayout`, `GalleryLayout` and `GraphCanvas` are unreachable in the shipped real-mode
app** — not merely empty. `GraphCanvas` (374 LOC, `@xyflow/react` + `dagre`) plus `graph/model.ts`
(337 LOC), `graph/nodes.tsx`, `graph/EdgeComposer.tsx` and `graph/graph.css` (171 LOC) are
approximately 1 000 lines of code and two npm dependencies with no route to them. And even if
reached, `queryGraph` returns `{nodes:[],edges:[],clusters:[]}`.

### 3.6 `docs/` — PARTIALLY POPULATED

The tree sidebar (`CollectionView` in tree layout over `kinds:['doc']`, `useDocs.ts:26`) and doc
creation (`createEntity`, `DocsScreen.tsx:51`) are **ALIVE**. `getVersions` returns an empty page,
so **`VersionHistory` is permanently blank** — and because the read succeeds, it shows an empty
list rather than an error or a "not built" caption.

### 3.7 `leaderboard/` — FULLY BLANK

Both reads dead. `ScoreRows` gets nothing, `AwardsFeed` gets nothing, `useCompletionMoment` /
`breakdownsByTask` / `CELEBRATION_MS` never fire. `grantPoints` throws. The entire
`subsystems/reactions/` package that feeds it is dead too (§7).

### 3.8 `settings/` — MOSTLY BLANK

`getSettings` (`SettingsScreen.tsx:18`) returns `name`, `description` and `githubRepo` from
`spaces.get` — **real** — and `axes:[]`, `members:[]` — **blank by construction**
(`RealFacade.ts:277-279`). So:

* `SpaceProfileSection` — real data.
* `MembersSection` — its own `CollectionView` over member entities (`:39`), so it is **ALIVE**
  independently of `getSettings.members`.
* `InvitesSection` — nothing behind it.
* `TaskAxesSection` — `getTaskAxes` empty; **create, rename and delete all throw**
  (`TaskAxesSection.tsx:68`, `:94`, `:95`). The section renders an empty list with a fully enabled
  create form.

### 3.9 `tracking/` — STRUCTURALLY ALIVE, EMPTY IN PRACTICE

`queryCollection({kinds:['pull_request']})` and `({kinds:['commit']})` are alive, and
`getConnections` (`TrackingRow.tsx:37`) resolves the `tracks` counterparts for real. But nothing
on this node can create a PR or a commit entity — `linkPr` throws — so both collections are
permanently empty. `trackingRefresh` (`TrackingScreen.tsx:52`) throws.

### 3.10 Cross-cutting

* **No screen reads the connection store.** `useConnectionStore` / `selectConnected` have no
  consumers outside `stores/`. There is **no offline banner and no queued composer inside the
  module**; the only offline signal in the running app is `real/ModeBanner` (`ModeBanner.tsx:62-66`).
* **Error handling is inconsistent.** Channel, Settings, the Docs tree, Tracking's collection,
  Inbox, `ActivityFeed` and `SelectableTaskList` all discard `error`, so a failure presents as a
  permanent skeleton or an empty state.
* **Two `data-testid` conventions** — `view-<name>` (home, inbox, tasks, channel, tracking,
  settings) vs `<name>-screen` (team, docs, leaderboard).

---

# 4. Entity components + registry

## 4.1 The four zoom levels

| Level | Component | LOC | Role |
|---|---|---|---|
| Z1 chip | `entity/EntityChip.tsx` | — | inline reference: glyph, tint, label, meta, pulse |
| Z2 card | `entity/EntityCard.tsx` | — | list/board row: title, status pill, `SummaryFields`, badges |
| Z3 panel | `entity/EntityPanel.tsx` | 427 | the peek/split panel |
| Z4 full | `entity/EntityFullView.tsx` | 193 | the promoted route, layout picked from the registry |
| — | `EntityById`, `Tombstone`, `skeletons.tsx`, `context.tsx`, `ctx.tsx`, `entity.css` (408) | | |

## 4.2 Z3 `EntityPanel` anatomy — and which tabs have data

Documented in its own header (`EntityPanel.tsx:4-9`) and implemented at `:389-412`:

① header — breadcrumb from `hierarchy.path`, kind icon, inline-editable title (`data-editable`
gated on `entry.patchTitle`, `:279`)
② action bar — `entry.primaryActions(detail)` from the registry
③ **body tabs — the universal set, same order for every kind** (`PANEL_TABS`, `:32-37`)
④ footer

| Tab | Renders | Backing read | Verdict |
|---|---|---|---|
| **Content** | `entry.Content` from the registry (`:406`) | `getEntity` | **ALIVE** — per-kind content fields render |
| **Discussion** | `slots.discussion` → `subsystems/thread` (`:407-410`) | `getMessages` + `postMessage` | **ALIVE** — read and post work; edit/delete/react all throw (§7) |
| **Connections** | `slots.connections` → `subsystems/rail`, else `ConnectionsFallback` (`:98`, `:411`) | `getHierarchy` + `getConnections` | **ALIVE for display**; `createEdge` works, `deleteEdge`/`patchEdge`/`moveEntity` throw |
| **Activity** | `ActivityTab` (`:412`) | `getActivity` | **ALIVE** |

**All four Z3 tabs have real data.** This is the single healthiest surface in the UI — and it is
the one the panel stack, the placeholder rows, the collections and the palette all funnel into.
The dead parts are the *write* affordances inside the tabs, not the tabs themselves.

## 4.3 Kinds registered

`KIND_REGISTRY` (`registry/KindRegistry.tsx:907-919`) — **11 kinds**:
`channel · task · message · member · team_member · doc · file · spell · skill · pull_request · commit`.
`KIND_ORDER` (`:922-925`) lists the same 11 in display order.

`real/tm8Kinds.tsx` adds **2 more at runtime** (`:218-223`), because tm8's contract promoted them
to core and the snapshot's `EntityKind` union predates that:

| Kind | glyph | tint | Z2 `SummaryFields` | Z3 `Content` | Z4 | `primaryActions` |
|---|---|---|---|---|---|---|
| `work_session` `:71` | `▶` | green `running` / red `failed` / ink | status + started/exited `HH:MM:SS` (`:90-99`) | status / tool / model + the stale no-terminal paragraph (`:100-117`) | `generic` | **Prompt**, **Terminate** — both hidden once `exited`/`failed` (`:142`) |
| `collection` `:172` | `▤` | ink | `collectionType` (`:184-188`) | `type:` row (`:189-195`) | `generic` | none |

`tm8Kinds.tsx:230-244` also **monkey-patches the `task` entry**, appending a `tm8-spawn`
"Spawn agent" action that only dispatches the CustomEvent — deliberately not guessing a project.

## 4.4 🚩 FINDING 4.1 — `registryFor` has no fallback, and any unknown kind white-screens the app

```ts
export function registryFor(kind: EntityKind): KindEntry {
  return KIND_REGISTRY[kind];      // KindRegistry.tsx:927-929
}
```

The signature promises a non-optional `KindEntry`; the body is a bare index with **no fallback**.
`kindCan` (`:932-933`) indexes directly too. For any kind outside the 13, the first field access
throws and the whole React tree unmounts.

This is the transplant's headline defect and it is recorded in three places — `STATE.md`
§"UI transplant — drift ledger", `TRANSPLANT.md` §"⚠ Open defect for Atlas", and
`real/tm8Kinds.tsx:4-31`, which reproduces the exact observed crash:
`registryFor('work_session').tint` → *"Cannot read properties of undefined (reading 'tint')"*.

The load-bearing consequence: **the contract explicitly supports `c:*` custom kinds, and the first
one to reach a chip white-screens the app.** The two promoted kinds were only the symptom.
`installTm8Kinds()` at `main.tsx:28` treats the symptom; the defect is unfixed by design (the
lane's rule was to keep the diff inside the module at zero).

---

# 5. Collections

`collections/` — `CollectionView.tsx` (206), `controls.tsx`, `grouping.ts`, `dnd.ts`,
`mutations.ts`, `slots.ts`, `useCollection.ts`, `useListNav.ts`, `EmptyState.tsx`,
`collections.css` (291), `layouts/` ×5, `graph/` ×5.

**Six layouts** (`controls.tsx:12-16`): `list · board · tree · feed · gallery · graph`, labelled
`List · Board · Tree · Feed · Gallery · Graph`, switched by a `role="tablist"` (`:24-25`).
Layout selection: `layout` prop → `savedView.query.layout` → `query.layout`, then the built-in
switcher takes over after mount (`CollectionView.tsx:64`, `:72`).

Per FINDING 3.1, the switcher is only reachable inside a channel auto-tab pane, so on a real
server **`feed`, `gallery` and `graph` never render**.

| Concern | Where | Verdict |
|---|---|---|
| Data + live patching | `useCollection.ts:55` `queryCollection`, `:77` `subscribe`, `:120` cursor page | **ALIVE** |
| `load more` | `CollectionView.tsx:188-192`, hidden for `graph` | ALIVE |
| Grouping | `grouping.ts`; board is the grouped presentation, other layouts get a group-count chip summary (`CollectionView.tsx:194-203`) | ALIVE |
| Status mutation | `mutations.ts:71,85` → `patchTask` | **ALIVE** |
| Assign mutation | `mutations.ts:97` → `placements` | **DEAD** |
| Reparent mutation | `mutations.ts:107` → `moveEntity` | **DEAD** |
| Saved views | `listSavedViews` → `[]`; `createSavedView`/`update`/`delete` all throw; `SaveViewControl` (`controls.tsx:78-98`) captures graph node positions | **FULLY DEAD** — the control renders and the save throws |
| Empty state | `EmptyState.tsx`, per-kind hint from `registryFor(kind).collectionEmptyHint` | ALIVE |
| Keyboard nav | `useListNav.ts` over `kit/listKeyNav.ts` | present |
| Row slots | `slots.ts` — per-row action injection (`rowAction`) | present |
| Graph canvas | `graph/GraphCanvas.tsx:109` → `facade.queryGraph` | **DEAD + UNREACHABLE** |

---

# 6. Interactions

## 6.1 The drag-drop grammar table — every implemented row

`interactions/grammar.ts:70-146`. Five drop surfaces; row order within a surface is precedence
(`:154`, first match wins); `resolveDrop` returns `[]` when a surface rejects a source, and targets
then render no highlight (`:149-151`). Self-drops are rejected (`:153`).

| # | Surface | Accepts | Options offered | Line |
|---|---|---|---|---|
| 1 | `channel` | anything | **Attach** · **Attach + post card** (`withEmbed`) | 75-85 |
| 2 | `task` | task → task | **Attach** · **Depend** · **Subtask** | 88-99 |
| 3 | `task` | artifact kind → task | **Attach** | 101-108 |
| 4 | `task` | actor → task | **Assign** | 110-117 |
| 5 | `actor` | task → actor | **Assign** | 119-126 |
| 6 | `composer` | anything | **Embed** | 128-135 |
| 7 | `parent-zone` | same kind, `treeReparentable` | **Move here** | 137-146 |

Predicates are registry-derived, not kind-literals: `isActor` = `capabilities.actor !== null`
(`:63`), `isTask` = `kindCan(kind, 'workStatusBearing')` (`:64`).

## 6.2 🚩 FINDING 6.1 — the entire grammar is dead, all seven rows, via one line

`interactions/execute.ts:90` — `const result = await facade.placements(input);`

Its own header states the invariant (`execute.ts:2-4`): *"EVERY grammar drop (and every keyboard
equivalent) commits through `runPlacement`: exactly ONE `facade.placements` command."*
`placements` throws `not_implemented` on the real server. Therefore **every drag-drop in the
application fails**, regardless of row, surface or intent.

The failure is at least graceful and complete: the optimistic patch is rolled back
(`execute.ts:99-101`), the pre-drag summary is re-applied, and an error toast fires —
*"{label} failed — {describeError(e)}"* (`:107`). No unhandled rejection. But the drop targets
still highlight, the ghost labels still promise "Attach to #general", and the drop still animates
before failing.

Also dead by the same throw: `registerUndo(result.undo)` (`:92`) never runs, because the success
path is unreachable — so **the undo pill and `⌘Z` can never appear from a placement**. And
`interactions/undo.ts:71` (`facade.undo(entry.token)`) throws anyway.

## 6.3 Create flows

`interactions/create/index.tsx` (302 LOC). Kinds are not hard-coded: the creatable set is derived
from the registry — `createVia !== null` (`KindRegistry.tsx:943`) and `paletteCreate !== null`
(`:948`). Submission is `facade.createEntity({spaceId, kind, title, …})` (`:67-70`) — **ALIVE**.
Success toasts *"Created {title}"* with the new entity id (`:181`); failure toasts
*"Create failed — {describeError(err)}"* (`:187`). The comment at `:69` notes the cast is safe
because `createVia ≠ null` excludes `message` and `member`.

**Create is one of the few write paths that works end to end.**

## 6.4 Promote

`interactions/promote/index.tsx` (176 LOC) contains **no facade calls at all** (verified by grep).
It is a pure presentation/slot mechanism — `promoteReactionsSlot` is wired into the panel's
discussion slot at `CollabV2App.tsx:47-49`. Promote-to-task / promote-to-doc, if intended, would
have to run through `createEntity`; nothing here issues a mutation.

## 6.5 Other

* `interactions/dnd.tsx` (529 LOC) — `@dnd-kit/core` drag sources, `DropSurface`, drop indicators,
  ghost labels, the multi-option chooser.
* `interactions/keyboard.tsx` (275 LOC) — the interaction-menu store and keyboard equivalents of
  the grammar (which route to the same dead `runPlacement`).
* `interactions/undo.ts` — `facade.undo` throws; the code distinguishes *"The undo window has
  expired."* from *"Nothing left to undo."* (`:77-79`), neither of which can be reached.

---

# 7. Subsystems

Complete facade-call map, grepped per package:

| Package | Facade calls | Verdict |
|---|---|---|
| **thread** | `getMessages` (×3 forms) · `postMessage` · `getEntity` · `getNavigation` · `getActivity` · `subscribe` — all ALIVE. **`patchMessage`**, **`deleteMessage`** — THROW. `markRead` — silent no-op, and called with `.catch(() => {})` (`useThread.ts`) | **MOSTLY ALIVE** — read + post work; edit and delete throw |
| **rail** | `getHierarchy` + `getConnections` `useRailData.ts:55`, `:100` — ALIVE. `createEdge` `ConnectionsRail.tsx:103` — **ALIVE**. **`deleteEdge`** `:107`, **`moveEntity`** `:118`, `:131` — THROW | **DISPLAY ALIVE, HALF-WRITEABLE** |
| **reactions** | `getEntity` `useReactions.ts:71` · `getActivity` `:129` — ALIVE. **`setReaction`** `:113`, **`grantPoints`** `:122` — THROW | **FULLY DEAD as a feature** |
| **live** | `getEntity` `useLive.ts:43` — ALIVE. **`getPresence`** `:61` → empty. **`subscribePresence`** `:79` → no-op. **`pullEntity`** `StalenessBadge.tsx:58` — THROWS | **SPLIT — see below** |
| **palette** | `getEntity` `usePaletteData.ts:26` · `patchTask` `actions.ts:112` · `completeTask` `:126` · `createEdge` `:178` · `markRead` `:202` — ALIVE. **`getActions`** `usePaletteData.ts:92` → `[]`. **`pullEntity`** `actions.ts:99` — THROWS. `search` — THROWS | **MOSTLY ALIVE** |

### 7.1 The live layer, badge by badge

This is the one subsystem where the verdict genuinely differs per component:

| Component | Source of truth | Verdict |
|---|---|---|
| `PresenceAvatars` | `getPresence().viewers` | **DEAD** — always `[]` |
| `TypingIndicator` | `subscribePresence` | **DEAD** — the channel is a no-op |
| `StalenessBadge` | computed client-side from the entity's own `version` vs a pinned version (`useLive.ts:43` `getEntity`) | **display ALIVE**, but its RE-PULL action calls `pullEntity` → **THROWS** |
| `BlockedBadge` | entity `badges.blocked` from `getEntity`/`queryCollection` | **ALIVE** |
| `WorkingPulse` / `WorkingAggregate` | entity `badges.workingActors` | **ALIVE where the server populates it**; note `team_member.state.liveWork` is HOLLOW |
| `toast.tsx` / `ToastViewport` | local store, mounted at `CollabV2App.tsx:176` | **ALIVE** — and it is what every dead write surfaces through |

So the live layer is not uniformly dead: the badges derived from durable entity fields work; the
two derived from the presence channel do not.

### 7.2 The command palette

`CommandPalette.tsx` (396) + `actions.ts` (478) + `usePaletteData.ts` + `recents.ts` + `types.ts`.
Opened by `⌘K` from anywhere including the composer (`shell/keyboard.ts:87-93`); rendered only
while `paletteOpen` (`ShellLayout.tsx:92`).

Sources, in the order `actions.ts:6` documents: ① `facade.getActions(contextEntityId)` — the
backend's context-aware list, **returns `[]`** — ② locally-composed actions ③ recents.

| Section | Contents | Verdict |
|---|---|---|
| **Go to** | one entry per view, `` `Go to ${label}` `` with hint `` `g ${view[0]}` `` (`:363`, `:384`) | **ALIVE** (hint is wrong for Team/Tracking — §2.4) |
| **Set status** | 6 choices from `WORK_STATUS_CHOICES` (`:63-68`): Open · Pulled · Working · In review · Blocked · Cancelled → `patchTask` (`:112`) | **ALIVE** |
| **Set status** | `Complete task…` (`:397`) → `completeTask` (`:126`) | **ALIVE**, provided `completerIds` is non-empty |
| **Edge type** | 7 types from `EDGE_TYPE_CHOICES` (`:45-51`): `depends_on` · `assigned_to` · `attached_to` · `tracks` · `equips` · `relates_to` · `copy_of`, plus a free-text `Custom edge "…"` (`:415`) → `createEdge` (`:178`) | **ALIVE** |
| **Create** | one entry per `paletteCreatableKinds()` (`:431`) → `createEntity` | **ALIVE** |
| **Context actions** | `ctx-open` (panel), `ctx-pin` (split), `ctx-promote` (full view) (`:297`, `:302`, `:314`) | **ALIVE** — pure nav |
| **Context actions** | `ctx-repull` (`:327`) → `pullEntity` | **DEAD, throws** |
| **Context actions** | `ctx-mark-read` (`:335`) → `markRead` | **silent no-op — succeeds, does nothing** |
| **Entities** | recents / known entities (`:448`) — `search` is deferred so the palette runs on recents instead | **ALIVE** |

The palette is, after the Z3 panel, the most functional surface in the app: `Go to`, `Set status`,
`Edge type`, `Create` and the nav context actions all work against the real server.

---

# 8. Kit + tokens

## 8.1 Kit primitives (`collab-v2/kit/`)

| File | Primitive |
|---|---|
| `Avatar.tsx` | actor avatar |
| `Eyebrow.tsx` | the uppercase, letter-spaced micro-label used above every section |
| `IconBtn.tsx` | icon button with `active` / `disabled` states — the panel chrome and the sim toggle |
| `Kbd.tsx` | keycap glyph, used in hint copy |
| `Pill.tsx` | the status pill; `PillTone` + `pulse` — the app's single most-used status primitive |
| `Popover.tsx` + `PopoverProvider` | the popover layer, mounted outermost at `CollabV2App.tsx:155` |
| `listKeyNav.ts` | arrow-key roving helper (L0 so subsystems need not import upward from `shell`, per DEF-15, `shell/keyboard.ts:17-19`) |
| `kit.css` | primitive styles |

## 8.2 `tokens.css` — the visual language

Three fonts, and the pairing is the signature: a **serif** for editorial text, a **grotesk** for UI,
a **mono** for identifiers and metadata.

```
--pn-serif: 'Newsreader', Georgia, 'Times New Roman', serif        :56
--pn-ui:    'Hanken Grotesk', system-ui, -apple-system, …          :57
--pn-mono:  'JetBrains Mono', ui-monospace, 'SF Mono', 'Menlo'     :58
```

**Palette — warm paper, not grey.** Light mode is a cream/ink scheme with a burnt-orange brand,
not the usual blue-on-white:

| Token | Light (`:12-37`) | Dark (`:121-144`) |
|---|---|---|
| `--pn-paper` | `#F4F2EC` | `#15130E` |
| `--pn-surface` | `#FBFAF6` | `#1B1810` |
| `--pn-card` | `#FFFFFF` | `#221E15` |
| `--pn-hover` / `--pn-active` | `#F2EFE8` / `#ECE8DF` | `#262117` / `#302A1D` |
| `--pn-line` / `--pn-line-2` | `#E7E3D9` / `#D8D3C6` | `#2C2719` / `#3B3524` |
| `--pn-ink` … `--pn-ink-4` | `#23201B` `#5B564C` `#8E897B` `#B7B2A4` | `#EFE9DB` `#BDB5A2` `#8C8470` `#665E4C` |
| `--pn-brand` / `-2` / `-soft` | `#B26A2B` / `#9A581F` / `rgba(178,106,43,.11)` | `#E0A45A` / `#C98A3E` / `rgba(224,164,90,.15)` |

**Status colours** — five semantic pairs, each with a `-soft` fill for pill backgrounds
(`:33-37`, `:140-144`):

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--pn-run` | `#3E8E5A` | `#5CB381` | working / running |
| `--pn-wait` | `#BD8A2A` | `#D9AA49` | waiting / pulled |
| `--pn-block` | `#BB4D3D` | `#DA7D6A` | blocked / failed |
| `--pn-info` | `#3F6C90` | `#6F9FC7` | review / info |
| `--pn-idle` | `#A29C8E` | `#7A7360` | idle / neutral |

**Scales.** Type: `display 40 · h1 28 · h2 22 · h3 18 · title 15 · body 14 · sm 13 · label 12 ·
micro 11 · mono 12.5` (`:60-69`), line-heights `1.18 / 1.35 / 1.5` (`:71-73`), tracking
`mega .12em · label .06em · tight -.01em` (`:75-77`). Space: `4 8 12 16 20 24 32 40 48 64`
(`:80-89`). Radii: `xs 5 · sm 7 · md 10 · lg 14 · pill 999` (`:92-96`). Shadows: three tiers,
warm-tinted in light (`rgba(40,34,24,…)`) and black in dark (`:99-101`, `:146-148`). Motion:
`ease-out cubic-bezier(.16,1,.3,1)`, `ease-standard cubic-bezier(.4,0,.2,1)`, durations
`120 / 180 / 280 ms` (`:104-108`).

**Dark mode exists** as a full token override block (`:121-148`).

Note that `real/`'s own components (`SpacePicker`, `ModeBanner`, `SpawnDialog`, `SessionTerminal`)
use inline styles with `var(--pn-*, <hardcoded fallback>)` — they reference some tokens but do
not adopt the type scale, so they read as a separate visual system.

---

# 9. Tests

`src/collab-v2/__tests__/**` — **60 files, 534 `it(`/`test(` calls** (counted). Groups:
`acceptance/` (7) · `collections/` (8) · `entity/` (6) · `foundation/` (11) · `interactions/` (7) ·
`palette-live/` (4) · `rail-reactions/` (5) · `screens-a/` (4) · `screens-b/` (5) ·
`screens-c/` (4) · `shell/` (4) · `thread/` (4).
Plus `src/real/__tests__/mapping.test.ts` (234) and `src/real/terminal/{ptyTransport,writeScheduler}.test.ts`.

## 9.1 🚩 FINDING 9.1 — no test in the module ever touches the real server path

```
$ grep -rn "RealFacade|real/" src/collab-v2/__tests__/
(no matches)
```

Every one of the 534 module tests runs against `MockFacade`. `acceptance/helpers.tsx:31` imports
`createSeededWorld, MockFacade` from `../../mock`, and `renderApp` mounts the real provider tower
with three test-only substitutions (`helpers.tsx:5-11`): a latency-0 seeded facade on a
`ManualClock`, `createMemoryTarget` instead of `window.location`, and an explicit `spaceId`.

The **only** coverage of the tm8 integration is `src/real/__tests__/mapping.test.ts` (234 LOC),
which asserts the facade-mapping contract itself — e.g. `isUnavailable('markRead') === false` vs
`isUnavailable('markNotificationRead') === true` (`:194-195`), `isHollow('channel.state.unreadCount')`
(`:207`), `hollowReason('member.state.taskDoneCount')` matching `/always 0/` (`:209`).

**Implication for this audit:** the 534 green tests prove the module is *built*, not that any of it
*works against tm8*. Every screen verdict in §3 is therefore invisible to the suite — a screen can
be fully blank in real mode and 100 % green in CI.

## 9.2 The five golden workflows (`acceptance/`)

| File | Workflow | Harness |
|---|---|---|
| `w1-author-and-stage.test.tsx` (192) | author and stage work | MockFacade |
| `w2-agent-pulls-and-works.test.tsx` | an agent pulls and works | MockFacade |
| `w3-ship-and-review.test.tsx` (270) | ship and review | MockFacade |
| `w4-knowledge-grows.test.tsx` | knowledge grows | MockFacade |
| `w5-orient-a-newcomer.test.tsx` (174) | orient a newcomer | MockFacade |
| `states-and-offline.test.tsx` | loading / empty / error / offline states | MockFacade (`setConnected`) |
| `gaps-static.test.ts` (198) | static assertions about known gaps — e.g. that no screen consumes the connection store (`:51-56`) | static source scan |

`acceptance/helpers.tsx:12-17` records a defect of its own: `CollabV2App.tsx` exports only the
component, so `VIEWS` and `PanelBody` are module-private and the harness must **re-assemble an
identical composition** from the same view modules. `appViewRegistryParity` pins the two together
by kind and count so drift fails the suite — a real safeguard, but it means the acceptance tests
do not exercise the actual app root.

`w2` ("an agent pulls and works") is worth flagging: it is driven entirely through
`pullEntity` + `placements` + presence, **all three of which are dead on tm8**.

## 9.3 The purity tests — the architectural rules that are actually enforced

| Test | Rule |
|---|---|
| `entity/registry-purity.test.ts` (218) | **Behaviour may not branch on entity kind outside `registry/`.** Recursive source scan; flags `kind === 'x'`, `case 'x'`, `[…].includes(x.kind)`, `Record<EntityKind,…>` dispatch. Escape hatch is a grep-able `// registry-purity: allow — <reason>` comment (one live use at `shell/useShellData.ts:61`). Current debt: **zero**. |
| `foundation/seam-purity.test.ts` | No backend-vendor or auth concept may appear anywhere in `collab-v2` (DEV-12) |
| `foundation/kit-layering.test.ts` | Layer discipline — `kit` (L0) may not import upward (DEF-15) |
| `screens-a/composition-purity.test.ts`, `screens-b/purity.test.ts`, `screens-c/screens-purity.test.ts` | Screens are composition over L1/L2/L4 only |

These are the reason the transplant's import-path pass was a verified no-op: the module was built
under an enforced rule that it may not reach outside itself.

## 9.4 What the other groups pin

| Group | What is actually asserted |
|---|---|
| `shell/` | router hash round-trip + memory-target back/forward walks; the keyboard map driven with plain objects; panel-stack pin cap, promote, breadcrumb pop |
| `entity/` | chip/card rendering per kind; the Z3 tab set; tombstone + Z4; registry completeness |
| `collections/` | board drag, tree, group-by parity across layouts, row slots, saved views, the graph model |
| `interactions/` | the grammar table row-by-row, create, promote, dnd, placements, conflict handling |
| `thread/` | message body parsing, virtualization, thread behaviour |
| `rail-reactions/` | rail model + reactions model and components |
| `palette-live/` | palette actions, palette keyboard, the live layer |
| `foundation/` | commands, connection, contract reads, home presets, reconciliation, simulation, store replay, validation |

## 9.5 The mock world

| File | LOC | Role |
|---|---|---|
| `mock/world.ts` | 2 460 | the seeded graph itself |
| `mock/seed.ts` | 433 | seed construction |
| `mock/MockFacade.ts` | 276 | full `CollabFacade` over the world, incl. `queryGraph` (`:215`) and `setConnected` |
| `mock/validate.ts` | 350 | invariant checks on the seeded world |
| `mock/simulation.ts` | — | a stepped driver that emits synthetic `WorkspaceEvent`s (the ▶/◼ toggle) |
| `mock/internal.ts` | 227 | shared internals |

Per FINDING 1.3 the whole package is statically imported by `CollabV2App.tsx:95` and therefore
ships in the production bundle.

---

# 10. Summary — the alive/dead map in one place

| Surface | Verdict against a real tm8 server |
|---|---|
| Boot, space picker, mode banner | **ALIVE** — four distinct, honest pre-shell states |
| Shell chrome, rails, router, keyboard, panel stack | **ALIVE** — layout and navigation are fully functional |
| **Z3 `EntityPanel`, all four tabs** | **ALIVE** — Content, Discussion, Connections, Activity all carry real data |
| Command palette (Go to / Set status / Edge type / Create / nav) | **ALIVE** |
| Create flows (`createEntity`) | **ALIVE** |
| Tasks board + tree, docs tree, team cards, tracking rows, members list | **ALIVE** (populated by `queryCollection`) |
| Thread read + post | **ALIVE** |
| Spawn → terminal → prompt → terminate | **ALIVE** (one modal, one entry point, no way back) |
| Home | **PARTIAL** — columns populate for the viewer only; agent-owned work never counts; PULL throws |
| Channel | **PARTIAL** — thread and header alive; no auto-tabs, no pinned, no unread; Z4 unreachable by URL |
| Docs | **PARTIAL** — tree and create alive; version history permanently blank |
| Settings | **MOSTLY BLANK** — profile + members alive; invites and task axes dead |
| Tracking | **STRUCTURALLY ALIVE, EMPTY** — nothing can create a PR |
| Team org trees, "working" tally, done counts | **HOLLOW** — always empty / always 0 |
| **Inbox** | **FULLY BLANK** |
| **Leaderboard + awards** | **FULLY BLANK** |
| **Reactions + points** | **FULLY DEAD** |
| **Presence + typing** | **FULLY DEAD** |
| **Drag-and-drop — all 7 grammar rows, 5 surfaces** | **FULLY DEAD** via one line (`execute.ts:90`) |
| **Undo (pill + ⌘Z)** | **UNREACHABLE** — needs a placement success that cannot happen |
| **Saved views** | **FULLY DEAD** — list empty, save throws |
| **Graph view + `GraphCanvas` (~1 000 LOC, 2 deps)** | **DEAD *and* UNREACHABLE** |
| **Feed + Gallery layouts** | **UNREACHABLE** (no layout switcher renders) |
| `ProfileZ4View`, `PlaceholderPanelBody`, `PLACEHOLDER_VIEWS`, `settings`/`square` icons | **DEAD CODE** — never mounted |

## 10.1 The findings this pass would most want carried forward

1. **FINDING 0.1** — the honesty register (`capabilities.ts`) has zero production call sites, so
   nothing is gated and no emptiness is captioned. The banner's claim "or disabled" is untrue.
2. **FINDING 6.1** — one line (`execute.ts:90`) kills the entire drag-drop grammar. This is the
   highest leverage single point in the whole audit.
3. **FINDING 3.1** — no auto-tabs ⇒ no layout switcher ⇒ Feed, Gallery and Graph are unreachable,
   not merely empty. ~1 000 LOC and two npm dependencies with no route to them.
4. **FINDING 1.1** — the entire execution product is one event-driven modal with no session list
   and no way back to a running PTY.
5. **FINDING 9.1** — 534 green tests, zero of which touch the real server path. Every verdict in
   §3 is invisible to CI.
6. **FINDING 4.1** — `registryFor` has no fallback; the contract supports `c:*` custom kinds and
   the first one white-screens the app.
7. **FINDING 1.3** — ~4 000 lines of mock world ship in the production bundle via a static import.
8. **FINDING 1.2** — the `work_session` panel's copy denies the terminal exists.
9. **FINDING 2.2** — `graph` has no screen; `ProfileZ4View` is built and never mounted.
10. Home's actor roster is sourced from `getLeaderboard` (`useViewerActors.ts:28`), so a dead
    leaderboard silently breaks Home's *"an agent's work counts as its owner's work"* premise.
