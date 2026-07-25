# Workspace Transplant — Build Blueprint

**Author:** Rhea (integration) · **For:** Vega (CTO) · **Date:** 2026-07-25
**Status:** blueprint, ready to execute · **Scope:** descoped per user — UI only, on today's 28 implemented ops. No server work this wave.

---

## 0. The acceptance (this is the definition of done)

1. **THIS UI** — the four-pane maestro workspace look, in tm8's `tasks` tab.
2. **RUN A TASK** — click Run on a task → an agent session spawns.
3. **RUN A TERMINAL** — the live terminal works in the middle pane.
4. **LEFT PANEL (tasks) and RIGHT PANEL (sessions) work properly** — render, refresh, click-through, live status.
5. Reorder / delete / reactions / drag — **not needed**. Deferred appendix (§8).

Everything below is aimed at exactly that.

---

## 1. Headline

**This is a mount-and-fill job, not a port.** Three things that would have been the expensive parts are already built in tm8 and were verified by reading the source, not by assumption:

| Expected cost | Actual state | Evidence |
|---|---|---|
| Port the four-pane layout | **Already exists.** tm8's shell *is* the four-pane layout. | `packages/ui/src/collab-v2/shell/ShellLayout.tsx:87-93` composes `IconRail │ LeftRail │ CenterHost │ PanelStack` |
| Build a mount seam / iframe | **Already exists, and override-capable.** | `CollabV2App.tsx:144` `extraViews?: ViewRegistry`, merged **last** (`:186`), so it can override a module screen. Already in use: `main.tsx:32` `TM8_VIEWS = { sessions: SessionsScreen }` |
| Port the terminal | **Already ported, byte-identical wire protocol.** | `real/terminal/ptyTransport.ts:1-10` — *"Ported from old maestro's `webTerminal` … the wire protocol here is byte-identical to maestro's. The only difference is the URL"* (`/pty` → `/v2/ws?sessionId=`) |

**And the flow the acceptance asks for already runs end to end today.** `tm8Kinds.tsx:251` dispatches `tm8:spawn-request` → `SpawnDialog` (`real/SpawnDialog.tsx`) picks project + persona → `execution.spawn` → navigates to `#/s/{space}/sessions/{id}` → `SessionsScreen` mounts `SessionTerminal` on the live PTY. That is G1A, already passing.

**So the build is: re-compose surfaces that already work into one four-pane screen, registered under `tasks`.** The genuinely new code is a layout component, a task tree, a right-hand panel with tabs, and honest degradation. No new transport, no new protocol, no server work.

### The one correction to the earlier assumption

I reported earlier that Docs/Drawings had no backend. **That was wrong, and it is good news.** Docs are fully implemented on the existing 28 ops:

- `entities.create` supports `kind:'doc'` → `create_document(spaceId, title, actorId, body, format, parentId, position, attachTo, edgeType, cmid)` — `handlers/entities.ts:57,584`
- `entities.patch` supports `kind:'doc'` → `update_document(id, expectedVersion, actorId, title, body, format, cmid)` — `handlers/entities.ts:684`
- `collections.query` lists them generically by kind
- `documents.format` is `check (format in ('markdown','mermaid','excalidraw'))` — `db/migrations/001_core_graph.sql:589`
- `attachTo` + `edgeType` means a doc attaches to a task or a `work_session`

**Drawings therefore already have a home: a `doc` with `format:'excalidraw'` and the scene JSON in `body`.** No migration, no new op. The only real constraint is `body text check (char_length(body) <= 200000)` — a 200 KB cap on a scene.

**This match is exact, and it was confirmed from the maestro side too — the two formats are the same bytes.** Maestro's Drawings tab is Excalidraw (`@excalidraw/excalidraw ^0.18.0`, `maestro-ui/src/components/ExcalidrawBoard.tsx`), and a drawing is persisted as **a doc with `kind:'diagram'`**, written with an `.excalidraw` extension, whose content is the `serializeAsJSON` form `{"type":"excalidraw", …}` (`MaestroClient.ts:530,539`; detection logic in `utils/docHelpers.ts:15-32`). tm8's `doc` + `format:'excalidraw'` + `body` is a **one-to-one** target:

