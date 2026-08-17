# Time-based graph — design proposal

Task `01a006f8-b411-7bee-8e97-c4cc79dd89b6` ("Time based Graph"). Written 2026-08-16
against space `019fb748-0068-76dc-9869-1bb36133c554` on node :7778 (`tm8_stable`).

Every number below is measured, not estimated. The measurement scripts are inline so
they can be re-run when the space grows again — and it will, see §1.

---

## 1. What changed: the space grew 9x and time became a filter

The current graph relevance pass was built on 2026-08-01 against **435 entities / 567
edges**. Re-measured today:

| | 2026-08-01 | 2026-08-16 |
|---|---|---|
| entities | 435 | **3,917** |
| edges | 567 | **7,434** |

Recency distribution today, by `activity_at`:

| window | entities | share of space |
|---|---|---|
| last 1h | 31 | 0.8% |
| last 24h | **195** | **5%** |
| last 7d | 2,111 | 54% |
| last 30d | 3,917 | 100% |

**This inverts the ruling the current design was built on.** `relevance.ts` deliberately
refuses to let recency seed a lens, with the comment that recency "cannot discriminate"
— and on 2026-08-01 that was correct and measured: 348 of 435 entities (80%) were active
within a day, so a 24h window selected almost the whole space.

Today a 24h window selects **5%**. Recency is now the single strongest discriminator the
data offers, and it is the only one that keeps working as the space grows, because it
selects a roughly constant *rate* of work rather than a fraction of an accumulating pile.

The ruling was not wrong. The data moved out from under it. That is the reason to
revisit, and it should be written down as the reason, so the next person does not
re-litigate it from taste.

---

## 2. The bug that has to be fixed first: the server's answer is discarded

`graph.query` is already a time-based query and the client already calls it. The client
then throws the result away.

```ts
// packages/tm8-ui/src/views/useGateData.ts:472
const result = await seam.graph({ spaceId: space, layout: 'graph', limit: 150 });
const store = domain.store.getState();
store.ingestSummaries(result.nodes);   // <- merged into the shared domain store
store.ingestEdges(result.edges);
```

```ts
// packages/tm8-ui/src/views/useGateData.ts:1301
const graphNodes = useMemo(
  () => graphLoad.phase === 'error'
    ? EMPTY_ROWS
    : Object.values(entities).filter((entity) => entity.spaceId === spaceId),
  [graphLoad.phase, entities, spaceId],
);
```

The canvas renders `Object.values(entities)` — **the entire accumulated domain store**,
which every other read in the app also writes into (rail kind hydration, channel
messages, launch resources, panel detail fetches). `graph.query`'s `limit: 150` only
decides how much the graph read *seeds* into that store; it does not scope the canvas.

Two consequences:

1. **The canvas is unbounded by construction and grows as you browse.** Open a few
   channels, then the graph, and it draws them. This is the direct cause of "it shows a
   lot of entities". The relevance/DOI pass in `relevance.ts` is the only thing between
   it and a hairball — exactly as designed, but it is now absorbing a load the DOI
   thresholds were never tuned for.
2. **Any server-side time window we add would be defeated by this line.** Adding a
   `since` parameter to `graph.query` while the client renders the whole store would be
   dead code that tests green.

So this is a prerequisite, not a nice-to-have.

### The nearly-free version of the whole feature

Verified in the handler and the sort table:

- `packages/server/src/facade/handlers/collections.ts:101` — `DEFAULT_SORT = 'activityAt_desc'`
- `packages/server/src/facade/context.ts:134` — `MAX_LIMIT = 200`, and `limitOf` clamps to it
- `graph-undo.ts:67-77` — `queryCollection` is called with the caller's query and
  `limit: MAX_LIMIT`, so the sort passes straight through; `nodeLimit` slices *after*
  traversal

Therefore **`graph.query` already returns "the 200 most recently active entities in the
space, plus their induced edges"**. A top-N under `activityAt_desc` *is* a time window —
expressed as a rank instead of a threshold.

