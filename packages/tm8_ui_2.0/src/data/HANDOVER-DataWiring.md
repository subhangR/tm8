# HANDOVER — Real data by default · create/save wired · the live create→event→screen loop

**status-as-of:** `763c637` (last commit at the start of this seat; nothing was committed by me — no `git add`, no `git commit`, per the brief, and other seats moved the tree during the window, so no sha names the tree this describes) · seat `sess_1785327593469_fuu53cu7k` · task `task_1785327593165_jrt06p7yo` · 2026-07-29

Three deliverables, all landed in the working tree. **Two of them need a line the coordinator must add in files this seat does not own — GAP-1 and GAP-2 below, and GAP-1 is a correctness precondition of the default flip, not a polish item.** Read §6 before committing.

---

## 1. What was actually wrong (the shape, so the fix reads as a fix)

Every link of the live loop already existed and was green:

| link | state at HEAD |
|---|---|
| `createRealSeam` — all 22 reads, all 18 commands over HTTP | built, tested |
| `socket.ts` + `connection.ts` — real WebSocket, subscribe→resume, backoff | built, tested |
| `createDomainStore(seam)` — subscribes `seam.onEvent`, folds every event into a normalized projection | built, tested |
| `src/authoring/` — create flow, save flow, inline title editor, conflict card | built, tested |

And the app showed invented data, `＋ New` wrote to a node nobody was reading, and the title was a `contentEditable` span that swallowed keystrokes. Three separate instances of the same shape: **four links green, the chain dead, because nothing asserted the join.**

- `realSeamFlag.isRealSeamEnabled()` returned false unless opted in → a fresh load constructed `createFixtureSeam()`.
- `useGateData` kept its own `rows` state, refreshed on openSpace / onResync / its own spawn. `createDomainStore` reduced the event stream correctly into a projection **no view read**.
- `src/authoring/`'s own handover opens with "mountable, not mounted".

## 2. DELIVERABLE 1 — the real node is the default

**Approach: a pure resolver with an explicit opt-out, and no fall-back path.** `src/views/realSeamFlag.ts` now exports `resolveSeamSource(env, flag)` — the whole decision, taking both inputs as arguments — plus `seamSource()` / `isRealSeamEnabled()` over the ambient env.

| rule | result | why |
|---|---|---|
| flag `'1'` | real | the old opt-in, unchanged |
| flag `'0'` | fixture | **NEW.** A default with no off switch is a trap; this is how the fixture world comes back with no rebuild |
| `MODE === 'test'` | fixture | vitest has no node and no network. A real default there makes every suite measure the ENVIRONMENT — 1000 reds saying nothing about the change that caused them |
| otherwise, including production | **real** | the headline; production never silently composes fixture data |

**Why a pure resolver and not just an inverted return.** `isRealSeamEnabled()` reads the ambient `MODE`, and under vitest that is `'test'` forever — so the app's real default was *structurally unassertable*. `seamSource.test.ts` is the whole truth table against injected envs. A default nobody can assert is a default nobody can defend.

**NO FALL-BACK, deliberately.** If the node is unreachable the boot read rejects and `useGateData` holds the reason in `bootError`. It never quietly re-constructs the fixture seam: serving invented entities in place of a node that is down is the same lie in a more expensive costume. **This is exactly why GAP-1 is blocking.**

### What still legitimately reads a fixture (enumerated, not asserted)

`grep -rn "from '.*fixtures'" src | grep -v ^src/fixtures/ | grep -v test`:

| consumer | what it takes | verdict |
|---|---|---|
| `views/GateApp.tsx`, `home/HomeScreen.tsx` | `presenceHollowReason`, `authoredFromHollowReason`, `homeActivityLoadEarlierReason` | **LEGITIMATE.** Honesty COPY, not entity data — the sentences that explain a hollow value. Nothing about them is a stand-in for a node. |
| `gallery/GalleryPage.tsx` | fixture entities | **LEGITIMATE.** It is a component gallery; fixtures are its subject. |
| `views/WorkspaceView.tsx` + `LaunchSheet.tsx` | Active seam — team/profile entities, linked projects, settings defaults, liveness capacity | **RESOLVED.** Production launch pickers are graph/server-backed; `views/launch-fixtures` is test-only (GAP-5a). |
| `views/GateApp.tsx` → `graph/GraphScreen` | active seam `graph.query` + domain-store entity/edge projection | **RESOLVED.** Initial nodes/edges come from the server graph lens; durable events update the same normalized projection in realtime. |
| `data/fixtures/seam-fixture.ts` | everything | **LEGITIMATE.** It IS the fixture seam, and it is now reachable only by opt-out or under MODE=test. |