| maestro | tm8 |
|---|---|
| `addSessionDoc(sessionId, title, content, kind:'diagram')` | `entities.create {kind:'doc', title, content:{body, format:'excalidraw'}, attachTo:{entityId: sessionId}}` |
| `addTaskDoc(taskId, …, kind:'diagram')` | same, `attachTo:{entityId: taskId}` |
| `updateDocContent(sessionId, docId, content)` | `entities.patch(docId, {expectedVersion, content:{body}})` |
| `getSessionDocs` / `getTaskDocs` / `getProjectDocs` | `collections.query {kinds:['doc'], filters:{edge:{type:'attached_to', direction:'outgoing', entityId}}}` |

So Docs **and** Drawings are a data-model no-op. The only open question is the renderer dep (§4).

What *is* genuinely hollow is the **session transcript**: `work_session.content.transcriptDoc` is *"always null — no transcript store"* (`real/capabilities.ts:101`). That is the one right-panel content with nothing behind it.

---

## 2. The four panes → tm8

The user's four panes map 1:1 onto slots tm8 already has. Two of the four need **no new code at all**.

| Pane | Maestro today | tm8 target | Work |
|---|---|---|---|
| **P1 · Icon rail** (far left) | icon rail | `shell/IconRail.tsx` — 56px rail, spaces + Home + Inbox, already styled with the maestro mark (`&gt;···+`) | **none** — reuse as-is |
| **P2 · Left panel** (task list) | task list | *inside* the new workspace view's own left column | **build** — task tree on `collections.query` |
| **P3 · Middle panel** (terminal/chat) | terminal + chat | the workspace view's center column | **compose** — reuse `SessionTerminal` + `Thread` |
| **P4 · Right panel** (Sessions/Resources, tabs) | `SessionsSection.tsx` (1823 LOC) | the workspace view's right column | **build** — tabbed panel over existing queries |

> **Design note, and it matters for the lane split.** The four panes the *user* means live **inside the center view**, not spread across the shell's own four slots. The shell's `LeftRail` is space navigation (Home/Tasks/Sessions/Docs/…) and its `PanelStack` is the Z3 entity-peek stack — neither is the maestro left/right panel. So the workspace view owns its own three-column layout (tasks │ terminal │ sessions) and sits in `CenterHost`, with the shell's `IconRail` supplying P1. This keeps the whole build inside one registered view and touches no shell file.

**Mount point:** register under the existing `tasks` view name. `extraViews` is merged last, so it *overrides* the module's `tasksViews` with no fork:

```ts
// packages/ui/src/main.tsx — the ONLY line that changes
const TM8_VIEWS = { sessions: SessionsScreen, tasks: WorkspaceScreen };
```

`ViewName` already contains `tasks` (`stores/nav.ts:31-34`), `LeftRail` already lists it (`shell/LeftRail.tsx:29`), and the route `#/s/{space}/tasks` already serializes. **Nothing in the shell, the router, or the nav store needs to change.**

---

## 3. Action map — WIRED NOW

Every action the acceptance requires, against the 28 implemented ops. All verified against handler source.

### Left panel — tasks

| Action | tm8 op | Call | Notes |
|---|---|---|---|
| List tasks | `collections.query` | `facade.queryCollection({spaceId, kinds:['task'], sort:'position'\|'priority'\|'dueDate', limit})` | keyset cursors, never offset |
| Task tree (children) | `collections.query` | same + `parentId` or `subtreeOf` | `CollectionQuery.parentId`/`subtreeOf` — `contract.ts:190-191` |
| Filter by status | `collections.query` | `filters.workStatus[]` | executed server-side |
| Filter by assignee | `collections.query` | `filters.assigneeIds[]` | |
| Open a task | `entities.get` | `facade.getEntity(id)` | full detail incl. `connections` |
| Children page | `entities.children` | `facade.getHierarchy(id)` | |
| **Create task** | `entities.create` | `facade.createEntity({kind:'task', spaceId, title, content:{description, priority, …}, parentId, position})` | |
| **Edit task** (title/desc/priority/status) | `entities.patch` | `facade.patchEntity(id, {expectedVersion, title, content:{description, workStatus, priority, dueDate, …}})` | **`content.workStatus` is supported** — `handlers/entities.ts:672` |
| **Complete task** | `entities.commands.complete` | `facade.completeTask(id, {expectedVersion, completerIds:[…]})` | `completerIds` required, ≥1 |
| Claim / assign | `entities.commands.work` | `facade.setWork(id, …)` | |
| **Run agent on task** | *(client event)* | `dispatchEvent(new CustomEvent('tm8:spawn-request', {detail:{taskId, spaceId}}))` | already wired to `SpawnDialog` |
| Task thread | `messages.list` / `messages.post` | `facade.getMessages(taskId)` / `postMessage` | reuse `subsystems/thread` |
| Activity | `entities.activity` | `facade.getActivity(id)` | |

