# Chat Entity Graph — design and build plan

**Status:** design ruled, not built.
**Supersedes:** the `LiveGraphStrip` star currently mounted in Chat Home.
**Owner ruling (Subhang, 2026-08-16):** *"I don't want hub and spoke. I want a
proper graph and relations between these entities that it read."* and
*"the conversation should not be part of the graph."*

---

## 1. The one-sentence statement

**Draw the entities this conversation touched, and the relations those entities
actually have to each other in the tm8 graph. Nothing else is in the picture.**

The conversation is the *selector*, not a node. It decides which entities are on
screen and it never appears on screen.

---

## 2. What exists today, honestly

All paths are on `origin/main`. **The primary shared tree
(`~/Desktop/Projects/tm8`) does not contain `packages/tm8-ui/src/chat-home/` at
all** — it is hundreds of commits stale. Work from a clean main worktree
(`~/tm8-main-build` exists and is at main).

### 2.1 The node fold (keep this)

| file | what it does |
|---|---|
| `chat-home/turn-graph.ts` | `foldTurnGraph(turns, suppressEntityIds)` → `LiveGraphModel` |
| `chat-home/entity-refs.ts` | `extractEntityRefs(...payloads)` — the defensive JSON walk |
| `chat-home/turn-model.ts` | `projectTurnParts` — collapses append-only `tool_call`/`tool_result` records for one `toolCallId` into one `tool` part |
| `chat-home/ChatHomeScreen.tsx:440` | the `useMemo` that folds |
| `chat-home/ChatHomeScreen.tsx:1094` | the `<LiveGraphStrip>` mount |

`extractEntityRefs` heuristics, verbatim from the source:

- an **object** carrying a UUIDv7 `id` → ref, with sibling `kind`/`title`
  (skipped when the object is edge-shaped: has `srcId`+`dstId` or `src`+`dst`);
- a **bare** UUIDv7 under a key matching `id | ids | *Id | *Ids`, minus a
  12-entry `SKIP_KEYS` denylist (`spaceId`, `clientMutationId`, `edgeId`,
  `toolCallId`, `requestId`, `cursorId` + plurals);
- a **string that parses as JSON** is parsed once and re-walked — this is how
  the MCP `content: [{type:'text', text:'<json>'}]` envelope gets opened;
- bounds: `MAX_REFS = 8` (per call), `MAX_NODES = 500`, `MAX_DEPTH = 8`.

### 2.2 The renderer (replace this)

| file | what it does |
|---|---|
| `channel-screen/LiveToolGraph.tsx` | `LiveGraphStrip` (Chat Home) and `TurnGraph` (session feed), both over `LiveGraphCanvas` |
| `channel-screen/live-graph-model.ts` | `foldLiveGraph`, `edgeLabel`, `neutralEdgeLabel`, `segmentTurnGraphs` |

`LiveGraphCanvas` places node `i` at `angle = -π/2 + i·2π/n` on a single ring of
radius `r = max(132, n·NODE_W·0.8 / (2π))` and draws `M cx cy L x y`.

### 2.3 The engine that already solves most of this (reuse it)

`packages/tm8-ui/src/session-graph/` — the fourth session chip.

| file | constant / fact |
|---|---|
| `load.ts` | `loadSessionGraph`, `ConnectionsReader`, `FOCUS_LIMIT = 200`, `NEIGHBOUR_LIMIT = 60`, `EXPAND_BUDGET = [12, 6]`, settled/partial-failure policy |
| `model.ts` | `HUB_DEGREE = 12`, `FOLD_AT = 5`, `FANOUT = 24`, `MAX_CELLS = 64`; relation labels keyed `type:direction`; `humanize` fallback for unknown types |
| `layout.ts` | `NODE_W = 216`, `NODE_H = 72`, `FOCUS_W = 268`, `FOCUS_H = 104`, `RING_GAP = 26`, `PAD = 32`; **axis-aligned clearance** (`\|Δx\| ≥ w` **or** `\|Δy\| ≥ h`) |
| `data/seam.ts:549` | `connections(id: EntityId, opts?: ConnectionOpts): Promise<Page<EdgeView>>` |

`model.ts` records the measurement that decides the read: **`graph.query` takes
a 200-row candidate slice *before* it traverses**, and reported ONE
`authored_from` edge for a session holding fifty-one. `entities.connections` on
the same session returned all 103. **Use `entities.connections`. Never
`graph.query`.**