`src/fixtures/**` was not touched, per the brief.

## 3. DELIVERABLE 3 — the loop (the headline)

**Approach chosen: (i), and the sentence that makes it decidable is "rows are IDS now, not summaries."**

The brief offered (i) render from the store's projections, or (ii) subscribe `onEvent` in `useGateData` and patch the cache. (ii) was rejected: it means writing a second reducer beside the one `domain-store` already has and keeping the two in agreement by care. (i) as literally stated — "make the store the source of truth" — is also wrong on its own, because the store is a **flat entity table with no notion of which server query returned what**, so a kind nobody has read would render as confidently empty rather than honestly unread.

So the two questions were split:

- **`useGateData.rows: Record<key, EntityId[]>`** answers what the store cannot: WHICH entities the server put in this `(kind, filter)` list, in what order. Every read `ingestSummaries` into the store first, then records its ids here.
- **the store's `entities` table** answers what each of them currently IS.
- **`projectRows()` joins them on every render.**

A cached row used to be a photograph — correct at read time, frozen after — which is why every update path was a re-read. Now the list is a *view over the projection*.

`projectRows` does three things, each answering a different way a list goes stale:

1. **every row is re-read from the store** → an edit anyone made shows up with no read;
2. **rows the filter now excludes LEAVE** → a task marked done drops out of Open by itself;
3. **rows the store knows and the read never saw ARRIVE, at the head** → the created task, without a refresh.

**Head, not tail, and it is not a preference:** `activityAt_desc` is the server's DEFAULT sort (`packages/server/src/facade/handlers/collections.ts:98`) and nothing in this app passes a `sort` — confirmed live, the node echoed `"sort":"activityAt_desc"` in the query it ran (§5). A freshly-created entity belongs at the head by the server's own rule.

### `membershipOf` — and the third answer is the point

`'in'` / `'out'` / **`'unknown'`**. The client may hide a row it can prove the filter excludes, show one it can prove the filter includes, and must do **neither** when it cannot tell. Decidable clauses: `deleted`, `workStatus`, `sessionStatus`. Anything else (`readyToPull`, `axes`, `assigneeIds`, `edge`, the actor-scoped presets) makes the WHOLE filter undecidable — not "evaluate what we can and hope". An undecidable filter keeps exactly what the server gave it: no guessed arrivals, and — the more dangerous direction — no guessed removals emptying a panel the server had populated.

Semantics measured, not assumed: a missing `deleted` clause means `'exclude'` (`collections.ts:248`, `f.deleted ?? 'exclude'`), and a null state axis never matches a status filter (contract, `CollectionQuery.sessionStatus`).

### Everything else that fell out

- `detailOf` reads the store too, fed by `ingestDetail`. `entity.upsert` then overlays the fresher envelope onto a cached detail (`reducers.mergeSummary` keeps the heavy sections) — **so an open panel shows a title someone else changed, with no re-read.** That is also what makes the save flow's conflict story coherent.
- `livenessOf` is an O(1) lookup in the projection instead of a flatten-and-scan of every cached list. **The verdict still comes exclusively from `seam.liveness.statusOf`** — asserted, because the new path could have quietly started reading `state.status`.
- `pull()`'s re-entrancy guard moved to a ref, and **a failed detail read is no longer re-armed.** `renderPanel` calls `pull` *from render*; with a real node, clearing the guard on failure turns one unreadable entity into an unbounded request loop. `onResync` clears the set. The fixture seam could never fail, so this shape was invisible until the default flipped.
- **Threads (`messagesByAnchor`) were deliberately NOT moved to the store.** The reducer sorts by `createdAt` and caps at 500; the current path returns `seam.messages()` verbatim. Moving it would change discussion ordering as a side effect of a data-plumbing change. Named as remaining non-live surface, not done.

### Referential identity