### Middle panel — terminal

| Action | tm8 op / transport | Call |
|---|---|---|
| Attach terminal | PTY WS `/v2/ws?sessionId=` | `<SessionTerminal key={sessionId} sessionId live fill />` — **reuse, do not reimplement** |
| Stream grant | `execution.streams.attach` | already used by the transport |
| Input / resize | same socket | inside `ptyTransport` |
| Offset resume, epoch reset, gap loss | same socket | already handled — `ptyTransport.ts:16-38` |
| Prompt the agent | `entities.commands.prompt`* | `facade.promptSession(sessionId, message)` |
| Terminate | `entities.commands.terminate`* | `facade.terminateSession(sessionId)` |

\* routed via `execution.prompt` / `execution.terminate` (`facade/execution-handlers.ts:580,593`); the REST path is `/v2/entities/:id/commands/{prompt,terminate}`.

> **Upgrade worth taking while we're here:** `SessionsScreen` currently prompts with `window.prompt()` and says so in its own comment (`SessionsScreen.tsx:145-147` — *"A browser prompt() is a placeholder, not a design"*). The middle pane should carry a real composer. Cheap, and it is squarely inside acceptance #3.

### Right panel — sessions & resources

| Tab | Action | tm8 op | Notes |
|---|---|---|---|
| **Terminals** | List sessions | `collections.query` `kinds:['work_session']`, `sort:'activityAt_desc'` | exactly what `SessionsScreen.tsx:67` does |
| | Live status | `entities.get` on the open session, polled | 4000 ms list / 1500 ms detail today |
| | Click-through → terminal | nav store `setView('sessions', id)` or local selection | |
| **Agents** | List personas | `collections.query` `kinds:['team_member']` | proven — `SpawnDialog.tsx:74` |
| | Create persona | `entities.create` `kind:'team_member'` | supported — `handlers/entities.ts:522` |
| | Which agent is on what | `work_session.projectId` + `working_on` edge via `entities.get.connections` | `state.liveWork` is **hollow** |
| **Docs** | List docs | `collections.query` `kinds:['doc']` (+ `filters.edge` to scope to a task/session) | **real, works today** |
| | Read / write | `entities.get` / `entities.patch` `content.body` | |
| | Create | `entities.create` `kind:'doc'`, `attachTo:{entityId, edgeType}` | |
| **Drawings** | List / read / write | same as Docs with `content.format:'excalidraw'`, scene JSON in `body` | **real** — 200 KB cap |

### Refresh / liveness

**Polling is the realtime story — do not blueprint a push channel.** `events.poll` is the 28th implemented op (`server/src/events/handlers.ts:87`); `RealFacade.subscribe()` is an `EventPoller` over `GET /v2/spaces/:id/events?since=<seq>` and is honestly named one (`real/events.ts:1-10`). Sessions additionally poll `collections.query` / `entities.get` on an interval because **session status changes do not emit a graph event** (`SessionsScreen.tsx:31-34`). Keep both. Terminal output is genuinely pushed — that is the PTY socket, separate and already correct.

---

## 4. Honest degradation — the rules for this build

Follow the established `real/capabilities.ts` contract exactly. It is already the house style and there is a purity test behind it.

- **Reads that aren't built → typed empty + a caption.** Never an unlabelled empty list: `isUnavailable(method)` exists so the screen can say *"not available on this node"* rather than let it read as *"you have no tasks"*.
- **Writes that aren't built → the affordance is rendered DISABLED**, with the reason in a `title`. Never hidden (the user hunts for it), never enabled-then-throwing. The `SpawnDialog` untrusted-project row (`SpawnDialog.tsx:124-145`) is the pattern to copy: shown, dimmed, `disabled`, reason inline.
- **Hollow fields → hide the affordance rather than render the zero.** `isHollow(path)` / `hollowReason(path)`. A real `0` and an unbuilt `0` are pixel-identical and only one is true.
- **No `not_implemented` rejection may reach the user as an unhandled error.** See the `markRead` precedent (`RealFacade.ts:393-413`) — a refusal aimed at a button is honest; the same refusal fired by an automatic background call is just noise.

