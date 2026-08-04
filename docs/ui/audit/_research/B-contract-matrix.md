# B — Contract-op × UI-consumption × Server-implementation matrix

**Repo:** `/Users/subhang/Desktop/Projects/tm8` · **Audited:** 2026-07-25 · **Method:** read from source
(`packages/contract/src/catalog.ts`, `packages/server/src/**`, `packages/ui/src/**`), not from docs.
**READ-ONLY audit** — no code changed, no git commands run.

> Every count below was derived by parsing `catalog.ts` and cross-referencing the actual
> `registry.register*` call sites. Where this report disagrees with `STATE.md`, the source wins
> and the disagreement is called out.

---

## 0. Headline

| | Count | Source of truth |
|---|---|---|
| Catalog entries | **81** | `packages/contract/src/catalog.ts:30-142` |
| — `status: 'v1'` | 79 | `catalog.ts:159` |
| — `status: 'reserved'` (must 501 forever) | 2 — `search.query` (`:95`), `bridge.fetchBlob` (`:111`) | `catalog.ts:162` |
| HTTP routes mounted | **80** (81 − `events.subscribe`, which is `method: 'WS'`) | `http/router.ts:82` filters `method !== 'WS'` |
| Handlers actually registered | **28** | 23 + 1 + 4, enumerated in §2 |
| Answering honest 501 | **53** of 81 | `facade/registry.ts:5-6`, `http/server.ts` step 7 |
| CollabFacade methods on the UI seam | **53** | `collab-v2/facade/CollabFacade.ts:45-161` |
| — backed by a real server call in `RealFacade` | **19** | §4.1 |
| — degraded to a typed empty / hardcoded (**silently dead**) | **11** | §4.2 |
| — deliberate silent no-op (`markRead`) | **1** | §4.2 |
| — reject with `not_implemented` (**loudly dead**) | **21** | §4.3 |
| — no-op subscription (`subscribePresence`) | **1** | §4.3 |

**The one-line answer:** the tm8 node implements 35% of its own contract; the transplanted UI was
built against 100% of it. **34 of 53 CollabFacade methods (64%) are dead against real data**, and
the more dangerous third of that is the *silent* part — 11 methods return a well-typed empty value,
so the screen renders successfully and looks truthful while showing nothing.

---

## 1. Summary by family

`impl` = a handler is registered. `UI` = at least one non-test, non-mock UI code path can reach the
op through `RealFacade`.

| Family | Ops | Server-impl | UI-reachable | Notes |
|---|---:|---:|---:|---|
| `identity` | 1 | 1 | 0 | `identity.get` works but **nothing in the UI calls it** — no viewer identity anywhere |
| `spaces` (core) | 9 | 5 | 4 | `spaces.update`/`settings`/`leaderboard`/`awards` = 501 |
| `spaces.members` | 1 | 0 | 0 | read-only op; no add/remove op exists at all |
| `spaces.invites` | 4 | 0 | 0 | entire sharing story is 501 |
| `spaces.taskAxes` | 4 | 0 | 0 | axes UI exists and is fully dead |
| `entities` (uniform) | 13 | 6 | 6 | see §3 for the per-op split |
| `entities.commands` | 5 | 2 | 2 | `pull`/`linkPr`/`linkCommit` = 501 |
| `tracking` | 1 | 0 | 0 | |
| `edges` | 4 | 1 | 1 | only `edges.create`; `edges.list` isn't even reachable (`getConnections` sources from `entities.get`) |
| `edgeTypes` | 1 | 0 | 0 | never referenced by UI at all |
| `messages` | 4 | 2 | 2 | edit/delete = 501 |
| `collections` | 1 | 1 | 1 | **the workhorse** — every list screen runs through it |
| `graph` | 1 | 0 | 0 | `GraphCanvas` renders an empty graph |
| `placements` | 1 | 0 | 0 | the entire drag-drop grammar is dead |
| `commands` (undo) | 1 | 0 | 0 | ⌘Z is dead |
| `search` | 1 | 0 (reserved) | 0 | reserved by contract; UI never calls it by design |
| `projects` | 6 | 5 | 5 | only `projects.unlink` missing; **not on CollabFacade at all** (see §4.4) |
| `files` | 4 | 0 | 0 | no upload/download anywhere |
| `bridge` | 1 | 0 (reserved) | 0 | Phase 2 |
| `inbox` | 2 | 0 | 0 | InboxScreen is fully dead |
| `readMarks` | 1 | 0 | 0 | |
| `savedViews` | 4 | 0 | 0 | |
| `actions` | 1 | 0 | 0 | palette falls back to recents |
| `events` | 2 | 1 | 1 | `events.poll` only; `events.subscribe` (WS) **not served for graph events** |
| `presence` | 1 | 0 | 0 | |
| `execution` | 4 | **4** | 4 | the only 100%-complete family — and it is **off the CollabFacade seam** |
| `entityKinds` | 3 | 0 | 0 | ⇒ no `c:*` custom kind can be defined on this node |
| **TOTAL** | **81** | **28** | **26** | |

Two ops are server-implemented but **unreachable from the UI**: `identity.get` and
`entities.points.add` (see §5.1 — the latter is a genuine drift bug).

---

## 2. What is actually registered (the authoritative 28)

Three registration sites, all called from the composition root `packages/server/src/main.ts:85-89`:

```
if (db) {
  registerFacadeHandlers(registry, { db, config });   // main.ts:86
  registerEventHandlers(registry, { db, config });    // main.ts:87
  execution?.register(registry);                      // main.ts:88
}
```

**Note the guard:** with no `TM8_DATABASE_URL`, `db` is `undefined`, **zero** handlers register and
all 81 ops answer 501 (`main.ts:76`, and the reasoning at `:60-72`).

### 2a. `registerFacadeHandlers` — 23 ops (`packages/server/src/facade/index.ts:86-125`)

| Op | Line | Handler |
|---|---|---|
| `identity.get` | `facade/index.ts:88` | `handlers/identity.ts:25` → RPC `current_identity` |
| `spaces.list` | `:91` | `handlers/spaces.ts` |
| `spaces.create` | `:92` | " |
| `spaces.get` | `:93` | " |
| `spaces.home` | `:94` | " |
| `spaces.navigation` | `:95` | " |
| `projects.list` | `:98` | `handlers/projects.ts` |
| `projects.create` | `:99` | " |
| `projects.get` | `:100` | " |
| `projects.update` | `:101` | " |
| `projects.link` | `:102` | " |
| `entities.get` | `:105` | `handlers/entities.ts` |
| `entities.create` | `:106` | " — **kind-gated**, see §2d |
| `entities.patch` | `:107` | " — **kind-gated**, see §2d |
| `entities.children` | `:108` | " |
| `entities.activity` | `:109` | `handlers/commands.ts:105` |
| `entities.points.add` | `:110` | `handlers/commands.ts:83` → RPC `grant_points` |
| `edges.create` | `:113` | `handlers/edges.ts` |
| `collections.query` | `:116` | `handlers/collections.ts` |
| `messages.list` | `:119` | `handlers/messages.ts` |
| `messages.post` | `:120` | " |
| `entities.commands.work` | `:123` | `handlers/commands.ts` |
| `entities.commands.complete` | `:124` | " |

### 2b. `registerEventHandlers` — 1 op (`packages/server/src/events/handlers.ts:87`)