That means Phase 1 is a client change of a few lines with **no contract change, no
migration, no new operation**: render `result.nodes`/`result.edges` instead of the store.
Confirmed on the wire — passing no `sort` echoes back `"sort": "activityAt_desc"`.

Rank-vs-threshold is a real design difference and worth choosing deliberately:

- **Top-N (free today)** — constant render cost, never empty. But the window silently
  stretches to weeks on a quiet space, so "recent" stops meaning recent.
- **Threshold (`since`, needs a contract change)** — honest and legible ("last 24 hours"),
  and it can be *empty*, which is information. But it is unbounded on a busy day.

Recommendation: **ship top-N first, then add `since` and use both** — threshold for
meaning, top-N as the safety cap. That is one new optional field on `CollectionQuery`
(`activitySince`), which today has time *sorts* but no time *filter*.

---

## 3. Disjoint sets: they do not exist naturally, and that is the interesting part

Union-find over the real edge set, per window:

| window | nodes | edges | components | singletons | non-trivial | largest | giant share |
|---|---|---|---|---|---|---|---|
| all time | 3,917 | 7,387 | 85 | 81 | **4** | **3,822** | **98%** |
| last 7d | 2,111 | 4,221 | 51 | 46 | 5 | 2,038 | 97% |
| last 24h | 195 | 384 | 9 | 5 | 4 | 171 | 88% |
| last 1h | 31 | 53 | 4 | 2 | 2 | 25 | 81% |

**"Show disjoint sets" as literally specified would render one enormous blob plus a
handful of orphans.** The space is a single giant component at every time scale. Dropping
messages does not help — the giant is still 1,253 of 1,343 (93%).

### Why it is one blob

Top degrees, 7d window: `work_session` 237, `team_member` 130, `work_session` 128,
`work_session` 119, `project` 112. Every session touches the same teammate and the same
project; every entity an agent creates carries a `created_in` edge back to its session.
Those hub nodes weld otherwise-unrelated work into one component. Edge-type ablation
confirms it: dropping `created_in` alone takes the 7d component count from 51 to **189**.

### Hub-stopping creates the sets — and it is already a proven pattern here

Removing nodes above a degree threshold, then re-running union-find:

**7d window** (2,111 nodes) — time alone is not enough:

| threshold | hubs removed | largest | non-trivial components |
|---|---|---|---|
| none | 0 | 2,038 | 5 |
| >100 | 6 | 1,782 | 26 |
| >25 | 49 | 302 | 73 |
| >12 | 105 | 57 | **100** |

100 components is not a view either. But **combined with a 24h window**:

| threshold | nodes left | largest | non-trivial components | sizes |
|---|---|---|---|---|
| none | 195 | 171 | 4 | 171, 11, 5, 3 |
| >25 | 192 | 106 | 13 | 106, 15, 12, 11, 9, 8… |
| **>12** | **183** | **19** | **22** | 19, 12, 11, 11, 10, 9, 8, 8, 8, 7… |

**Neither axis works alone. Together they turn a 3,917-node hairball into 22 clusters of
7–19 nodes.** That is the headline result of this investigation.

