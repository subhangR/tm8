# A — Exhaustive inventory of the tm8 UI (as it exists today)

**Scope:** `/Users/subhang/Desktop/Projects/tm8/packages/ui`
**Method:** every file under `src/real/**` and `src/collab-v2/**` read directly (no graph — tm8 has none). Live probes against the running dev server.
**Date:** 2026-07-25. **Nature:** factual map only. Gaps/opinions are another worker's deliverable; where something is *dead or unreachable* that is stated as fact, not judgement.

---

## 0. Orientation — the two halves and the live numbers

The UI package is **two codebases stitched at one seam**:

| Half | Path | Origin | Size |
|---|---|---|---|
| The **module** | `src/collab-v2/**` (270 files) | Verbatim `git archive` snapshot of `maestro-ui/src/collab-v2/` at SHA `b422978` on `feat/collab-v2-ui`, built entirely against **mock data** | ~26,600 lines src + ~13,600 lines tests |
| The **integration layer** | `src/real/**` (16 files) + `src/main.tsx` | Written for tm8 at W3; the only code that knows a server exists | ~2,900 lines |

**Exactly two files inside the module were touched** during the transplant (per `STATE.md` §UI transplant drift ledger): `CollabV2App.tsx` (optional `{facade, spaceId, banner}` props + gating the sim toggle on the mock existing) and the host `tsconfig.json`. Everything else is byte-identical to the mock-era build. The import-path pass was a verified no-op — the module has zero imports escaping itself.

### Live probe (executed 2026-07-25)

| Probe | Result |
|---|---|
| `GET http://127.0.0.1:4611/` | `200`, serves `index.html` → `<div id="collab-v2-root">` + `/src/main.tsx` (`packages/ui/index.html:18-19`) |
| `GET :4620/health` | `{"ok":true,"server":"tm8-server","contractVersion":"0.1.0","operations":80,"implemented":28}` |
| `GET :4610/health` | identical (`operations":80,"implemented":28`) |
| `GET :4611/v2/spaces` (through the Vite proxy) | Real data — but every space is a **conformance-suite leftover**: `conf-projects-…`, `conf-idem-…`, `conf-cursors-…`, `conf-files-…`, `conf-exec-…`, `conf-events-…`, `conf-reads-…`, each `memberCount:1`, `unreadTotal:0`, `description:""` |

**28 of 80 catalog operations are implemented server-side.** The UI mirrors that arithmetic itself: `src/real/capabilities.ts:29-66` lists 12 unimplemented reads + 21 unimplemented writes = **33 facade methods with no server behind them**, surfaced to the user in the banner as "*N operations not built on this node*" (`ModeBanner.tsx:58`).

### Vite host (`packages/ui/vite.config.ts`)

- Port **4611**, `strictPort`, bound `127.0.0.1`.
- Proxies `/v2` → `process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:4620'` **with `ws: true`** (required — `/v2` carries both the workspace event socket and the per-session PTY socket, told apart by `?sessionId=`), and `/health`.
- Same-origin by design: tm8-server binds loopback only and ships no CORS headers, so a direct cross-origin fetch would be refused by the browser. `RealFacade` therefore carries **no base URL** (`TmClient` constructor defaults `baseUrl = ''`).
- A comment at `vite.config.ts:32-33` records that the old `/pty` proxy entry (the interim 500 ms scrollback poll) has been **removed**.
- Dependencies of note: `@dnd-kit/core`, `@xyflow/react` + `dagre` (the graph canvas), `@xterm/xterm`, `react-markdown` + `remark-gfm`, `react-mentions`, `zustand`. No icon library — the shell hand-draws 15 SVG glyphs.

---

## 1. Entry point + the `real/` integration layer

### 1.1 What the app boots into — `src/main.tsx` (113 lines)

```
installTm8Kinds()                        ← main.tsx:28, BEFORE first render
const useMock = ?mock in query string    ← main.tsx:30
createRoot(#collab-v2-root).render(<StrictMode><Root/></StrictMode>)
```

`Root()` (`main.tsx:94-107`) is a **two-world switch**:

| URL | Path taken | Mounts |
|---|---|---|
| `http://localhost:4611/` (default) | `<RealApp facade={createRealFacade()}/>` | `RealFacade` over the live server |
| `http://localhost:4611/?mock` | `<CollabV2App banner={mock ModeBanner}/>` — **no `facade` prop at all** | The snapshot's *original* path: builds its own seeded world, derives its own space id, keeps the simulation driver |

The `?mock` branch deliberately passes no facade (`main.tsx:96-99`): "Passing the mock in explicitly would work but would silently drop the simulation control, so the default is used on purpose."

`installTm8Kinds()` runs **before render** and the comment says why (`main.tsx:25-27`): the shell resolves kinds through `registryFor()`, which has **no fallback**, so a `work_session` reaching a chip before registration is a white screen, not a degraded card.

### 1.2 The boot state machine — `RealApp` (`main.tsx:38-92`)

```ts
type Boot = { phase:'loading' } | { phase:'ready'; spaces } | { phase:'failed'; message }
```

- `facade.subscribeConnection(setConnected)` on mount (`:43`).
- `load()` calls `facade.listSpaces()` (`:47`); on success it reads a **space deep-link out of the hash** — `window.location.hash.match(/space=([0-9a-f-]+)/i)` — and *validates it against the server's list* rather than trusting it (`:53-55`): "a stale hash must not mount the shell on a space id that no longer exists." Falls back to `spaces[0]`.
- Until `phase==='ready' && spaceId`, it renders `<ModeBanner/> + <SpacePicker/>` (`:67-79`). Only then does the shell mount.

### 1.3 The actual top-level layout a user sees at localhost:4611

```
┌──────────────────────────────────────────────────────────────────────┐
│ ModeBanner  — "REAL SERVER" · "tm8 catalog over /v2 (proxied)"       │  main.tsx:64
│              · "33 operations not built on this node…"               │  ModeBanner.tsx:56-61
├──────────────────────────────────────────────────────────────────────┤
│ [IconRail 56px] [LeftRail 232px] [CenterHost flex:1] [pins] [panel]  │  ShellLayout.tsx:86-94
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ToastViewport (fixed)                                                │  CollabV2App.tsx:176
└──────────────────────────────────────────────────────────────────────┘
  + SpawnDialog (fixed full-screen overlay, event-driven)                 main.tsx:89
  + CommandPalette (rendered only while nav.paletteOpen)                  ShellLayout.tsx:92
  ✗ simulation toggle — HIDDEN in real mode (CollabV2App.tsx:180)
```

`CollabV2App` (`CollabV2App.tsx:154-206`) wraps everything in `PopoverProvider → CollabFacadeProvider → CollabDndProvider`, and:
- builds the seeded mock **only when no facade is injected** (`:137`) — "building a seeded world behind a live server would waste the work and, worse, leave fabricated entities one mistaken reference away from the screen";
- `connectStores(facade, spaceId)` (`:144`) and `startRecentsTracker()` (`:145`);
- gates the sim control on `simulation != null`, i.e. mock-only (`:180`).

### 1.4 The `real/` files, one by one

| File | Lines | What it is |
|---|---|---|
| `RealFacade.ts` | 476 | `implements CollabFacade, ConnectionControl, ExecutionControl` |
| `TmClient.ts` | 138 | HTTP transport: DEV-6 envelope unwrap + error-taxonomy mapping |
| `events.ts` | 147 | `EventPoller` — `subscribe()` is a **1500 ms poll**, named as such |
| `capabilities.ts` | 127 | The honest gap register (`UNIMPLEMENTED`, `HOLLOW_FIELDS`) |
| `tm8Kinds.tsx` | 250 | Runtime KindRegistry extension: `work_session`, `collection`, + task "Spawn agent" |
| `SpawnDialog.tsx` | 256 | Spawn an agent on a task → live terminal |
| `SessionTerminal.tsx` | 179 | xterm instance, sizing + input |
| `SpacePicker.tsx` | 114 | Four distinct pre-shell states |
| `ModeBanner.tsx` | 69 | Permanent real/mock/offline banner |
| `terminal/ptyTransport.ts` | 534 | One WebSocket per session, offset resume |
| `terminal/runtime.ts` | 108 | Joins transport + scheduler + visibility driver |
| `terminal/writeScheduler.ts` | 160 | rAF coalescing, hidden-terminal throttle |
| `terminal/visibilityDriver.ts` | 159 | Suspend offscreen terminals (warm LRU) |
| `__tests__/mapping.test.ts` | 234 | 16 tests — the **only** RealFacade coverage |
| `terminal/ptyTransport.test.ts` | 228 | 12 tests |
| `terminal/writeScheduler.test.ts` | 122 | 5 tests |

**`TmClient`** (`TmClient.ts`): unwraps `{data, requestId}` → bare payload (`:124`); maps tm8 error codes onto the UI's **frozen** `CommandErrorCode` set (`KNOWN_CODES`, `:26-30`); tm8-only `limit_exceeded` → `rate_limited` preserving `details.tm8Code` (`:40`, `:51-52`); unrecognised code → `upstream_unavailable`, 404 → `not_found` (`:56`); a thrown fetch sets `connected=false` (`:108`) which drives the offline banner.

**`events.ts`**: `EventPoller` polls `GET /v2/spaces/:id/events?since=<seq>` every **1500 ms** (`DEFAULT_INTERVAL_MS = 61`… line `:61`), primes immediately on first subscribe (`:98`), and synthesises the snapshot's `eventId` as `` `${spaceId}:${seq}` `` (`:53`) because tm8 replaced `eventId` with the AM-2 §3 envelope. Cursor discipline: advances to **max observed seq**, preferring a server `nextCursor`; a failed poll does **not** advance (`:136-141`). Presence/typing events are filtered out as non-durable (`:57-59`).

**`capabilities.ts`** — three registers:
- `UNIMPLEMENTED.reads` (12): `getVersions, getPresence, queryGraph, getChannelTabs, getInbox, getLeaderboard, getAwards, getTaskAxes, getSettings, listSavedViews, search, getActions`.
- `UNIMPLEMENTED.writes` (21): `moveEntity, deleteEntity, patchEdge, deleteEdge, placements, undo, patchMessage, deleteMessage, setReaction, grantPoints, pullEntity, linkPr, trackingRefresh, markNotificationRead, createTaskAxis, updateTaskAxis, deleteTaskAxis, createSavedView, updateSavedView, deleteSavedView`.
- **`HOLLOW_FIELDS` (13)** — the third and most dangerous class: present, typed, permanently zero. `channel.state.unreadCount`, `space.unreadTotal`, `navigation.unreadTotal`, `member.state.taskDoneCount`, `team_member.state.liveWork`, `channel.content.autoTabs`, `channel.content.pinned`, `member.content.teamMembers`, `member.content.work`, `team_member.content.equipped`, `team_member.content.work`, `work_session.content.workingOn`, `work_session.content.transcriptDoc`. Helpers `isHollow()`/`hollowReason()` exist — **and no screen calls either of them** (grep: consumers are `mapping.test.ts` only).

**`tm8Kinds.tsx`** — registers two kinds the snapshot's `EntityKind` union does not contain, using only the module's exported surface (`KIND_REGISTRY` mutation + `KIND_ORDER.push`, `:218-223`), idempotent for StrictMode (`:208`, `:214`):

| Kind | glyph | tint | Z2 SummaryFields | Z3 Content | Z4 | primaryActions |
|---|---|---|---|---|---|---|
| `work_session` | `▶` | green if `running`, red if `failed`, else ink | status + started/exited HH:MM:SS | status / tool / model + a paragraph | `generic` | **Prompt** (`promptSession` via `window.prompt`), **Terminate** — both hidden once `exited`/`failed` (`:142`) |
| `collection` | `▤` | ink | `collectionType` | `type:` row | `generic` | none |

It also **monkey-patches the task entry** (`:230-244`), appending a `tm8-spawn` "Spawn agent" action that only `window.dispatchEvent(new CustomEvent('tm8:spawn-request', {detail:{taskId, spaceId}}))` — deliberately not guessing a project.

> **Stale-comment finding:** `work_session`'s `Content` renderer still prints, verbatim, *"No terminal stream: this tm8 node exposes no PTY route yet, so session output cannot be shown. Status above is polled from the entity itself."* (`tm8Kinds.tsx:111-114`). That is **no longer true** — `SessionTerminal` streams a real PTY over `/v2/ws?sessionId=`. So opening a `work_session` in a Z3 panel shows a paragraph denying a terminal exists, while the SpawnDialog shows one.

**`SpawnDialog.tsx`** — the only place the execution family is reachable. Listens for `SPAWN_REQUEST_EVENT` (`:92`), then loads `facade.listProjects()` and `facade.queryCollection({kinds:['team_member'], limit:50})`. Pre-selects only when there is exactly one trusted project / one member (`:82-83`, `:89`). Untrusted projects are rendered **disabled with the reason** ("untrusted — spawn refused", `:188`). On spawn it swaps from a 560px dialog card to a `min(1500px,96vw) × 94vh` **session card** (`:45-51`) containing a `SessionStatusPill`, the session id, `<SessionTerminal fill/>`, and Prompt/Terminate buttons. Session status is **polled every 1500 ms** via `facade.getEntity` (`:98-107`).

**`SessionTerminal.tsx`** — DOM renderer, **no addons**, `scrollback: 5000`, `cursorBlink: true`; `computeFit()` reads xterm's private `_core._renderService.dimensions.css.cell` rather than adding `@xterm/addon-fit` (dependency-light policy, `:36-44`); resize debounced through rAF + `ResizeObserver`; keystrokes go out as binary frames with **no local echo** (`:93`).

**`terminal/`** — module-level singletons shared by every mounted terminal. `ptyTransport` is a byte-identical port of maestro's shipped socket; offsets are **raw byte counts** and the client snaps to `attached.next` rather than `base + replay.length` (the replay is sanitised and shorter). Resets on changed `epoch`, on `gap > 0`, or (only absent an epoch) the legacy base-rewind heuristic. `writeScheduler`: visible terminals flush once per animation frame, hidden ones at most once per `HIDDEN_FLUSH_INTERVAL_MS = 1000`, force-flush past `MAX_BUFFERED_BYTES = 1<<20`, **never drops**. `visibilityDriver`: `HIDE_GRACE_MS = 10000`, `RECONCILE_INTERVAL_MS = 2000`, `WARM_LRU_SIZE = 3`; reads DOM computed `visibility`, never React state.

> **Present-but-inert:** the visibility driver's benefit is currently unobservable because **the app mounts exactly one terminal** (inside `SpawnDialog`). `STATE.md` records this as a known parked item.

### 1.5 What is reachable from the real entry vs mock-only

| Surface | Real (`/`) | Mock (`/?mock`) |
|---|---|---|
| `ModeBanner` | ✅ green "REAL SERVER" / red "UNREACHABLE" | ✅ amber "MOCK DATA — NOT A REAL SERVER" |
| `SpacePicker` (4 states) | ✅ | ❌ never rendered |
| `SpawnDialog` + `SessionTerminal` + PTY WS | ✅ | ❌ `main.tsx:101-104` mounts no dialog |
| Simulation toggle (`▶`/`◼` + step counter) | ❌ gated off (`CollabV2App.tsx:180`) | ✅ |
| `#/gallery` QA route (`Gallery` + `ThreadGallery`) | ⚠️ route works, but `Gallery` builds **its own** `createSeededFacade()` (`Gallery.tsx:72`) and depends on `facade.ids` — **mock-only by construction**, unusable against real data | ✅ |
| The whole `collab-v2` shell + 11 screens | ✅ mounted | ✅ mounted |

---

## 2. Shell — `src/collab-v2/shell/`

### 2.1 Layout regions (`ShellLayout.tsx:86-94`) — **flex, not grid**

`.cv2-shell` is `display:flex; height:100%; overflow:hidden` (`shell.css:3-12`). Left → right:

| # | Region | Selector | Width | Source |
|---|---|---|---|---|
| 1 | Icon rail (spaces) | `.cv2-iconrail` | `56px`, `flex:none` | `shell.css:17-27` |
| 2 | Left rail (space nav) | `.cv2-leftrail` | `232px`, `flex:none` | `shell.css:82-90` |
| 3 | Center host | `.cv2-center` | `flex:1; min-width:0; overflow-y:auto` | `shell.css:152-159` |
| 4 | Pinned splits (0–3) | `.cv2-panel--pinned` | `flex:1 1 0; min-width:320px` | `shell.css:227` |
| 5 | Stacked peek panel | `.cv2-panelstack > .cv2-panel` | `440px`, `flex:none` | `shell.css:205,216-226` |
| 6 | Palette | caller node, only while `paletteOpen` | — | `ShellLayout.tsx:92` |

`PanelStack` returns a **fragment** (`PanelStack.tsx:236-269`), which is how pinned panels become siblings of the center column inside the same flex row. Widest layout = center + `MAX_PINNED` = 4 columns (`MAX_SPLIT_COLUMNS = MAX_PINNED + 1`, `PanelStack.tsx:29`). A stack deeper than 1 renders an 8px `.cv2-panelstack__shim` sliver hinting at buried panels (`PanelStack.tsx:254`, `shell.css:206-215`).

**Space bootstrap precedence** (`ShellLayout.tsx:62-76`): store already has a space → bail; routable hash → `hydrateFromHash` (a deep link must win, because `setSpace` clears stack/pins); `spaceId` prop → `setSpace`; else `listSpaces()[0]` (rejection swallowed). Router only starts once a space exists (`:78-82`). Center fallback copy: **"Loading space…"**.

### 2.2 IconRail (`IconRail.tsx`, 78 lines)

| Order | Element | Action | Badge |
|---|---|---|---|
| 1 | `.cv2-iconrail__mark` — literal `>···+`, `title="Maestro"` | none | — |
| 2 | one tile per space, `initials(name)` | `setSpace(id)` (`:43`) | active → brand marker bar (`:46`); **inactive only** + `unreadTotal>0` → dot (`:47`) |
| 3 | spacer (`flex:1`) | — | — |
| 4 | Home (`Icon home`) | `setView('home')` (`:60`) | active when `view==='home'` |
| 5 | Inbox (`Icon inbox`) | `setView('inbox')` (`:72`) | `unread>0` → dot, `data-testid="inbox-unread-dot"` (`:74`) |

Data: `useSpaces` → `listSpaces`; `useUnreadInbox` → `getInbox`. **There is no Settings tile** — `settings` is reachable only via `g s` or a typed URL.

### 2.3 LeftRail (`LeftRail.tsx`, 126 lines)

- **Header:** eyebrow `space`, name (`spaces.find(...)?.name ?? spaceId ?? '—'`, `:72`), viewer row = `navigation.viewer.displayName` + `navigation.unreadTotal` badge (`:85-88`).
- **The seven primary sections** — `RAIL_SECTIONS` (`:20-28`):

| view | label | icon | badge query |
|---|---|---|---|
| `home` | Home | `home` | *(none)* |
| `tasks` | Tasks | `list-checks` | `queryCollection({kinds:['task'],limit:1}).page.total` |
| `docs` | Docs | `file-text` | `kinds:['doc']` |
| `team` | Team | `users` | `kinds:['member','team_member']` |
| `tracking` | Tracking | `git-pull-request` | `kinds:['pull_request']` |
| `graph` | Graph | `share-2` | *(none)* |
| `leaderboard` | Leaderboard | `trophy` | *(none)* |

  `extraSections` (saved views shared into a space) append after the seven (`:76`) and bring their own badge — **no caller ever passes `extraSections`**.
- **Channels:** recursive `ChannelRow` (`:30-56`) over `navigation.channels`; indent `10 + depth*12`; `hash` icon; a green working dot when `workingAgentCount>0`; an unread count badge. Click → `setView('channel', id)`.
- Empty: **"No channels yet — ⌘K to create one."** (`:121`).
- Route sensitivity: a section is active iff `view===section.view && !entityId` (`:98`) — an entity Z4 route de-highlights every section.

### 2.4 CenterHost (`CenterHost.tsx`, 43 lines) — the route→screen dispatch

```ts
if (!spaceId) return <main className="cv2-center cv2-center--empty">{fallback}</main>;   // :33
const View = views[view] ?? PlaceholderView;                                             // :35
```
Every screen receives `ShellViewProps = { facade, spaceId, view, entityId, onOpenEntity, onNavigate }` (`types.ts:14-24`). `onOpenEntity(id)` → `pushPanel({entityId:id})` — **clicking a card peeks a Z3 panel, it does not navigate** (`:28-31`).