### Vega's question: hide or caption the Docs/Drawings tabs?

**Neither — ship them for real.** They are backed (§1). My recommendation:

- **Docs tab: ship, fully functional** (list / read / edit / create). Real data, real writes, zero server work.
- **Drawings tab: ship read+list on day 1; make the Excalidraw *editor* the one optional call.** Listing `doc`s with `format:'excalidraw'` costs nothing. Mounting an editor means taking `@excalidraw/excalidraw` — a heavy dep that moves `bun.lock`, against a codebase that is deliberately dependency-light (`SessionTerminal.tsx:36-38` declines even `@xterm/addon-fit` on exactly this ground). **Recommendation: day 1 lists drawings and opens them read-only via a lightweight SVG/preview path; the editor is a follow-up decision, not a blocker.**

The **general principle where something *is* missing: caption, don't hide.** A hidden tab reads as "this product doesn't do that." A captioned empty tab reads as "this node hasn't built that yet" — which is the true statement, and it is the whole reason `capabilities.ts` exists. The single place this applies here is the **session transcript** (`work_session.content.transcriptDoc` always null): the terminal replays from the server's output ring, so show *that* and caption the absence of a durable transcript rather than implying scrollback is a transcript.

---

## 5. Lanes — package/file-disjoint, 3 UI lanes, no server lanes

All new code lands under **`packages/ui/src/real/workspace/`** (a new directory — keeps the lanes disjoint and keeps `collab-v2/` pure, which its seam-purity test enforces). Lane A owns the one-line `main.tsx` edit; nobody else touches a file outside their list.

### Lane A — Shell mount + layout + left panel (tasks)

**Owns**
```
packages/ui/src/real/workspace/WorkspaceScreen.tsx      (new) the ShellViewProps view; 3-column layout
packages/ui/src/real/workspace/workspace.css            (new) grid, resizers, panel chrome
packages/ui/src/real/workspace/TaskPanel.tsx            (new) P2 — tree, filters, create, run
packages/ui/src/real/workspace/useTasks.ts              (new) collections.query + polling
packages/ui/src/main.tsx                                (edit, ONE line: tasks: WorkspaceScreen)
```

**Slice of the action map:** the entire *Left panel — tasks* table in §3, plus the `tm8:spawn-request` dispatch for the Run button.

**Acceptance:** `#/s/{space}/tasks` renders a three-column workspace inside `CenterHost`, with the shell's `IconRail` at far left. The left column lists real tasks from the graph, expands children, filters by status, creates a task, edits title/description/status, and completes one. A **Run** button on a task row opens `SpawnDialog` and spawns a real agent. `bun run typecheck` clean; new vitest for the task query/tree.

---

### Lane B — Right panel (Sessions / Resources) + tabs

**Owns**
```
packages/ui/src/real/workspace/ResourcePanel.tsx        (new) P4 shell + tab bar
packages/ui/src/real/workspace/tabs/TerminalsTab.tsx    (new) work_session list, status, click-through
packages/ui/src/real/workspace/tabs/AgentsTab.tsx       (new) team_member list + create
packages/ui/src/real/workspace/tabs/DocsTab.tsx         (new) doc list/read/edit/create
packages/ui/src/real/workspace/tabs/DrawingsTab.tsx     (new) format:'excalidraw' docs
packages/ui/src/real/workspace/useSessions.ts           (new) session list + detail polling
```

**Slice of the action map:** the entire *Right panel* table in §3.

**Acceptance:** all four tabs render real data from the 28 ops. Terminals tab lists sessions grouped live/finished with a status pill that updates on the poll; clicking one drives the middle pane. Agents tab lists and creates personas. Docs tab reads and writes a real `doc`. Drawings tab lists `format:'excalidraw'` docs. Every unavailable affordance is disabled-with-reason, never absent and never throwing.

> **Reuse, don't rebuild:** `SessionStatusPill` (`real/tm8Kinds.tsx:258`) already renders the status tones with a pulse on `running`. The session list/grouping logic in `SessionsScreen.tsx:214-218` is the reference — lift it, don't reinvent it.

---

### Lane C — Middle panel (terminal + composer) + degradation polish

**Owns**
```
packages/ui/src/real/workspace/CenterPane.tsx           (new) P3 — terminal host + tab strip
packages/ui/src/real/workspace/Composer.tsx             (new) real prompt composer (replaces window.prompt)
packages/ui/src/real/workspace/Unavailable.tsx          (new) shared caption/disabled primitives over capabilities.ts
packages/ui/src/real/workspace/__tests__/*              (new) lane-owned tests
```