---

## 3. Why the current picture fails

Evidence: live screenshot, Chat Home, 2026-08-16 07:07.

1. **Nine of ten edges read `tm8_read`.** One fact, stated ten times, radially.
2. **Four nodes are unresolved UUIDs** (`01a005da…6965 · Member`). `EntityChip`
   takes a `ChatEntityResolver`; `foldTurnGraph` was given none, so a bare-id
   ref is permanently `kind:'entity'` / `title: truncateEntityId(id)`.
3. **Cards overlap** (two pairs). The ring is sized by circumference ÷ count,
   which is not a collision test for axis-aligned rectangles. `LiveToolGraph`
   imports `NODE_W`/`NODE_H` from `session-graph/layout.ts` but not its maths.
4. **The shape is a lie of omission.** `LiveGraphModel` has no field for a
   relation between two touches, so the star is not a claim about structure —
   it is the only drawing the data structure can produce.
5. **Two surfaces hold opposite rulings.** `TurnGraph` uses `neutralEdgeLabel`
   specifically so "no tool names, arguments, or payload ever reach the feed";
   `LiveGraphStrip` prints raw tool names on every edge.

---

## 4. Measured facts this design rests on

Run against the live node, 2026-08-16, over a 10-entity seed set chosen to
mimic the screenshot's mix (4 `work_session`, 2 `team_member`, 1 `channel`,
3 `task`), one `tm8 entity connections <id> --limit 60` per seed:

```
INDUCED EDGES (both endpoints inside the seed set): 14
  Fix THis            --assigned_to-----> GPT 5.6 Teammate
  All CHAT UI Modes…  --assigned_to-----> Opus 5 Teammate
  Task Types, axis…   --assigned_to-----> Opus 5 Teammate
  GPT 5.6 Teammate    --participates_in-> Fix THis
  Opus 5 Teammate     --participates_in-> All CHAT UI Modes…
  Opus 5 Teammate     --participates_in-> Task Board
  Task Board          --relates_to------> Opus 5 Teammate
  Fix THis  (session) --working_on------> Fix THis  (task)
  Task Types (session)--working_on------> Task Types (task)
  … 14 total, 4 relation types
```

Four consequences, each load-bearing:

- **F1 — the graph is real.** 10 seeds, 14 induced edges, task↔teammate↔session
  triangles. This design is not speculative.
- **F2 — the connections response carries full summaries.** Every `EdgeView`
  embeds the complete `source` **and** `target` entity summary (id, kind,
  title, state, badges). **The read that gives you edges also resolves the
  UUID-titled nodes.** One request, both defects.
- **F3 — hubs are present.** 3 of 10 seeds returned degree 60 — page-capped, so
  actually more (both teammates and one session). Ordinary tasks sat at 6–11.
  `HUB_DEGREE = 12` separates them with room on both sides, as `model.ts` says.
- **F4 — isolated seeds are real, and connector hops explode.** The
  `deployment` channel had degree 16 and contributed **zero** induced edges.
  Meanwhile **72** external nodes were reached by ≥2 seeds — so "add one
  intermediate hop to connect things up" floods the picture. See R5/R3.

---

## 5. Rulings

Each is binding. Where one contradicts existing code, the code changes.

### R1 — The conversation is not a node
No hub, no centre, no anchor card, no "this conversation" cell. The chat
selects the node set and is otherwise absent from the drawing. There is no
`focusKind`, no `anchorNoun`, no `sg-cell--focus`.

### R2 — The node set is the existing client fold
Seeds = entities `extractEntityRefs` pulled from this thread's tool calls,
reads included. **`entity-refs.ts` and `projectTurnParts` do not change.**
"What we talked about" is the right selector and it is already correct.

### R3 — Edges come only from the real graph
An edge is drawn if and only if `entities.connections` returned it **and both
endpoints are in the seed set**. Explicitly forbidden:
- co-occurrence edges ("these two ids appeared in the same tool result") — a
  query returning 8 rows would draw a K8 clique that means nothing;
- inferred / derived / "probably related" edges;
- intermediate connector nodes to join otherwise-separate components (F4).

### R4 — Parallel edges merge into one line
The measurement shows `assigned_to` **and** `relates_to` between the same
task/teammate pair. That is one relationship line carrying a relation set, not
two lines. Direction is preserved per relation.