`events.poll` only. The file's own header (`events/handlers.ts:9-12`) states this explicitly and
explains the 80-vs-81 discrepancy: `events.subscribe` is WS-only, hence not an HTTP route.

### 2c. `createExecutionRuntime(...).register` — 4 ops (`packages/server/src/facade/execution-handlers.ts`)

`execution.spawn` (`:470`), `execution.prompt` (`:498`), `execution.terminate` (`:511`),
`execution.streams.attach` (`:525`). The last returns a `StreamAttachGrant` whose `url` is
`/v2/ws?sessionId=<id>` (`execution-handlers.ts:546`) — that URL is how the terminal socket is
reached (§6).

### 2d. Partial implementations — ops that are registered but only work for some inputs

This is the class that a naive "28 implemented" count hides.

| Op | Restriction | Cite |
|---|---|---|
| `entities.create` | Only `task`, `doc`, `team_member`, `channel`. Every other declared kind → **501**, not 400 | `handlers/entities.ts:57` (`SUPPORTED_CREATE_KINDS`), refusal at `:507-515` |
| `entities.patch` | Only `task` and `doc` — narrower than create. Dispatches on the **stored** kind, not the client's | `handlers/entities.ts:653-660`, refusal `:694-698` |
| `spaces.home` | Real, and is the **only** source of space-wide activity — `RealFacade.getSpaceActivity` reads `home.activity` | `RealFacade.ts:258-261` |
| `collections.query` | Generic over kinds — `e.kind = any($n::text[])` with **no allowlist** (`handlers/collections.ts:185-186`). Consequence: `kinds:['work_session']` **would work today**. Nothing in the UI does it (§7.5) |
| `entities.get` | Real, and richer than the catalog implies: it returns a fully-populated `connections` block, which is why `edges.list` being 501 does not break the connections rail | `RealFacade.ts:173-182` |

Several ops also carry **hollow fields** — present, correctly typed, permanently zero because the
computation was trimmed under AM-5. The UI has a register of these:
`packages/ui/src/real/capabilities.ts:84-98` (13 entries, incl. `channel.state.unreadCount`,
`space.unreadTotal`, `work_session.content.workingOn`, `work_session.content.transcriptDoc`).
That file's own comment calls these *"more dangerous than a 501"* — a 501 throws and something
catches it; a hollow field renders a confident `0` with nothing in the console.

---

## 3. Full per-op matrix (81 rows)

**Server:** `IMPL` = handler registered · `501` = no handler (honest not_implemented) ·
`RESERVED` = contractually 501 forever · `PARTIAL` = registered but input-gated.
**UI:** `LIVE` = a non-test UI path reaches the real server through it ·
`STUB-EMPTY` = a CollabFacade method exists and screens call it, but `RealFacade` returns a typed
empty (silently dead) · `STUB-THROW` = `RealFacade` rejects with `not_implemented` (loudly dead) ·
`NO-UI` = no UI code path references the op at all.

### spaces / identity

| Op | Method + path | Server | UI | Notes |
|---|---|---|---|---|
| `identity.get` | GET `/v2/identity` | **IMPL** `facade/index.ts:88` | **NO-UI** | No CollabFacade method exists for "who am I". Real, working, unused. |
| `spaces.list` | GET `/v2/spaces` | **IMPL** `:91` | **LIVE** | `RealFacade.ts:147`; 3 call sites incl. `main.tsx:49` boot |
| `spaces.create` | POST `/v2/spaces` | **IMPL** `:92` | **LIVE** | `RealFacade.ts:438` — via `ExecutionControl`, **not** CollabFacade; `SpacePicker.tsx:71` |
| `spaces.get` | GET `/v2/spaces/:spaceId` | **IMPL** `:93` | **LIVE** | only via `RealFacade.getSettings` `:275` |
| `spaces.update` | PATCH | 501 | **NO-UI** | no facade method |
| `spaces.navigation` | GET `/…/navigation` | **IMPL** `:95` | **LIVE** | `RealFacade.ts:151`; 4 call sites |
| `spaces.home` | GET `/…/home` | **IMPL** `:94` | **LIVE (indirect)** | `getHome` is **never called by a screen** — only by `getSpaceActivity` `RealFacade.ts:259` |
| `spaces.settings` | GET | 501 | **STUB-EMPTY** | `getSettings` synthesizes from `spaces.get` + blanks `RealFacade.ts:274-280` |
| `spaces.members.list` | GET | 501 | **NO-UI** | no facade method — members arrive inside `navigation`/`collections` |
| `spaces.invites.list` | GET | 501 | **NO-UI** | |
| `spaces.invites.create` | POST | 501 | **NO-UI** | |
| `spaces.invites.revoke` | POST | 501 | **NO-UI** | |
| `spaces.invites.redeem` | POST `/v2/invites/redeem` | 501 | **NO-UI** | |
| `spaces.taskAxes.list` | GET | 501 | **STUB-EMPTY** | `getTaskAxes` → `[]` `RealFacade.ts:266`; 2 screens read it |
| `spaces.taskAxes.create` | POST | 501 | **STUB-THROW** | `RealFacade.ts:383` |
| `spaces.taskAxes.update` | PATCH | 501 | **STUB-THROW** | `:384` |
| `spaces.taskAxes.delete` | DELETE | 501 | **STUB-THROW** | `:385` — also unreachable by transport (§5.2) |
| `spaces.leaderboard` | GET | 501 | **STUB-EMPTY** | `getLeaderboard` → empty page `:264` |
| `spaces.awards` | GET | 501 | **STUB-EMPTY** | `getAwards` → empty page `:265` |

### entities

| Op | Method + path | Server | UI | Notes |
|---|---|---|---|---|
| `entities.get` | GET `/v2/entities/:id` | **IMPL** `:105` | **LIVE** | 18 call sites — the most-used read in the app |
| `entities.create` | POST `/v2/entities` | **PARTIAL** (4 kinds) `:106` | **LIVE** | `RealFacade.ts:311` |
| `entities.patch` | PATCH | **PARTIAL** (2 kinds) `:107` | **LIVE** | `RealFacade.ts:315`; `patchTask` sugar `:303` |
| `entities.move` | POST `/…/move` | 501 | **STUB-THROW** | `:348` — 3 call sites (tree reparent, DnD) all dead |
| `entities.delete` | DELETE | 501 | **STUB-THROW** | `:349`; also transport-unreachable (§5.2) |
| `entities.restore` | POST `/…/restore` | 501 | **NO-UI** | no facade method — tombstones can never be undone |
| `entities.children` | GET `/…/children` | **IMPL** `:108` | **LIVE** | via `getHierarchy` `RealFacade.ts:168` |
| `entities.hierarchy` | GET `/…/hierarchy` | 501 | **NO-UI** | `getHierarchy` is composed from `entities.get` + `children` instead |
| `entities.connections` | GET `/…/connections` | 501 | **NO-UI** | `getConnections` reads `detail.connections` instead `:179-182` — real data, different route |
| `entities.versions` | GET `/…/versions` | 501 | **STUB-EMPTY** | `:191`; `useDocs.ts:49` renders a blank version list |
| `entities.activity` | GET `/…/activity` | **IMPL** `:109` | **LIVE** | 4 call sites |
| `entities.react` | PUT `/…/reaction` | 501 | **STUB-THROW** | `:356` — 4 call sites; also transport-unreachable (§5.2) |
| `entities.points.add` | POST `/…/points` | **IMPL** `:110` | **STUB-THROW** ⚠️ | **DRIFT — see §5.1.** Server works; UI refuses |