**Slice of the action map:** the entire *Middle panel — terminal* table in §3, plus §4's degradation rules as a reusable primitive the other two lanes import.

**Acceptance:** the middle pane hosts a live `SessionTerminal` for the selected session, keyed by session id (so switching tears down the old xterm and socket — `SessionsScreen.tsx:110-117`); a composer sends `promptSession` with history and a record of what was sent; Terminate works and is disabled for exited sessions. `Unavailable.tsx` is imported by Lanes A and B.

**Sequencing:** Lane C's `Unavailable.tsx` is the only cross-lane dependency. Land it first as a stub (≤30 LOC) so A and B are unblocked immediately, then fill it out.

**Critically — no lane reimplements the PTY transport.** `real/terminal/*` and `real/SessionTerminal.tsx` are **read-only for every lane**. One terminal, one owner.

---

## 6. Day-1 vertical

Given the descope, **day 1 ≈ the whole deliverable.** The honest slice, in order:

1. `WorkspaceScreen` registered under `tasks`, three-column CSS grid, shell `IconRail` intact. *(Lane A)*
2. Left column lists real tasks. *(Lane A)*
3. Right column Terminals tab lists real `work_session`s with live status. *(Lane B)*
4. Clicking a session drives a live `SessionTerminal` in the middle. *(Lane C)*
5. **Run** on a task spawns an agent and the new session appears in the right panel and attaches in the middle. *(A + B + C — this is the acceptance loop)*
6. Remaining tabs (Agents / Docs / Drawings) + degradation polish.

Steps 1–5 *are* acceptance items 1–4. Step 6 is the finish.

---

## 7. Iframe alternative — and why not

| | **Native transplant (recommended)** | **Iframe-embed old maestro** |
|---|---|---|
| Time to something on screen | ~1 lane-day | hours |
| Backends running | **one** (tm8 Postgres) | **two** (tm8 + file-based maestro-server on separate ports/data) |
| Data | one graph; a task in the left pane *is* the entity the agent runs on | two disjoint worlds; tm8 tasks and maestro tasks are unrelated rows |
| Auth / identity | one identity claim path | two, unreconciled |
| Terminal | one transport, already ported | two PTY stacks, two sockets |
| Tauri coupling | dropped at the boundary | dragged in — maestro-ui is a Tauri app; the desktop-only paths do not exist on the web |
| End state | **is** the product | a demo that must be thrown away and rebuilt |

**Recommendation: native transplant, unambiguously.** The iframe's entire appeal was avoiding a rewire — but §1 shows the rewire is small, because the shell, the seam, the terminal, and the spawn loop already exist. An iframe would buy a few hours and cost the single-backend property that is the whole point of tm8. It also cannot satisfy acceptance #2 in any meaningful sense: "click Run on a task" would spawn against maestro's file store, not tm8's graph, so the tm8 side of the product would still have nothing running in it.

---

## 8. Deferred appendix — mapped, not built

Kept so nothing is lost. Each is the maestro action, its tm8 op, and where it would land.

### Contract ops that exist but are 501 on this node

| Maestro action | tm8 op | Where it lands when built |
|---|---|---|
| Reorder tasks (drag) | `entities.move` | `handlers/entities.ts` + a `move_entity` RPC (migration 015+) |
| Delete task / session / doc | `entities.delete`, `entities.restore` | `handlers/entities.ts` + soft-delete RPC |
| Task ↔ task links, unlink | `edges.patch`, `edges.delete`, `edges.list` | `handlers/edges.ts` (only `edges.create` is registered) |
| Emoji reactions | `entities.react` | `handlers/commands.ts` |
| Drag-drop placements | `placements.apply` | new handler |
| Undo | `commands.undo` | new handler + token store |
| Edit / delete a message | `messages.edit`, `messages.delete` | `handlers/messages.ts` |
| Saved views (task lists) | `savedViews.*` (4 ops) | new handler + table |
| Task axes | `spaces.taskAxes.*` (4 ops) | `handlers/spaces.ts` |
| Space settings, members, invites | `spaces.settings`, `spaces.members.list`, `spaces.invites.*` | `handlers/spaces.ts` |
| Inbox / notifications | `inbox.list`, `inbox.markRead`, `readMarks.upsert` | new handler |
| Leaderboard / awards | `spaces.leaderboard`, `spaces.awards` | `handlers/spaces.ts` |
| Graph view | `graph.query` | new handler (traversal) |
| File upload (task images) | `files.uploadInit/Complete/Abort/download` | new handler + blob dir (S17) |
| Command palette actions | `actions.list` | new handler |
| Presence / typing | `presence.get`, `events.subscribe` (push) | new handler + socket publisher |
| Project unlink | `projects.unlink` | `handlers/projects.ts` |
| Custom entity kinds | `entityKinds.list/create/update` | new handler |
| Task hierarchy read | `entities.hierarchy`, `entities.connections`, `entities.versions` | `handlers/entities.ts` (facade currently derives the first two from `entities.get`) |
| Pull work / link PR / commit | `entities.commands.pull/linkPr/linkCommit`, `tracking.refresh` | `handlers/commands.ts` |