**The live mapping** (`CollabV2App.tsx:82-93`) — all 11 views resolve to a real screen:

| route | component | source |
|---|---|---|
| `home` | `HomeScreen` | `screens/home` |
| `inbox` | `InboxScreen` | `screens/inbox` |
| `tasks` | `TasksScreen` | `screens/tasks` |
| `docs` | `DocsScreen` | `screens/docs` |
| `team` | `TeamScreen` | `screens/team` |
| `leaderboard` | `LeaderboardScreen` | `screens/leaderboard` |
| `channel` | `ChannelHub` | `screens/channel` |
| `tracking` | `TrackingScreen` | `screens/tracking` |
| `settings` | `SettingsScreen` | `screens/settings` |
| `entity` | `EntityZ4Route` | inline, `CollabV2App.tsx:64-80` |
| `graph` | **→ `PlaceholderView`** | no `graphViews` fragment exists |

> **`graph` is the one route with no screen.** The LeftRail offers it as one of seven primary sections and `g g` jumps to it, and it lands on the data-backed placeholder. (The real `GraphCanvas` exists but is reachable only through a channel tab's layout switcher — see §5.)

`ProfileZ4View` (`screens/team/ProfileZ4View.tsx`, 49 lines) is exported as an optional `profileViews` fragment but **is not wired** — `CollabV2App.tsx:92` claims the `entity` route with its own `EntityZ4Route`. Its own header says to wire it only if nothing else claims that route. **Dead in the shipped app.**

### 2.5 PanelStack (`PanelStack.tsx`, 271 lines)

| Gesture | Store action | Semantics |
|---|---|---|
| click a chip/card anywhere | `pushPanel({entityId})` | Z3 panel peeks over the right edge |
| click a chip **inside** a panel | `pushPanel` again | stacks; breadcrumb grows |
| 📌 pin | `pinPanel(id)` | moves ref `stack` → `pinned`, docks as a split |
| ⤢ promote | `promotePanel(id)` | `view:'entity'`; center view becomes the back target |
| ⌫ / Esc / swipe-right | `popPanel()` | pops the top |

Store semantics (`stores/nav.ts:82-117`): `pushPanel` de-dupes by id first (`:83`); `{replace:true}` swaps the top instead of growing (`:84-86`). **`MAX_PINNED = 3`** (`nav.ts:18`) → `MAX_SPLITS = 3`. **The stack itself has no depth cap.** `pinPanel` returns `true` if already pinned, `false` when capped. Only the **top** of the stack is mounted (`:233`, `:252`) — panels beneath are not rendered.

Chrome (`:154-194`): breadcrumb `aria-label="Panel stack"` (pinned = one static crumb; stacked = the full trail with `chevron-right` separators, each crumb popping back to it via `onPopTo`), then three `IconBtn`s — pin (`aria-label` becomes `` `Split limit reached (3 splits)` `` when capped, `disabled`), promote (`maximize-2`), close. A refused pin flashes a `role="status"` warning **"3 splits max — unpin one first."** for **1600 ms** (`:97-104`, `:188-192`). Swipe-right pop: `SWIPE_POP_PX = 64`, requires `dx>64 && |dy|<dx`, ignored for pinned panels (`:113-126`).

Panel bodies arrive through `renderPanel(slotProps)`; `PanelSlotProps` (`types.ts:34-55`) carries `entityId, tab, mode, depth, facade, onOpenEntity, onClose, onPin→boolean, onUnpin, onPromote, onTabChange, canPin, isPinned`. The app supplies `PanelBody` (`CollabV2App.tsx:37-56`) = `DropSurface(surfaceForEntity) → EntityPanel` with `discussion` and `connections` slots.

### 2.6 router.ts (187 lines) — hash grammar and its one asymmetry

`ViewName` = `home | tasks | docs | team | tracking | graph | leaderboard | inbox | settings | channel | entity` (`nav.ts:20-24`).

```
#/s/{spaceId}/{view}                     primary view
#/s/{spaceId}/e/{entityId}               entity AND channel Z4 routes
  ?p=id1.id2      panel stack (bottom→top, '.'-joined)
  &pin=id3        pinned splits
  &t=id:tab,…     active panel tabs
```

- `isRoutableHash` (`:28-32`): requires `segs[0]==='s' && segs[1]`. So `#/` and `#/gallery` are non-routable and the router ignores them.
- Transports: `createBrowserTarget` (hashchange + `replaceState`) and `createMemoryTarget` (full in-memory back/forward stack — test double).
- `startRouter` (`:121-167`): routable initial hash → hydrate then **re-publish normalized** with `{replace:true}` (because hydration truncates pins past the cap); else `opts.fallbackHash`; else publish the store. Store→URL is gated by `routeKey = JSON.stringify([spaceId, view, entityId, stack, pinned])` (`:102-104`) — **`paletteOpen` and `selection` deliberately do not push history**; every push/pop/pin/promote does.
- `buildHash` (`:170-187`) — a **second, non-identical codec** for links/share menus. It emits `p` and `pin` but **has no `t=` tab parameter**, which `toHash` does emit (`nav.ts:137-138`).

> **Round-trip asymmetry (factual, verified in source):** `toHash` serialises `view:'channel'` as `#/s/{space}/e/{id}` (`nav.ts:131-133`), but `hydrateFromHash` maps *any* `/e/{id}` back to `view:'entity'` (`nav.ts:151-153`). `'channel'` is therefore **unreachable from a URL**: a channel deep link, reload, or back/forward lands on `EntityZ4Route` rather than `ChannelHub`, and the LeftRail channel row loses its `data-active`. Also: an unrecognised view segment silently coerces to `home` (`nav.ts:154-156`), and both codecs can emit `/e/` with an empty id when `entityId` is null.

### 2.7 keyboard.ts (169 lines) — every shortcut

Dispatch order in `createKeyboardMap.handle` (`:80-145`):

| # | Combo | Condition | Action | Consumed |
|---|---|---|---|---|
| 1 | **⌘K / Ctrl-K** | **always**, including inside inputs/composer | `togglePalette()` | ✅ |
| 2 | any other ⌘/Ctrl/Alt combo | — | pass through | ❌ |
| 3 | **Esc** | palette open | `closePalette()` | ✅ |
| 4 | **Esc** | palette closed, stack non-empty | `popPanel()` | ✅ |
| 5 | Esc | empty stack | nothing | ❌ |
| 6 | anything while `isTypingTarget` | checked *after* Esc, *before* chords | clears chord, passes through | ❌ |
| 7 | second key of a live `g` chord, mapped | — | `setView(view)` | ✅ |
| 8 | second key, unmapped | — | chord dropped (`chord.cancel`) | ❌ |
| 9 | **`g` / `G`** | not typing, no live chord | arms chord | ✅ (no `preventDefault`) |
| 10 | **⌫ Backspace** | stack non-empty | `popPanel()` | ✅ |
| 11 | ⌫ | empty stack | nothing | ❌ |

**`g`-chord jump table** — `DEFAULT_VIEW_JUMPS` (`:21-31`), window `CHORD_TIMEOUT_MS = 1200` (`:33`), second key lowercased:

| chord | view | | chord | view |
|---|---|---|---|---|
| `g h` | home | | `g g` | graph |
| `g t` | tasks | | `g l` | leaderboard |
| `g d` | docs | | `g i` | inbox |
| `g m` | team | | `g s` | settings |
| `g k` | tracking | | | |

Not chord-mapped: `channel`, `entity` (both need an entity id). `isTypingTarget` (`:36-44`) matches `isContentEditable`, `INPUT`/`TEXTAREA`/`SELECT`, or `role="textbox"`.

> The command palette advertises `g t` for **both Team and Tracking** in its hints (`subsystems/palette/actions.ts:364` computes `` `g ${view[0]}` ``), which disagrees with this table (`g m` / `g k`).

### 2.8 placeholders.tsx (130 lines) — what it reveals

`PlaceholderView` is **data-backed on purpose**: it runs `facade.queryCollection({spaceId, kinds, limit:6, sort:'activityAt_desc'})` (`:55`) so "switching views or deep-linking changes numbers that came from the seeded world, not static copy."

**`VIEW_BLURB` verbatim** (`:25-37`) — this is the module's own spec of what each screen was meant to be:

| view | blurb |
|---|---|
| `home` | "My work — ready to pull, in flight, needs me." |
| `tasks` | "Collection view, default Board; axis pivots; bulk ops." |
| `docs` | "Tree sidebar + Z4 reader with margin threads." |
| `team` | "Member cards with nested agent org-trees." |
| `tracking` | "PRs and commits linked by tracks edges." |
| `graph` | "Full-page canvas over the seeded subgraphs." |
| `leaderboard` | "Score rows, recent awards, completion moments." |
| `inbox` | "Cross-space notifications — click opens a panel." |
| `settings` | "Members, invites, task-axis management." |
| `channel` | "Channel hub — shelf, auto-tabs, thread, composer." |
| `entity` | "Generic entity Z4 route." |
| *(default)* | **"Screen arrives in wave 3."** (`:70`) |

Row hint verbatim: **"Click a row to peek it as a Z3 panel · ⌫ pops · g then t jumps to tasks"** (`:82-84`). `PlaceholderPanelBody` footer: **"Entity component plugs in here (W1a · EntityPanel)."** (`:121`).

`PLACEHOLDER_VIEWS` (`:127-130`) maps all 11 names to the placeholder — **dead export**, since only `graph` actually falls through in the shipped app.

### 2.9 useShellData.ts (108 lines) — every shell facade read

| Hook | Facade call(s) | Refetch trigger |
|---|---|---|
| `useAsyncValue(load, deps)` | caller-supplied | `deps` + internal nonce |
| `useSpaces` | `listSpaces()` | `[facade]` only — **never on events** |
| `useSpaceNavigation` | `getNavigation(spaceId)` | `NAV_EVENTS` |
| `useSectionCounts` | 4× `queryCollection({kinds, limit:1})` in `Promise.all` | `entity.upsert` \| `entity.deleted` |
| `useUnreadInbox` | `getInbox()` | `notification.created` \| `notification.read` |

`NAV_EVENTS` (`:56-62`): `message.created`, `message.deleted`, `notification.created`, `notification.read`, `entity.upsert` where `kind==='channel'` (with an explicit registry-purity lint waiver at `:61`), `counter.changed`.

`AsyncValue` exposes `{value, loading, error, reload}` — **no shell consumer reads `loading`, `error`, or calls `reload`** (`IconRail.tsx:25`, `LeftRail.tsx:69-70`, `placeholders.tsx:54,60,94` all destructure `{value}` only). A facade failure renders as a permanently empty rail with no message.

### 2.10 icons.tsx / index.ts

15 hand-drawn inline SVGs on a `0 0 20 20` viewBox, `currentColor`, `strokeWidth 1.5`, `aria-hidden`: `home, list-checks, file-text, users, git-pull-request, share-2, trophy, inbox, hash, pin, maximize-2, x, chevron-right, settings, square`. **`settings` and `square` are referenced nowhere** — dead assets (there is no settings entry point in either rail).

---

## 3. Screens — `src/collab-v2/screens/` (9 dirs, 61 files)

Every screen is a `ViewComponent` receiving `ShellViewProps`. Every screen barrel exports a `*Views` registry fragment merged in `CollabV2App.tsx:82-93`. Two async primitives are used throughout: `useAsyncValue` (`shell/useShellData.ts:17`, one-shot) and `useCollection` (`collections/useCollection.ts:38`, cache-backed + live-patched via `facade.subscribe`).

**Cross-cutting facts, established file-by-file:**
- **No screen anywhere reads the connection store.** `useConnectionStore` / `selectConnected` have zero consumers outside `stores/` — pinned as a test assertion at `__tests__/acceptance/gaps-static.test.ts:51-56`. There is **no offline banner and no queued/disabled composer** in the module; the only offline signal in the running app is the `real/ModeBanner`.
- Error handling is inconsistent: `WorkColumn`, `CollectionView`, `TeamScreen`, `LeaderboardScreen`, `VersionHistory` and `TaskAxesSection` surface errors; **Channel, Settings, Docs' tree, Tracking's collection, Inbox, ActivityFeed and SelectableTaskList all discard `error`**, so a failure presents as a permanent skeleton or an empty state.
- Screen root `data-testid` follows **two conventions** — `view-<name>` (home, inbox, tasks, channel, tracking, settings) vs `<name>-screen` (team, docs, leaderboard). Filed inline at `__tests__/acceptance/w3-ship-and-review.test.tsx:258-260`.

### 3.1 `home/` (7 files, 571 lines)

**Renders** (`HomeScreen.tsx:91-133`): eyebrow `my work` → `<h1>` = `viewer.displayName` (fallback literal `'Home'`) → blurb → a 4-column grid (`repeat(3, minmax(240px,1fr)) minmax(220px,0.8fr)`, collapsing at 1200px/760px):

| Column | testId | hint | extras |
|---|---|---|---|
| ready to pull | `home-ready` | "Open, unblocked, and yours — pull one to pin its version." | `PullButton` per row |
| in flight | `home-inflight` | "Pulled or being worked — a stale pin offers RE-PULL." | `OwnerAttribution` |
| needs me | `home-needsme` | "In review where you are the author or an assignee." | `OwnerAttribution` |
| `ActivityFeed` | `home-activity` | eyebrow `recent activity` | `<aside>` |

The three queries verbatim (`HomeScreen.tsx:51-64`):
```ts
ready    = { spaceId, kinds:['task'], filters:{ readyToPull:true, assigneeIds:actorIds }, sort:'priority' }
inFlight = { spaceId, kinds:['task'], filters:{ assigneeIds:actorIds, workStatus:['pulled','working'] }, sort:'activityAt_desc' }
needsMe  = { spaceId, kinds:['task'], filters:{ inReviewForActorId: viewer?.id ?? '' }, sort:'activityAt_desc' }
```

**Facade calls:** `getNavigation` + **`getLeaderboard`** (`useViewerActors.ts:25,28` — the leaderboard is repurposed as the actor roster: *"The leaderboard page IS the contract's actor roster"*), `queryCollection` + `subscribe` per column, `getSpaceActivity` + `subscribe` for the feed, `pullEntity` for PULL/RE-PULL, `getEntity`/`getPresence`/`subscribePresence` via `LiveBadges`.

**`facade.getHome()` is never called.** The header (`HomeScreen.tsx:1-11`) says so deliberately — the presets are re-expressed as live `CollectionQuery`s. The contract's preset filters `inFlightForActorId` / `needsActorId` are therefore never exercised by the UI.

**States:** whole-screen loading `"loading your work…"`; no-scope `"no work scope for this space yet."`; per-column `"loading…"`; per-column `EmptyState` (`"no tasks linked yet — drag one here, or press ⌘K to create or link one."`); per-column error `role="alert"` + `retry`. **`ActivityFeed` has no empty state and no error state** — a failed fetch renders an empty `<ol>` forever (`ActivityFeed.tsx:47`). Pull toasts: `Pulled "{title}" · pinned v{version}` / `Couldn't pull "{title}" — {message}`.

**Interactions:** row click/Enter/Space → panel; `PULL` (label flips to `PULLING…`); `RE-PULL` inside `StalenessBadge`; `retry`. No drag, no selection, no arrow nav. Pagination unimplemented (`ActivityFeed` slices client-side after `limit=20`; `useViewerActors` reads page 1 only, mock cap 50).

### 3.2 `inbox/` (5 files, 326 lines)

**Renders** (`InboxScreen.tsx:74-123`): eyebrow `inbox` → `<h1>Notifications</h1>` → toolbar (`{n} unread` · `unread only` toggle with `aria-pressed` · `mark all read`, disabled at zero) → `<ol>` of `NotificationRow`.

`NotificationRow` (`:21-51`): unread dot · kind `Pill` · actor `Avatar` · single-line ellipsised message · `relTime` · then meta: space name + `<EntityChip variant="ref">` of `item.target`.

**Kind table** (`kinds.ts:15-22`), 6 entries, pure data: `mention→brand`, `assignment→open`, `award→done`, `unblock→working`, `review_request→review`, `stale→stale`. Unknown kinds degrade to `{label: kind.replace(/_/g,' '), tone:'neutral'}` (`:24-26`) — no branching.

**Facade:** `getInbox()`, `listSpaces()`, `subscribe` (bumps a nonce on `notification.created`/`.read`), `markNotificationRead` (single + `Promise.all` for mark-all).

**States:** `"loading…"`; empty (filter on) **"nothing unread — you are caught up."**; empty (filter off) **"no notifications yet."**; **error not handled** (`:27-28` destructure `{value, loading}` only). Mark-read failure rolls back optimistically + toasts; mark-**all** failure is swallowed per item with no rollback.

**Notes:** first page only, no cursor, no "load more" — so `{n} unread` and `mark all read` describe only the loaded page while presenting as totals. The file's own header (`:3-4`) says `getInbox` is space-agnostic, yet the live subscription is scoped to the **current** space (`:21`), so a notification in another space never triggers a refresh.

### 3.3 `tasks/` (5 files, 350 lines)

**Renders** (`TasksScreen.tsx:45-88`): eyebrow `tasks` → `<h1>Tasks</h1>` → controls (`role="tablist"` with three tabs from `MODES = [board, tree, select]`, `:19-23`; then `GroupByPivot`) → body → `BulkBar` (sticky bottom, rendered in **all three modes**, returns `null` when the selection is empty).

- `board`/`tree` → `<CollectionView key={mode:pivot} query={{spaceId, kinds:['task'], sort:'position'}} layout={mode} groupBy={pivot} showControls={false}/>`. The `key` forces a remount because `CollectionView` only adopts a **truthy** `groupBy` after mount (`CollectionView.tsx:72-74`).
- `select` → `SelectableTaskList` (its own checkbox list reusing `EntityRow` from `../home/rows`), backed by `useNavStore.selection`.

**Facade:** `getTaskAxes` (twice — once here, once inside `CollectionView`), `queryCollection` ×3 distinct cache keys in board mode, `subscribe`; mutations via `collections/mutations.ts` → `patchTask` (status / axes) and `placements({intent:'assign'})`; tree drag → `moveEntity`.

**States:** board/tree loading + `EmptyState` + error banner with `retry` (all from `CollectionView`). **Select mode has no empty state and no error handling** (`SelectableTaskList.tsx:19` destructures `{items, loading}`). Axes fetch error silently degrades the pivot to `None`/`Status`/`Assignee`.

**Interactions:** mode tabs (leaving `select` clears the selection, `:40-42`); pivot chips; checkbox toggle + select-all; `BulkBar` "move to {column}" chips (`Promise.all`, partial-failure toast `"{failed} of {n} didn't move — rolled back"`) + `clear`. Board/tree drag-drop comes from the layouts. `role="tablist"`/`role="radiogroup"` are declared with **no arrow-key roving tabindex**.

**Hardcoded/stubbed:** `MODES` exposes 3 of the 6 available layouts; initial pivot hardcoded `'workStatus'`; `BulkBar` receives `groupBy={pivot ?? 'workStatus'}` so with pivot "None" the bulk bar still offers status columns; `BulkBar.tsx:39` hardcodes an exclusion so you can bulk-assign but **never bulk-unassign**; two unchecked casts (`columnKey as WorkStatus`, `axisNameOf(...) as string`).

### 3.4 `team/` (8 files, 503 lines)

**Renders** (`TeamScreen.tsx:32-65`): header — hardcoded emoji `👥` + "Team" + a tally `"{h} human(s) · {a} agent(s) · {w} working"` with inline English pluralisation → error banner (reusing `cv2-board__banner`) → loading → grid `repeat(auto-fit, minmax(360px,1fr))` of `MemberCard` → empty block.

`MemberCard` (`:24-57`): a card head that is **a `DropSurface` on the `'actor'` surface** (dropping a task on a person = assign) wrapping `EntityCard`, then an agents section with `Agent team · {n}`, a flex spacer, and a **`+ Spawn`** button → `openPaletteWith(member.id)`, then `AgentOrgTree`.

`AgentOrgTree` (`:26-55`): `role="tree"`, each row `role="treeitem"` with `aria-level`, `paddingLeft: depth*18`, an L-tick for depth>0, and `EntityCard` + `LiveBadges workingStyle="pulses"`. **No arrow-key nav, no expand/collapse, no `aria-expanded`** — permanently fully expanded.

**Facade:** `queryCollection({kinds:['member'], sort:'position', limit:100})` and `({kinds:['team_member'], sort:'position', limit:200})` (`useTeam.ts:26,34`), `subscribe` (nonce on entity/edge events), plus `LiveBadges`' reads. `+ Spawn` issues no mutation — it opens the palette scoped to the member, which then calls `facade.getActions(memberId)`.

**States:** loading `"loading…"`; error `role="alert"` **with no retry**; empty (no humans) **"Nobody here yet — invite people from space settings."** (hand-written, *not* `EmptyState`, and it diverges from the registry hint at `KindRegistry.tsx:496`); empty agents → `EmptyState kinds={['team_member']}` → "no agents yet — spawn one from a member profile, or press ⌘K…".

**Model** (`model.ts`, pure): `ownerOf` reads `state.owner` via an unchecked `AgentShape` cast; `isWorking` = `state.liveWork != null`; `groupByOwner` **silently drops agents with no owner** (`:33`); `orgRows` flattens via `parentId`. A comment at `:46` names concrete seed agents ("Forge → Scout, Probe") — mock-world names in production source.

**Pagination:** none — `page.nextCursor` is never read, so spaces past 100 members / 200 agents truncate silently *and the header tally under-reports*.

### 3.5 `channel/` (10 files, 611 lines)

The **hub** is the composed channel view — `header · shelf · auto-tabs · pane` (`ChannelHub.tsx:2-12`). Its design claim: *"'Put tasks and team members into a channel' is not a feature: it is `attached_to` edges + the auto-tab projection + embeds. This screen composes, it never derives."*

The body is factored out (`ChannelHubBody.tsx`) so it mounts **two ways**: as the `channel` center view, and as `EntityFullView`'s `hub` slot via `channelHubSlot()` (wired at `CollabV2App.tsx:77`).

| Part | Renders |
|---|---|
| `ChannelHeader` | tinted glyph · `<h1>{title}` · topic · spacer · `{unread} unread` Pill (only >0) · `PresenceAvatars` · `WorkingAggregate` |
| `ChannelShelf` | horizontal strip of pinned `EntityCard`s each with a 📌 glyph; empty: **"Nothing pinned yet — pin a task or doc to shelve it here."** |
| `ChannelTabStrip` | `role="tablist"`, rendered **1:1 from the facade**, each tab = label + mono count |
| pane | Feed tab → `<Thread variant="feed" markReadOnView reactionsSlot={promoteReactionsSlot(ReactionsPointsBar)}/>`; any other tab → `<CollectionView query={tab.query}/>` with **controls ON** |

`projection.ts` (49 lines) is four defensive accessors — `channelTopic`, `channelShelf`, `channelUnread`, `channelWorkingCount` — each optional-with-fallback so a mis-routed id degrades to an empty hub. It **deliberately excludes the tab strip** (`:12-15`): *"the facade's auto-tab projection IS the source of truth."* Consequence: `content.autoTabs` is declared in the contract (`types/contract.ts:111`) and **never read by the UI**.

**Facade:** `getNavigation` (to resolve `entityId ?? navigation.channels[0]`), `getEntity`, **`getChannelTabs`**, `subscribe` (30 ms debounce; reloads on entity events matching the channel and on edge events touching it), `queryCollection` per tab, plus Thread/reactions/presence reads. The whole body is a `DropSurface` on `targetRef(detail,'channel')`. **The channel screen issues no mutations of its own.**

**Mock tab projection** (`mock/world.ts:341-367`) — what the tabs would be: always `feed`, then when non-empty `tasks`, `docs` (`doc`+`file`), `team` (`member`+`team_member`), `prs` (`pull_request`+`commit`), `kit` (`spell`+`skill`), each an `attached_to` edge query.

> **Against `RealFacade`, `getChannelTabs()` returns `[]`** (`RealFacade.ts:235-237`, mirroring the server's honest empty). So on the live server the channel hub shows **only the feed pane**, and the layout switcher (the only route to Board/Tree/Feed/Gallery/**Graph**) is unreachable.

**Error: not handled** — `ChannelHub.tsx:23,53` and `ChannelHubBody.tsx:29` destructure `{value}` only; a rejected `getEntity` leaves the skeleton forever.

### 3.6 `docs/` (5 files, 361 lines)

Two-column frame (`DocsScreen.tsx:69`): left `aside` "Chapter tree" = `<CollectionView layout="tree" query={{kinds:['doc'], sort:'position', limit:200}} showControls={false}/>`; right `section` "Reader" = toolbar (`v{n}` · `⟲ History` · `⑃ Split to child doc` · `⤡ As panel`) + error banner + optional `VersionHistory` + `<EntityFullView slots={{margin: discussionSlot({variant:'comments', defaultExpanded:'all'})}}/>`.

**Facade:** `queryCollection` (issued **twice** — once by `useDocs` purely to compute a default selection, once by the tree), **`getVersions`** (only while History is open, re-read when the doc's `version` moves), **`createEntity`** for split-to-child (`{kind:'doc', parentId: selected, content:{body:'## Untitled chapter\n\n', format:'markdown'}}`), plus `getEntity` and the Thread's methods.

**States:** no screen-level loading/error at all (`docs.loading`/`docs.error` are never read); empty **"No docs in this space yet — create one from the palette."**; version history has its own `"loading…"`, `role="alert"` and **"No edits recorded yet."** Split failures show a raw message in a banner.

> **Against `RealFacade`, `getVersions()` returns an empty page** (`RealFacade.ts:190-193`) — History always reads "No edits recorded yet."

### 3.7 `leaderboard/` (6 files, 548 lines)

Header 🏆 "Leaderboard" + *"points from completions and grants · humans and agents alike"*; body (max-width 720px): error banner → loading → **completion moment** (`role="status"`, `data-testid="completion-moment"`, `◈ **{name}** was awarded **{n} points** for {task}`) → **Scores** (`ScoreRows`: rank · avatar · name · `agent`/`human` tag · proportional bar · `{score} pts`) → **Recent awards** (`AwardsFeed`) → **Per-task breakdowns** (`<details>` per task).

**Facade:** `getLeaderboard`, `getAwards`, `subscribe` (nonce on `counter.changed` / `activity.created` / `notification.created`). Pure derivations: `breakdownsByTask` (skips awards with `ref == null`), `useCompletionMoment` (seeds a Set of known ids on first ready render so history never celebrates on mount, then flashes for `CELEBRATION_MS = 2600`).

**Empty copy:** "No scores yet — the ledger opens with the first award." / "No awards yet — complete a task to open the ledger." / "No completions have paid out yet." Respects `prefers-reduced-motion` (`leaderboard.css:192-195`). **No mutations at all** — a pure read surface. No pagination (cursors accepted by the facade, never passed).

> **Against `RealFacade`, both `getLeaderboard()` and `getAwards()` return empty pages** (`RealFacade.ts:264-265`) — the entire screen is three empty-state lines.

### 3.8 `settings/` (7 files, 504 lines)

Four sections in order (`SettingsScreen.tsx:31-40`), all fed by **one** `getSettings(spaceId)` read:

| Section | Mutates? | Evidence |
|---|---|---|
| `SpaceProfileSection` | **Display-only** | `:4-6` "READ-ONLY BY CONTRACT: `CollabFacade` has no space-patch command, so the fields render as facts, not inputs." |
| `MembersSection` | **Display-only** — role tally computed client-side from the roster + a separate `CollectionView layout="list"` for the rows | only handler is `onOpenEntity` |
| `InvitesSection` | **Display-only + clipboard** | `:3-9` "READ-ONLY BY CONTRACT: the facade seam exposes no invite command… nothing is faked in the meantime." Renders that note to the user: **"Read-only until the invite commands land on the facade seam."** |
| `TaskAxesSection` | **Full CRUD** | `createTaskAxis` (`:68`), `updateTaskAxis` (`:94`), `deleteTaskAxis` (`:95`) |

`TaskAxesSection` (181 lines): rows show name · `{kind}` pill · values joined ` · ` · `✎` edit · `🗑` delete (**non-default only**, `:176-178`); an add form with `axis name (e.g. surface)` and `values, comma separated (e.g. ui, server, cli)`. Errors are translated **by code** (`describe()`, `:22-32`): `invalid_input`→"That name is already taken — pick another.", `forbidden`→"A default axis cannot be changed here.", `not_found`→"That axis is already gone.", non-CollabError→"Something went wrong." Client validation: "An axis needs a name and at least one value." Delete has **no confirm dialog**. The `✎` editor sends only `axisValues` — **axis renaming is unreachable** despite the prop being `onRename({name?, axisValues?})`.

**Loading** = `EntityPanelSkeleton`. **Error not handled** at screen level (`:17` destructures `{value, reload}`), so a rejected `getSettings` leaves the skeleton permanently.

> **Against `RealFacade` this screen is broken, not merely empty.** `getSettings` returns `{spaceId, name, description, githubRepo, axes:[], members:[]} as unknown as SpaceSettings` (`RealFacade.ts:274-280`), which does **not** match the `SpaceSettings` shape the screen reads (`{space, members, invites, taskAxes}`, `types/contract.ts:484-489`). `SpaceProfileSection.tsx:21` reads `{space.name}` on `undefined` → TypeError. All three axis writes also `notImplemented` (`RealFacade.ts:383-385`).

### 3.9 `tracking/` (5 files, 333 lines)

Header eyebrow `tracking` · `<h1>Pull requests</h1>` · **`↻ Refresh all`** · blurb *"Linked by `tracks` edges. Freshness is per-entity — a stale fetch says so on the card."* → PR list (one `TrackingRow` each, `Load more` when `hasMore`) → a **Commits** section (`CollectionView layout="list"`, no load-more).

`TrackingRow`: two-column grid — left a clickable `EntityCard entity keyEdges={tasks}`, right the linked-task `EntityChip`s (empty: **"no linked task"**) and a per-row `↻` `IconBtn` (`Re-fetch this from the forge`).

`links.ts`: `TRACKS_EDGE = 'tracks'`; `counterparts()` merges incoming+outgoing, keeps matching types, takes the non-self endpoint, de-dupes by id — direction- and kind-agnostic by design.

**Facade:** `queryCollection` ×2 (`kinds:['pull_request']` / `['commit']`, both `limit:50`, `sort:'activityAt_desc'`), **`trackingRefresh({entityIds, clientMutationId})`**, and **`getConnections(entity.id)` per row** — an N+1 that re-fires whenever `live.activityAt` moves. Under `RealFacade`, `getConnections` is itself a full `getEntity`, so a 50-PR list issues 50 detail requests.

**States:** no spinner (loading only suppresses the empty state); empty **"Nothing tracked yet — link a PR from a task."**; toasts `Re-fetched from the forge.` / `Re-fetching everything tracked…` / `Refresh failed — the forge did not answer.`; **collection error not handled** (a failed query reads as "Nothing tracked yet"). `refreshSlot` is a designed per-row seam that **no caller ever supplies**.

> **Against `RealFacade`, `trackingRefresh` throws `not_implemented`** (`RealFacade.ts:360`) — both refresh buttons always land in the catch and toast the failure.

### 3.10 `gallery/` — the QA surface (3 files, 239 lines)

**Not a product screen.** Header comment (`Gallery.tsx:1-8`): *"the L1 exit-criteria page (gate G1) and Sentinel's audit surface: every one of the 11 kinds rendered at Z1 (chip + inline ref), Z2 (card) and Z3 (panel) from the seeded mock world, plus skeletons, the tombstone, badge states, and live demos."*

Reached **only** through `useGalleryRoute()` (`CollabV2App.tsx:101-110`): `window.location.hash.startsWith('#/gallery')` **replaces** the entire shell with `<Gallery/> + <ThreadGallery/>` (`:160-166`). Not in the `ViewRegistry`, no rail entry.

It owns a **private** `createSeededFacade({latency:0})` (`Gallery.tsx:72`) and, on mount, **resets and rewires the app-wide stores to its own world** (`useGraphStore.reset()`, `usePresenceStore.reset()`, `connectStores(facade, facade.ids.space)`, `useNavStore.setSpace(...)`, `:78-81`). `seedIdForKind()` hardcodes one seed entity id per kind from `facade.ids` — **so the Gallery cannot run against `RealFacade` at all**. It also mutates its own mock world to manufacture a tombstone (creates "Scratch task (gallery tombstone)" then soft-deletes it, `:95-107`). No error handling — a rejected `getEntity` leaves it stuck on "loading seeded world…".

---

## 4. Entity component system + KindRegistry

### 4.1 The four zoom levels — `src/collab-v2/entity/`

| File | Lines | Zoom | What it renders |
|---|---|---|---|
| `EntityChip.tsx` | 80 | **Z1** | `<button class="cv2-chip cv2-chip--{chip\|ref}">` — glyph (tinted) + `chipLabel` + optional `chipMeta` + optional pulse dot. Hover → shared Z2 popover containing `<EntityCard inPopover/>`; click → `onOpen(id)` or `pushPanel`; `draggable` writes `ENTITY_DRAG_MIME` = `application/x-cv2-entity` with `{entityId, kind, title}` plus `text/plain`. Tombstoned → `<Tombstone variant="chip"/>` |
| `EntityCard.tsx` | 92 | **Z2** | head (glyph · `entry.label` · `createdBy` Avatar) → title → `entry.SummaryFields` → badge row (`⚠ blocked · n` / `working · names` / `v{n} → stale` / `🔒 restricted`) → footer counters `👍 👎 ⭐ ◈ 💬` + optional `keyEdges` chips + working avatars. **Strictly pure** — no store reads, no fetching |
| `EntityPanel.tsx` | 427 | **Z3** | Uniform anatomy for every kind: ① header (breadcrumb from `hierarchy.path` minus self, 📌 pin / ⤢ promote / ✕ close, glyph, inline-editable title, status Pill + a `change…` `<select>` where mutable, `⋯` overflow menu) ② action bar ③ 4 body tabs ④ footer (presence avatars · created-by · `v{n} · active {relTime}`) |
| `EntityFullView.tsx` | 193 | **Z4** | header (breadcrumb, glyph, `<h1>`, status Pill, `⤡ Collapse`) + one of **five** layout bodies keyed by `entry.fullLayout` |

Supporting: `EntityById.tsx` (51) — `ChipById`/`CardById` resolve an id from the graph store, fetch on miss, and render a muted `✕ unavailable` token when the read rejects. `Tombstone.tsx` (45) — chip variant (struck title + `deleted {kind}`) and card variant (keeps footprint, counters intact, `deleted {relTime}`). `skeletons.tsx` (54) — `ChipSkeleton`, `EntityCardSkeleton`, `EntityPanelSkeleton` ("panels never blank-flash"). `context.tsx` — `CollabFacadeProvider`/`useFacade`. `ctx.tsx` — `REGISTRY_CTX` (the injected `{Chip, Card, ChipById, CardById}` so `registry/` never imports `entity/`).

**`PANEL_TABS`** (`EntityPanel.tsx:33-38`) — the same order for every kind: **Content · Discussion · Connections · Activity**.
- `content` → `entry.Content`
- `discussion` → `slots.discussion?.(live)` else a `SlotPlaceholder` reading *"The universal Thread subsystem (W2) plugs in here — every conversation, one component."*
- `connections` → `slots.connections?.(live)` else `ConnectionsFallback` (hierarchy chips + edge-group chips + `"The Connections rail (W2) replaces this basic list."`)
- `activity` → inline `ActivityTab` → `facade.getActivity(entityId)`, `"No activity yet."` when empty

**Action bar** (`EntityPanel.tsx:334-387`), gated by `live.capabilities`: 👍/👎/⭐ (`setReaction`), `◈` grant-1-point (title still says *"hold-to-choose arrives in W4"*), separator, `Link` (title *"Edge composer arrives in W4"* when `onLink` absent), `Add child` (*"Creation flow arrives in W4"*), `Pull` (`pullEntity`), then `entry.primaryActions(live)`. **`onLink` and `onAddChild` are never supplied by the app** (`CollabV2App.tsx:42-53` passes only `slots`), so both buttons render and do nothing.

**Overflow menu** (`:311-328`): `Copy link` (writes `#/s/{space}/e/{id}` to the clipboard), `Copy to space` (**hardcoded `disabled`**, title *"Cross-space copy arrives later"*), `Watch`/`Unwatch` (**local `useState` only — no facade call, purely cosmetic**), `Delete` (when `capabilities.canDelete`).

**Z4 layout variants** (`EntityFullView.tsx:103-158`):

| variant | body |
|---|---|
| `reader` | 3-col: Chapters chip column (`"No chapters yet."`) · prose `entry.Content` · `SlotBox "Margin threads"` |
| `hub` | content + `SlotBox "Channel hub"` |
| `subtree` | content + `ChildrenGrid "Subtree"` + `SlotBox "Dependencies"` (hint *"The dependency mini-graph plugs in here (W2/W4)."* — **no caller ever fills this slot**) |
| `profile` | 44px avatar + title + status, content, `ChildrenGrid "Children"` |
| `generic` | content + `ChildrenGrid "Children"` |

### 4.2 The registry — `src/collab-v2/registry/` (4 files, 1,193 lines)

**`KindEntry`** (`types.ts:122-173`) is the whole per-kind surface, 18 fields: `kind, label, labelPlural, glyph, tint, chipLabel, chipMeta, chipPulse, SummaryFields, Content, fullLayout, status{current,options?,set?}, patchTitle, primaryActions, creation, creationDisabledReason?, capabilities{workStatusBearing,treeReparentable,markReadAnchor,actor}, createVia, paletteCreate, collectionEmptyHint`.

**Every kind registered** — `KIND_REGISTRY` (`KindRegistry.tsx:907-919`) + `KIND_ORDER` (`:922-925`), plus the two added at runtime by `real/tm8Kinds.tsx`:

| # | kind | label | glyph | `fullLayout` | Z1 chipMeta | Z2 SummaryFields | Z3 Content | status | `patchTitle` | `primaryActions` | caps (`wsB/treeR/markRead/actor`) | `createVia` | `paletteCreate` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `channel` | Channel | `#` | **hub** | ✅ | ✅ (`:193`) | ✅ rich (`:210`) | current only | ✅ `patchEntity` | 1 (`:243`) | `-/✅/✅/–` | ✅ | ✅ "new channel add" |
| 2 | `task` | Task | `☑` | **subtree** | ✅ | ✅ (`:265`) | ✅ richest (`:288`) | **current + options + set** (`:321`), `done` deliberately absent | ✅ `patchTask` | **Start**, **Complete…** (+ `Spawn agent` appended at runtime) | `✅/✅/✅/–` | ✅ | ✅ "new task add" |
| 3 | `message` | Message | `💬` | generic | ✅ | ✅ (`:380`) | ✅ (`:395`, renders embeds) | current only | **null** | none | `-/-/-/–` | **null** — *"Messages are written in a thread composer."* | null |
| 4 | `member` | Member | `👤` | **profile** | ✅ | ✅ (`:449`) | ✅ (`:464`) | current only | **null** | 1 (`:488`) | `-/-/-/**human**` | **null** — *"Members join a space via invite."* | null |
| 5 | `team_member` | **Agent** | `🤖` | **profile** | ✅ | ✅ (`:508`) | ✅ (`:534`) | current only | ✅ `patchEntity` | 1 (`:568`) | `-/-/-/**agent**` | ✅ | **null** (required fields a title-only create can't satisfy) |
| 6 | `doc` | Doc | `📄` | **reader** | ✅ (version) | ✅ (`:589`) | ✅ markdown via `react-markdown` (`:609`) | current only | ✅ | 1 (`:625`) | `-/✅/✅/–` | ✅ | ✅ "new doc add write" |
| 7 | `file` | File | `📎` | generic | ✅ | ✅ (`:647`) | ✅ (`:657`) | **`current: () => null`** | ✅ | none | `-/✅/-/–` | ✅ | ✅ "new file upload add" |
| 8 | `spell` | Spell | `✨` | generic | ✅ | ✅ (`:692`) | ✅ (`:704`) | current only | ✅ | none | `-/✅/-/–` | ✅ | ✅ "new spell add" |
| 9 | `skill` | Skill | `📚` | generic | ✅ | **shared with `spell`** (`:740-743`) | shared | shared | ✅ | none | `-/✅/-/–` | ✅ | ✅ "new skill add" |
| 10 | `pull_request` | PR | `🔀` | generic | ✅ (state) | ✅ (`:771`) | ✅ (`:790`) | current only | **null** (tracked from GitHub) | **Refresh** (`:825`) | `-/-/-/–` | ✅ | **null** |
| 11 | `commit` | Commit | `◉` | generic | ✅ (sha) | ✅ (`:854`) | ✅ (`:868`) | **`current: () => null`** | **null** | **Refresh** (`:890`) | `-/-/-/–` | **null** — *"Commits are tracked from GitHub."* | null |
| +12 | **`work_session`** *(runtime)* | Session | `▶` | generic | ✅ tool·model | ✅ status/started/exited | ⚠️ status/tool/model + a **stale "no terminal stream" paragraph** | current + tone map | null | **Prompt**, **Terminate** (hidden once exited/failed) | `-/-/-/–` | null | null |
| +13 | **`collection`** *(runtime)* | Collection | `▤` | generic | ✅ item count | ✅ `collectionType` | ✅ minimal | `() => null` | null | none | `-/-/-/–` | null | null |

**Richness summary:** all 13 kinds have Z1 (chip label + meta + pulse + tint) and Z2 (`SummaryFields`) and Z3 (`Content`). **Z4 is never kind-specific** — it is one of 5 shared layout variants, and `doc→reader`, `channel→hub`, `task→subtree`, `member`/`team_member`→`profile`, and the remaining **8 kinds all share `generic`**. Only `task` has a mutable status control. Only `task` is `workStatusBearing`. Only `member`/`team_member` are actors. `channel`/`task`/`doc` are the three `markReadAnchor` kinds.

**Derived helpers** (`KindRegistry.tsx:932-949`): `kindCan(kind, flag)`, `kindsWhere(flag)`, `creatableKinds()` = 9 (all but `message`, `member`, `commit`), `paletteCreatableKinds()` = 6 (`channel, task, doc, file, spell, skill`). `TOMBSTONE` = `{glyph:'✕', label: kind => 'deleted ' + label.toLowerCase()}`. `format.ts` (36 lines) supplies `relTime`/`truncate`.

### 4.3 What `registryFor()` does with an unknown kind — **it returns `undefined`**

```ts
export function registryFor(kind: EntityKind): KindEntry {
  return KIND_REGISTRY[kind];        // KindRegistry.tsx:927-929
}
```

The signature promises a non-optional `KindEntry`; the body is a bare index into a `Record<EntityKind, KindEntry>` with **no fallback**. For any kind outside the 11 (or 13, post-`installTm8Kinds`) it returns `undefined`, and the first field access crashes.

This is recorded as the transplant's headline defect, in three places:
- `STATE.md` §"UI transplant — drift ledger": *"**NOT fixed — Atlas's to make, and it is the real defect:** `registryFor(kind)` promises `KindEntry` and can return `undefined`. The missing kinds were only the symptom. **Any unknown kind white-screens the app — including any `c:*` custom kind, which the contract explicitly supports.**"*
- `real/tm8Kinds.tsx:4-31` reproduces the exact crash observed: tm8's contract promoted `work_session` and `collection` to core kinds; the live server returns a `work_session` the moment anything is spawned; the first real render died on `registryFor('work_session').tint` → *"Cannot read properties of undefined (reading 'tint')"* and the whole app went white. The note adds: *"A mock world that never produced those kinds could not have caught it."*
- The workaround is **additive registration from outside the module** (`installTm8Kinds()`, `main.tsx:28`), using only the module's exported surface, so nothing inside `collab-v2` was edited.

Two consumers do **not** go through `registryFor` and so are also exposed: `TOMBSTONE.label(kind)` indexes `KIND_REGISTRY[kind].label` directly (`:954`), and `kindCan`/`kindsWhere` index it directly too (`:933`, `:938`).

`registryFor` is called from ~20 sites including `EntityChip.tsx:42`, `EntityCard.tsx:25`, `EntityPanel.tsx:209`, `EntityFullView.tsx:93`, `Tombstone.tsx:17`, `collections/EmptyState.tsx`, `shell/placeholders.tsx:40,101`, `screens/channel/ChannelHeader.tsx:30`, `interactions/grammar.ts:63`.

### 4.4 The registry-purity law

`__tests__/entity/registry-purity.test.ts` (218 lines) enforces, by recursive source scan of all of `src/collab-v2`, that **behaviour may not branch on entity kind outside `registry/`**. Allowed without annotation: `registry/`, `mock/` (a simulated backend, not UI), and discriminated-union *narrowing reads* of `state`/`content`. Allowed with a grep-able `// registry-purity: allow — <reason>` comment: kind-keyed storage maps, lexical collisions. Flagged: `kind === 'x'`, `case 'x'`, `['task','doc'].includes(x.kind)`, `'task' in x`, `Record<EntityKind, …>` dispatch tables, kind-keyed object dispatch. **Current debt: zero** — `EXPECTED_FAILURES` is empty (`:77-80`).

---

## 5. Collections — `src/collab-v2/collections/` (23 files, ~2,400 lines)

### 5.1 The six view types

`COLLECTION_LAYOUTS = ['list','board','tree','feed','gallery','graph']` (`controls.tsx:12`); the contract mirrors it at `types/contract.ts:168`.

| Layout | File | Renders | Drag | Slots | Key nav |
|---|---|---|---|---|---|
| `list` | `layouts/ListLayout.tsx` (56) | vertical `EntityCard` cells, `role="list"`, **every cell `draggable`** | source only | checkbox + rowAction | `useListNav` vertical |
| `board` | `layouts/BoardLayout.tsx` (167) | columns from `boardColumns()`; header label+count; drag ghost "Move to **X**"; empty-column hint `drop a card here`; error banner | source **iff `workStatusBearing`**, else a `read-only here` Pill; columns are drop targets | ✅ | per-column vertical |
| `tree` | `layouts/TreeLayout.tsx` (246) | caret expand/collapse, `paddingLeft: depth*20`, children **paged from the facade** via `getHierarchy` + `load more children`, kind glyph + status Pill, reparent ghost "make X a child of Y", `role="tree"` | source **iff `treeReparentable`**; rows are drop targets (**same-kind only**) | ✅ | **none** |
| `feed` | `layouts/FeedLayout.tsx` (54) | re-sorts by `activityAt` desc **ignoring the query sort**, rows under a `active 3h ago` rule | source only | **neither** | vertical |
| `gallery` | `layouts/GalleryLayout.tsx` (62) | CSS grid of cards, `GRID_COLUMNS = 3` | source only | ✅ | grid, 3 cols |
| `graph` | `graph/GraphCanvas.tsx` (374) | real xyflow canvas — §5.7 | node→node connect | n/a | xyflow defaults |

**`CollectionView.tsx` (206 lines) selects** by an explicit guard chain, not a map: `:152` list, `:155` feed, `:156` gallery, `:159` board, `:169` tree, `:179` graph. Initial layout = `layout` prop → `savedView.query.layout` → `query.layout`, coerced by `coerceLayout()` which falls back to `'list'` for anything unrecognised. `useEffect`s re-adopt props only when **truthy** (`:72-74`) — which is why `TasksScreen` remounts with a `key` to make "None" take effect. A board with no pivot **force-pivots on `workStatus`** (`:78-79`). Chrome (`showControls`, default `true`): `LayoutSwitcher` + `GroupByPivot` + spacer + `SaveViewControl`. `graph` is the one layout rendered **without** the `!isEmpty` guard (`:179`). Non-board, non-graph layouts with a pivot render only a **group-count chip strip** — the list stays flat (`:193-203`).

**Mount sites:** `ChannelTabs.tsx:64` (**the only one with controls ON**), `TasksScreen.tsx:74-83` (`board`/`tree`), `DocsScreen.tsx:76-83` (`tree`), `MembersSection.tsx:39` (`list`), `TrackingScreen.tsx:114` (`list`). `HomeScreen`'s `WorkColumn` deliberately uses `useCollection` + `EmptyState` directly instead.

### 5.2 Data loading — `useCollection.ts` (133 lines)

`facade.queryCollection(q)` → `useCollectionsStore` keyed by `collectionKey(query)` (stable recursively-sorted JSON, `stores/collections.ts:12-26`). Live via `facade.subscribe`: `entity.upsert` already in the result → patch in place (plus a reconciling refetch when the query has filters); not in result but kind matches → refetch; `entity.deleted` → remove; `edge.upsert`/`edge.deleted` → refetch **only if `edgeSensitive(q)`** (`filters.edge`, `filters.assigneeIds`, `filters.readyToPull`, or `groupBy==='assignee'`). Refetch debounce `REFETCH_DEBOUNCE_MS = 30`. On error the store gets an **empty page** and `error` is set.

### 5.3 Grouping — `grouping.ts` (112 lines)

**Group-by axes supported:** `'workStatus'`, `'assignee'`, `` `axis:${string}` `` (one per `TaskAxis` from `facade.getTaskAxes`), and `undefined` = "None". **Default and manual axes are deliberately indistinguishable** in the pivot UI.

Computation is client-side over already-patched page items so optimistic moves reposition cards with no refetch: `workStatus` → `state.workStatus` for tasks else `'open'`; `assignee` → one group per assignee, zero assignees → `unassigned`/`Unassigned` (**a task with N assignees appears in N groups**); `axis:<name>` → `state.axes[name]` or `'none'`.

Ordering: `STATUS_ORDER = ['open','pulled','working','in_review','blocked','done','cancelled']` (blocked before done, deliberately); `axis:*` follows the axis's declared `axisValues` with unknowns appended; `assignee` keeps insertion order. This mirrors the facade exactly (`mock/world.ts:2186-2213`), asserted by `__tests__/collections/groupby-parity.test.tsx`.

`boardColumns()` adds **empty drop targets**: every status in `STATUS_ORDER` except `cancelled` (hidden unless occupied); every declared `axisValues` entry; for `assignee` only `unassigned` is guaranteed.

### 5.4 Sorting and filtering — no UI for either

**Sort** values (`types/contract.ts:170`): `activityAt_desc | createdAt_desc | position | dueDate | priority`. `uiSort` exists in `CollectionView` (`:69-71`) but **has no setter call other than the prop effect, and no screen passes `sortBy`** — there is **no sort UI anywhere**. Sorting is only ever the screen's hardcoded query. `FeedLayout` ignores it entirely.

**Filters** (`types/contract.ts:153-167`): `workStatus[]`, `axes`, `assigneeIds[]`, `edge{type,direction,entityId}`, `readyToPull`, `inReviewForActorId`, `mentionedActorId`, the preset expansions `inFlightForActorId`/`needsActorId`, and `deleted: exclude|only|include`. All honoured by the mock. **There is no filter UI in the collections layer at all** — filters arrive pre-baked, only from `HomeScreen` (the sole screen using `filters:`) and facade-built `ChannelTab.query`s. The graph canvas has kind/edge-type chips, but those refine a `GraphQuery`, not `filters`.

### 5.5 Saved views — creatable, barely readable

- UI: `SaveViewControl` (`controls.tsx:78-137`) — a "Save view" chip → inline form with a **View name** input and a **"share to space"** checkbox (default checked → `shareMode:'space'`, else `'private'`), then a `saved "<name>"` hint.
- Persist: `facade.createSavedView(spaceId, {name, shareMode, query, graphLayout})` → `useCollectionsStore.upsertSavedView`. **No localStorage anywhere.**
- Update: only the graph does it — `facade.updateSavedView(id, {graphLayout})` (`GraphCanvas.tsx:210-216`).
- List: only `GraphCanvas.tsx:132` calls `facade.listSavedViews(spaceId)`, feeding its subgraph `<select>`.
- **`facade.deleteSavedView` is never called from the UI.**
- **No screen ever passes `savedView` to `CollectionView`** (tests only). Store selectors `selectSavedViews` and `removeSavedView` have zero readers. So saved views are creatable, and re-selectable **only inside the graph canvas** — there is no saved-views list in the rail or anywhere else.

### 5.6 Row slots, keyboard nav, empty states

**`slots.ts` (17 lines)** — two types only: `RowAction = (entity) => ReactNode` (trailing) and `RowSelection {selectedIds, onToggle}` (leading checkbox). `CollectionView` forwards both to List/Gallery/Board/Tree; **`FeedLayout` supports neither**. **No screen passes `rowAction` or `selection`** — tests only; `SelectableTaskList` rolls its own checkbox list instead. Same for `expandDepth`, `emptyState` and `sortBy`.

**`useListNav.ts` + `kit/listKeyNav.ts`** — roving focus, one index, `cellProps(i)` gives `tabIndex` 0/-1 + `data-nav-index`. Keys handled: `ArrowDown`/`ArrowUp` (±1, ±`columns` in grid; ignored when horizontal), `ArrowRight`/`ArrowLeft` (ignored when vertical), `Home`→0, `End`→count-1, `Enter`→activate. **Any of meta/ctrl/alt short-circuits** so ⌘K passes through. `loop` defaults false and `useListNav` never passes it → collection nav **never wraps**. `move()` returns `true` + `preventDefault` even when the index doesn't change, so an arrow at a boundary still swallows the key.

**Empty states** — `EmptyState.tsx` (21 lines), glyph `◇`, `role="status"`. Copy = `registryFor(kind).collectionEmptyHint` when the query targets exactly one kind, else the generic fallback, always suffixed `<Kbd>⌘K</Kbd> to create or link one.`

| kind | `collectionEmptyHint` |
|---|---|
| generic fallback | **"nothing here yet — drag an entity in, or press ⌘K to create or link one."** |
| channel | "no channels yet — press" |
| task | "no tasks linked yet — drag one here, or press" |
| member | "nobody here yet — invite from space settings, or press" |
| team_member | "no agents yet — spawn one from a member profile, or press" |
| doc | "no docs here yet — drag one in, or press" |
| pull_request | "nothing tracked yet — link a PR from a task, or press" |
| message, file, spell, skill, commit | `null` → generic |

Other verbatim copy: `loading…`, `loading graph…`, `load more`, `load more children`, `drop a card here`, `no children`, `read-only here`, `retry`.

### 5.7 The graph subdir — a real interactive canvas, reachable one way

**Yes, genuinely built** — ~1,024 lines across 5 files on `@xyflow/react` + `dagre`.

- **Layout** (`graph/model.ts`, 337 lines, pure/DOM-free): `dagre.graphlib.Graph({compound:true})`, `rankdir:'LR'` in dependency mode / `'TB'` in free mode, `nodesep:48`, `ranksep:110|80`; `NODE_WIDTH=260`, `NODE_HEIGHT=150`, `CLUSTER_PADDING=28`. **Hierarchy is containment, never lines** — clusters become compound dagre parents drawn as dashed boxes. Collapsing a cluster hides descendants and **remaps their edges onto the nearest visible ancestor**, deduped and flagged `aggregated`. Dependency mode reverses edges for ranking so prerequisites sit left. A saved layout overrides dagre **only for node ids it knows**. Hover dims everything outside the 1-hop neighbourhood + parent + visible children. `collectLayout()` converts nested positions to absolute and drops `cluster:*` ids.
- **Nodes/edges** (`graph/nodes.tsx`): `cv2Entity` wraps a real Z2 `EntityCard` with left/right Handles, classes `--blocked`/`--dimmed`, and an `⊞ {hiddenCount}` expand chip when collapsed; `cv2Cluster` is a dashed box with a `⊟` collapse button. Edges are labelled with `ArrowClosed` markers; CSS gives soft edges `dasharray 6 4`, aggregated `2 3`, blocked a bold block colour.
- **Data:** `facade.queryGraph(effective)`, `facade.listSavedViews`, `facade.subscribe` (30 ms debounced refetch); writes `facade.createEdge` and `facade.updateSavedView`.
- **Controls:** Free/Dependency mode tabs · saved-view subgraph `<select>` · kind filter chips (free mode, >1 kind, never empty) · edge-type filter chips · `focus · 2 hops` + a 1/2/3 hops select + `clear` · `save layout` (only with an active saved view). Node click pushes a Z3 panel without leaving the canvas. Node→node connect opens a second **`EdgeComposer`** (`graph/EdgeComposer.tsx`, 66 lines — a `role="dialog"` offering `depends on · hard (blocks)`, `depends on · soft`, `relates to`, `attached to`, `assigned to`, `tracks`, `equips`, plus a free-form `x:*` custom type) → `facade.createEdge`.

> **Reachability:** the only production usage is `CollectionView.tsx:18,180`. Nothing sets `layout:'graph'` in a query, and every screen that hardcodes a layout uses `list`/`tree`/`board`. So the graph is reachable **only** via the `LayoutSwitcher`'s "Graph" tab, and the only `CollectionView` with `showControls` on is a **non-feed channel tab**. Since `RealFacade.getChannelTabs()` returns `[]`, **the graph canvas is unreachable against the live server**. It also has no route (`graph` resolves to the placeholder) and no gallery presence. And `RealFacade.queryGraph()` returns `{nodes:[],edges:[],clusters:[]}` (`RealFacade.ts:225-228`) — deliberately fully empty, because nodes-without-edges "would draw a disconnected graph that looks like a real answer."

### 5.8 `mutations.ts` (108 lines) — the optimistic protocol

`runOptimistic` (`:39-62`): `applyOptimistic(cmid, …)` + `collections.applyEntityPatch` → run the command with the same `clientMutationId` → success `reconcile(cmid)` + apply `res.patches` → failure `rollback(cmid)` + restore; on `version_conflict` **adopt `e.current`** and return it as `conflict`.

| Helper | No-op guard | Facade method |
|---|---|---|
| `moveTaskToStatus` | not a task, or already there | **`patchTask({expectedVersion, workStatus, clientMutationId})`** |
| `moveTaskToAxisValue` | axis already = value | **`patchTask({expectedVersion, axes, …})`** — sends the **merged** map because the facade replaces it wholesale |
| `assignTaskTo` | already assigned | **`placements({sourceId, targetId, intent:'assign', …})`** — **no optimistic paint** (no local `ActorSummary`) |
| `reparentEntity` | same parent | **`moveEntity({parentId, position, expectedVersion, …})`** |

Failure copy verbatim: board — `Someone changed "<title>" first — reloaded the latest version.` / `Couldn't move "<title>" — change rolled back.`; tree adds `Hierarchy is same-kind only — can't nest a <k1> under a <k2>.` `onMutationError` exists on both layout prop types but **`CollectionView` never passes it**.

---

## 6. Interactions — `src/collab-v2/interactions/` (9 files, ~2,000 lines)

### 6.1 Create flows — `create/index.tsx` (302 lines)

Three seeded entry points, all funnelling into `createFromSeed`: **channel "+"** (`seedForChannel` → `attachTo{entityId, edgeType:'attached_to'}`), **parent "+"** (`seedForParent` → `parentId`), and **palette** (via `openCreation(kind, seed)` on a zustand `useCreationStore`).

Dispatch: `registryFor(kind).createVia(facade, {spaceId, title, attachTo, content})` → always **`facade.createEntity`** (never `createTask` — DEV-1). The **parent-seed path bypasses the registry** and calls `createEntity({… parentId …})` directly, because `KindCreateInput` has no `parentId` field.

**9 creatable kinds** and their forms (`CreationSchema`, `KindRegistry.tsx:127-175`):

| kind | titleLabel | fields |
|---|---|---|
| task | Task title | `description`:textarea · `priority`:select[low,medium,high,urgent] · `dueDate`:date |
| channel | Channel name | `topic`:textarea |
| doc | Doc title | `format`:select[markdown,mermaid,excalidraw] **required** · `body`:textarea |
| team_member | Agent name | `identity`:textarea · `model`:text · `agentTool`:text |
| file | File name | `mimeType`:text · `sizeBytes`:number |
| spell | Spell name | `description`:textarea |
| skill | Skill name | `description`:textarea |
| pull_request | Pull request title | `repository`:text **required** · `number`:number **required** |

Not creatable: `message` (*"Messages are written in a thread composer."*), `member` (*"Members join a space via invite."*), `commit` (*"Commits are tracked from GitHub."*).

**Validation:** title required + trimmed; `field.required` is passed to the DOM only (native HTML validation, no JS check); `contentFromValues` skips empty values and coerces `number` fields. **Optimistic behaviour: none** — strictly pessimistic, then a `Created <title>` toast, then `pushPanel`. No `clientMutationId` is threaded.

> **Dead:** `CreatePlus`, `openCreation`, `seedForChannel`, `seedForParent`, `createFromSeed`, `CreationModal` have **no production callers**. `CreationHost` is mounted by `CollabDndProvider` (`dnd.tsx:235`) but **nothing ever opens it**. The context-seeded "+" is built and unwired. The palette's create step reaches `registryFor(kind).createVia` on its own path (`palette/actions.ts:133-172`), which is why palette creation still works.

### 6.2 Promote — `promote/index.tsx` (176 lines)

**Promote** = turn a thread message into a new entity, linked `relates_to` the message with the body quoted in. `PROMOTE_TARGETS = ['task','doc']` — **`message → task` and `message → doc` only**; anything else throws *"messages promote to task / doc, not <kind>"*.

`quoteExcerpt` strips embed/ref tokens, collapses whitespace, truncates (280 for the body, 80 for the title, fallback title `Promoted message`); `quoteBlock` produces `> <excerpt>\n> — <author>`. Landing: task → `{description: quote}`, doc → `{format:'markdown', body: quote}`. Method: `facade.createEntity` via the registry's `createVia`.

**Live wiring:** `promoteReactionsSlot` is genuinely mounted twice — `CollabV2App.tsx:47` (panel Discussion slot) and `ChannelHubBody.tsx:69` (channel feed) — rendering an `↗ Promote` button beside each message's reactions. Toasts: `Promoted to <label> — <title>` / `Promote failed — <describeError>`.

> Known gap, encoded as a test: the promote seed carries **no `parentId`**, so a promoted doc is born at the root rather than under its source's parent (`__tests__/acceptance/gaps-static.test.ts:83-98`, and an EXPECTED-FAIL marker at `w4-knowledge-grows.test.tsx:132-135`).

### 6.3 The drag-drop runtime — `dnd.tsx` (529 lines)

`CollabDndProvider` mounts once inside `CollabFacadeProvider` and hosts **two input paths converging on one pipe**: (a) **@dnd-kit** `DndContext` with `PointerSensor{distance:4}` + `KeyboardSensor` and a `DragOverlay`; (b) a **native HTML5 bridge** — document-level *capture* listeners for `dragstart` (the only moment `dataTransfer.getData` is readable → snapshot into the store), `dragover` (pointer tracking for the floating ghost), `dragend`/`drop`.

Both call `drop(source, target, at)` → `resolveDrop` → **0 options: abort · 1: commit immediately · 2–3: open the ambiguity menu**.

Shared state `useDndStore`: `drag, viaKit, hover{target,options}, pointer, menu`. `useDropSurface` returns `domProps` + `setNodeRef` + `isOver` + `options`; `onDragOver` requires the MIME **and** a non-empty `resolveDrop` before it will `preventDefault` — so a surface the grammar rejects renders no highlight and refuses the drop. `DropSurface` renders **inert (no hooks)** without a `DndApiContext`, so galleries and unit tests still mount.

**Production drop surfaces — only three:** the open Z3 panel body (surface inferred by `surfaceForEntity`, `CollabV2App.tsx:41`), the channel hub body (`'channel'`, `ChannelHubBody.tsx:45`), and a member card head (`'actor'`, `MemberCard.tsx:35`).

Overlays: `KitGhostOverlay` (dnd-kit only), `NativeGhostLabel` (fixed label at pointer+14/+18, `role="status"`), `DropMenu` (`role="menu"` "Choose what this drop means", Escape/ArrowUp/ArrowDown/Enter, positioned at the drop point), `UndoPill` (`role="status"` label + **Undo** + `×`, self-hiding at `expiresAt`). Also mounted here: `CreationHost`, `InteractionMenusHost`, and the **⌘Z / Ctrl+Z** binding (ignored with Shift, ignored in text fields, ignored with no live token).

`DraggableEntity` (the dnd-kit drag *source*) is **unused in production** — only the native path is exercised.

### 6.4 The command grammar — `grammar.ts` (187 lines)

Not a text grammar — the **`source kind × target surface → meaning`** table. Nouns (`DropSurfaceKind`): `channel`, `task`, `actor`, `composer`, `parent-zone`. Verbs (`PlacementIntent`): `attach`, `assign`, `depend`, `subtask`, `embed`, `reparent`. `MAX_DROP_OPTIONS = 3`, and `resolveDrop` **throws** if a row exceeds it.

**`GRAMMAR_TABLE` — all 7 rows, in precedence order:**

| # | id | surface | accepts | options (intent · label · example ghost) |
|---|---|---|---|---|
| 1 | `chip-to-channel` | channel | anything | `attach` · **Attach** · "Attach to #v2-build"; `attach`+`withEmbed` · **Attach & post card** |
| 2 | `task-to-task` | task | task→task | `attach` · **Attach**; `depend` · **Depend** · "Ship login depends on Add OAuth" (**target depends_on source** — the dropped task becomes the prerequisite); `subtask` · **Subtask of Ship login** |
| 3 | `artifact-to-task` | task | `{doc,file,spell}` → task | `attach` · **Attach** |
| 4 | `actor-to-task` | task | actor → task | `assign` · **Assign to Priya** |
| 5 | `task-to-actor` | actor | task → actor | `assign` · **Assign Ship login** |
| 6 | `chip-to-composer` | composer | anything | `embed` · **Embed Ship login** |
| 7 | `same-kind-to-parent-zone` | parent-zone | same kind **and** `treeReparentable` | `reparent` · **Move here** · "Move into Q3 epic" |

Predicates are all registry lookups, never kind literals: `isActor` = `capabilities.actor !== null`, `isTask` = `kindCan(kind,'workStatusBearing')`. `surfaceForEntity({kind})` infers `task`/`actor`/`channel`/`null` for generic hosts.

> **Two of the seven rows have no reachable drop target:** `composer` is never registered as a surface anywhere, and `parent-zone` is used only by the unreachable keyboard menus (§6.6). Only `channel`, `task` (via panel-body inference) and `actor` are mountable today.

### 6.5 Dispatch — `execute.ts` (116 lines)

`runPlacement(facade, {source, target, option, embedMessage?})` is the single dispatcher, and **the client does not branch on intent** beyond one optimistic special case:
1. `clientMutationId = nextMutationId()`.
2. Optimistic paint **only** for `subtask`/`reparent` (the one intent pair with a local field to patch) — `{...before, parentId: target.entityId}` into the graph store and every cached collection. `attach`/`assign`/`depend`/`embed` rely on the command's returned `patches`.
3. **`facade.placements(input)`** — the one and only command, `+ embedMessage` when `option.withEmbed`.
4. Success → `reconcile` → `applyEverywhere(patches)` → `registerUndo(result.undo)` → success toast.
5. Failure → `rollback` + restore, then branch **on the error code**: `version_conflict` (+`e.current`) → adopt server truth, best-effort `editorName()` from `facade.getActivity(current.id)`, toast `Edited by <who> just now — showing the latest version.`; anything else → `<option.label> failed — <describeError(e)>`. **No merge dialogs, ever.**

Server-side meaning of each intent (`mock/world.ts:1399-1486`): `attach`→`createEdge('attached_to')` + optional embed message; `assign`→normalise order then `createEdge('assigned_to')`; `depend`→`createEdge({srcId: target, dstId: source, type:'depends_on', props:{hard:true}})` (**reversed**, matching the ghost); `subtask`/`reparent`→`moveEntity`; `embed`→`postMessage` with an embed token. All five register undo tokens.

### 6.6 Keyboard parity — `keyboard.tsx` (275 lines)

Two imperative pickers intended as the keyboard equivalent of pointer drops (DEF-16): `openMoveTo(entity)` → `MoveToMenu` (the parent-zone drop) and `openLink(entity)` → `LinkMenu` (drop onto a picked target's surface, two steps). Both are `role="dialog" aria-modal` with a `role="listbox"`, an auto-focused `Filter…` input matching label+hint, and keys **Escape / ArrowDown / ArrowUp / Enter**. Candidates come from `knownEntities()` (graph store, non-deleted, newest `activityAt` first), each resolved through `resolveDrop` so rows carry real grammar ghosts. Empty copy: *"No other parent of this kind is known yet."* / *"<labelPlural> cannot be re-parented."* / *"Open ⌘K for a custom edge"*.

> **Dead:** `openMoveTo`, `openLink`, `MoveToMenu`, `LinkMenu`, `keyboardOptionsFor`, `useInteractionMenuStore` have **zero production call sites**. `InteractionMenusHost` is mounted but nothing ever opens it — **the entire keyboard-parity surface is unreachable in the running app.** The file's own header (`:12-14`) admits the palette rows are still a pending "one-line change, reported to Atlas".

### 6.7 Undo — `undo.ts` (84 lines)

**Not a stack — a single held token.** `useUndoStore {entry: UndoEntry | null}`; registering a new token **replaces** the previous one (newest wins). TTL `UNDO_TTL_MS = 5 * 60_000`, `expiresAt` from the server token when present. `runUndo(facade, now)` clears the entry **first** (single-use either way), then `facade.undo(token)` → `applyEverywhere(patches)` → `Undone — <label>`. Errors by code: `invariant_violation`→"The undo window has expired.", `not_found`→"Nothing left to undo.", else "Undo failed."

**What is undoable: placements only** (all six intents). Board/tree/bulk mutations (`patchTask`, `moveEntity` via `collections/mutations.ts`), creation and promote **register no undo token**. Redemption surfaces: the `UndoPill` button and the global ⌘Z.

---

## 7. Subsystems — `src/collab-v2/subsystems/` (5 dirs, 50 files)

### 7.1 `palette/` — the ⌘K command palette (7 files, 1,357 lines)

**How it opens:** `⌘K`/`Ctrl-K` via `shell/keyboard.ts:87-93` — handled **before** the typing guard, so it works inside the thread composer. Rendered only while `nav.paletteOpen` (`ShellLayout.tsx:92`). Also `openPaletteWith(entityId)` (`recents.ts:62-66`) sets a context entity then opens — called from `screens/team/MemberCard.tsx:48` (the `+ Spawn` button) and `interactions/keyboard.tsx:213`.

**Step machine** (`types.ts:15-28`): `root` → `goto` | `create{entityKind,parentId}` | `link-target{sourceId}` → `link-type{sourceId,targetId}` | `status{targetId}`. History is a stack; **Escape** pops one step (else closes) and **Backspace on an empty query** pops one step.

#### Complete action table

**A. Rows supplied by `facade.getActions(contextEntityId)`** (mapped at `actions.ts:231-287`; mock source `mock/world.ts:2441-2459`):

| id | label | section | glyph | Does | Gating |
|---|---|---|---|---|---|
| `create-task` | "Create task…" | Create / Context actions | `+` | step → `create{kind:'task', parentId:target??null}` | always (from mock) |
| `go-home` | "Go to Home" | Go to | `→` | `nav.setView('home')` | always |
| `go-tasks` | "Go to Tasks" | Go to | `→` | `nav.setView('tasks')` | always |
| `go-graph` | "Go to Graph" | Go to | `→` | `nav.setView('graph')` | always |
| `complete-<id>` | "Complete {title}…" | Context actions | `✓` | `getEntity` → **`completeTask(id,{expectedVersion, completerIds})`** (assignees else `createdBy`) | context entity **and** `capabilities.canComplete` |
| `status-<id>` | "Set status…" | Context actions | `◑` | step → `status{targetId}` | context entity **and** `kind==='task'` |
| `pull-<id>` | "Pull {title}" | Context actions | `⤓` | `getEntity` → **`pullEntity(id,{pinnedVersion})`** | context entity **and** `capabilities.canPull` |
| `link-<id>` | "Link {title} to…" | Context actions | `⇄` | step → `link-target` | context entity |
| *(other `navigate` kinds)* | facade label | Context actions | `→` | open entity, else `pushPanel` | target required |
| *(unknown kind)* | facade label | Context actions | `•` | `pushPanel({entityId:target})` | target required; **row dropped entirely without a target** |

**B. Local registry rows** (`buildLocalActions`, `actions.ts:290-370`):

| id | label | section | Does | Gating (`when`) |
|---|---|---|---|---|
| `ctx-open` | "Open {title} in a panel" | Context actions | `nav.pushPanel` | context entity |
| `ctx-pin` | "Pin {title} as a split" | Context actions | `nav.pinPanel`; notice **"Pin limit reached (3 splits)."** on refusal | context entity |
| `ctx-promote` | "Open {title} full view" | Context actions | `nav.promotePanel` → Z4 | context entity |
| `ctx-create-in` | "Create in {title}…" | Context actions | step → `create{kind:'task', parentId:ctx.id}`, later `attachTo{edgeType:'attached_to'}` | context entity |
| `ctx-repull` | "Re-pull {title} (refresh context)" | Context actions | `getEntity` → `pullEntity` | context entity **and** some `badges.pulls[]` has `contentStale \|\| discussionMoved` |
| `ctx-mark-read` | "Mark {title} read" | Context actions | **`facade.markRead(id)`** | context entity **and** `kindCan(kind,'markReadAnchor')` → **channel, task, doc only** |
| `create-channel` | "Create Channel…" | Create | step → `create{kind:'channel'}` | registry `paletteCreate != null` |
| `create-task` | "Create Task…" | Create | step → `create{kind:'task'}` | registry; **deduped away when the facade already returned `create-task`** |
| `create-doc` / `create-file` / `create-spell` / `create-skill` | "Create Doc/File/Spell/Skill…" | Create | step → `create{kind}` | registry |
| `link-from-ctx` | "Link {title} to…" | **Graph** | step → `link-target` | context entity |
| `goto` | "Go to…" | Go to | step → `goto` mode | always |
| `goto-home`/`-tasks`/`-docs`/`-team`/`-tracking`/`-graph`/`-leaderboard`/`-inbox`/`-settings` | "Go to X" (hint `g <first letter>`) | Go to | `nav.setView(view)` | always (9 rows) |
| `entity-<id>` × N | entity title | **Recent & known** | `nav.pushPanel` | one per entity in the known pool |

`VIEW_CHOICES` excludes `channel` and `entity` — they need an entity, not a jump.

**C. Step-mode choices.**
- **`status`** → `runSetStatus` = `getEntity` then **`facade.patchTask(id,{expectedVersion, workStatus})`**: `status-open` Open · `status-pulled` Pulled · `status-working` Working · `status-in_review` In review · `status-blocked` Blocked · `status-cancelled` Cancelled · `status-complete` "Complete task…" (hint *"awards points"*, routes to `completeTask`). **`done` is deliberately absent** — completion must go through `completeTask`.
- **`link-type`** → `runLink` = **`facade.createEdge({srcId,dstId,type})`**: `depends_on` (*blocks until resolved*) · `assigned_to` (*task → member / agent*) · `attached_to` (*entity → channel / hub*) · `tracks` (*task → PR / commit*) · `equips` (*task / agent → spell / skill*) · `relates_to` (*soft link, both ways*) · `copy_of` (*derived from*) · **`edge-custom`** "Custom edge `x:…`" — shown only when the typed query yields a namespaced type not already listed (`customEdgeType` trims, `\s+`→`_`, lowercases, prefixes `x:`).
- **`create`** → one row `create-confirm-{kind}`, label `Create {kind} "{title}"` or `Type a title for the new {kind}…`, hint `in {parent.title}`. `runCreate` errors "No space is open." / "Type a title, then press Enter." / the registry's `creationDisabledReason`, else `createVia(facade, {spaceId, title, attachTo})` → **`facade.createEntity`** → `pushPanel`.
- **`link-target`** → the entity pool under a "Link to" section; picking one advances to `link-type`.

**Errors:** `describeError` (`actions.ts:73-84`) switches on **code, never text**: `version_conflict`→"Someone changed this first — reopen and retry.", `forbidden`→"You do not have permission for that.", `not_found`→"That entity no longer exists.", `invalid_input`→the verbatim message. It is also imported by `interactions/execute.ts`, `create/index.tsx` and `promote/index.tsx`.

**Search:** **there is none, and no scoring.** `matchesQuery` lowercases `label + hint + keywords + entity.title` and requires **every whitespace token to be a substring** — AND, unordered, no fuzzy, no ranking; display order = insertion order. `parseQuery` strips repeatable leading `kind:<name>` tokens, which are unioned with the kind-chip toggles and applied **only to the entity pool** (action rows are never kind-filtered). The Recent & known section renders a literal slot: **"Full search arrives in a later release — showing recent & known entities."** (`CommandPalette.tsx:371-375`). Footer hint: `kind:task filters · tab reaches kind chips`.

**Entity pool** (`usePaletteData.ts`): recent ids (visit order) → nav stack reversed → pinned → host `entities` prop → the rest of the graph store by `activityAt` desc; tombstones excluded; capped `KNOWN_CAP = 40`; misses hydrated via `facade.getEntity`. **`facade.search` is never called.**

**Recents:** a plain in-memory zustand store, `RECENTS_CAP = 12`. **No localStorage / sessionStorage / server persistence — recents die with the tab.** `startRecentsTracker()` is idempotent and mounted twice (`CollabV2App.tsx:145`, `CommandPalette.tsx:93`).

**Keyboard:** `createListKeyNav({loop:true})` — ArrowUp/ArrowDown (wrapping), Home, End, Enter; mouse `onMouseMove` sets the index and `onClick` calls the identical `activate()` (the "parity law"); an async `busy` flag blocks re-entry. a11y: `role="dialog" aria-modal`, input `role="combobox"` with `aria-controls`/`aria-activedescendant`, list `role="listbox"`, rows `role="option" aria-selected`; kind chips are `role="checkbox"` over all 11 kinds + an "All" reset.

**Two internal inconsistencies:** duplicate "Go to Home/Tasks/Graph" rows (facade ids `go-*` vs local `goto-*`, deduped by id so both survive), and the `g <first letter>` hints yield `g t` for **both Team and Tracking** where the real chords are `g m` and `g k`.

> **Against `RealFacade`, `getActions()` returns `[]`** (`RealFacade.ts:288`), so on the live server group A vanishes: no Complete, no Set status, no Pull, no facade Link. What remains is group B — navigation, create, `ctx-*` context rows, and the recents pool. Of the commands those rows fire, **`pullEntity`, `setReaction`, `grantPoints`, `placements` and `undo` all throw `not_implemented`**, while `createEntity`, `patchEntity`/`patchTask`, `createEdge`, `completeTask`, `setWork`, `postMessage` and `markRead` are real.

### 7.2 `thread/` — the universal discussion component (12 files, 2,182 lines)

**Message rendering** (`MessageRow.tsx`): author `Avatar` (26px, 22px in compact/comments), display name, an **`AGENT`** badge plus `data-agent` on the article, `relTime` with the ISO string as `title`, an "edited" marker; replies indent `min(depth,6) * 20`; a soft-deleted message keeps its slot as a `<Tombstone variant="chip"/>` and still shows its reply toggle.

**Row kinds** (`types.ts:39-44`): `message`, `unread` (a divider "N new"), `more-replies` ("Load N more replies"), `activity` (folded "N updates", `ACTIVITY_FOLD_MIN = 2`), `pending`.

**Footer actions:** reactions slot (or a default `ReactionsReadout` = 👍 likes · 👎 dislikes if >0 · ⭐ stars · ◈ points if >0) · **Reply** · **Edit** (own only) · **Delete** (own only, danger) · reply-count toggle. Inline editing: textarea seeded from `markupFromBody`, **Enter** commits, **Shift+Enter** newline, **Escape** cancels, no-op if unchanged.

**Body parsing** (`body.ts` + `MessageBody.tsx`) — wire format is plain `content.body` + typed `content.mentions[]`, with **exactly two inline token forms**: `{{embed:<id>}}` → a **live Z2 card** (`CardById`) rendered as a block (an inline chip in compact mode), and `{{ref:<id>}}` → an inline `ChipById`. `@mentions` carry **no token** — the literal `@Display` text stays in the body and `parseBody` re-attaches chips by matching each mention's display **longest-first** (so "@Mira Chen" beats "@Mira"); mentions whose display never appears render as a trailing chip row. **No markdown, no code fences, no autolinking in message bodies** (markdown exists only for docs, via `react-markdown` in `KindRegistry.tsx:609`).

**Composer** (`Composer.tsx`, built on `react-mentions`): **Enter** sends / **Shift+Enter** newline; `@` completes **actors only** (`{member, team_member}`); `#` completes everything non-actor → `{{ref:id}}`; drag-and-drop accepts `ENTITY_DRAG_MIME` — a dropped **`file`** stages as a `FileAttachment`, anything else appends `{{embed:id}}`; staged attachment chips with "Remove {name}"; reply context label "Replying to {name}" + Cancel (Escape also cancels). **No slash commands — no `/` trigger exists.** Candidates come from the thread's authors + mentions + every cached graph-store entity except `message` and tombstones — **no server query**.

**Virtualization** (`VirtualList.tsx`, hand-rolled, no new dependency): variable-height windowing, rows start at `estimateRowHeight = 92`, real heights measured in a `useLayoutEffect` and committed only past 0.5px, a `Float64Array` prefix-sum offset table, **binary search** for `indexAtOffset`, `overscan = 6`, `BOTTOM_SLACK_PX = 32`, a `fallbackViewport = 720` for jsdom/`display:none`, ResizeObserver-driven viewport tracking. Imperative handle: `scrollToIndex`, `scrollToBottom`, `isAtBottom`, `element`.

**Facade methods** (`useThread.ts`, 408 lines): reads `getEntity`, `getMessages` (first page, `{cursor}` for `loadMore`, `{rootId}` for `loadReplies`), `getActivity` (**feed variant only**), `subscribe`, `getNavigation` (to resolve the viewer); writes `postMessage`, `patchMessage`, `deleteMessage`, `markRead`.

**Optimistic/pending:** `post` pushes a `PendingMessage` with a fresh `cmid_<base36>_<seq>`, applies `applyOptimistic(cmid, [{...anchor, counters.messages + 1}])` so the anchor counter moves immediately, then on success `reconcile` + defensively ingest the created message, on failure `rollback` + stamp `failed:{code,message}` → the row stays on screen with **↻ Retry** and **✕ Discard**. The **unread line** is computed once per anchor then frozen in a ref; a "↑ N new · jump to unread" bar plus "Mark read" sit above; `markRead` is one-shot per mount. Typing is **inline text** ("someone is typing…" / "N people are typing…"), not the `TypingIndicator` component.

**Mount sites:** panel Discussion tab (`CollabV2App.tsx:46`), `EntityFullView` margin slot (`:77`), the doc reader margin (`DocsScreen.tsx:24`, `variant:'comments'`), the member/agent profile wall (`ProfileZ4View.tsx:44` — **dead, unwired route**), the channel hub feed (`ChannelHubBody.tsx:65`, `variant:'feed'`), and `ThreadGallery` on `#/gallery`.

> **Dead export:** `DiscussionPanel` (`DiscussionSlot.tsx:47-56`) has **zero references anywhere, including tests**.

### 7.3 `rail/` — the Connections rail (8 files, 1,148 lines)

Top→bottom (`ConnectionsRail.tsx`): a **blocked rollup banner** (`⚠ Blocked` + "N unresolved hard dependencies · waiting on" + chips, preferring the server-computed `badges.blocked.waitingOn` and deriving from edges only as a fallback) → `HierarchySection` → edge groups (empty: **"Nothing linked yet — use "+ Link" or drop a chip here."**) → a **"+ Link"** button opening an inline `EdgeComposer` → an error line showing `"{code}: {message}"`. Loading skeleton; failure shows "Connections could not be loaded." + Retry. Permissions: `canEdit = !readOnly && (capabilities.canLink ?? true)`, `canAddChild = !readOnly && (capabilities.canAddChild ?? true)`.

**Edge groups** arrive **from the facade** as `Connections{outgoing[], incoming[]}` of `EdgeGroup{type, direction, label, edges[]}`. `orderedGroups` renders outgoing first, each sorted by unresolved-hard count desc → edge count desc → label, dropping empties. `x:*` custom types render exactly like registered ones (`railEdgeLabel` strips the prefix, `_`→space, capitalises). `resolutionBadge` fires only when `edge.hard != null` → `HARD ✓/⚠` or `SOFT ✓/⚠`. `GROUP_PREVIEW = 8` items before "Show all N".

The composer's own type list, `RAIL_EDGE_TYPES` — a **differently ordered and labelled list from the palette's**: `relates_to` "Related", `depends_on` "Depends on", `attached_to` "Attached", `tracks` "Tracks", `assigned_to` "Assigned to", `equips` "Equips", `copy_of` "Copy of", plus `__custom__` "Custom (x:…)".

**`HierarchySection`:** "Hierarchy" + total + **"Open as tree"** / **"Open as board"** buttons (disabled unless `onOpenCollection` is supplied — **it never is**); parent axis `↑` with a `⤴` "Detach from parent"; children `<ol>` with 1-based ordinals, `↑`/`↓` reorder buttons and `⤴` "Move {title} out" (reparents to the grandparent); the children container is a **drop zone** accepting `ENTITY_DRAG_MIME` → reparent; "Show more children (N left)" paging; "+ Add child". Reorder math is pure (`planReorder` + fractional `positionBetween`).

**Can edges be created from the UI?** The code says yes — `EdgeComposer` is reachable from "+ Link" and from each group's "+" (pre-typed, direction-locked), and submitting calls **`facade.createEdge({srcId,dstId,type,clientMutationId})`** (removal → `facade.deleteEdge`, reorder/reparent → `facade.moveEntity`). **But its target picker delegates to an injected `pickEntity` callback that no production call site supplies** (`CollabV2App.tsx:51` and `ProfileZ4View.tsx:40` both omit it), and the offline `candidates` fallback is never passed either. So **"Choose entity…" is permanently disabled and rail edge creation is unreachable in the shipped app.**

**Reads** (`useRailData.ts`): `getHierarchy` + `getConnections` in parallel — **skipped entirely when the host seeds an `EntityDetail`** (the panel slot already paid for those bytes). Re-fetches on entity change, on a seed `version` bump, and on any change to `useGraphStore.edgeIdsByEntity[entityId]`.

**Mount sites:** the panel Connections tab via `connectionsSlot()` (`CollabV2App.tsx:26,51`) and `ProfileZ4View.tsx:40` (**dead route**).

> Name collision worth knowing: **two unrelated `EdgeComposer`s exist** — `subsystems/rail/EdgeComposer.tsx` and `collections/graph/EdgeComposer.tsx`.

### 7.4 `reactions/` — `ReactionsPointsBar` (6 files, 702 lines)

**Reaction set — exactly three** (`ReactionsPointsBar.tsx:34-38`): `like` 👍 (`counters.likes`), `dislike` 👎 (`counters.dislikes`), `star` ⭐ (`counters.stars`). **like/dislike are mutually exclusive; star is independent.** Because the contract's `counters.viewerReaction` is a single field, the bar keeps a richer local `Set<Reaction>` and collapses it by priority `like › dislike › star` when projecting; `reconcileLocal` drops the local set when the server disagrees. Each is an `IconBtn` with `aria-pressed`, tooltip `"{Label} · {count}"`, and a count suppressible via `hideZeroCounts`.

**Points** (`PointsControl.tsx`) — one button, three gestures: **TAP** → `onGrant(1)`; **HOLD** (`HOLD_MS = 450`) → the amount picker (also reachable by **ArrowDown** and a dedicated `▾` caret with `aria-expanded`, because hold is not an accessible gesture); **HOVER** → a `PoolCard` popover showing "Points pool", the total, and the **top granters** with avatars. Picker: presets `POINT_PRESETS = [1,3,5,10,20]`, a custom `<input type="number" min=1>` + "Grant", Cancel; `role="menu"`/`menuitem`. Top granters are derived from the entity's own activity feed, summing `amount` for verbs `granted_points` **and** `awarded`, top 3.

**Facade:** `setReaction`, `grantPoints({amount, reason:'grant'|'award'})`, `getActivity` (lazy, memoised, for granters), `getEntity` (only when neither prop nor store has the envelope). Full optimistic journal with `cv2-rx-<seq>-<rand>` mutation ids.

**Mount sites:** per **message** in the panel Discussion slot (`CollabV2App.tsx:27,48`) and the channel hub feed (`ChannelHubBody.tsx:12,70`) — both `size="sm" hideZeroCounts`, both via the Thread's `reactionsSlot`. **In production the bar is only ever mounted on messages**, never directly on a task/doc panel, despite being designed as universal. Neither mount passes `capabilities`, and both flags default to **`true`**, so the bar is always interactive regardless of the entity's real capabilities.

> **Against `RealFacade`, `setReaction` and `grantPoints` both throw `not_implemented`.** The `EntityPanel` action bar's own 👍/👎/⭐/◈ buttons (§4.1) call the same two methods.

### 7.5 `live/` — presence, working, staleness, blocked, toasts (11 files, 883 lines)

Design rule (`useLive.ts:1-9`): components read **stores and the facade**, never their own timers or fake state.

| Component | Renders | Data | Mounted at |
|---|---|---|---|
| `PresenceAvatars` | overlapping viewer avatars + `+N` (max 4, 20px), title "N viewing: names"; `null` when empty | `usePresenceOf` → presence store, seeded once by `facade.getPresence` | `ChannelHeader.tsx:37` |
| `TypingIndicator` | animated dots + "Mira is typing…" / "A and B…" / "A and N others…" / "Someone…", `role="status" aria-live="polite"` | `usePresenceStore.typingByAnchor` | **nowhere** — dead |
| `WorkingPulse` | breathing actor avatar + name + pulse dot; hover popover "working on {task} since {relTime}" | `LiveWork` prop from `badges.workingActors` | only via `LiveBadges workingStyle="pulses"` → `AgentOrgTree.tsx:49` |
| `WorkingAggregate` | "🤖 N working" pulsing Pill, hover lists each detail, splits "N agents · M humans"; `null` at zero | `badges.workingActors` | `ChannelHeader.tsx:38` + `LiveBadges` default |
| `StalenessBadge` | per-puller `"v{pinned} pinned · v{live} → stale"` (compact `"v{pinned} → stale"`) or `"discussion moved since pull"`, **plus a RE-PULL button per row** | `badges.pulls` filtered to `contentStale \|\| discussionMoved` | only via `LiveBadges` |
| `BlockedBadge` | `⚠ blocked · N` + waiting-on chips (max 3, `+N`); an `unblocked` pill during the flash | `badges.blocked` | only via `LiveBadges` |
| `LiveBadges` | composed row in brief order **blocked → working → stale** | the three above | `screens/home/rows.tsx:63`, `AgentOrgTree.tsx:49` |
| `ToastViewport` | the toast stack | `useToastStore` | `CollabV2App.tsx:176` |

**Thresholds, verbatim:** `UNBLOCK_FLASH_MS = 2600` · `TOAST_TTL_MS = 5000` · `TOAST_CAP = 4` (keeps the newest 4) · `HOLD_MS = 450` (points) · and the only **time-based** staleness in the whole system, `PR_STALE_MS = 15 * 60 * 1000` in the mock. **Entity staleness is version-based, not time-based** — `StalenessBadge` compares `pull.pinnedVersion` to `live.version` and reads the server's `contentStale`/`discussionMoved` flags; there is no client-side "N minutes old" threshold anywhere.

`useUnblockMoment` tracks `wasBlocked` in a ref and fires **once** on the `true → false` flip (never on mount), flashing for `flashMs` and pushing a `{title} is unblocked` toast. RE-PULL calls **`facade.pullEntity(id, {pinnedVersion, localId, actorId})`** and toasts `Re-pulled {title} at v{version}`; errors decode by code. **Without a `facade` prop the badge is read-only** (no RE-PULL button) — so there is no affordance to mis-fire.

**Toasts** (`toast.tsx`) are a **zustand store, deliberately not a context**, so a badge deep inside a collection can announce without a provider. Kinds `unblock | stale | success | info | error`; glyphs `⛓️‍💥 / ⟳ / ⚠ / ✓`; `role="region" aria-label="Notifications"`, per-toast `role="status"`, `data-testid="toast-{kind}"`, "Dismiss notification" ×. `pushToast` has **11 external call sites** across `interactions/{execute,undo,create,promote}`, `screens/tasks/BulkBar`, `screens/inbox/InboxScreen`, `screens/home/HomeScreen`, `screens/tracking/TrackingScreen`.

**Presence plumbing:** `stores/presence.ts` holds `byEntity` + `typingByAnchor`, fed by `presence.changed` and `typing.changed` (never the durable stream, DEV-4). Production wiring is `connectStores` (`stores/index.ts:33-45`), which subscribes both channels — so the live layer's own `usePresenceChannel` hook is redundant and has **zero consumers anywhere, including tests**.

> **Against `RealFacade` the entire live layer is inert:** `getPresence()` returns `{viewers:[], typingActorIds:[], updatedAt: now}` (`:196-198`) and `subscribePresence()` is a no-op returning `() => {}` (`:460-463`) — "the channel exists, and it is genuinely silent." So `PresenceAvatars` and `TypingIndicator` render nothing. `team_member.state.liveWork` is a **hollow field** (always null), so `WorkingPulse`/`WorkingAggregate` render nothing. And `pullEntity` throws, so every RE-PULL button fails.

**Dead exports across the subsystems** (exported from a barrel, no consumer outside their own dir + tests): palette — `usePaletteOpen`, `selectPaletteContextId`, every `build*`/`run*`/`parseQuery`/`matchesQuery`; thread — **`DiscussionPanel`** (unused even by tests), `countMessages`, `variantForKind`, `foldActivity`, `MENTION_MARKUP`/`REF_MARKUP`; rail — `HierarchySection`, `EdgeGroupSection`, `EdgeComposer`, `useRailData`, all of `model.ts`; reactions — `PointsControl`, `useReactions`, all of `model.ts`; live — **`TypingIndicator`**, **`usePresenceChannel`**, `WorkingDetail`, and every hook except `useLiveEntity`.

---

## 8. Stores + the facade seam

### 8.1 The five stores — `src/collab-v2/stores/` (6 files, 715 lines)

| Store | Lines | Holds | Notes |
|---|---|---|---|
| `graph.ts` | 259 | `entities`, `details`, `edges`, `edgeIdsByEntity`, `messagesByAnchor`, `activityFeed`, `notifications`, `optimistic`, `seenEventIds` | The normalized client cache. Caps: `ACTIVITY_CAP = 300`, `MESSAGES_CAP = 500`. Optimistic journal keyed by `clientMutationId` with `applyOptimistic`/`reconcile`/`rollback` (rollback removes optimistically-created entities). Event de-dup by `eventId` |
| `nav.ts` | 185 | `spaceId`, `view`, `entityId`, `stack[]`, `pinned[]`, `paletteOpen`, `selection[]` | Owns the hash codec (`toHash`/`hydrateFromHash`) so every state is addressable. `MAX_PINNED = 3`. Narrow selectors `selectTopPanel`, `selectIsPinned`, `selectStackDepth` |
| `collections.ts` | 163 | `cache: Record<collectionKey, CachedCollection>`, `savedViews` | `collectionKey` = recursively key-sorted JSON. Cursor append + in-place `applyEntityPatch` so live events move board cards with no refetch. `selectSavedViews`/`removeSavedView` have **zero readers** |
| `presence.ts` | 45 | `byEntity`, `typingByAnchor` | Fed only by `presence.changed` / `typing.changed` |
| `connection.ts` | 18 | `connected: boolean` | **Zero UI readers** — the seam landed, the surface did not |

**The one event router** — `dispatchWorkspaceEvent` (`stores/index.ts:18-26`): every event goes to `graph.applyEvent` and `presence.applyEvent`; `entity.upsert` also patches cached collections, `entity.deleted` removes. `connectStores(facade, spaceId)` (`:33-45`) wires `subscribe` + `subscribePresence` and, when the facade exposes `ConnectionControl`, seeds and subscribes the connection store. Returns a combined unsubscribe.

### 8.2 `CollabFacade` — every method, and what `RealFacade` does with it

`facade/CollabFacade.ts` (178 lines) is **the** seam: 27 reads + 30 commands + 2 realtime = **59 methods**, plus the optional `ConnectionControl` (2) and tm8's bolted-on `ExecutionControl` (6, which lives beside the seam because the interface was frozen before `execution.*` existed).

Legend: **REAL** = a live server call · **EMPTY** = typed empty/zeroed (honest read degradation) · **THROW** = rejects `CollabError('not_implemented')` · **REROUTED** = real data fetched via a different route.

#### Reads — spaces & navigation
| Method | RealFacade | Detail |
|---|---|---|
| `listSpaces()` | **REAL** | `GET /v2/spaces` — a bare array, not a page |
| `getNavigation(spaceId)` | **REAL** | `GET /v2/spaces/:id/navigation` (but `unreadTotal` is a **hollow 0**) |

#### Reads — entity detail + lazy sections
| Method | RealFacade | Detail |
|---|---|---|
| `getEntity(id)` | **REAL** | `GET /v2/entities/:id` |
| `getHierarchy(id, cursor?)` | **REAL** | `getEntity` + `GET /v2/entities/:id/children` merged (one extra call buys parent + path) |
| `getConnections(id)` | **REROUTED** | `edges.list` is a 404, but `entities.get` carries a fully populated `connections` block — real edges both directions. Explicitly **not** counted as degraded |
| `getActivity(id, cursor?)` | **REAL** | `GET /v2/entities/:id/activity` |
| `getVersions(id, cursor?)` | **EMPTY** | `emptyPage()` — "so version UI renders blank, not wrong" |
| `getPresence(id)` | **EMPTY** | `{viewers:[], typingActorIds:[], updatedAt: now}` — "No viewers is TRUE here: nothing tracks presence" |

#### Reads — collections, graph, home
| Method | RealFacade | Detail |
|---|---|---|
| `queryCollection(query)` | **REAL** | `POST /v2/collections/query`; **strips `layout`/`groupBy`** (the server schema is `.strict()`) then merges them back into the echoed query so screens can read `result.query.layout` |
| `queryGraph(query)` | **EMPTY** | `{nodes:[],edges:[],clusters:[]}` — deliberately *fully* empty, because nodes-without-edges "would draw a disconnected graph that looks like a real answer" |
| `getHome(spaceId)` | **REAL** | `GET /v2/spaces/:id/home` — **and no screen calls it** |
| `getChannelTabs(channelId)` | **EMPTY** | `[]`, mirroring the server's honest empty |

#### Reads — messages, activity, inbox, leaderboard, axes, misc
| Method | RealFacade | Detail |
|---|---|---|
| `getMessages(anchorId, opts?)` | **REAL** | `GET /v2/entities/:id/messages` with `cursor`/`order`/`rootId` |
| `getSpaceActivity(spaceId, cursor?)` | **REROUTED** | No space-wide activity route; `spaces.home` computes exactly that feed → `home.activity` |
| `getInbox(cursor?)` | **EMPTY** | `emptyPage()` |
| `getLeaderboard(spaceId, cursor?)` | **EMPTY** | `emptyPage()` |
| `getAwards(spaceId, cursor?)` | **EMPTY** | `emptyPage()` |
| `getTaskAxes(spaceId)` | **EMPTY** | `[]` |
| `getSettings(spaceId)` | ⚠️ **MIS-SHAPED** | Returns `{spaceId, name, description, githubRepo, axes:[], members:[]} as unknown as SpaceSettings` — the contract expects `{space, members, invites, taskAxes}`. **Crashes the Settings screen** |
| `listSavedViews(spaceId)` | **EMPTY** | `[]` |
| `search(q, opts?)` | **THROW** | Deferred by DEV-13 *and* unbuilt on tm8. Deliberately throws rather than returning empty: "An empty search result reads as 'no matches', which is a different and false claim from 'search does not exist'" |
| `getActions(contextEntityId?)` | **EMPTY** | `[]` — "the palette falls back to recents" |

#### Commands — entities
| Method | RealFacade | Detail |
|---|---|---|
| `createTask(input)` *(deprecated)* | **REAL** | Sugar → `createEntity({kind:'task', content: rest})` |
| `patchTask(id, input)` *(deprecated)* | **REAL** | Sugar → `patchEntity(id, {content: rest})` |
| `createEntity(input)` | **REAL** | `POST /v2/entities` |
| `patchEntity(id, input)` | **REAL** | `PATCH /v2/entities/:id` |
| `moveEntity(id, input)` | **THROW** | |
| `deleteEntity(id, ctx?)` | **THROW** | |

#### Commands — edges & placements
| Method | RealFacade | Detail |
|---|---|---|
| `createEdge(input)` | **REAL** | `POST /v2/edges` |
| `patchEdge(edgeId, input)` | **THROW** | |
| `deleteEdge(edgeId, ctx?)` | **THROW** | |
| `placements(input)` | **THROW** | **⇒ the entire drag-drop grammar is dead against the live server** |
| `undo(token, ctx?)` | **THROW** | **⇒ ⌘Z and the undo pill are dead against the live server** |

#### Commands — messages, reactions, points, completion
| Method | RealFacade | Detail |
|---|---|---|
| `postMessage(input)` | **REAL** | `POST /v2/messages` |
| `patchMessage(id, input)` | **THROW** | ⇒ message editing dead |
| `deleteMessage(id, ctx?)` | **THROW** | ⇒ message deletion dead |
| `setReaction(id, input)` | **THROW** | ⇒ 👍👎⭐ dead everywhere |
| `grantPoints(id, input)` | **THROW** | ⇒ `◈` and `PointsControl` dead |
| `completeTask(id, input)` | **REAL** | `POST …/commands/complete`; **rejects client-side with `invalid_input`** when `completerIds` is empty rather than letting the server 400 |

#### Commands — pull/work, tracking, read-marks, axes, saved views
| Method | RealFacade | Detail |
|---|---|---|
| `pullEntity(id, input)` | **THROW** | ⇒ Home's PULL and every RE-PULL dead |
| `setWork(id, input)` | **REAL** | `POST …/commands/work` |
| `linkPr(id, input)` | **THROW** | |
| `trackingRefresh(input)` | **THROW** | |
| `markRead(anchorId, ctx?)` | ⚠️ **SILENT NO-OP** | Returns `{patches: []}`. The **one** unbuilt write that must not throw: the thread marks itself read on view, so throwing produced *"PAGEERROR: markRead is not implemented"* on **every** thread open. Also the truthful answer — the counters it would clear are hollow zeros |
| `markNotificationRead(id, ctx?)` | **THROW** | |
| `createTaskAxis` / `updateTaskAxis` / `deleteTaskAxis` | **THROW** ×3 | ⇒ the only mutating Settings section fails on every write |
| `createSavedView` / `updateSavedView` / `deleteSavedView` | **THROW** ×3 | ⇒ "Save view" and "save layout" dead |

#### Realtime
| Method | RealFacade | Detail |
|---|---|---|
| `subscribe(spaceId, cb)` | **REAL, but a POLL** | An `EventPoller` per space on `GET /v2/spaces/:id/events?since=<seq>` every **1500 ms**. Named a poller on purpose: "it deliberately does not pretend to be a subscription that happens to be slow" |
| `subscribePresence(spaceId, cb)` | **NO-OP** | Returns `() => {}` — "the channel exists, and it is genuinely silent" |

#### Beside the seam
`ConnectionControl`: `isConnected()`, `subscribeConnection(cb)` — both **REAL** (delegated to `TmClient`). `ExecutionControl` (`RealFacade.ts:101-116`) — all **REAL**: `spawnSession` (`POST /v2/execution/spawn`, always sending `mode: 'worker'` and `workdir:{mode:'project'}` because worktree is *refused* rather than defaulted), `promptSession`, `terminateSession`, `listProjects`, `createProject` (defaults `trust:'trusted'` because the operator just named it), `linkProject`, `createSpace`. Feature-detected via `hasExecutionControl(f)`.

### 8.3 Scoreboard

| Category | Count |
|---|---|
| Methods on `CollabFacade` | **59** (27 reads · 30 commands · 2 realtime) |
| REAL against tm8 | **21** (+ 8 `ExecutionControl`/`ConnectionControl` beside the seam) |
| REROUTED (real data, different route) | **2** (`getConnections`, `getSpaceActivity`) |
| EMPTY / zeroed reads | **9** |
| THROW `not_implemented` | **21 writes + `search`** |
| Special cases | **2** — `markRead` (silent no-op, reasoned) and `getSettings` (mis-shaped, crashes its screen) |
| NO-OP realtime | **1** (`subscribePresence`) |
| POLL masquerading as a subscription | **1** (`subscribe`, 1500 ms) |
| Hollow-but-typed fields | **13** (`HOLLOW_FIELDS`) |

### 8.4 `MockFacade` and `types/contract.ts`

**`mock/`** (7 files, **3,921 lines** — larger than any screen dir): `MockFacade.ts` (276) `implements CollabFacade` over a synchronous `MockWorld` (`world.ts`, **2,460 lines** — the real behavioural spec of the whole contract), plus `seed.ts` (433, the seeded world + `SeedIds`), `validate.ts` (350), `internal.ts` (227) and `simulation.ts` (165, the demo driver).

`MockFacade` adds the "backend feel": configurable latency (default **120–400 ms**, `0` for tests), an `errorRate` and a one-shot `failNextWith(err)`, `WorkspaceEvent` fan-out after every mutation, a deterministic `mulberry32` PRNG, **two separate subscriber maps** (durable vs presence, per DEV-4), an `offlineBuffer` that holds durable events while disconnected and replays them **in order with no loss**, and `ConnectionControl` via `setConnected`.

**`types/contract.ts`** (511 lines) is the single type module: `EntityKind` (the inherited **eleven**, `:16`), `EntitySummary`/`EntityDetail`/`EntityState`/`EntityContent` discriminated unions, `CollectionQuery` (kinds/filters/sort/groupBy/layout/cursor), `GraphQuery`/`GraphResult`, `Hierarchy`, `Connections`/`EdgeGroup`/`EdgeView`, `MessageView`, `ActivityItem`, `NotificationItem`, `LeaderboardRow`, `PointEventView`, `TaskAxis`, `SavedView`, `SpaceSettings`, `PresenceSnapshot`, `WorkspaceEvent`/`PresenceWorkspaceEvent`, all command inputs, `CommandResult`/`UndoToken`, and `CollabError` + `CommandErrorCode`. `CreateEntityInput.kind` is `Exclude<EntityKind, 'message'|'member'>` (`:343`). Note `EntityKind` here does **not** include `work_session` or `collection` — which is exactly why `real/tm8Kinds.tsx` has to widen the registry at runtime with a cast.

---

## 9. Kit + tokens

### 9.1 `src/collab-v2/kit/` — six primitives, 349 lines total

| Primitive | Props / variants |
|---|---|
| **`Pill`** (52) | `tone?: PillTone = 'neutral'`, `children`, `dot?: boolean = true` ("the color carrier"), `pulse?: boolean`, `title?`. **10 tones:** `working, done, blocked, review, stale, waiting, idle, open, neutral, brand`. Also exports `toneForWorkStatus` (`working→working`, `done→done`, `blocked→blocked`, `in_review→review`, `pulled→waiting`, `cancelled→idle`, else `open`) and `labelForWorkStatus` (`in_review`→`"in review"`). Design rule in the header: **status is always color + WORD, never color alone** |
| **`Avatar`** (44) | `actor: ActorSummary`, `size?: number = 24`, `title?`. **Shape is the provenance signal:** `isAgent` → `border-radius: 27%`, else `50%`; reinforced in the label (`"{name} (agent)"`). Content precedence: `actor.avatar` → glyph span (if length ≤4 and no `/` or `.`) or `<img>`, else first+last initials. `role="img"`, `data-actor-kind` |
| **`Eyebrow`** (6) | `{children, title?}` → `<span class="cv2-eyebrow">`. JetBrains Mono, 600, 11px, uppercase, 0.12em tracking. No variants |
| **`Kbd`** (6) | `{children}` → `<kbd>`. Mono micro type, 2px bottom border for the keycap effect |
| **`IconBtn`** (21) | Extends all native button attrs but **`'aria-label': string` is required at the type level** (the a11y contract). `active?: boolean` → `data-active`. 26×26, `:focus-visible` brand outline, `:disabled { opacity:.45 }` |
| **`Popover`** (111) | **One shared instance for the whole module** — `PopoverProvider` + `usePopover()` (throws outside the provider). `PopoverController = {open(anchor, content, {delayMs?}), cancel(), close(), isOpen}`. `OPEN_DELAY_MS = 350`, `CLOSE_DELAY_MS = 200` (grace so the pointer can travel in), `VIEWPORT_PAD = 12`; fixed positioning with a flip-above rule; Escape closes; `role="tooltip"`; `min-width:200px; max-width:360px` |
| **`listKeyNav.ts`** (80) | `createListKeyNav({count, index, onIndexChange, onActivate?, orientation?: 'vertical'\|'horizontal'\|'grid', columns?, loop? = false})`. Lives in kit (L0) so L2/L4 never import upward from the shell — enforced as an **identity** assertion by `__tests__/foundation/kit-layering.test.ts` (`shell/keyboard.ts` may only re-export it) |

### 9.2 `tokens.css` (163 lines) — the design system

Everything is scoped under **`.cv2-root`** so the module cannot leak into a host app; dark mode via `.cv2-root[data-theme="dark"]` or `[data-theme="dark"] .cv2-root`. Theme name: **"ATELIER" (paper & ink)**. Stated rule: *status is ALWAYS color + word, never color alone.* **85 custom properties** in 8 groups:

| Group | Vars |
|---|---|
| **1 · paper & ink** | 5 surfaces (`--pn-paper` `#F4F2EC`, `--pn-surface`, `--pn-card`, `--pn-hover`, `--pn-active`), 2 lines (`--pn-line`, `--pn-line-2`), 4 inks (`--pn-ink` `#23201B` → `--pn-ink-4`) |
| **2 · brass accent** | `--pn-brand` `#B26A2B`, `--pn-brand-2`, `--pn-brand-soft` (11% alpha), `--pn-brand-rgb` — "the one restrained accent" |
| **3 · functional/status** | `--pn-run`, `--pn-wait`, `--pn-block`, `--pn-info`, `--pn-idle` each + a `-soft` — "desaturated, anti-neon" |
| **3b · collab semantics** | `--cv2-status-working/-done/-blocked/-review/-stale/-idle` (+ softs) aliasing onto the functional ramp; `working` and `done` both alias `--pn-run` |
| **4 · type** | 3 families (`--pn-serif` Newsreader, `--pn-ui` Hanken Grotesk, `--pn-mono` JetBrains Mono) · 10 sizes (`display` 40 → `micro` 11, `mono` 12.5) · 3 line-heights · 3 tracking values |
| **5 · spacing** | strict 4px grid, `--pn-space-1` 4 … `-16` 64 (name = px/4) |
| **6 · radii** | `--pn-r-xs` 5, `-sm` 7, `-md` 10, `-lg` 14, `-pill` 999 |
| **7 · elevation** | `--pn-sh-sm`, `--pn-sh-md`, `--pn-sh-pop` — warm-tinted `rgba(40,34,24,…)`, "no glow" |
| **8 · motion** | `--pn-ease-out`, `--pn-ease-standard`, `--pn-dur-fast` 120ms, `-base` 180ms, `-slow` 280ms — "fast, mechanical, no bounce" |
| **Dark overrides** | Re-declares groups 1–3 as warm graphite (`--pn-paper` `#15130E`, `--pn-ink` `#EFE9DB`), brand → `#E0A45A`, all three shadows → black ramps. **Token-only inversion — no component CSS is dark-aware** |
| **Semantic type classes** | `.t-display .t-h1 .t-h2 .t-h3 .t-title .t-body .t-secondary .t-label .t-eyebrow .t-quote .t-mono .t-code`, all `.cv2-root`-prefixed |

**No z-index token group.** The only z-indices anywhere are hardcoded: `.cv2-popover { z-index: 1000 }`, the sim toggle's inline `zIndex: 60`, and the real-layer overlays' inline `zIndex: 200` (SpawnDialog). The design vocabulary talks in Z-levels (Z1–Z4) but there is no `--pn-z-*` scale.

**External network dependency:** `tokens.css:8` is `@import url('https://fonts.googleapis.com/css2?…')` pulling **Newsreader, Hanken Grotesk, JetBrains Mono** from Google Fonts at CSS-parse time — the module's only outbound request. Offline/CSP-restricted environments fall back to the local stacks in `--pn-serif/--pn-ui/--pn-mono`.

**Per-area stylesheets** (all tokens-only, `cv2-` prefixed): `shell.css` 265 · `entity.css` 408 · `collections.css` 291 · `graph/graph.css` 171 · `interactions.css` 308 · `thread.css` 354 · `rail.css` 246 · `reactions.css` 142 · `live.css` 178 · `palette.css` 185 · `kit.css` 119 · plus one per screen dir (`home` 128, `inbox` 112, `tasks` 109, `team` 128, `channel` 150, `docs` 103, `leaderboard` 195, `settings` 130, `tracking` 92) and `gallery.css` 39.

---

## 10. Tests — what is genuinely asserted

**853 tests total in `packages/ui`: 820 in `collab-v2` (78 files, 13 dirs) + 33 in `real/` (3 files).** The 820 figure is itself pinned in prose at `real/__tests__/mapping.test.ts:4` — *"Atlas's 820 tests cover the module; none of them touch this seam."*

### 10.1 The headline fact about which facade the tests run against

**Every one of the 820 `collab-v2` tests runs against `MockFacade` over a seeded in-memory world.** There is no `vi.mock` of the facade anywhere and no partial fake: tests use `vi.spyOn(realMockFacadeInstance, 'method')` to *observe* while the real implementation still executes, and `facade.failNextWith(err)` for error injection. Every DOM dir constructs it the same way, e.g. `entity/helpers.tsx:16-18` → `new MockFacade(createSeededWorld(), { latency: 0 })`; `acceptance/`, `interactions/` and `foundation/` add a `ManualClock` for undo-TTL determinism.

There is exactly **one** hand-rolled stub in the whole suite — `thread/helpers.tsx:78` `volumeFacade()`, used only by the 10,000-row virtualization test, whose docstring says: *"The smallest facade the Thread will run against… Anything the Thread calls beyond this it must tolerate failing — which is the point of the test."*

**Zero `collab-v2` tests touch `RealFacade` or `TmClient`.**

### 10.2 Per-directory counts

| Dir | Tests | What it covers |
|---|---|---|
| `foundation/` | **306** (113 literal) | `seam-purity` **195** (1 per source file) · `commands` 28 · `contract-reads` 21 · `validation` 20 · `reconciliation` 18 · `stores-replay` 11 · `connection` 5 · `home-presets` 3 · `simulation` 3 · `kit-layering` 2 |
| `entity/` | **89** (39 literal) | `chip-card` 31 (looped over all 11 kinds) · `panel` 19 · `registry` 19 · `tombstone-fullview` 16 · `registry-purity` 4 |
| `acceptance/` | **54** | `gaps-static` 14 · `states-and-offline` 8 · `w1` 4 · `w2` 6 · `w3` 9 · `w4` 6 · `w5` 7 |
| `rail-reactions/` | **55** | `rail-model` 15 · `rail` 15 · `reactions-model` 10 · `reactions` 10 · `slots` 5 |
| `interactions/` | **53** (47 literal) | `grammar` 16 (table-driven) · `create` 9 · `placements` 8 · `dnd` 7 · `keyboard` 5 · `promote` 5 · `conflict` 3 |
| `shell/` | **46** | `keyboard` 16 · `router` 12 · `panel-stack` 9 · `shell-layout` 9 |
| `screens-b/` | **42** (23 literal) | `purity` 20 · `team` 7 · `leaderboard` 6 · `docs` 5 · `registry-wiring` 4 |
| `screens-c/` | **40** (22 literal) | `screens-purity` 21 · `settings` 7 · `channel-hub` 6 · `tracking` 6 |
| `collections/` | **39** | `graph-model` 8 · `row-slots` 8 · `graph-canvas` 5 · `board-drag` 4 · `collection-view` 4 · `tree` 4 · `groupby-parity` 3 · `saved-view` 3 |
| `thread/` | **37** | `thread` 25 · `body` 8 · `virtualization` 4 |
| `palette-live/` | **35** | `palette-actions` 15 · `live` 11 · `palette-keyboard` 9 |
| `screens-a/` | **24** | `home` 7 · `tasks` 6 · `composition-purity` 6 · `inbox` 5 |

Sharpest individual assertions worth knowing: `board-drag.test.tsx` proves a board drop calls `patchTask({workStatus})` and that an injected `version_conflict` rolls the card back **and adopts the server's `current`**; `home-presets.test.ts` asserts **re-executing each preset's returned query reproduces the preset's items** and that "actor scope rides IN the returned filters, not in post-processing"; `placements.test.ts` proves attach-with-embed posts the card message **through the same single command**; `palette-actions.test.tsx` is driven **keyboard-only** by design (*"if a flow can't be finished with `press()`/`typeInto()`, it is a parity defect, not a test-harness problem"*) and asserts a rejected command surfaces a **code-derived** message, never raw server text; `live.test.tsx` asserts the unblock moment fires **exactly once on the flip, never on mount**; `thread.test.tsx` asserts a dropped **file** stages as an *attachment* while any other chip becomes an *embed*.

### 10.3 The five acceptance workflows

Run against a **re-assembly** of the real app composition (`acceptance/helpers.tsx:168-197`), because — and the file says so at `:12-16` — *"`CollabV2App.tsx` exports only the component — its `VIEWS` registry and `PanelBody` are module-private, so this file must RE-ASSEMBLE the identical composition."* `appViewRegistryParity` pins the two together by kind + count.

- **W1 — Author & stage** (4). *A human opens the creation modal from a channel, names a task, drags in a design doc, drags it onto an agent, and puts a 20-point bounty on it.* Asserts create+attach is **one command**; `resolveDrop(doc→task)` yields exactly `['attach']`; every drop returns a truthy `result.undo`; the channel's `tasks` auto-tab count is `before + 1`; then mounts the shell, clicks the **Connections** tab and asserts both the doc and the agent are present.
- **W2 — Agent pulls & works** (6). *An agent pulls at a pinned version, goes working, posts progress, a human corrects it mid-flight, the agent acks — visible from Home and via the channel embed.* Driven by **the app's own `Simulation` driver** so "what this test exercises is exactly what a viewer of the running app sees, not a parallel fixture." Asserts the tail three bodies in order `[progress, /^Correction:/, /^Ack —/]`, that `WorkingAggregate` renders `/🤖\s*1 working/`, and that the channel feed ends up containing a literal `{{embed:<t104>}}` token.
- **W3 — Ship & review** (9). *An agent links a PR, flips to in_review, the reviewer docks task and PR as pinned splits, stars it, completes it tagging the completer — points award, leaderboard moves, the dependent task unblocks exactly once.* Asserts `linkPr` is atomic **and upserts by URL**; both panel bodies simultaneously in the DOM; `MAX_SPLITS === MAX_PINNED` and the **4th pin returns `false`, not silently dropped**; a deep-link round-trip of the pinned layout; and **exactly one** badge-clearing `entity.upsert`. It also files a mock defect inline and then asserts the divergence.
- **W4 — Knowledge grows** (6). *Someone promotes a message into a doc; the doc quotes it and links back forever, and should land as a child of the spec doc.* **The file splits the brief's claim in two because half is not built**: an EXPECTED-FAIL marker asserts `result.entity!.parentId` **is `null`** with the message *"brief §10.4 wants parentId === docSpec; the build produces null"*, and a third test shows the one-line fix is available.
- **W5 — Orient a newcomer** (7). *A brand-new member lands on Home, reads the three labelled columns, opens the dependency graph and sees the red blocked path, then reads a channel's pinned shelf — with zero prior clicks.* "Newcomer" is enforced mechanically by `assertColdStart()` (0 entities in the graph store, 0 stack, 0 pins): *"If a surface only makes sense after you have clicked around, it fails here."*

### 10.4 `gaps-static.test.ts` — the encoded-gaps file (14 tests)

A node-environment source-grepper whose stated purpose (`:4-8`) is: *"Each `GAP:` test pins the CURRENT state of an unmet §L7/§L8 requirement, so the day the gap is closed this file fails and someone updates it deliberately — the opposite of a silently-passing suite that has drifted away from the plan."*

| Gap | Asserted |
|---|---|
| **1 — offline UI does not exist** | `useConnectionStore`/`selectConnected` readers outside `stores/` `.toEqual([])`; no component matches `/offline[-\s]?banner\|OfflineBanner\|reconnecting/i`; `CollabV2App` contains no `setConnected` — *"ships a simulation toggle but no connection toggle"* |
| **2 — promote never parents** | the promote seed contains `attachTo` but **not** `parentId`, *"so the doc is born at the root"*; the create module proves the capability exists |
| **3 — gallery coverage vs the definition of done** | Z1/Z2/Z3 present, but **`EntityFullView` absent** (*"all 11 kind × Z4 cells are missing; the 5 Z4 layout variants are unexercised"*), no `EmptyState` cell, no error cell, and **none of 12 named W2/W3/W4 components** (`ConnectionsRail, ReactionsPointsBar, CommandPalette, CollectionView, GraphCanvas, LiveBadges, StalenessBadge, BlockedBadge, DropSurface, CreationModal, PromoteMenu, UndoPill`) has gallery presence |
| **4 — the one layer-direction violation** | upward `screens/ → interactions/` imports are **exactly** `screens/channel/ChannelHubBody.tsx` and `screens/team/MemberCard.tsx` (*"if this list grows, the inversion is spreading"*); `interactions/ → screens\|shell` is `[]`; and **no test anywhere enforces import direction** — this file is the only place the layer law is written down |
| **rig fidelity** | `CollabV2App` still spreads all nine `*Views` and still contains `entity: EntityZ4Route`; and `GAP: CollabV2App exports no composition, so the rig must copy it` |

`states-and-offline.test.tsx` (8) additionally records a doc divergence inline (`:47-51`): *"`facade/CollabFacade.ts:20` states 'Reads reject with `not_found` for missing/tombstoned ids'. They do not, for `getEntity`. The behaviour is better than the docstring."*

### 10.5 The six purity tests — the module's design constraints

| Test | Rule it enforces |
|---|---|
| `entity/registry-purity.test.ts` (4) | **THE LAW: kinds are data.** Behaviour may not branch on kind outside `registry/`. Scans all of `src/collab-v2` with 9 forbidden regex forms, allows narrowing *reads* of `state`/`content`, requires a grep-able `// registry-purity: allow — <reason>` for kind-keyed storage maps. Includes negative controls proving the scanner catches all 9 forms and clears annotated lines. Fails **in both directions** (a stale `EXPECTED_FAILURES` entry whose count dropped reports "the fix landed; DELETE this entry"). **Current debt: zero.** One permanent per-file allowance: `thread/Thread.tsx`'s `row.kind` (a `ThreadRow` union discriminant, not an entity kind) |
| `screens-a/composition-purity.test.ts` (6) | **THE L5 LAW, strictest variant** (home/inbox/tasks): screens are composition only — no `kind ===`, no `.state.(kind\|workStatus\|axes\|assignees)` reads, no hand-rolled `cv2-(chip\|card)__` markup, **no `registryFor()` at all** (*"only its shared formatters"*), and **no mock imports** (*"screens speak only to the facade seam"*) |
| `screens-b/purity.test.ts` (20) | Same law for docs/team/leaderboard, plus the only variant that **bans hand-rendered `{x.title}` / `{x.excerpt}` markup** and the only one with a **positive** requirement: each dir must actually mount one of 12 named `COMPOSED` components |
| `screens-c/screens-purity.test.ts` (21) | Same law for channel/tracking/settings, in conditional form: a file *either* renders entities through a shared component *or* renders no entities at all |
| `foundation/seam-purity.test.ts` (195) | **DEV-12: the seam is backend-agnostic.** One generated test per source file forbidding `/firebase/i`, `/supabase/i`, `/publishable[_-]?key/i`, `/x-collab-/i`, `/postgres_changes/` anywhere in shipped `.ts/.tsx/.css` |
| `foundation/kit-layering.test.ts` (2) | **DEF-15:** `createListKeyNav` lives in `kit/` (L0); three import paths must be **identical** (`toBe`), so a re-implementation in `shell/` fails |

### 10.6 Zero coverage, and the `real/` suites

**Never imported by any test** (and never transitively mounted): `collab-v2/gallery/*` (only *read as a string* by `gaps-static`), **`collab-v2/CollabV2App.tsx`** (only grepped — the acceptance rig re-implements its composition, so a drift in the component *body* is invisible except via two string-parity tests), `collab-v2/main.tsx`, and — on the tm8 side — **`real/ModeBanner.tsx`, `real/SpacePicker.tsx`, `real/SpawnDialog.tsx`, `real/tm8Kinds.tsx`, `real/terminal/runtime.ts`, `real/terminal/visibilityDriver.ts`, `src/main.tsx`**.

**Indirect-only coverage** (no direct mount): all of `shell/{LeftRail,IconRail,PanelStack,CenterHost,icons,placeholders}`, `channel/{ChannelHeader,ChannelShelf,ChannelTabs}`, `home/{ActivityFeed,WorkColumn}`, `inbox/NotificationRow`, `leaderboard/ScoreRows`, `tracking/TrackingRow`, `team/{AgentOrgTree,ProfileZ4View}`, `tasks/BulkBar`, `docs/VersionHistory`, all four `settings/*Section`, `rail/{EdgeComposer,HierarchySection}`, `collections/{graph/EdgeComposer,layouts/{Feed,Gallery,List}Layout}`, `entity/EntityById`, `registry/format.ts`, and the whole `kit/` primitive set.

**`real/__tests__/mapping.test.ts` (16 tests)** — the only RealFacade coverage, running the real facade + client against a stubbed global `fetch`. Its framing (`:2-8`): *"What is tested here is specifically the places where tm8 and the UI snapshot DISAGREE, plus the degradation policy, because those are the two things that cannot be caught by looking at a screen: a wrong error code still renders, and a fabricated empty still renders."* Covers: DEV-6 envelope unwrap + bare-array `spaces.list` + `patches` defaulting to `[]`; `limit_exceeded`→`rate_limited` preserving `status 429`/`retryable`/`details.tm8Code`; unrecognised codes → `upstream_unavailable`; `ECONNREFUSED` → `isConnected() === false`; `toWorkspaceEvent` synthesising `sp1:42` and stripping `seq`/`schemaVersion`; **poller cursor discipline** (advances to max observed seq so a gap 1→7 resumes at 7 *"which would resume at 2 and replay forever"*; a server `nextCursor` wins; a failed poll does not advance); the **never-fabricate** policy (9 typed-empty reads, 6 loud-throw writes, `markRead` as a reasoned silent no-op, and `search` **rejecting** because *"An empty search result reads as 'no matches', which is a different and false claim from 'search does not exist'"*); the hollow-field register; and spawn preconditions (`workdir:{mode:'project'}` always, empty `completerIds` rejected client-side).

**`real/terminal/ptyTransport.test.ts` (12)** — real transport against a hand-rolled `FakeWebSocket`. Asserts it snaps to `attached.next` and **not** `base + replay.length` (5 chars standing for 432 raw bytes → `__received === 432`); live frames advance by **raw UTF-8 byte length** (`'é'` counts 2); suspend/resume reopens at the preserved offset with **no** reset; **resets** on a changed epoch even without a byte rewind (*"the epoch is the only honest signal"*) and on a ring-eviction `gap`; the legacy base-rewind heuristic fires only absent an epoch; a `replayKind:'snapshot'` frame is decoded but **not counted**; a resize measured before the socket opens is **flushed on `onopen`, not dropped** (*"Dropping that frame strands the PTY at 80x24 forever"*); keystrokes go as **binary** frames, filtered by `typeof f !== 'string'` because *"under jsdom the TextEncoder can come from a different realm, so instanceof lies"*.

**`real/terminal/writeScheduler.test.ts` (5)** — coalesces `'a','b','c'` into **one** write per frame with nothing written before it; `flushTerminalOutput` writes **synchronously** (*"the visibility driver depends on this — it flushes and suspends with no await in between"*); force-flushes past the hidden throttle; `dropTerminalOutput` discards.

---

## 11. Consolidated: present-but-dead, mock-only, or unreachable from the real entry

This is the section that matters most for the gap audit. Everything below **exists as shipped code** and is either never mounted, never opened, or inert against the live server.

### 11.1 Never mounted / never opened in the running app

| Thing | Status |
|---|---|
| **The whole `interactions/create/` UI** — `CreationModal`, `CreatePlus`, `openCreation`, `seedForChannel`, `seedForParent` | `CreationHost` **is** mounted (`dnd.tsx:235`) but **nothing ever opens it**. The context-seeded "+" affordance does not appear anywhere. (Palette creation works via its own path.) |
| **The whole keyboard-parity surface** — `MoveToMenu`, `LinkMenu`, `openMoveTo`, `openLink`, `keyboardOptionsFor` | `InteractionMenusHost` **is** mounted but nothing ever opens it. Drag-drop has no keyboard equivalent in the running app |
| **Rail edge creation** | `EdgeComposer` is wired to `facade.createEdge`, but its target picker needs an injected `pickEntity` that **no production call site supplies**, and the `candidates` fallback is never passed either → "Choose entity…" is permanently `disabled` |
| **`ProfileZ4View`** (`screens/team/`) | Exported as an optional `profileViews` fragment; `CollabV2App.tsx:92` claims the `entity` route with `EntityZ4Route` instead. Its own header says "wire it only if no other screen claims that route" — nothing does |
| **`DiscussionPanel`** (`thread/DiscussionSlot.tsx:47`) | Zero references anywhere, **including tests** |
| **`TypingIndicator`** (`live/`) | Fully built with 4 phrasings; mounted nowhere. The Thread renders its own inline typing text instead |
| **`usePresenceChannel`** (`live/`) | Zero consumers anywhere, including tests; superseded by `connectStores` |
| **`PLACEHOLDER_VIEWS`** (`shell/placeholders.tsx:127`) | Dead export — only `graph` actually falls through |
| **`extraSections`** (LeftRail) | Prop exists; no caller passes it |
| **`onLink` / `onAddChild`** (EntityPanel) | The `Link` and `Add child` buttons render (titled *"arrives in W4"*) and **do nothing** — the app passes only `slots` |
| **`dependencies` slot** (EntityFullView `subtree` layout, i.e. every task Z4) | Renders the hint *"The dependency mini-graph plugs in here (W2/W4)."* — no caller fills it |
| **`Copy to space`** (panel overflow menu) | Hardcoded `disabled`, titled *"Cross-space copy arrives later"* |
| **`Watch` / `Unwatch`** (panel overflow menu) | Local `useState` only — **no facade call**, purely cosmetic |
| **`refreshSlot`** (TrackingRow) | A designed per-row seam no caller supplies |
| **`onOpenCollection`** (rail HierarchySection) | Absent → "Open as tree"/"Open as board" render `disabled` |
| **`rowAction` / `selection` / `expandDepth` / `savedView` / `emptyState` / `sortBy`** (CollectionView) | Six props with **no production caller** (tests only) |
| **`onMutationError`** (Board/Tree layouts) | `CollectionView` never passes it |
| **`DraggableEntity`** (the dnd-kit drag source) | Unused — only the native HTML5 drag path is exercised |
| **`icons.tsx` `settings` and `square`** | Drawn, referenced nowhere |
| **Two grammar rows** — `chip-to-composer` and `same-kind-to-parent-zone` | Their surfaces (`composer`, `parent-zone`) are never registered by any production drop target |
| **Sort UI** | `uiSort` exists in `CollectionView`; no UI, no screen passes `sortBy` |
| **Filter UI** | No filter control exists anywhere in the collections layer |
| **Saved-views list** | Creatable, but re-selectable **only** inside the graph canvas dropdown; `deleteSavedView` is never called |
| **Offline UI** | `connection.ts` has **zero UI readers**; no offline banner, no queued composer — asserted as a gap in `gaps-static.test.ts` |
| **`isHollow()` / `hollowReason()`** (`real/capabilities.ts`) | Built precisely so a screen can caption a hollow zero — **no screen calls either** |
| **`facade.getHome()`** | Implemented in both facades, called by nothing (HomeScreen re-expresses the presets as live queries) |
| **`facade.deleteSavedView()`** | Defined on the seam and in the mock, called by no UI |
| **`content.autoTabs`** | Declared in the contract, deliberately bypassed in favour of `getChannelTabs()` |

### 11.2 Mock-only by construction

| Thing | Why |
|---|---|
| **`gallery/Gallery.tsx`** (the `#/gallery` QA route) | Builds its own `createSeededFacade()` and hardcodes one seed entity id per kind from `facade.ids` — a property only `MockFacade` exposes. It also **resets and rewires the app-wide stores** to its own world on mount. Cannot run against `RealFacade` |
| **The simulation toggle** (`▶`/`◼` + step counter) | Explicitly gated off in real mode (`CollabV2App.tsx:180`), because "a 'sim on/off' toggle over live data would imply the events are synthetic when they are not" |
| **`mock/` (3,921 lines incl. a 2,460-line `world.ts`)** | The behavioural spec of the whole contract, shipped in the bundle |
| **`useViewerActors`** (Home) | Repurposes `getLeaderboard` as the actor roster — mock-shaped: `getLeaderboard` returns `{actor, score, rank}`, and the mock happens to include every `member` *and* `team_member`. Against `RealFacade` it returns an empty page, so **Home has no actor scope at all** and every column query carries an empty `assigneeIds` |
| **`filters.readyToPull` / `inReviewForActorId` semantics** | Defined only in `mock/world.ts` |
| **`assignTaskTo`** (collections/mutations) | Paints no optimistic state and relies on `patches` arriving synchronously — the comment says "the mock emits the fresh summary synchronously after latency" |
| **`model.ts:46` comment** (screens/team) | Names concrete seed agents ("Forge → Scout, Probe") in production source |

### 11.3 Inert against the live server (code is alive; the server is not)

Because 21 writes + `search` throw and 9 reads return typed empties:

| Surface | Effect on the real server |
|---|---|
| **Drag & drop, all of it** | `placements` throws → every drop toasts a failure |
| **⌘Z / the undo pill** | `undo` throws |
| **👍 👎 ⭐ and ◈ points** (panel action bar, every message's `ReactionsPointsBar`, `PointsControl`) | `setReaction` / `grantPoints` throw |
| **Home's PULL, every RE-PULL, the palette's Pull/Re-pull rows** | `pullEntity` throws |
| **Message edit and delete** | `patchMessage` / `deleteMessage` throw |
| **`Delete` in the panel overflow menu** | `deleteEntity` throws |
| **Tree drag-reparent, rail reorder/reparent, `moveEntity` anywhere** | `moveEntity` throws |
| **Tracking's `↻` and `↻ Refresh all`** | `trackingRefresh` throws |
| **Task-axes CRUD** (the only mutating Settings section) | all three throw |
| **"Save view" and "save layout"** | `createSavedView` / `updateSavedView` throw |
| **Inbox** (screen + the icon-rail unread dot) | `getInbox` → empty page ⇒ permanently "no notifications yet.", dot never appears |
| **Leaderboard** (whole screen) | `getLeaderboard` + `getAwards` → empty ⇒ three empty-state lines |
| **Docs → History** | `getVersions` → empty ⇒ always "No edits recorded yet." |
| **Channel auto-tabs** | `getChannelTabs` → `[]` ⇒ only the Feed pane; **and therefore the layout switcher — the sole route to Board/Tree/Feed/Gallery/Graph — is unreachable** |
| **The graph canvas** | Unreachable (above) *and* `queryGraph` returns fully empty |
| **The task-axis pivot** | `getTaskAxes` → `[]` ⇒ only `None`/`Status`/`Assignee` |
| **All presence and typing** | `getPresence` → no viewers, `subscribePresence` → no-op ⇒ `PresenceAvatars` and typing render nothing |
| **Working badges** | `team_member.state.liveWork` is a **hollow null** ⇒ `WorkingPulse`/`WorkingAggregate` render nothing |
| **Every unread count** | `channel.state.unreadCount`, `space.unreadTotal`, `navigation.unreadTotal` are **hollow zeros** — a real "0 unread" and an unbuilt "0 unread" are pixel-identical |
| **The palette's whole facade-supplied action group** | `getActions` → `[]` ⇒ no Complete, Set status, Pull or facade Link rows |
| **The Settings screen** | ⚠️ Not empty — **crashes**: `getSettings` returns a shape that does not match `SpaceSettings`, so `{space.name}` reads a property of `undefined` |
| **Realtime everywhere** | `subscribe` is a **1500 ms poll**, so every "live" surface updates on that tick |

### 11.4 Internal inconsistencies found while reading

1. **`view:'channel'` does not round-trip through the URL.** `toHash` writes `/e/{id}`; `hydrateFromHash` reads any `/e/{id}` back as `'entity'`. A channel deep link, reload or back/forward lands on `EntityZ4Route`, and the LeftRail channel row loses its active state.
2. **Two hash codecs.** `nav.toHash` emits `t=` (panel tabs); `router.buildHash` does not — links built for sharing silently drop tabs.
3. **The work_session Z3 panel still says there is no terminal** (`tm8Kinds.tsx:111-114`), which stopped being true when the PTY WebSocket shipped.
4. **The palette's `g <letter>` hints disagree with the real chords** for Team (`g m`) and Tracking (`g k`) — both are advertised as `g t`.
5. **Duplicate palette rows** — facade `go-home/go-tasks/go-graph` vs local `goto-home/goto-tasks/goto-graph`, deduped by id so both survive.
6. **Two unrelated `EdgeComposer` components**, and **two differently-ordered edge-type lists** (`palette/actions.ts` `EDGE_TYPE_CHOICES` vs `rail/model.ts` `RAIL_EDGE_TYPES`).
7. **Two divergent `initials()` helpers** — `IconRail` (first+second, `'??'`) vs `Avatar` (first+last, `'?'`).
8. **Two screen-root testid conventions** — `view-<name>` vs `<name>-screen`.
9. **Axis renaming is unreachable** — the `✎` editor sends only `axisValues` though `onRename` accepts `{name?, axisValues?}`.
10. **Bulk-unassign is impossible by design** — `BulkBar` filters out the `unassigned` column.
11. **`TasksScreen` "None" pivot still shows status columns in the bulk bar** (`groupBy={pivot ?? 'workStatus'}`).
12. **Duplicate reads:** Tasks fetches `getTaskAxes` twice and issues ≥2 `queryCollection` calls for the same task set (distinct cache keys); Docs issues its doc query twice; Tracking issues **one `getConnections` per row** (an N+1 that, under `RealFacade`, is one full `getEntity` per PR).
13. **No pagination** on Inbox, the Home activity feed, the leaderboard-as-roster, both Team rosters, the leaderboard, or the Tracking commits list — several of which then present a first-page count as a total.
14. **Declared ARIA roles without their keyboard contracts** — `role="tablist"` (Tasks), `role="radiogroup"` (GroupByPivot) and `role="tree"` (AgentOrgTree, TreeLayout) all lack arrow-key navigation; the org tree also lacks `aria-expanded` and is permanently expanded.
15. **`tokens.css` fetches Google Fonts over the network** at CSS-parse time — the module's only outbound request.
16. **The layer-direction law is enforced nowhere** except as a pinned-list assertion in `gaps-static.test.ts`; the two known upward `screens/ → interactions/` imports are `ChannelHubBody.tsx` and `MemberCard.tsx`.

---

## Appendix — file/line inventory by area

| Area | Files | Source lines |
|---|---|---|
| `src/main.tsx` | 1 | 113 |
| `src/real/` (excl. tests) | 13 | 2,317 |
| `src/real/__tests__` + terminal tests | 3 | 584 |
| `collab-v2/` root (`CollabV2App`, `index`, `tokens.css`) | 3 | 387 |
| `collab-v2/shell/` | 13 | 1,565 |
| `collab-v2/entity/` | 10 | 1,391 |
| `collab-v2/registry/` | 4 | 1,193 |
| `collab-v2/collections/` (incl. `layouts/`, `graph/`) | 23 | 2,404 |
| `collab-v2/interactions/` | 9 | 2,026 |
| `collab-v2/subsystems/` | 50 | 6,272 |
| `collab-v2/screens/` | 61 | 4,395 |
| `collab-v2/stores/` | 6 | 715 |
| `collab-v2/facade/` + `types/` | 4 | 692 |
| `collab-v2/kit/` | 9 | 468 |
| `collab-v2/mock/` | 7 | 3,921 |
| `collab-v2/gallery/` | 3 | 239 |
| `collab-v2/__tests__/` | 78 | 13,148 |
| **Total** | **297** | **~40,230** |

*Roughly 34% of the package by line count is tests; roughly 10% is the mock world. Of the ~26,600 non-test module lines, the sections marked dead or unreachable in §11.1–11.3 account for a substantial minority — the gap audit owns quantifying that.*