### entity commands / tracking

| Op | Server | UI | Notes |
|---|---|---|---|
| `entities.commands.complete` | **IMPL** `:124` | **LIVE** | `RealFacade.ts:334`; requires `completerIds` — enforced client-side `:336` |
| `entities.commands.work` | **IMPL** `:123` | **LIVE** | `RealFacade.ts:342` |
| `entities.commands.pull` | 501 | **STUB-THROW** | `:358` — 4 call sites (pull button, staleness badge, palette) |
| `entities.commands.linkPr` | 501 | **STUB-THROW** | `:359` — **zero non-test UI call sites** (dead method on a dead op) |
| `entities.commands.linkCommit` | 501 | **NO-UI** | no facade method |
| `tracking.refresh` | 501 | **STUB-THROW** | `:360` — 3 call sites; whole Tracking screen is dead |

### edges

| Op | Server | UI | Notes |
|---|---|---|---|
| `edges.list` | 501 | **NO-UI** | connections come from `entities.get` instead |
| `edges.create` | **IMPL** `:113` | **LIVE** | `RealFacade.ts:319`; 3 call sites |
| `edges.patch` | 501 | **STUB-THROW** | `:350` — **zero non-test UI call sites** |
| `edges.delete` | 501 | **STUB-THROW** | `:351`; transport-unreachable (§5.2) |
| `edgeTypes.list` | 501 | **NO-UI** | no facade method — edge types are hardcoded UI-side |

### messages

| Op | Server | UI | Notes |
|---|---|---|---|
| `messages.list` | **IMPL** `:119` | **LIVE** | `RealFacade.ts:243`; 3 call sites in `useThread` |
| `messages.post` | **IMPL** `:120` | **LIVE** | `RealFacade.ts:323` |
| `messages.edit` | 501 | **STUB-THROW** | `:354` |
| `messages.delete` | 501 | **STUB-THROW** | `:355`; transport-unreachable (§5.2) |

### collections / graph / placements / undo / search

| Op | Server | UI | Notes |
|---|---|---|---|
| `collections.query` | **IMPL** `:116` | **LIVE** | `RealFacade.ts:211`; 8+ call sites. UI strips `layout`/`groupBy` before sending (server DTO is `.strict()`) and merges them back `:212-217` |
| `graph.query` | 501 | **STUB-EMPTY** | `queryGraph` → `{nodes:[],edges:[],clusters:[]}` `:225-228`. `GraphCanvas.tsx:109` renders an empty canvas |
| `placements.apply` | 501 | **STUB-THROW** | `:352` — 2 call sites; **the entire drag-and-drop assignment grammar** |
| `commands.undo` | 501 | **STUB-THROW** | `:353` — UndoPill + ⌘Z dead |
| `search.query` | **RESERVED** `catalog.ts:95` | **STUB-THROW** | `:283`; UI never calls it — palette runs on recents by design (`palette/recents.ts:7`) |

### projects

| Op | Server | UI | Notes |
|---|---|---|---|
| `projects.list` | **IMPL** `:98` | **LIVE** | `RealFacade.ts:419` via `ExecutionControl`; `SpawnDialog.tsx:77` |
| `projects.create` | **IMPL** `:99` | **LIVE** | `RealFacade.ts:429` — forces `trust:'trusted'` |
| `projects.get` | **IMPL** `:100` | **NO-UI** | working, unused |
| `projects.update` | **IMPL** `:101` | **NO-UI** | working, unused — **this is where trust is changed** (`ProjectUpdateInput.trust`, `contract.ts:678`) and no UI exposes it |
| `projects.link` | **IMPL** `:102` | **LIVE** | `RealFacade.ts:433` |
| `projects.unlink` | 501 | **NO-UI** | |

### files / bridge

| Op | Server | UI | Notes |
|---|---|---|---|
| `files.uploadInit` | 501 | **NO-UI** | |
| `files.uploadComplete` | 501 | **NO-UI** | |
| `files.uploadAbort` | 501 | **NO-UI** | |
| `files.download` | 501 | **NO-UI** | the one op that returns raw bytes (`http/server.ts` `raw` result kind) |
| `bridge.fetchBlob` | **RESERVED** `catalog.ts:111` | **NO-UI** | Phase 2 |

Nothing on CollabFacade takes or returns a file. The `file` kind has a registered renderer but the
server refuses to create one (`entities.ts:507`) and there is no upload path — see §7.6.

### inbox / read-marks / saved views / actions

| Op | Server | UI | Notes |
|---|---|---|---|
| `inbox.list` | 501 | **STUB-EMPTY** | `getInbox` → empty page `:263`; `InboxScreen` + shell badge both dead |
| `inbox.markRead` | 501 | **STUB-THROW** | `markNotificationRead` `:382`; transport-unreachable (§5.2) |
| `readMarks.upsert` | 501 | **STUB-RESOLVE** ⚠️ | `markRead` resolves `{patches:[]}` `:379-381` — the **one deliberate silent no-op**, because the thread marks itself read on view and a throw produced an unhandled rejection on every thread open. Reasoning at `RealFacade.ts:361-378` |
| `savedViews.list` | 501 | **STUB-EMPTY** | `listSavedViews` → `[]` `:267` |
| `savedViews.create` | 501 | **STUB-THROW** | `:386` |
| `savedViews.update` | 501 | **STUB-THROW** | `:387` |
| `savedViews.delete` | 501 | **STUB-THROW** | `:388` — **zero non-test UI call sites** |
| `actions.list` | 501 | **STUB-EMPTY** | `getActions` → `[]` `:288`; palette degrades to recents |

### events / presence

| Op | Server | UI | Notes |
|---|---|---|---|
| `events.subscribe` | WS — **not served for graph events** | **NO-UI** | see §6 |
| `events.poll` | **IMPL** `events/handlers.ts:87` | **LIVE** | the *only* refresh channel — `real/events.ts` polls every 1500ms |
| `presence.get` | 501 | **STUB-EMPTY** | `getPresence` → `{viewers:[],typingActorIds:[]}` `:196-198` |

### execution (100% implemented — and off the seam)

| Op | Server | UI | Notes |
|---|---|---|---|
| `execution.spawn` | **IMPL** `execution-handlers.ts:470` | **LIVE** | `RealFacade.ts:394` — always sends `workdir:{mode:'project'}`; `worktree` is refused server-side rather than silently downgraded (`:398-401`) |
| `execution.prompt` | **IMPL** `:498` | **LIVE** | `RealFacade.ts:407` |
| `execution.terminate` | **IMPL** `:511` | **LIVE** | `RealFacade.ts:413` |
| `execution.streams.attach` | **IMPL** `:525` | **LIVE** | grants `/v2/ws?sessionId=…` `:546` |

### entityKinds

| Op | Server | UI | Notes |
|---|---|---|---|
| `entityKinds.list` | 501 | **NO-UI** | `EntityKindDef`'s own doc-comment (`contract.ts:857`) says it is "read by the KindRegistry" — **it is not, anywhere** |
| `entityKinds.create` | 501 | **NO-UI** | ⇒ no `c:*` kind can be defined on this node |
| `entityKinds.update` | 501 | **NO-UI** | |

---

## 4. ⭐ The CollabFacade method table — which existing screens are silently dead