### R5 — Isolated nodes are drawn, unlinked
A seed with no induced edge stays on the canvas with no line. *"We read this;
it relates to nothing else we read"* is true and useful. Never fabricate an
attachment, and never drop the node to make the picture tidier.

### R6 — Read and write are visually distinct
A node the conversation **mutated** is emphasised; a node it merely **read** is
not. Interim source: the tool call's write-ness. Durable source: `public.activity`
rows (`internal.record_activity` runs inside every mutating RPC). Phase 4 ships
the interim; the durable source is a follow-up, not a blocker.

### R7 — Titles come from the edge payload first
Resolution order: (a) `EdgeView.source`/`target` summary from the connections
read (F2); (b) the ref's own `kind`/`title` from extraction; (c) the existing
`ChatEntityResolver` path used by `EntityChip`, sharing its module-level cache;
(d) `truncateEntityId`. **A node showing a truncated UUID in the shipped
surface is a bug, not a state.**

### R8 — No tool names anywhere
No `tm8_read`, no `Bash`, no `mcp__tm8__*` string reaches this surface. Edge
labels are relation types (`assigned_to`, `working_on`), humanised by the
existing `model.ts` mechanism. This resolves the two-surface contradiction in
§3.5 in favour of the stricter rule.

### R9 — Layout is not radial
There is no focus, so a radial ego layout is the wrong instrument. Requirements:
deterministic, axis-aligned clearance (reuse `layout.ts`'s clearance maths, not
its ring), and stable — a settled node must not move when a new node arrives
mid-stream. Prior research says **buy `@dagrejs/dagre`** (16.5 kB, single file)
rather than a renderer: the cards are rich DOM/SVG, which disqualifies every
WebGL graph library. A hand-rolled deterministic layered layout is acceptable
if it meets the same three requirements; justify the choice in the PR.

### R10 — Deterministic
Same seed set + same edges ⇒ byte-identical layout. No clock, no random source.

### R11 — Partial reads are normal and say so
One 403 or 404 on one seed must not blank the graph. A seed whose connections
read failed is drawn and **labelled as "edges not read"** — never as isolated,
because those two states mean opposite things (R5 vs failure).

### R12 — Degenerate cases
- 0 seeds → render nothing at all (no header, no empty frame).
- 1 seed → one card, no graph chrome, no edge language.
- All seeds isolated → cards, no lines, and a caption that says so.

### R13 — Honest caption
State entities and relations. The word **"touch" is retired** — it meant
"mutated" on one surface and "mentioned" on the other. Note that today's
`activityCount` counts `(call, ref)` pairs and is capped at 8 per call, so it
must not be presented as a total of anything.

### R14 — Do not re-fold the world on every frame
`mergeChatTurnFrame` returns a new `detail` object per streaming delta, and the
current `useMemo(..., [detail, …])` re-walks every payload in the thread on
every frame. The seed fold must be incremental or memoised per turn (the chips
already memoise per part: `TurnParts.tsx:103`). The connections read must be
issued per *new* seed id, never re-issued for the whole set.

### R15 — Scope
This replaces `LiveGraphStrip` **in Chat Home only**. The session-feed
`TurnGraph` (`ChannelScreen.tsx:438`) is out of scope for this work and is not
to be changed or deleted. Whether it later adopts the same engine is a separate
decision.

---

## 6. Data flow

```
ChatTurn[]  (durable + streamed)
  │
  │  projectTurnParts → tool parts → extractEntityRefs        [unchanged]
  ▼
seedIds: Set<EntityId>            "what this conversation is about"
  │
  │  seam.connections(id, {limit: 60}) per NEW seed, in parallel   [R14]
  ▼
EdgeView[] per seed  ──► entity summaries (titles, kinds)      [F2 → R7]
  │
  │  keep edges with BOTH endpoints in seedIds                 [R3]
  │  merge parallel pairs                                      [R4]
  ▼
InducedGraph { nodes[], edges[], isolated[], unread[] }
  │
  │  deterministic layout, axis-aligned clearance              [R9, R10]
  ▼
canvas — no centre, no anchor, relation labels only            [R1, R8]
```

---

## 7. Build plan

Each phase lands independently and is separately reviewable.

### P0 — Lock the measurement
Encode §4 as a fixture-backed test: a 10-seed set with the four relation types,
a hub at degree ≥ 60, an isolated node, and a failed read. **Write this first**
— it is the acceptance instrument for P1 and P2.

*Done when:* the fixture exists and P1's model can be asserted against it.