**Reserved — cannot be registered without a contract amendment:** `search.query`, `bridge.fetchBlob` (`facade/registry.ts:41-49`).

### Maestro surfaces with no tm8 contract op at all

These need a **contract amendment** before any implementation. Batch them with the modals/status-filter amendment already queued.

| Maestro surface | Notes |
|---|---|
| Session transcript / logs / stats / prompt history / command usage | `work_session.content.transcriptDoc` is hollow; `getSessionStats`, `getSessionLogDigest`, `getSessionPrompts`, `getSessionCommandUsage` have no tm8 analogue |
| **Huddles** | `GET /huddles` — no tm8 concept |
| **Ensembles** (8 endpoints) | create/update/members/message/disband — no tm8 concept |
| **Spells** (~16 endpoints) | activate/deactivate/toggle/invoke/reset-loop/definitions/custom-prompts — `spell` and `skill` *kinds* exist in the schema (`001:318-319`) and `equips` edges are defined, but there are no ops |
| **Git integration** (8 endpoints) | worktree/diff/PR/merge/branch-rename/discard — `pull_request` and `commit` kinds exist; no ops |
| Teams / team tree | `team_member` exists; `Team` grouping + `subTeamIds` does not |
| Model profiles, workflow templates, skills catalog | no tm8 analogue |
| Task graphs (DAG + validate) | `graph.query` is the nearest, itself unbuilt |
| Session timeline events | `entities.activity` is adjacent but not equivalent |
| Session docs vs task docs distinction | expressible today via `attachTo` edges — no amendment needed |

### Tauri-only, dropped at the web boundary

tm8 is web-only and has no Tauri anywhere (confirmed: `packages/ui/package.json` has no `@tauri-apps/*`). Maestro's native paths — filesystem browsing (`platform/fs.ts`), native log tailing (`platform/logs.ts`), window management, native menus, SSH, secure storage, local PTY spawn (`platform/terminal.ts:592` `/pty/spawn`) — do not come along. The web PTY path is the one that was already ported.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Many mounted terminals tank the whole tab.** xterm's WebGL renderer allocates one GPU context per terminal; past the browser's ~16-context cap the compositor thrashes and the entire UI goes laggy | **high** — this bit the old app | Keep the DOM renderer and **no addons** (`SessionTerminal.tsx:16-24`). Mount **one** terminal in the middle pane; never one per row in the right panel. The existing `visibilityDriver` suspend/resume already handles offscreen sessions |
| **Copying maestro's terminal setup would import the exact bug tm8 avoided.** maestro-ui is on `@xterm/xterm ^6.0.0` **with `@xterm/addon-webgl` and `@xterm/addon-fit`**; tm8 is on `^5.5.0` with **no addons at all**, deliberately | **high** | Do not port `maestro-ui/src/platform/terminal.ts` or its xterm config. `real/SessionTerminal.tsx` + `real/terminal/*` are read-only for all lanes and already solve sizing without `addon-fit` (`SessionTerminal.tsx:36-44`) |
| Poll storm — three panels each on their own interval, times N sessions | medium | One shared poll per data class (tasks, sessions), not per component. Reuse the `EventPoller` cadence; keep the 4000/1500 ms split |
| `collections.query` is `.strict()` server-side — an unknown key is a 400, not an ignored field | medium | `RealFacade.queryCollection` already strips `layout`/`groupBy` and merges them back (`RealFacade.ts:211-218`). Route **all** queries through the facade; never hand-build a body |
| `completeTask` requires `expectedVersion` + ≥1 `completerId` | low | Fail early with the server's vocabulary, as the facade already does (`RealFacade.ts:349-355`) |
| Excalidraw dep moves `bun.lock` in a deliberately dependency-light package | low | Deferred by §4's recommendation — list/read on day 1, editor is a separate decision |
| 200 KB `documents.body` cap truncates a large drawing | low | Validate before write; surface the cap in the UI rather than letting Postgres reject it |
| Overriding the module's `tasks` screen may break collab-v2 acceptance tests that assert on it | medium | The override is in `main.tsx` only; the module's own `tasksViews` stays registered and its tests mount the module directly. Verify with the collab-v2 suite before merge |
| Lane collision on `main.tsx` | low | Lane A owns it, one line. Lanes B and C never touch it |