This is the table that matters. `packages/ui/src/collab-v2/facade/CollabFacade.ts` is the interface
the entire mock-era UI was built against; `packages/ui/src/real/RealFacade.ts` is what it gets
against a real server. **Call sites** counts exclude `__tests__/`, `mock/`, and the facade files
themselves.

### 4.1 LIVE — 19 methods with a real server call behind them

| Method | Contract op(s) | `RealFacade` | UI call sites |
|---|---|---|---|
| `listSpaces` | `spaces.list` | `:147` | 3 (`useShellData:65`, `ShellLayout:71`, `InboxScreen:28`) |
| `getNavigation` | `spaces.navigation` | `:151` | 4 |
| `getEntity` | `entities.get` | `:159` | **18** |
| `getHierarchy` | `entities.get` + `entities.children` | `:163-171` | 3 |
| `getConnections` | `entities.get` (`.connections`) | `:179-182` | 2 — real edge data, sourced sideways |
| `getActivity` | `entities.activity` | `:184` | 4 |
| `queryCollection` | `collections.query` | `:211-218` | 8+ — **the workhorse of every list screen** |
| `getSpaceActivity` | `spaces.home` (`.activity`) | `:258-261` | 1 (`ActivityFeed:48`) |
| `getMessages` | `messages.list` | `:243` | 3 |
| `createTask` → | `entities.create` | `:295` | 1 (Gallery — mock-only, see 4.5) |
| `createEntity` | `entities.create` | `:311` | 3 |
| `patchTask` → | `entities.patch` | `:303` | 4 |
| `patchEntity` | `entities.patch` | `:315` | 6 |
| `createEdge` | `edges.create` | `:319` | 3 |
| `postMessage` | `messages.post` | `:323` | 1 |
| `completeTask` | `entities.commands.complete` | `:334` | 2 |
| `setWork` | `entities.commands.work` | `:342` | 2 |
| `subscribe` | `events.poll` (a **poller**, not a socket) | `:446-453` | 7 |
| `getHome` | `spaces.home` | `:230` | **0** — screens build their own `CollectionQuery` instead |

### 4.2 ⚠️ STUB-EMPTY — 11 methods that return a typed empty. **These are the silently-dead screens.**

A screen calling one of these renders successfully, with no console error, showing nothing. The user
cannot distinguish "you have no notifications" from "notifications were never built".

| Method | Op | Returns | UI call sites | Screen that goes silently blank |
|---|---|---|---|---|
| `getVersions` | `entities.versions` | `emptyPage()` `:191` | 1 | Doc version history (`useDocs.ts:49`) |
| `getPresence` | `presence.get` | `{viewers:[],typingActorIds:[]}` `:196` | 2 | Viewer avatars, typing indicator (`EntityPanel:193`, `useLive:61`) |
| `queryGraph` | `graph.query` | `{nodes:[],edges:[],clusters:[]}` `:225` | 1 | **Graph canvas** (`GraphCanvas.tsx:109`) — draws nothing |
| `getChannelTabs` | (`channel.autoTabs`) | `[]` `:235` | 1 | Channel auto-tabs (`useChannelData.ts:63`) |
| `getInbox` | `inbox.list` | `emptyPage()` `:263` | 2 | **Inbox screen + shell unread badge** |
| `getLeaderboard` | `spaces.leaderboard` | `emptyPage()` `:264` | 2 | **Leaderboard screen**; also `useViewerActors:28` → *no viewer roster* |
| `getAwards` | `spaces.awards` | `emptyPage()` `:265` | 1 | Awards tab |
| `getTaskAxes` | `spaces.taskAxes.list` | `[]` `:266` | 2 | **Task axes / board grouping** (`TasksScreen:32`, `CollectionView:91`) |
| `getSettings` | `spaces.settings` | name from `spaces.get`, everything else blank `:274-280` | 1 | **Settings screen** — renders with empty axes + empty members |
| `listSavedViews` | `savedViews.list` | `[]` `:267` | 1 | Saved-view picker on graph |
| `getActions` | `actions.list` | `[]` `:288` | 1 | Command-palette actions (degrades to recents by design) |

Plus one deliberate silent no-op, counted separately: `markRead` → `{patches:[]}` (`RealFacade.ts:379`,
3 call sites). It is the only method allowed to lie quietly, and the reasoning at `:361-378` is sound:
the thread marks itself read on view, so a throw produced `PAGEERROR: markRead is not implemented` on
*every* thread open, and the unread counters it would clear are hard-wired zeros anyway
(`capabilities.ts:85-87`) — so there is genuinely nothing to do.

`RealFacade`'s header states the policy explicitly (`:10-14`): *"NEVER FABRICATE… returns a typed
empty (reads) or throws not_implemented (writes). It never invents a plausible row."* The UI-side
register of these gaps is `packages/ui/src/real/capabilities.ts:29-67` with `isUnavailable(method)`
so a screen *can* caption the emptiness — **whether each screen actually calls `isUnavailable` is a
separate question this audit did not verify, and is the natural follow-up.**

### 4.3 STUB-THROW — 21 methods that reject with `not_implemented`

Loud, so at least they surface. `notImplemented()` returns a *rejected promise*, not a synchronous
throw, so `.catch()` at the call site works (`RealFacade.ts:57-74` — the reasoning is worth reading).

| Method | Op | Line | Call sites | Affordance that fails |
|---|---|---|---|---|
| `moveEntity` | `entities.move` | `:348` | 3 | Tree reparent, DnD reorder (`ConnectionsRail:118,131`, `mutations:107`) |
| `deleteEntity` | `entities.delete` | `:349` | 2 | Delete button (`EntityPanel:324`) |
| `patchEdge` | `edges.patch` | `:350` | **0** | — |
| `deleteEdge` | `edges.delete` | `:351` | 1 | Unlink in connections rail |
| `placements` | `placements.apply` | `:352` | 2 | **The whole drag-drop assignment grammar** (`execute.ts:90`, `mutations:97`) |
| `undo` | `commands.undo` | `:353` | 2 | UndoPill + ⌘Z |
| `patchMessage` | `messages.edit` | `:354` | 1 | Edit message |
| `deleteMessage` | `messages.delete` | `:355` | 1 | Delete message |
| `setReaction` | `entities.react` | `:356` | 4 | **Like / dislike / star buttons** (`EntityPanel:338,342,346`) |
| `grantPoints` | `entities.points.add` | `:357` | 2 | **⚠️ Points button — server WORKS, see §5.1** |
| `pullEntity` | `entities.commands.pull` | `:358` | 4 | Pull-to-work, staleness badge |
| `linkPr` | `entities.commands.linkPr` | `:359` | **0** | — |
| `trackingRefresh` | `tracking.refresh` | `:360` | 3 | **Tracking screen refresh** |
| `markNotificationRead` | `inbox.markRead` | `:382` | 2 | Inbox mark-read + mark-all |
| `createTaskAxis` | `spaces.taskAxes.create` | `:383` | 1 | Settings → axes |
| `updateTaskAxis` | `spaces.taskAxes.update` | `:384` | 1 | " |
| `deleteTaskAxis` | `spaces.taskAxes.delete` | `:385` | 1 | " |
| `createSavedView` | `savedViews.create` | `:386` | 1 | Save-view on collection |
| `updateSavedView` | `savedViews.update` | `:387` | 1 | Graph layout persist |
| `deleteSavedView` | `savedViews.delete` | `:388` | **0** | — |
| `search` | `search.query` (reserved) | `:283` | **0** | never called by design |