The threshold `>12` is not arbitrary — it is `HUB_DEGREE = 12` from
`session-graph/model.ts`, already shipped and tuned against this same space (PR #83). The
session graph solved this exact problem one scale down. Reuse the constant and the rule.

### The clusters are real work threads

Sampled composition of the 24h + hub-stop clusters:

```
[1] 19 nodes  {message:14, work_session:4, task:1}   "UI/UX redesign — shell: top-row switcher…"
[5] 10 nodes  {work_session:1, message:6, task:2, commit:1}   "Restart staging"
[7]  8 nodes  {task:2, work_session:2, message:3, worktree:1} "Home page improvements"
[9]  8 nodes  {commit:2, task:1, message:3, pull_request:1, work_session:1}
                                                     "I dont see any graph in the chat"
[11] 6 nodes  {message:2, pull_request:1, task:1, work_session:1, commit:1}
[12] 5 nodes  {task:1, work_session:2, team_member:1, loop:1}  "Dreamer daily sweep"
```

Each cluster is **one unit of work: a task, the session that worked it, the PR and
commits it produced, and the messages exchanged about it.** This is exactly the mental
model in the task description. It is recoverable from pure topology — no kind literals,
no hardcoded semantics, so §15.2 needs no exemption. Both rules are derived from measured
degree and measured recency.

Withheld hubs at that threshold were: 3 teammates, the `tm8` project, and the 2–3
cross-cutting tasks/sessions that genuinely do touch everything.

### The design rule that follows

**A hub is not noise — it is context. Draw hubs, never traverse through them.**

If you delete the teammate and the project, the clusters are correct but the picture is a
lie: it looks like nobody owns the work. `session-graph` already got this right — a hub is
drawn, labelled with its true degree (`◈27`), and its undrawn neighbours are counted as
`withheld`. The canvas stays honest about what it is not showing.

So the partition is: **cluster by connectivity *excluding* hub edges; render hubs as
shared anchors that sit between clusters rather than inside any one of them.**

---

## 4. Proposed design

### The lens axis becomes time

Today's lenses (`live` / `working` / `all`) are DOI-seeded and mixed-axis. Replace with a
single **time scrubber** — `1h · 24h · 7d · all` — plus the existing `all` as the escape
hatch. Time is legible in a way "Active work" is not: the user knows what "last 24 hours"
means without reading the code.

DOI does not go away. It changes job: it stops being the *selector* and becomes the
*ranker within the window* and the tiebreak when a window overflows the render cap. That
is a smaller, more defensible role, and it keeps `relevance.ts` earning its keep.

Keep `live` sessions as a **pin**, not a lens — a live session must be drawn even if it
has been quiet for two hours and falls outside the window. `relevance.ts` already has
exactly this concept (`mustDraw`).

### Layout follows the partition

Clusters are the primary layout unit. Each cluster gets its own layered sub-layout;
clusters are packed as islands (the existing `model.ts` island packer already does this,
it has just never had more than one island worth packing). Hubs are placed *between* the
clusters they connect, not inside them.

This also fixes a real complaint about the current picture: with one giant component,
the island packer is dead code and every node lands in one long layered ribbon. That
ribbon is a large part of why it reads as "boring".

### Honesty budget

The existing accounting law must extend to the new categories, or the canvas will lie
about what it dropped:

```
placed + shelf + folded + truncated + outOfLens + outOfWindow + hubWithheld === visibleTotal
```

`outOfWindow` and `hubWithheld` are new and both need their own sentence in the banner.
This is the same class of bug already caught once on this surface: `truncated` was
conflated with `outOfLens` and the banner blamed the render cap for a lens decision.
Do not let a hub-stopped neighbour be reported as "truncated".

---

## 5. Library question

Full survey with versions, licences and bundle sizes measured 2026-08-16 is in the task
thread. Summary of the recommendation:

**The renderer is not the weak component; the layout is.**

`GraphView.tsx` (1,120 lines) already implements pan/zoom, minimap, search, keyboard nav,
`role="application"` + focusable node cards, and node folding. Critically, node cards are
240x124 DIVs with icon/title/badges/avatars/heat pill — **rich React nodes are close to a
hard requirement**, which disqualifies every WebGL option (Sigma, cosmos.gl,
react-force-graph, Reagraph) outright. They draw circles; that would be a downgrade.

And `placeWithFrozen` — freeze settled nodes, slot arrivals into free grid cells — is
genuinely good incremental placement that **no surveyed library ships for layered
graphs**. It should not be thrown away.

The actually weak part is one function: `model.ts:264` does *a single barycenter pass*
for crossing minimisation.

**Recommended: adopt a layout engine only — `@dagrejs/dagre@3.1.1`.** MIT, typed,
synchronous, 16.5 kB gzip, released 2026-08-08. It slots in behind `layoutComponent()`
because dagre lays out one component at a time, which is already the shape of that
function. Union-find, island packing, freezing, render cap, minimap and relevance all
stay. Gains network-simplex ranking and real crossing minimisation. **~1–2 days, one
file.** (Note: legacy `dagre@0.8.5` is dead since 2019 — the `@dagrejs` fork is the live one.)

**If "boring" turns out to mean the interaction model, not the layout:** `@xyflow/react`
(React Flow) 12.11.3, MIT, 50.5 kB, is the only library whose node model natively matches
our React cards, and its accessibility story is the strongest surveyed (WCAG 2.1 AA
target, aria-live announcements, full keyboard model) — which matters because `axe-core`
is already a devDependency. Cost is ~2–3 weeks and it means deleting working viewport
code. Worth it only if we want to stop maintaining that code, not to fix this task.

Two traps found while surveying, worth recording:
- `@cosmograph/cosmos` is **CC-BY-NC-4.0** (non-commercial). The MIT successor is the
  differently-named `@cosmos.gl/graph`. Tutorials predating 2025 point at the NC package.
- `elkjs` is **EPL-2.0 OR GPL-3.0-or-later** and 455 kB gzip with an async API. It has the
  best multi-component packing (`separateConnectedComponents`) and native compound nodes,
  but adopting it means a worker, an async `buildGraphModel`, rewriting `model.test.ts`,
  and a licence review. Only justified if we want its compound-node support for collapsible
  clusters.
- `mermaid` is a declared dependency of `packages/tm8-ui` that is imported nowhere in
  `src/`. Worth pruning separately.

---

## 6. Suggested phasing

| # | change | cost | server change? |
|---|---|---|---|
| 1 | Render `graph.query`'s result instead of `Object.values(entities)` | hours | none |
| 2 | Time scrubber (`1h/24h/7d/all`) as the lens axis; DOI demoted to ranker; live pinned | small | none (top-N) |
| 3 | Hub-stop at `HUB_DEGREE=12`; cluster by hub-excluded connectivity; hubs drawn as shared anchors | medium | none |
| 4 | Layout each cluster separately, pack as islands; extend the accounting law with `outOfWindow` + `hubWithheld` | medium | none |
| 5 | `@dagrejs/dagre` behind `layoutComponent()` | 1–2 days | none |
| 6 | `activitySince` on `CollectionQuery` + `graph.query` for a true threshold window | medium | **yes** — contract op, catalog pins |

Phases 1–5 need **no server change at all**. Phase 6 is the only one that touches the
contract, and it is deliberately last so the UI can prove the window is worth having
before we pay the catalog-pin cost (a catalog change is repo-wide — count pins, digest,
conformance manifest).

---

## 6b. Revision after owner feedback (2026-08-16)

Owner rulings: **navigation means the right panel opens, nothing more** — so hub-stopping is
safe and hubs never need to be traversed. And: *"I need the graph to give me proper visual
data… maybe we can have task-wise graph, session-wise graph."*

Three measurements taken in response, all of which sharpen the design:

### R1. The session-wise graph already ships, and its engine is kind-agnostic

`packages/tm8-ui/src/session-graph/` is **on `origin/main`** and mounted as the 4th chip on
a work session. More importantly, `session-graph/model.ts` and `load.ts` contain **zero kind
literals** — no `work_session`, no `'session'`, no `sessionId`. The engine walks
`entity connections` outward from any focus id.

Only two things are session-specific: the prop name (`sessionId` in `SessionGraphBody`) and
the chip placement (rendered by `WorkSessionContent.tsx:85`). **A task-wise graph is the same
body mounted on a task**, not a new feature.

### R2. A cluster mostly *is* a task's thread — so the two ideas are one idea

Of the clusters produced by 24h + hub-stop>12:

| | 24h (22 clusters) | 7d (100 clusters) |
|---|---|---|
| exactly one task | **12 (55%)** | **74 (74%)** |
| two tasks | 2 | 7 |
| no task at all | 8 | 17 |
| exactly one session | 14 (64%) | 56 |

So a majority of clusters are anchored by exactly one task, and most of the rest by exactly
one session. **The topologically-discovered cluster and the entity-addressed graph are the
same object seen from two directions.** This is one engine with three entry points, not
three features.

It also answers §7 Q3 without a new feature: a cluster's **name is the anchoring task's
title**, derived per render. No entity, no persistence — until the ~8 clusters per day that
have no task make a case for it.

### R3. Hub-stopping is what makes a per-entity graph possible at all

Ego-network size around a task, median over the 169 tasks active in 7d:

| | 1 hop | 2 hops | 3 hops | worst case at 3 hops |
|---|---|---|---|---|
| no hub-stop | 5 | 43 | **356** | **2,310** (≈ the whole space) |
| **hub-stop > 12** | 5 | **8** | **8** | 86 |

Without hub-stopping, "show me this task's graph" reaches 2,310 nodes and reproduces the
hairball at the scale of a single task. With it, the neighbourhood **saturates at ~8 nodes** —
2 hops and 3 hops give the same answer, meaning the work thread is naturally closed.

**One constant (`HUB_DEGREE = 12`) makes the space graph, the task graph and the session
graph all work.** That is the strongest argument for adopting it.

### The design this collapses to

The graph stops being *one space-wide surface* and becomes **one engine with three entry
points**:

1. **Session graph** — ships today on main.
2. **Task graph** — the same body on a task. Small: the engine has no kind literals; needs a
   chip host and a generic prop name.
3. **Space graph** — becomes *"what happened recently"*: time window + hub-stop, which
   produces exactly the per-task and per-session clusters as an overview. Clicking a node
   opens the right panel, which is all the navigation the owner wants.

### What this does to the library question

The owner's words were *"too many entities"*, not *"it looks dated"*. That is a **scoping**
complaint, not a rendering one. So §5's answer narrows further: **buy no renderer.**
`@dagrejs/dagre` stays worth ~2 days as polish once the scoping is right, but it is now
explicitly *not* on the critical path, and `@xyflow/react` is off the table for this task.

---

## 7. Open questions for the owner

1. **Rank or threshold?** Top-N is free today and never empty; a threshold is honest and
   can be empty. Proposal is both — threshold for meaning, top-N as cap. Confirm.
2. **Does the graph replace the workspace as a navigation surface, or stay a read-only
   overview?** If it becomes navigation, hub-stopping is wrong for hubs the user is
   actively steering by, and hubs need to be expandable on click.
3. **Should clusters be nameable/persistable?** They are currently derived per render. If a
   cluster is a "work thread" the user recognises, they may want to pin or name one — that
   is an entity, not a layout artifact, and a much bigger feature.
4. **Is "boring" the layout or the interaction?** This changes the library answer from
   ~2 days (dagre) to ~2–3 weeks (React Flow). §5 assumes layout.

---

## How to re-measure

The distributions above will drift. Node/edge dump (read-only):

```sh
PGURL="postgres://tm8@127.0.0.1:5442/tm8_stable"   # node :7778
SPACE=019fb748-0068-76dc-9869-1bb36133c554
psql "$PGURL" -F$'\t' -Atc "select id, kind, coalesce(activity_at, updated_at, created_at) \
  from entities where space_id='$SPACE' and deleted_at is null" > /tmp/gm_nodes.tsv
psql "$PGURL" -F$'\t' -Atc "select src_id, dst_id, type from edges \
  where space_id='$SPACE'" > /tmp/gm_edges.tsv
```

Then union-find over the induced edge set per window, and per degree threshold. Note that
`edges` has `src_id`/`dst_id`, **not** `source_id`/`target_id`, and entity titles live in
the per-kind tables (`tasks.title`, `work_sessions.title`, `documents.title`), not on
`entities`.