### P1 — `induced-graph.ts` (pure)
`buildInducedGraph(seedIds, edgesBySeed) → InducedGraph`. Implements R3, R4,
R5, R7 (a/b), R11's `unread` split, R12, R13.

*Done when:* over the P0 fixture it returns 14 edges, correctly merges the
duplicated task/teammate pair into one, lists the channel as isolated, and lists
the failed seed as unread — with no rendering code touched.

### P2 — the read
Connections reader over `seam.connections`, parallel, `limit: 60`, settled
(partial failure is a count, not a rejection), incremental per new seed id (R14).
Reuse `load.ts`'s policy shape; do **not** reuse its breadth-first expansion —
there is no expansion here, the seed set is closed.

*Done when:* a thread that adds one entity issues exactly one new read.

### P3 — layout
R9 + R10. Deterministic, clearance-correct, stable under insertion. Justify
dagre-vs-hand-rolled in the PR body with the three requirements as the rubric.

*Done when:* no two cards overlap at n = 3, 10, 24 with the real card size
(216×72), and re-running the same input twice produces identical coordinates.

### P4 — render
Cards (registry `KindIcon` + title + kind, click-through via `onOpenEntity`),
merged relation edges with humanised labels, mutated-vs-read emphasis (R6
interim), isolated and unread treatments (R5, R11), honest caption (R13).

*Done when:* the screenshot's ten entities draw as a connected graph with
relation labels, real titles, and no `tm8_read` string anywhere.

### P5 — wire and retire
Mount in `ChatHomeScreen` in place of `<LiveGraphStrip>` (`:1094`). Leave
`LiveGraphStrip`/`TurnGraph` in place for the session feed (R15). Delete the
Chat-Home-only call path and its now-dead props.

*Done when:* Chat Home renders the new surface and the session feed is
byte-identical to main.

---

## 8. Explicitly out of scope

- Changing `extractEntityRefs`, `SKIP_KEYS`, or the `MAX_REFS = 8` cap.
- The session-feed `TurnGraph` (R15).
- The whole-space graph canvas (`views/graphSurface.tsx`).
- Server changes. Everything here is available through `seam.connections` today.
- A durable activity-row source for R6 (follow-up).

---

## 9. Open questions — bring answers back, do not guess

1. **Does the Chat Home host have a connections reader?** `ChatHomeSurface`
   builds `resolveEntity` from `seam.entity`; it does not currently take
   `seam.connections`. Confirm the wiring point before P2.
2. **Cap on nodes.** `MAX_REFS = 8` per call is uncapped across a long thread.
   A 200-turn conversation could seed hundreds of entities. Is there a node cap,
   and if so is it recency-based or degree-based? (`MAX_CELLS = 64` is the
   session graph's answer; it may or may not be right here.)
3. **Hub rendering.** With no expansion, `HUB_DEGREE` is not needed for
   traversal. Is a seed's degree still worth showing on the card as context?
4. **`working_on` self-pairs.** The measurement shows a session and its task
   carrying the same title; confirm this reads clearly on the canvas rather
   than looking like a duplicate node.

---

## 10. Instruments and traps

- **Work off main.** The primary shared tree has no `chat-home/` at all.
  `~/tm8-main-build` is a clean main worktree.
- **`packages/tm8-ui` tests need `@tm8/contract` BUILT** — run `bun run build`
  in a fresh worktree first, or ~67 files fail at collect and it looks like
  breakage.
- Every tm8-ui test file needs `// @vitest-environment jsdom`. There is **no
  `user-event` and no `jest-dom`** in this package.
- **jsdom loads no stylesheets** — `getComputedStyle().backgroundColor` is
  empty, so no rendering test can see a colour. A geometry/overlap claim must be
  asserted against the layout function's numbers, not the DOM.
- Root `bun run typecheck` now includes tm8-ui.
- tm8-ui suite baseline on main: ~16 failed / ~3038 passed. Prove zero
  regression **by SET**, never by count.
- `panels/no-branching.test.ts` (§15.2) scans only `panels/` plus four named
  shell files, so `chat-home/` literals are legal. Relation TYPES are not entity
  kinds — `session-graph/model.ts` already states this is not a §15.2 breach.
- Measure the live graph with
  `tm8 entity connections <id> --limit 60 --format json`; every JSON output is
  wrapped in cache/journal lines, so slice from the first `{` to the last `}`.