`subscribePresence` (`:460-463`) returns a no-op unsubscribe — 2 call sites; presence/typing is
permanently silent.

### 4.4 Off-seam: `ExecutionControl` — the only fully-working feature, bolted on beside CollabFacade

`RealFacade.ts:101-116` defines a **separate optional interface** because `CollabFacade` was frozen
against the Collab V2 contract, which predates tm8's `execution.*` family. Feature-detected via
`hasExecutionControl()` (`:130`).

| Method | Op | Consumer |
|---|---|---|
| `spawnSession` | `execution.spawn` | `SpawnDialog.tsx:118` |
| `promptSession` | `execution.prompt` | `SpawnDialog.tsx:135` |
| `terminateSession` | `execution.terminate` | `SpawnDialog.tsx:145` |
| `listProjects` | `projects.list` | `SpawnDialog.tsx:77` |
| `createProject` | `projects.create` | — |
| `linkProject` | `projects.link` | — |
| `createSpace` | `spaces.create` | `SpacePicker.tsx:71` |

**Architectural consequence:** every execution capability lives *outside* the interface the 270-file
collab-v2 module was built against, and is consumed by exactly two bespoke components in
`packages/ui/src/real/` (`SpawnDialog`, `SpacePicker`) mounted beside the shell from
`main.tsx:83-89`. None of the transplanted screens know sessions exist. `tm8Kinds.tsx:230-244`
monkey-patches a "Spawn agent" action onto the `task` kind entry, which fires a `window`
CustomEvent (`SPAWN_REQUEST_EVENT`, `tm8Kinds.tsx:41`) that `SpawnDialog.tsx:24` listens for —
a DOM event bus is the seam between the module and execution.

### 4.5 `Gallery` is mock-only

`collab-v2/gallery/Gallery.tsx` reads `facade.ids.space` / `facade.ids.t105` (`:80-97`) — `ids` is a
`MockFacade` property with no equivalent on `RealFacade`. Any `createTask`/`deleteEntity` call site
attributed to Gallery is a dev-harness path, not product.

---

## 5. Drift and transport findings

### 5.1 ⚠️ `entities.points.add` — a working backend feature the UI refuses to call

`facade/index.ts:110` registers it; `handlers/commands.ts:83-102` is a genuine implementation calling
the `grant_points` RPC inside a transaction with a command envelope. But:

- `RealFacade.grantPoints` → `notImplemented('grantPoints')` (`RealFacade.ts:357`)
- `capabilities.ts:55` lists `grantPoints` under `UNIMPLEMENTED.writes` with the comment
  `// entities.points.add`

Two live UI affordances (`EntityPanel.tsx:353`, `useReactions.ts:122`) therefore fail against a
server that would have served them. This is the **only** case found where the UI is *more* pessimistic
than the server. Everything else errs the other way.

*(Related but not a bug: `identity.get`, `projects.get`, `projects.update` are also implemented and
unused — but no facade method exists for them at all, so nothing is refusing anything.)*

### 5.2 `TmClient` cannot issue `DELETE` or `PUT` at all

`packages/ui/src/real/TmClient.ts` exposes only `get` (`:127`), `post` (`:131`), `patch` (`:135`).
There is no `delete()` and no `put()`. So **9 catalog ops are unreachable from the UI even if the
server implemented them tomorrow**:

| Method | Ops |
|---|---|
| DELETE | `entities.delete`, `edges.delete`, `messages.delete`, `spaces.taskAxes.delete`, `savedViews.delete`, `projects.unlink` |
| PUT | `entities.react`, `inbox.markRead`, `readMarks.upsert` |

Notably `entities.react` — the like/dislike/star bar, 4 live call sites — needs a verb the client
does not have. This is a one-method fix, but it is a real prerequisite that a server-side plan alone
would miss.

### 5.3 Two `EntityKind` unions that disagree

Detailed in §7. `packages/contract/src/contract.ts:29-37` has 13 core kinds + `c:${string}`;
`packages/ui/src/collab-v2/types/contract.ts:16-18` (the snapshot) has 11 and **no custom arm**.

### 5.4 Conformance

No conformance *results* artifact exists on disk — `tools/conformance/` contains the suite
(10 test files: `commands`, `cursors`, `envelope`, `events`, `execution`, `files`, `idempotency`,
`projects`, `reads`, `taxonomy`) plus an honest stub, and results are produced by running it against
a live node. `STATE.md:132,162` records 46/65 at delivery with the 19 failures being the deliberate
AM-5 501s. The 28-implemented figure in this report was derived from the registration call sites
directly and matches `STATE.md:162` and `capabilities.ts:4` independently.

---

## 6. Events / realtime

**Net answer:** the graph UI gets updates by **polling every 1500 ms** against a **real durable
event log**. The events WebSocket accepts upgrades and cannot deliver a single graph event. The PTY
terminal socket, on the same URL path, is **genuinely live push in both directions**.

### 6.1 Contract

`events.subscribe` = `WS /v2/ws` (`catalog.ts:128`) — the catalog's only `method: 'WS'` entry, which
is exactly why 81 catalog entries mount 80 HTTP routes (`events/handlers.ts:9-12`).
`events.poll` = `GET /v2/spaces/:spaceId/events` (`catalog.ts:129`).

Envelope (`contract.ts:257-263`), with `WORKSPACE_EVENT_SCHEMA_VERSION = 1` (`:247`):

```ts
export interface WorkspaceEventEnvelope {
  spaceId: SpaceId;
  seq: number;        // per-space monotonic; gaps allowed, order authoritative
  occurredAt: string;
  schemaVersion: number;
}
```

`clientMutationId?` is **per-variant, not on the envelope** (`contract.ts:267-271`) — present on all
mutation-derived variants, absent on presence/typing. 12 `type` values across 8 union arms
(`contract.ts:272-281`): `entity.upsert|deleted`, `edge.upsert|deleted`,
`message.created|updated|deleted`, `counter.changed`, `activity.created`,
`notification.created|read`, `presence.changed`, `typing.changed`. Zod mirror is an 8-arm union of
`.strict()` objects (`schemas.ts:521-578`) — the strictness is what the server-side tripwire uses.
`DurableWorkspaceEvent` excludes the two presence arms (`contract.ts:287-291`).

**No client→server WS control frame exists.** Confirmed by grep over `packages/contract/src/` — the
only subscribe-adjacent type is `Unsubscribe = () => void` (`contract.ts:612`), a local callback,
not a wire shape. The server says so itself at `events/ws-server.ts:48-55`. This is the one approved
post-freeze amendment (`STATE.md:42-43`), explicitly **skipped** under AM-6 (`STATE.md:50`).

### 6.2 Server — the log is real, the socket is dead

`events.poll` is the **only** op the events block registers (`events/handlers.ts:87`), and only when
a DB is configured (`main.ts:88`).

It is backed by genuinely durable infrastructure:
- `PgDurableEventLog.since()` (`events/poll.ts:106-138`) reads `public.workspace_events` ordered by
  `seq`, inside **one `Db.tx(claims,…)`** so RLS filters rows *and* their hydration — deliberately,
  to avoid a post-policy leak (`poll.ts:82-94`).