`rowsFor` is called from render and `projectRows` builds an array, so the per-key result is memoized in a `Map` re-created only when `rows`/`entities`/`spaceId` change. Without it every consumer's `useMemo`/`useEffect` deps (WorkspaceView's roster, GateApp's palette, `useHomeData`'s three lists) churn forever. Pinned by a test, because the failure is a render loop nobody would attribute to this file.

### `GateOptions.seam?: Seam` — the injection port

Added. `onEvent` is the input side of the whole loop and there was no way to feed it: the only assertions available were about reads, which is the half that already worked. Omitted (every screen), the hook constructs the seam the flag selects, exactly as before.

## 4. DELIVERABLE 2 — create/save, end to end

`＋ New` was already wired (`useNewTask` → `createTask`) by the authoring lane. What is new here is the SAVE path, per `HANDOVER-Authoring.md` §7:

- **§7b the title** — `chrome.tsx`'s inert `contentEditable` span is replaced by `InlineTitleEditor` when a commit handler is passed. `au-title` is a byte-equivalent of `pn-head__title` (same flex, 14.5px/600, nowrap+ellipsis), so the swap changes behaviour and not the box. **When no executor is wired the title renders PLAIN — it loses the dotted underline it never earned.** A dotted underline is a promise, and it is now only kept where a real `patchTask` sits behind it.
- **§7c `SaveControls`** into the header's inline actions slot (D63), mounted only where `config.list.inlineEdit` says the kind has an edit surface. On a kind with none, a permanently-disabled Save would be a reason attached to nothing.
- **§7d `AuthoringHost`** wraps the panel BODY, not the 30px header. Asserted structurally: the test checks the conflict card is *not* inside `panel-header`.
- **Which kinds are editable is REGISTRY DATA** — `config.list.inlineEdit.title`, whose previous state was 35 sources and zero readers (G2 in the authoring handover; the D39.2 shape). This wiring is its first consumer. No kind literal was added to `panels/`.
- A version conflict is a designed state: reload or overwrite, never a silent overwrite, never a retry at the same version.

## 5. Verification

### Instrument, stated (D62 §1)

`bunx vitest run --exclude 'src/terminal/**'` and `bunx tsc --noEmit`, **both from `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`** — never the repo root, where `bunx` resolves vitest 2.x against this v4 tree and every file dies at collect. Banner control: `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`.

| when (UTC) | vitest, package minus `src/terminal/**` | `tsc --noEmit` |
|---|---|---|
| 2026-07-29T12:22:45Z — **baseline, before any edit** | `56 passed (56)` files · `1079 passed (1079)` tests | exit 0 |
| 2026-07-29T12:37:42Z — after the loop + save wiring | `1 failed \| 62 passed (63)` files · `1 failed \| 1176 passed (1177)` | exit 0 |
| 2026-07-29T12:44:28Z | `64 passed (64)` files · `1186 passed (1186)` | exit 0 |
| 2026-07-29T12:50:26Z — **final, re-run after the handover was written** | **`64 passed (64)` files · `1186 passed (1186)`** | **exit 0** |

**The 12:37 failure was not mine and is gone without any action by me:** `src/settings-governance/no-kind-literals.test.ts` → `governance-model.ts → 'team_member'`. `ls -la src/settings-governance/` timestamped `governance-model.ts` at **18:08 IST, the same minute as the run** — another seat mid-edit; they landed their fix in the intervening seven minutes. **I report the reading that looked bad rather than only the flattering one**, because a state report that quietly drops it is the failure mode D62 §1 exists to prevent.

`bunx tsc -p tsconfig.test.json --noEmit` (test files are EXCLUDED from the main config, so `tsc --noEmit` alone is structurally blind to them): **zero errors in my four test files.** Pre-existing errors remain in `src/panels/bodies/SessionAnatomy.test.tsx` and `src/settings-space/menu-edit.test.ts` — other seats', unchanged by me, not diagnosed.

### Red-first — the event loop (the feature's proof)

Written before the projection was wired, with only the injection port present, i.e. HEAD's behaviour:

```
2026-07-29T12:30:21Z   RUN v4.1.10 …/packages/tm8-ui
bunx vitest run src/views/live-event-loop.test.tsx
 FAIL > the created task is ON SCREEN, and it got there without a re-read
   AssertionError: the event-created task must be in the rendered rows:
   expected [ 'ent-task-seeded' ] to include 'ent-task-created'
 FAIL > an event that MOVES a task out of a filter takes it off screen
   AssertionError: a task marked done must leave the Open list:
   expected [ 'ent-task-seeded' ] to have a length of +0 but got 1
 FAIL > an edit to a row already on screen shows the NEW title
   AssertionError: expected [ 'before' ] to deeply equal [ 'after' ]
 Test Files  1 failed (1) · Tests  3 failed | 5 passed (8)
```
GREEN after: `2026-07-29T12:33:03Z · Tests 8 passed (8)`.

**The assertion that carries the feature is the query-call count.** A test that only checked "the row is there" would pass identically if the hook had answered the event by re-running its reads — a different, much weaker feature, and one that cannot work at all when the node emits an event for something another client did while this client is idle. The five that passed red are the read-path and no-lie guards; a projection that scavenged the store for every list would turn all five of them red.

### Red-first — the default flip

`resolveSeamSource`'s final `return 'real'` restored to `'fixture'` (HEAD's answer), run, reverted:

```
2026-07-29T12:34:08Z   bunx vitest run src/views/seamSource.test.ts
 FAIL > THE HEADLINE: a dev browser with nobody opting in gets the REAL node
 FAIL > a mode nobody named still defaults real
 FAIL > any value that is neither "1" nor "0" is not an opt-in or an opt-out
 Tests  3 failed | 4 passed (7)
```

### Red-first — the save wiring (restored-broken, the rowsFor precedent)

Two breaks applied to the finished tree, run, captured, reverted. Full output in the file's docblock.