---

## 10. Verified-source index

Everything asserted above was read, not assumed.

**tm8**
- `packages/ui/src/collab-v2/shell/ShellLayout.tsx` — the four-slot composition
- `packages/ui/src/collab-v2/shell/types.ts` — `ViewRegistry`, `ShellViewProps`, `PanelSlot`
- `packages/ui/src/collab-v2/shell/{IconRail,LeftRail,CenterHost}.tsx` — P1 + nav + view host
- `packages/ui/src/collab-v2/stores/nav.ts` — `VIEWS`, hash grammar, panel stack
- `packages/ui/src/collab-v2/CollabV2App.tsx:124-190` — the `extraViews` seam
- `packages/ui/src/main.tsx` — the real-mode boot and the mount line to edit
- `packages/ui/src/real/RealFacade.ts` — every method, envelope rules, `ExecutionControl`
- `packages/ui/src/real/capabilities.ts` — `UNIMPLEMENTED`, `HOLLOW_FIELDS`, the degradation contract
- `packages/ui/src/real/sessions/SessionsScreen.tsx` — session list/detail/poll reference
- `packages/ui/src/real/SpawnDialog.tsx` — the spawn flow, and the disabled-with-reason pattern
- `packages/ui/src/real/tm8Kinds.tsx:41,251` — `tm8:spawn-request`, `SessionStatusPill`
- `packages/ui/src/real/terminal/ptyTransport.ts` — the ported transport
- `packages/ui/src/real/SessionTerminal.tsx` — renderer decision, sizing, input
- `packages/ui/src/real/events.ts` — `EventPoller`, the polling story
- `packages/contract/src/catalog.ts` — all 81 ops
- `packages/contract/src/contract.ts:187-217` — `CollectionQuery` filters/sorts
- `packages/server/src/facade/index.ts:86-125` — the 24 registered facade ops
- `packages/server/src/facade/execution-handlers.ts:552-607` — the 4 execution ops
- `packages/server/src/events/handlers.ts:87` — `events.poll` (op 28)
- `packages/server/src/facade/handlers/entities.ts:57,505-600,660-700` — create/patch kind support
- `packages/server/src/facade/handlers/collections.ts` — keyset paging, executed filters
- `packages/server/src/facade/registry.ts` — 501-honesty, reserved ops
- `db/migrations/001_core_graph.sql:305-323,584-594,694-746` — kinds, `documents`, `work_sessions`

**maestro (agent-maestro)**
- `maestro-ui/src/utils/MaestroClient.ts` — 1078 LOC, ~110 methods: the complete action surface
- `maestro-ui/src/components/SessionsSection.tsx` (1823 LOC) — P4 reference
- `maestro-ui/src/components/app/AppWorkspace.tsx` (734 LOC), `App.tsx` (786 LOC) — pane composition
- `maestro-ui/src/platform/terminal.ts` (754 LOC) — the transport tm8 already ported
- `maestro-ui/src/stores/` — 39 stores (not 23)

---

## 11. Open decisions for Vega

1. **Excalidraw editor dep** — take `@excalidraw/excalidraw` now, or ship list+read-only on day 1? *(My recommendation: defer the editor.)*
2. **Task-list ordering without `entities.move`** — `sort:'position'` reads fine, but position can't be *written* this wave. Ship sorted-by-priority/dueDate/activity and disable drag with a reason? *(My recommendation: yes — it is explicitly out of acceptance.)*
3. **Does the middle pane also host the task thread** (`messages.*`, reusing `subsystems/thread`), or terminal only on day 1? *(My recommendation: terminal first, thread as a second tab in the same pane — the machinery already exists.)*