- The table and its per-space counter are real: `db/migrations/003_read_model.sql:294`
  (`workspace_events`), `:287` (`internal.next_event_seq`), `:376-377` (seq minted **inside the
  mutating transaction**). Capture triggers cover entities, edges, messages, counters, activity and
  notifications (`003:385-399`). Presence/typing are structurally never written.
- `NotImplementedEventLog` (`poll.ts:61-67`) exists so a DB-less node **refuses** rather than
  returning a plausible `[]`.

**Correction to `STATE.md` (two items):**

1. **`InMemorySeqSource` is not a skeleton.** The stale comment is at `main.ts:95-97`; the code is
   correct. `seq.ts:82-83` shows `export const InMemorySeqSource = PresenceSeqSource` — an alias kept
   only because main.ts constructs it by that name (`seq.ts:74-80`). Durable `seq` comes exclusively
   from Postgres; `DurableSeqSource` deliberately has **no `next()`**, only `latest()`
   (`seq.ts:85-104`), because a server-minted seq could only hand out a number for an event that does
   not exist or race the trigger. **Consequence: none for correctness — documentation drift only.**
   (`PgDurableSeqSource`, `seq.ts:117`, is never constructed — dead code today.)
2. **`EntityProjector` *is* injected on the poll path.** `PgDurableEventLog` default-constructs a
   real one: `new WorkspaceEventMapper(opts.projector ?? new PgEntityProjector())` (`poll.ts:100-103`).
   The **parked** backlog item is a *different* injection — swapping that default for the facade's own
   derived-truth assembler so socket/poll and REST reads cannot disagree (`projector.ts:12-20`). The
   injection point exists; the facade assembler is simply not passed in.

**Why the WS can never carry a graph event — three independent breaks, each sufficient:**

| # | Break | Evidence |
|---|---|---|
| 1 | **No browser can subscribe.** `createWsServer` is built at `main.ts:99` with no `onClientMessage`, so the hook is never installed (`ws-server.ts:149-152`). `SubscriptionRegistry.subscribe(connId, spaceId)` is **never called anywhere** in `packages/server/src` outside `subscriptions.ts`. Every connection is added with an empty `spaces: Set()` (`subscriptions.ts:33`), so `connectionsFor(spaceId)` returns `[]` forever | `subscriptions.ts:75-84,131-142` |
| 2 | **Nothing publishes.** `WorkspaceEventPublisher.publishDurable` (`emitter.ts:180`) has **zero production callers** — every hit is in `test/events.test.ts` | grep |
| 3 | **Nothing bridges log → socket.** By design the database is the sole emitter and the server may only forward already-sequenced rows (`emitter.ts:4-14`) — but the forwarder was never built | — |

What *is* real on that socket: RFC 6455 handshake, framing, ping/pong, close, heartbeat eviction.
Note `AllowAllSubscriptionAuthorizer` (`subscriptions.ts:167-179`) is marked "MUST NOT ship past W2".

A useful safety net worth knowing: `assertWorkspaceEvent` (`emitter.ts:144-153`) validates **every**
event against the strict contract schema on both the publish and poll/mapper paths, so an
off-contract projection throws server-side rather than reaching a client that would ignore it.

### 6.3 UI — polls, and says so

`packages/ui/src/real/events.ts:1-9` is unusually honest: *"There is NO live WebSocket push on this
node… this is a poller, and it is named one. It deliberately does not pretend to be a subscription
that happens to be slow."*

- Transport `GET /v2/spaces/${spaceId}/events?since=${since}` (`events.ts:118-120`), interval
  **1500 ms** (`:61`), primed immediately on first subscribe (`:93-99`), single-flight (`:114-116`),
  rescheduled in `finally` so a failed poll retries **from the same cursor** (`:137-145`).
- **The only `new WebSocket(...)` in the entire UI is the PTY one** (`terminal/ptyTransport.ts:250`).
- Envelope adaptation: `eventId` synthesised as `` `${spaceId}:${seq}` `` (`events.ts:49-54`) rather
  than editing types Atlas owns.
- **Events are genuinely applied, not just fetched.** `connectStores` (`stores/index.ts:33-44`, mounted
  by `CollabV2App.tsx:144`) routes them into `useGraphStore.applyEvent` + `usePresenceStore.applyEvent`
  + `useCollectionsStore.applyEntityPatch/removeEntity` (`stores/index.ts:18-26`). `stores/graph.ts:116-153`
  is a real reducer: dedupes on `eventId`, merges `EntitySummary`, indexes edges, and **clears the
  matching optimistic patch** on `clientMutationId`. Not invalidate-and-refetch — the payload is
  applied directly. 7 UI call sites consume `subscribe`.
- Connection store is fed from real HTTP outcomes via `ConnectionControl` (`stores/index.ts:39-43`,
  `RealFacade.ts:467-471`, `TmClient.ts:73-91`) — **not** the mock simulator, which is structurally
  excluded whenever a facade is injected (`CollabV2App.tsx:136-139`, `main.tsx:105`).
- `subscribePresence` is a no-op (`RealFacade.ts:460-463`) — presence is permanently silent.

**So: create a task in one tab and another tab updates within ~1.5 s, through the real graph.**

### 6.4 ⚠️ Bug found — the UI discards the server's `nextCursor` (type mismatch)

- Server sends a **string**: `nextCursor: String(...)` — `events/poll.ts:135`.
- UI accepts only a **number**: `this.since = typeof next === 'number' ? next : Math.max(highWater, this.since)` — `real/events.ts:136`.

The server's cursor is therefore **always ignored**, and the client falls back to the max `seq` of
items it actually received. Usually equivalent — but it defeats the precise anti-wedge design at
`poll.ts:121-131`: when the mapper **skips** rows (deleted entity, RLS-filtered, unknown kind), the
server returns `items: []` with the cursor advanced past them while the client leaves `since`
unchanged. The client then re-requests the same skipped page **forever**. `PollPage.nextCursor` is
even typed `number | string | null` (`events.ts:41`), so the string branch was anticipated and then
not handled.

### 6.5 The PTY terminal socket — a different socket on the same path

`execution.streams.attach` grants `/v2/ws?sessionId=<id>` (`execution-handlers.ts:546`). The two
sockets are told apart by the **presence of the `sessionId` query param**, dispatched at
`main.ts:115-121` via `isPtyUpgrade` (`pty/pty-ws-server.ts:87-92`) — deliberately, so no
off-contract second path is invented (`main.ts:104-113`; the events path is itself catalog-derived,
`ws-server.ts:30`). Frame policy is inverted between them: the events socket is JSON text only and
refuses binary with close 1008 (`events/ws-connection.ts:154-157`); the PTY socket is raw binary
output plus JSON text control frames (`pty/pty-ws-connection.ts:3-11`).

This one is genuine push — `{type:'size'}` → `{type:'attached', base, gap, next, hasReplay, epoch}`
→ binary replay → binary live output → `{type:'exit'}` (`pty-ws-server.ts:12-33`), with 16 ms
server-side coalescing and a rAF client write-scheduler. No interval anywhere.

**⚠️ Correction to `STATE.md:142`: client→server stdin IS wired, end to end.** STATE.md records it as
an open item ("the socket carries it, gated on prompt-delivery ownership"). Verified against source
on every hop:

1. `SessionTerminal.tsx:93` — `term.onData((data) => ptyTransport.write(sessionId, data))`
   (local echo deliberately off; the PTY echoes — `:90-92`)