- **BREAK 1** — `chrome.tsx` never mounts the editor (HEAD's inert title as far as anything here can observe): `Tests 5 failed | 4 passed (9)`, all five `Unable to find an element by: [data-testid="authoring-title"]`. `2026-07-29T12:43:42Z`.
- **BREAK 2** — header wiring kept, `<AuthoringHost>` dropped from the body — **the plausible half-fix**, the one that ships a save whose conflict state has nowhere to render: `Tests 2 failed | 7 passed (9)`, both `expected null not to be null`. `2026-07-29T12:43:54Z`.
- Restored: `9 passed (9)`.

### AGAINST THE LIVE NODE — measured, not inferred

The tests above drive `onEvent` by hand. **Whether the node actually emits is the one thing they cannot prove**, so it was measured directly (`scratchpad/wsprobe.mjs`: open `ws://127.0.0.1:4612/v2/ws`, `subscribe`, `POST /v2/entities`, watch):

```
2026-07-29T12:47:13Z
CREATE http 201 id 019fadea-2d70-7843-8a28-44a249cc2829
WS <- {"spaceId":"019f98d5-…","seq":199,"type":"entity.upsert","entity":{"id":"019fadea-…","kind":"task",…
WS <- {"spaceId":"019f98d5-…","seq":200,"type":"activity.created",…
frames: 2 | event naming the new task: YES
```

**The server half of the loop is proven.** `entity.upsert` carries the full summary, within milliseconds, unprompted.

Also measured on the live node: `GET /v2/spaces` → one space `019f98d5-739e-7adf-9b19-8c54e78d4271` ("Smoke Space 795791"); `POST /v2/collections/query` for `kind: task` returns real rows and echoes `"sort":"activityAt_desc"` — which is what turns the head-insertion rule from a reading of the source into a measurement.

**SIDE EFFECT, STATED: the probe created a real task titled `ws-probe task` in that space (id `019fadea-2d70-7843-8a28-44a249cc2829`).** It is live data in the user's node and will appear in the task list at the user's acceptance. Not deleted, because a delete is another write with its own event; delete it if it is in the way.

## 6. GAPS — including two the coordinator must close

### GAP-1 — **BLOCKING. Nobody renders `bootError`.**

`grep -rn "bootError" src` returns exactly one file: `useGateData.ts` itself. `GateApp.tsx` renders `loading workspace…` forever when boot throws. **With the default flipped, an unreachable node is now a silent infinite spinner** — the same lie class this change exists to remove, in the state most likely to occur (node not started). `src/views/GateApp.tsx` is not this seat's. The patch, at the final `) : (` of the render (currently `<div className="shell-boot" role="status">loading workspace…</div>`):

```tsx
) : data.bootError ? (
  /* An unreachable node is a NORMAL state and it is stated. Never fixtures,
     never a spinner that resolves for nobody. */
  <div className="shell-boot" role="alert">
    <strong>Can’t reach the tm8 node.</strong>
    <div>{data.bootError}</div>
    <div>The workspace is empty because nothing could be read — not because there is nothing in it.</div>
  </div>
) : (
  <div className="shell-boot" role="status">loading workspace…</div>
)}
```

**This should land in the same commit as the default flip.**

### GAP-2 — the save path needs one line per host

`EntityDetailPanel` takes `commands?: AuthoringCommands | null`; absent, the title is plain and Save renders disabled-with-reason (honest, visible — but not the deliverable). `AuthoringCommands` is a structural subset of `Seam['commands']`, so this assigns with **no cast and no adapter**:

- `src/views/EntityView.tsx` ~line 104, `<EntityDetailPanel …>` → add `commands={data.seam.commands}`. For the oracle's "Z3 opens, title in inline-edit focus", also `justCreated={selectedId === justCreatedId}` where `justCreatedId` is set in the `onCreated: (id) => …` callback that already exists there — **`NewTaskHandle` exposes no created id** (`{state, unavailable, create, dismiss}`), so the host has to remember it from the callback. Omit and the title still opens editable, just not auto-focused.
- `src/views/WorkspaceView.tsx` ~line 98, in `renderPanel` → add `commands={data.seam.commands}`.
- `src/graph/GraphScreen.tsx` ~line 67 → same, if editing from the graph aside is wanted.

Not done here because those three files are outside the ownership list and two of them were being edited by other seats during this window.

### GAP-3 — the one-gesture version window (a real hole, pinned by a test)

`useTaskSave` captures `expectedVersion` at the FIRST EDIT — the mechanism that turns a concurrent write into a conflict instead of a silent overwrite. The title uses `commitNow` (stage-and-flush in one call), so for the title the "first edit" IS the Enter key: **a write that lands while the user is typing is adopted, not conflicted with.** The live loop makes this reachable rather than theoretical, since an open panel now receives another writer's version mid-typing.

Fix belongs in the authoring lane (not this seat's directory): `InlineTitleEditor` gains `onBeginEdit`, the panel passes `() => save.edit({})`. That captures the base version at focus and leaves `dirty` false (`dirty` is `Object.keys(edits).length > 0`), so no chip appears. Measured and asserted in `save-wiring.test.tsx` so it cannot change unnoticed.

### GAP-4 — the node sends the winning version and the client drops it

The authoring handover listed "whether a real node returns `current: EntityDetail` on a 409" as NOT MEASURED. **It is measured now:** `packages/server/src/facade/handlers/entities.ts:enrichVersionConflict` decorates the conflict with `details.current` — the whole current `EntityDetail`, version included. But `src/data/real/http.ts:toCollabError` rebuilds the error from the wire and passes `details` through **without setting `opts.current`**, and `classifyFailure` reads only `error.current` and `details.currentVersion`. So `currentVersion` is `null` and **OVERWRITE — the move the server sent us everything needed to offer — renders disabled-with-reason against a real node.**

Two candidate one-liners, both outside this seat: set `current: details.current` in `toCollabError`, or read `details.current?.version` in `classifyFailure`. Pinned as a measurement in `save-wiring.test.tsx` — **when either lands, that test goes red**, which is the point of writing it that way rather than leaving a sentence in a handover nobody re-reads.

### GAP-5 — mock data still on real screens

- **5a — RESOLVED.** Launch teammate/profile summaries, linked projects and node capacity now come from the active seam. `views/launch-fixtures` remains test-only.
- **5b — RESOLVED.** `GateApp` now hands `GraphScreen` the active seam's `graph.query` lens. Hydrated edges share the domain store with `edge.upsert`/`edge.deleted`, and hydrated nodes share it with entity events, so the canvas advances without a fixture timeline or refresh.

### GAP-6 — RESOLVED: production uses the real seam

Production now follows the ordinary real-seam default. Fixture mode is explicit (`'0'`) or the test composition only.

### GAP-7 — `realSeamFlag.test.ts`'s "is OFF by default"

Still green, and it now measures the MODE=test rule rather than the app's default. **Its name no longer means what it says.** One line of that file (a docblock note in `realSeamFlag.ts` points at it); recommend the coordinator rename it to "is off under MODE=test". Not renamed here: it is an existing test file outside the "new test files" grant.

### GAP-8 — pagination

`rows[key]` is one page. An arrival the server would have placed on page 2 shows here on page 1. The lists this app draws are not paged yet, so this is stated rather than fixed.

## 7. Files + diffstat

```
 src/data/project/domain-store.ts   | 138 +++      membershipOf + projectRows (the loop, pure)
 src/views/useGateData.ts           | 183 ++++---   rows→ids, store subscription, projection, pull guard
 src/views/realSeamFlag.ts          | 139 ++++--    resolveSeamSource + opt-out + the flipped default
 src/panels/EntityDetailPanel.tsx   | 105 ++++-     useTaskSave, SaveControls, AuthoringHost, title props
 src/panels/detail/chrome.tsx       |  81 ++++-     InlineTitleEditor replaces the inert contentEditable
 5 files changed, 542 insertions(+), 104 deletions(-)

 src/views/live-event-loop.test.tsx      | 352  NEW  the loop through the real hook (8)
 src/data/project/projection.test.ts     | 155  NEW  membershipOf / projectRows, pure (13)
 src/panels/detail/save-wiring.test.tsx  | 332  NEW  the save crossing (9)
 src/views/seamSource.test.ts            |  72  NEW  the default's truth table (7)
 src/data/HANDOVER-DataWiring.md         |      NEW  this file
```

`git diff --stat` + `wc -l`, 2026-07-29 18:20 IST. No other file was edited. `src/fixtures/**`, `src/authoring/**`, `src/terminal/**`, `src/graph/**`, `src/auth/**` and every package outside `tm8-ui` are untouched.

**Dirty in the tree that is NOT mine**, so it is not assumed you know: `src/settings-governance/**` and `src/settings-space/**` (other seats, actively writing during my window — files timestamped inside the same minute as one of my runs), plus everything listed in the repo `git status` at session start.

## 8. NOT CHECKED — plainly

- **NOT LOOKED AT IN A BROWSER.** Zero of this was rendered on `:4612`, in either theme, at any width. jsdom has no layout engine. Specifically unverified: whether `au-title-input` at `height:24px` fits the header row without pushing the status pill out; whether the conflict card wraps sanely at the 320 floor; whether `AuthoringHost`'s card is clipped by the body's `overflow`; whether the editing pill + Cancel + Save fit beside `ActionBar inline`. **The card-clipping is the one I would check first** — it is the D35 class of defect and it is invisible to all 37 of my tests. Ready for capture.
- **THE FULL LIVE LOOP WAS NOT WATCHED IN A BROWSER.** Both halves are measured separately — the node emits (§5, live WS probe) and the hook renders an emitted event (§5, red→green) — and the join between them is `createRealSeam`'s `onEvent`, which is one line (`seam-real.ts:212`, `connection.onEvent`) and is covered by that lane's own tests. **Separately measured is not end-to-end measured**, and the user's acceptance is the pixel loop.
- **NOT MEASURED: what the app looks like against THIS node's data.** The space has one real space and real tasks; whether every screen's registry expectations survive real payloads (custom kinds, missing state axes, null actors) has not been exercised.
- **NOT TESTED: reconnect/resync with the new projection.** `onResync` clears `pulled` and re-hydrates, which re-`ingestSummaries`; entities the server has since deleted stay in the store's flat table and would keep appearing in any `deleted: 'include'` list. Untested and unbounded — the store has no eviction.
- **NOT TESTED: two panels editing the same entity in one client** (inherited from the authoring handover; each `useTaskSave` holds its own baseVersion).
- **NOT DONE: threads/messages are still local `useState`,** so the Discussion tab does not update from the event stream. Deliberate (§3), not overlooked.
- **NOT VERIFIED: `.pn-head__title--editable` vs `.au-title--editable`** — two selectors for one treatment still exist; `panels.css` is not this seat's, and their computed values were not diffed.
- **NOT INVESTIGATED: the other seats' test-tsc errors** (`SessionAnatomy.test.tsx`, `menu-edit.test.ts`). Confirmed foreign by path and mtime; NOT assumed harmless to those seats.