2. `ptyTransport.ts:425-430` — `ws.send(new TextEncoder().encode(data))`, **binary specifically** so a
   user typing `{"type":"resize"…}` cannot inject a control frame (`:413-419`). Dropped, not queued,
   when the socket is down — a queued trailing newline could execute against a later PTY.
3. `pty/pty-ws-connection.ts:149-152` routes `OPCODE.binary` → `onInput`
4. `pty-ws-server.ts:237` — `onInput: (data) => pty.write(sessionId, data)`

Resize is likewise live and bidirectional (`ptyTransport.ts:433-442` → `pty-ws-server.ts:134-147`).

**The real limitation is a UI-surface one, not a protocol one:** the only terminal in the app is
mounted inside `SpawnDialog`, so stdin reaches an agent only while that transient dialog is open on
a session you spawned this page-load (§8.1). Also note `HOW-TO-TEST.md:321` ("session panel polls
status every 1.5s… no terminal yet") is stale.

---

## 7. Entity kinds — contract vs UI renderers

### 7.1 Three disagreeing universes

| Union | File | Members |
|---|---|---|
| tm8 contract (**the law**) | `packages/contract/src/contract.ts:29-37` | 13 core + `` c:${string} `` |
| collab-v2 snapshot | `packages/ui/src/collab-v2/types/contract.ts:16-18` | **11 core, no custom arm** |
| DB registry | `db/migrations/001_core_graph.sql:311-324` | all 13 core seeded; `c:*` rows per space |

```ts
// contract.ts:29-37
export type CoreEntityKind =
  | 'channel' | 'task' | 'message' | 'member' | 'team_member'
  | 'doc' | 'file' | 'spell' | 'skill' | 'pull_request' | 'commit'
  | 'work_session' | 'collection';
export type CustomEntityKind = `c:${string}`;
```

### 7.2 Coverage table

| Kind | Contract | Server can create | collab-v2 `KIND_REGISTRY` | `tm8Kinds.tsx` | Verdict |
|---|---|---|---|---|---|
| `channel` | ✅ `:30` | ✅ `entities.ts:57`, branch `:550` | ✅ `KindRegistry.tsx:181,908` | — | Complete |
| `task` | ✅ `:30` | ✅ branch `:569` | ✅ `:253,909` | +Spawn action `tm8Kinds.tsx:230-244` | Complete |
| `message` | ✅ `:30` | ❌ excluded by design `contract.ts:426`; posted via `messages.post` | ✅ `:371,910` | — | Complete |
| `member` | ✅ `:30` | ❌ excluded `:426` (invite-managed) | ✅ `:440,911` | — | Complete |
| `team_member` | ✅ `:30` | ✅ branch `:522` | ✅ `:499,912` | — | Complete |
| `doc` | ✅ `:31` | ✅ branch `:569` | ✅ `:580,913` | — | Complete |
| `file` | ✅ `:31` | ❌ 501 `:507` — real path is `files.*`, all 501 | ✅ `:635,914` | — | UI renders it; server cannot produce one |
| `spell` | ✅ `:31` | ❌ 501 | ✅ `:683,915` | — | UI-only |
| `skill` | ✅ `:31` | ❌ 501 | ✅ `:731,916` | — | UI-only |
| `pull_request` | ✅ `:31` | ❌ 501 | ✅ `:753,917` | — | UI-only |
| `commit` | ✅ `:31` | ❌ 501 | ✅ `:839,918` | — | UI-only |
| **`work_session`** | ✅ `:32`, state `:101-103`, content `:148-151` | ❌ **by design** — spawn-only, excluded from `CreateEntityInput` (`:426`, `schemas.ts:654`); born only from `execution.spawn` (`:700-706`) | ❌ **absent** | ✅ `tm8Kinds.tsx:71-133` | Works **only** because `main.tsx:28` patches the map at boot |
| **`collection`** | ✅ `:32`, state `:104`, content `:152` | ❌ 501 (created by SQL RPC) | ❌ **absent** | ✅ `tm8Kinds.tsx:172-206` | Same |
| **`c:*`** | ✅ `:35`; scalars-only `:845-847`; `EntityKindDef :858-870` | ❌ `entities.create` accepts it at schema level (`schemas.ts:655`) but `SUPPORTED_CREATE_KINDS` rejects → 501; and `entityKinds.create` has **no handler** → no `c:*` can be defined at all | ❌ absent, **and unrepresentable** (snapshot union has no template-literal arm) | ❌ | Contract-supported, end-to-end unimplemented, **and a live landmine** |

### 7.3 What happens for an unregistered kind: the app white-screens

```ts
// collab-v2/registry/KindRegistry.tsx:927-929
export function registryFor(kind: EntityKind): KindEntry {
  return KIND_REGISTRY[kind];      // bare index — typed KindEntry, returns undefined
}
```

No fallback, no `??`, no throw. ~20 call sites dereference the result immediately —
`EntityChip.tsx:42-43` (`entry.tint(entity)` — the reported crash), `EntityCard.tsx:25,36`,
`EntityPanel.tsx:209,262`, `EntityFullView.tsx:93,172`, `TreeLayout.tsx:176`,
`shell/placeholders.tsx:40,101`, `interactions/grammar.ts:63`, `interactions/keyboard.tsx:156,173`,
`interactions/dnd.tsx:416`, and `KIND_REGISTRY[kind].label` in `TOMBSTONE` (`:954`).
There is **no React error boundary anywhere in `packages/ui/src`**, so the throw unmounts the whole
tree.

`work_session` and `collection` are safe only because `main.tsx:28` calls `installTm8Kinds()` at
module scope, which *mutates the exported registry object* (`tm8Kinds.tsx:218-223`) — there is no
`registerKind()` API; the "runtime registration path" is object mutation through casts. The
snapshot's own completeness test still asserts "exactly the 11 contract kinds"
(`__tests__/entity/registry.test.tsx:28-31`) and is now false at runtime while remaining true in the
suite, because tests never import `tm8Kinds`.

**The only thing preventing a repeat today is that `entityKinds.create` has no handler**, so no `c:*`
kind can exist. The moment T-L4 lands server-side, the first custom-kind entity rendered anywhere
white-screens the app. `STATE.md:120-124` already records this as "**NOT fixed — Atlas's to make, and
it is the real defect**".

Minimal durable fix, entirely inside `registry/`: widen the snapshot's `EntityKind`, add a
`GENERIC_ENTRY: KindEntry`, make it `return KIND_REGISTRY[kind] ?? GENERIC_ENTRY`, and apply the same
`??` in `kindCan` (`:933`) and `TOMBSTONE.label` (`:954`).

---

## 8. ⭐ BACKEND-CANNOT-SERVE — capabilities with **no contract op at all**

This is the punchline. Distinguish two failure classes:

- **Class A — merely 501:** the op exists in the frozen catalog; a handler is all that is missing.
  53 ops. Buildable without touching the contract.
- **Class B — no op exists:** the capability has no home in the catalog. **Requires a Vega-approved
  contract amendment** (`STATE.md:160` — "post-freeze contract changes require a Vega-approved
  amendment").

### Class B — genuinely unserveable today

| Capability | Status | Evidence |
|---|---|---|
| **Authentication / login / logout / human session** | ❌ **NO OP EXISTS** | grep for `auth\|login\|logout\|session` over `catalog.ts` returns **nothing**. The only identity op is `identity.get`. The node runs on a loopback auto-owner (`identity/loopback.ts`) which bootstraps a real `accounts` row and binds it to every request; it is sound *only* because the node binds 127.0.0.1 (AM-4/S1). There is no way for a second human to sign in. |
| **Account management** (create user, set password, change display name) | ❌ **NO OP EXISTS** | `ensure_account` / `resolve_account_credential` are DB RPCs (`identity/loopback.ts:22-26`) with **no HTTP binding**. No `accounts.*` family in the catalog. |
| **Space membership add / remove / role change** | ❌ **NO OP EXISTS** | `spaces.members.list` is a *read only*. There is no `spaces.members.add/remove/updateRole`. Membership can only be created by `spaces.create` (mints the caller's row) or by redeeming an invite. |
| **Sending stdin to a running terminal** | ✅ **WORKS — `STATE.md:142` is stale** | No *catalog op* carries keystrokes, and none needs to: stdin rides the PTY WebSocket that `execution.streams.attach` grants, and it is wired end to end (`SessionTerminal.tsx:93` → `ptyTransport.ts:425-430` binary frame → `pty-ws-connection.ts:149-152` → `pty-ws-server.ts:237` → `pty.write`). Verified in §6.5. **The limitation is UI-surface, not backend:** the only terminal in the app lives inside the transient `SpawnDialog`, so this is reachable only for a session you spawned this page-load. |
| **Listing / filtering work_sessions** | ⚠️ **op exists, unused** | There is no dedicated `sessions.list`, **but `collections.query` is generic over kinds** — `handlers/collections.ts:185-186` binds `e.kind = any($n::text[])` with no allowlist, so `kinds:['work_session']` works today. **No UI code path does it** (grep: zero non-test references outside `tm8Kinds`/`capabilities`). Consequence in §8.1. |
| **Project delete** | ❌ **NO OP EXISTS** | catalog has list/create/get/update/link/unlink — no `projects.delete`. |
| **Custom-kind delete** | ❌ **NO OP EXISTS** | `entityKinds` has list/create/update — no delete. |
| **Entity restore from tombstone** | ⚠️ op exists (`entities.restore`, 501) but **no CollabFacade method** — the UI seam has no way to express it even after the server builds it. |
| **Link a commit** | ⚠️ op exists (`entities.commands.linkCommit`, 501) but **no CollabFacade method**. |
| **Edge-type discovery** | ⚠️ op exists (`edgeTypes.list`, 501) but **no CollabFacade method** — edge types are hardcoded UI-side. |

### Class A — has an op, merely 501 (buildable without a contract change)

| Capability | Ops |
|---|---|
| Space invites & sharing | `spaces.invites.{list,create,revoke,redeem}` |
| Space settings edit | `spaces.update`, `spaces.settings` |
| Project trust management | `projects.update` (**already implemented!** — `ProjectUpdateInput.trust`, `contract.ts:678`; just no UI) |
| Project unlink | `projects.unlink` |
| Custom-kind definition CRUD | `entityKinds.{list,create,update}` |
| File / blob upload + download | `files.{uploadInit,uploadComplete,uploadAbort,download}` |
| Saved views | `savedViews.{list,create,update,delete}` |
| Placements (drag-drop grammar) | `placements.apply` |
| Task axes | `spaces.taskAxes.{list,create,update,delete}` |
| Undo | `commands.undo` |
| Inbox / notifications | `inbox.{list,markRead}`, `readMarks.upsert` |
| Points & leaderboard read | `spaces.{leaderboard,awards}` (grant side already works — §5.1) |
| Reactions | `entities.react` (+ a `PUT` verb on `TmClient` — §5.2) |
| Search | `search.query` — **reserved**; needs un-reserving by amendment first (`registry.ts:41-49` throws if you try to register it) |
| Cross-node blob fetch | `bridge.fetchBlob` — **reserved**, Phase 2 |

### 8.1 The sharpest consequence: a spawned session is unrecoverable after reload

`SpawnDialog` holds the spawned session in **React local state** (`SpawnDialog.tsx:66`) and polls
`entities.get` on it every 1500 ms (`:99-108`, comment: *"there is no push channel for it"*).
There is no session list anywhere in the UI. So:

- reload the page and the running agent becomes **unreachable from the UI** — you cannot re-attach
  its terminal, prompt it, or terminate it;
- it still counts against the 8-slot spawn concurrency cap (`execution-handlers.ts:103`, refused
  loudly at capacity as `limit_exceeded` → mapped to `rate_limited` client-side, `TmClient.ts:35`);
- this compounds with the known ghost-session-on-restart issue (`STATE.md:134`).

**And the backend could already serve the fix** — `collections.query` with `kinds:['work_session']`
needs no contract change and no new handler. This is the single highest-value, lowest-cost gap in
the whole matrix.

---

## 9. What a gap audit should conclude

1. **26 of 81 ops are reachable from the UI.** Of the 53 CollabFacade methods, **19 are live, 11 are
   silently dead (typed empties), 21 throw**, 1 is a deliberate no-op and 1 is a dead subscription.
   The silent 11 are the priority: Inbox, Leaderboard, Settings, Task Axes, Graph canvas, Doc
   versions, Presence and Saved Views all render as working screens showing nothing.
2. **Most missing UI features are Class A** — the op exists and is frozen; only a handler is missing.
   The contract is not the bottleneck for invites, files, saved views, axes, undo, placements,
   reactions, inbox or custom kinds.
3. **Class B is short and specific:** auth/login, account management, space-membership mutation, and
   project/custom-kind deletion. Those four need a contract amendment before any UI work. Terminal
   stdin is **not** on this list — it already works (§6.5).
4. **Realtime is poll-only for the graph** (1500 ms, real durable log) and **true push for the
   terminal**. The events WebSocket needs both a contract amendment (client→server subscribe frame)
   *and* a log→`publishDurable` bridge before it can carry anything — two pieces of work, not one.
5. **Four cheap wins needing no contract change and no new server op:**
   `grantPoints` (server already works — §5.1) · a session list via `collections.query` (§8.1) ·
   `delete()`/`put()` on `TmClient` to unblock 9 ops the transport cannot currently express (§5.2) ·
   the `nextCursor` string/number fix (§6.4).
6. **One latent crash to fix before any custom-kind work lands:** `registryFor` returning `undefined`
   with no error boundary (§7.3).

### Doc corrections this audit produced

| Claim | Where | Status |
|---|---|---|
| "no client→server stdin" | `STATE.md:142` item 2 | **Stale** — stdin is wired end to end (§6.5) |
| "`InMemorySeqSource` is a SKELETON stand-in" | `packages/server/src/main.ts:95-97` | **Stale comment, correct code** — it is an alias for the presence counter; durable seq is Postgres-assigned (§6.2) |
| "EntityProjector injection" parked | `STATE.md:5` | **Ambiguous** — the poll path already injects a real `PgEntityProjector`; the parked item is swapping in the facade assembler (§6.2) |
| "session panel polls status every 1.5s… no terminal yet" | `HOW-TO-TEST.md:321` | **Stale** — the terminal ships and streams over WS |
| "G1A builds task and doc" | `handlers/entities.ts:513` error text | **Cosmetically stale** — the allowlist is four kinds (`:57`) |
| "exactly the 11 contract kinds" | `collab-v2/__tests__/entity/registry.test.tsx:28-31` | **True in tests, false at runtime** — tests never import `tm8Kinds` (§7.3) |
