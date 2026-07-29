# Graph View — Initial Ideas (Phase One)

Seat: Graph Designer (Fable 5). Status: **living discussion doc** — Direction C decided (§4), graph
algorithms adopted (§8); staging lives in the companion plan `GRAPH-VIEW-PLAN.md`.
Inputs read: `contract.ts` (EntitySummary / EdgeView / GraphQuery / GraphResult), `schemas.ts` WorkspaceEvent union, `src/data/LLD.md` + the built domain store (`project/reducers.ts`, `domain-store.ts`), ATELIER design language (`03-DESIGN-LANGUAGE.md`), the T3-6 standing requirements, and the working xyflow+dagre reference (`collection-layouts/graph/model.ts` — 337 lines of proven pure layout logic).

---

## 1. What we're standing on (and what that means for the design)

The realtime pipeline **already exists and is integration-proven**. The domain store holds
`entities: Record<EntityId, EntitySummary>` and `edges: Record<string, EdgeView>` plus
`edgeIdsByEntity`, all reduced live from the seq-spine event stream. `activityFeed` holds recent
`ActivityItem`s (entityId, verb, actor, createdAt). The seam guarantees ordered, deduped events and
honest connection states (`live / polling / offline`), and `execution.liveness` gives the honest
session-liveness snapshot (`live / stale / not-running / unknown`).

**Design consequence:** the graph view is a *live projection of a store that is already moving*.
There is no "refresh" concept to design around. The design questions are entirely about salience,
stability, and scale:

1. **Salience** — of everything moving, what deserves the eye?
2. **Stability** — a chart that rearranges itself under you is unusable; a chart that never changes is dishonest.
3. **Scale** — 500+ nodes of Z2 cards (260×150) is ~19M px² of card. Something has to give, honestly.

Every direction below shares one spine: **the settled layout never moves on its own.** Arrivals slot
in; nothing already placed is re-laid-out without the user asking. This is the graph equivalent of
"no bounce" — a calm instrument.

---

## 2. The realtime visual grammar (shared vocabulary, all directions)

What an event *looks like* when it arrives. All motion: ease-out `cubic-bezier(.16,1,.3,1)`,
120–280ms, honors `prefers-reduced-motion` (reduced = state changes apply instantly, no travel).

| Event | Visual |
|---|---|
| `entity.upsert` (new node in scope) | Card materializes at its slot (fade + 4px rise, 180ms) with a **brass hairline ring** that decays over ~2s. If the layout has no good slot, it lands in a "new arrivals" gutter and a `Re-layout (3 new)` affordance appears — layout changes are always user-invoked. |
| `entity.upsert` (state change) | The status pill swaps in place (color + word, standard pill transition) with a one-shot 280ms underline flash in the status color. The card never moves. |
| `edge.upsert` | The edge **draws itself** source→target (line-draw, 280ms), label fades in. A new `working_on` edge is the marquee moment: agent thread connects to task. |
| `edge.deleted` / `entity.deleted` | Fade to ghost (ink-4, dashed) over 280ms, then gone. No dramatic exits. |
| `activity.created` | Feeds **recency heat** (below) + one line in the event ticker. The node itself gets a subtle activity tick, not a jolt. |
| `counter.changed` | Footer counters tick in place. No fanfare — counters are ambient. |

**Recency heat — "ink freshness."** ATELIER is paper-and-ink, so recency is how *fresh the ink is*:
a node active in the last ~2 min renders full-ink border + title; decay steps down through ink-2/ink-3
border tints toward the resting hairline over ~30 min. Status words and pills **never** fade
(status = color + word is law; heat is an additional channel, never the only one). Heat derives from
`activityAt` — a real field, honestly held.

**Liveness — the only pulse.** The established live-pulse dot appears on a work_session node (and on
its `working_on` edges as a slow marching-dash) **only** when the liveness snapshot says `live`
(R-UI-5). `recordedStatus: running` without a live PTY renders **stale** — wait color + the word
"stale", static. `unknown` renders neutral. The graph never fakes a heartbeat.

**Salience hierarchy** (what draws the eye, strongest first):

1. **Live work** — pulse dots + marching-dash `working_on` threads (the only sustained animation on the canvas)
2. **Blocked / NEEDS-YOU** — block color + word + badge; in dependency mode, the red path
3. **Fresh ink** — recency heat
4. **Structure** — calm paper, hairlines, containment

**The event ticker.** A one-line mono strip (t-mono, micro) docked at the canvas edge: the last few
events as terse entries — `◉ scout-2 → working_on → T-041 · 2s`. Each entry is a C1 target: click
pans to the node and flashes its ring. This is the "what just happened" narration — the canvas
shows *state*, the ticker shows *events*, and neither has to do the other's job. Events touching
filtered-out or capped-out nodes increment a counter chip on the ticker (`+12 outside view`) instead
of causing render churn — realtime honesty at scale.

---

## 3. Concept directions

### Direction A — "Steady chart, living ink" (structure-first)

The T3-6 graph as speced — layered dagre layout, hierarchy as collapsible dashed containment
clusters, typed labeled edges, dependency LR mode with the red blocked path, hover-neighborhood
dimming (all proven in the reference `model.ts`) — with the §2 grammar applied as a **restrained
overlay**. The map is stable; live-ness reads as pulse dots, fresh ink, self-drawing edges, and the
ticker. You glance at it and the warm spots are where the action is.

- **For:** most ATELIER-native ("a calm instrument, not a dashboard"); maximally reuses proven layout code and the speced T3-6 design; layout stability for free; serves "unified view of all entities + relations" directly.
- **Against:** the "what's happening NOW" story is ambient rather than foregrounded — a busy 20-agent space reads as many warm patches, and the eye has to hunt. The answer to "what is everyone doing right now" is *derivable* but not *composed* for you.

### Direction B — "Activity field" (now-first)

Invert the emphasis. The default projection centers **actors**: live work_sessions and team_members
are anchors; the entities they touch hang off them via `working_on` / `attached_to` / `shared_into`
threads. Structure (hierarchy, the wider entity sea) is collapsed to cluster chips at the periphery
and expanded on demand. Entities with no recent activity shrink Z2→Z1 chip and eventually retire
from the field (visibly, with a count — never silently). It's mission control: what's alive is
what's rendered.

- **For:** the strongest direct answer to "a nice view of what's happening, where, and what"; naturally scale-honest (the live working set is small even when the space is huge); great ambient wall-display mode.
- **Against:** it is *not* "the view of all entities and their relations" — the stated core vision; anchoring on actors makes layout inherently less stable (sessions come and go, so the field's anchors churn); retire-on-idle motion fights the calm-instrument ethos; a second, different projection to design and maintain.

### Direction C — "One engine, two lenses" (A's engine, B as a projection)

Build Direction A as the engine and single node/edge/filter system, and add a first-class **lens
switch**: **Structure** (default: layered + containment, the full map) and **Now** (the same nodes
re-projected actor-centrically à la B, restricted to the live working set + n-hop context). Same Z2
cards, same C1, same filters, same ticker — the lens is a pure re-projection, like the existing
free/dependency mode switch, just one level up. Lens choice can default by scope: collection-scoped
◉ opens in Structure; the space-wide full view could open in Now.

- **For:** honest about the real insight that *structure* and *activity* are different questions with different natural layouts; both get a first-class answer without one compromising the other; engine cost is shared; maps cleanly onto the two placements (§6).
- **Against:** two projections to design, test, and keep coherent; risk that "Now" quietly becomes a whole second view wearing a trench coat; more surface for v1.

*(A fourth candidate — a time-scrub/replay direction — didn't earn a slot as a direction: replay is a
feature any direction could host, and the store's `activityFeed` retention is bounded. It appears as
open question Q3 instead.)*

---

## 4. Recommendation

> **DECIDED (user, 2026-07-28): Direction C.** Built A-first as recommended below. §8 (graph
> algorithms) extends C's engine.

**Direction C, built as A-first.** Ship the Structure lens (the T3-6 design revived, §2 grammar
applied) as the collection-scoped ◉ layout and the full view's first lens; design the Now lens as
the second lens with the full view as its home. Rationale: A alone under-delivers the user's
explicit realtime emphasis ("a nice view of what's happening, where, and what" is B's home turf);
B alone abandons the equally explicit "all entities and their relations, unified." C pays a real
cost (two projections) but it's the only direction that doesn't quietly drop half the vision — and
the staging (A's engine first) means the cost is deferred, not compounded.

---

## 5. Genericity — kinds, edges, filters as data

- **Nodes are registry-rendered Z2 cards, period** (T3-6 law: reuse EntityCard anatomy, don't invent a node visual). Core kinds get their kind-specific summary fields; custom `c:*` kinds render their schema-declared scalars; an unknown kind gets the generic card. The graph adds zero node design — it adds *placement, heat, and connection*.
- **Edges are typed data with a styling table, not bespoke art.** Default rendering: hairline + direction arrow + humanized label (the reference `edgeLabel()` logic: `working_on` → "working on"). A small registry maps known types to semantic treatments — `depends_on` hard/soft + the blocked red path, `working_on` live marching-dash, `tracks` toward PR/commit, `shared_into` handoff provenance. Unregistered types (including `x:*`) get the default and are none the worse.
- **Filters are literally `GraphQuery`/`CollectionQuery` fields** — kinds, workStatus/sessionStatus, actor, project, edge-type set, time window (activityAt since) — rendered as a chip bar. The filter bar is a query editor, so a filtered graph is shareable/saveable as data and reproducible by the server. Filtering by *edge type* doubles as declutter (e.g., hide `relates_to` noise, keep the dependency + work skeleton).

## 6. Where it lives — one engine, two scopes

| | ◉ in the six-layout switcher | Showcase full view |
|---|---|---|
| Scope | the collection's query result | space-wide |
| Default lens | Structure | Now *(open question Q2)* |
| Default disclosure | expanded (collections are small) | clusters collapsed, live set expanded |
| Chrome | compact toolbar, no minimap | full toolbar, minimap, ticker, lens switch |

Same engine, same grammar; the panel-body variant is a chrome reduction, not a different graph.
Focus modes are shared everywhere: center-on-entity n-hop (`focusId` + `hops` — the server already
computes this), dependency-only, and **"what is this agent doing"** (focus a team_member/work_session,
its threads + 1-hop context) — that last one is C1-reachable from any session card anywhere in the
app, which makes the graph the answer surface for the app's most realtime question.

## 7. Scale honesty — the 500+ stance

A progressive-disclosure ladder, each rung honest and labeled:

1. **Semantic zoom.** Z2 card at working zoom; below a threshold, nodes render as **Z1 chips** (kind glyph + name + state tint — an established component); clusters render as labeled containment boxes with counts. Zoom or hover promotes chip → card. *(Bends "Z2 cards as nodes" at far zoom — needs the user's ruling, Q4.)*
2. **Server clusters collapsed by default at scale.** Above ~120 renderable nodes, `GraphResult.clusters` render collapsed (parent card + `⊞ 47`); expansion is per-cluster, user-invoked. The reference model already does collapse + edge re-aggregation (deduped, marked aggregated).
3. **The hard cap is a banner, never a freeze.** Beyond the render budget: `Showing 150 of 763 — expand a cluster or refine filters.` Filters and focus modes are the escape hatch, offered in the banner itself. The canvas never silently truncates and never locks the main thread.
4. **Realtime under cap:** events for unrendered entities go to the ticker counter (`+12 outside view`), not the canvas.
5. **Empty state teaches:** "Nothing matches these filters" vs. genuinely empty space — "The graph draws itself as work happens" (and with the fixture-proven connection states, an `offline` canvas says so instead of pretending stillness is calm).

## 8. Graph algorithms & techniques (added after user discussion, 2026-07-28)

Filter: insight per pixel — every entry maps to a question a user actually asks. Governing rule:
**structure algorithms compute facts and render as facts; inference algorithms compute suggestions
and must dress as suggestions** (visually labeled as inferred, never silently replacing real
structure). This is the honesty law applied to computation.

### Connected components / disjoint sets (user-raised — adopted)

1. **Islands layout** — layout runs *per component*, then components are packed (largest anchored,
   smaller flowing around). Kills the disconnected-input hairball, and hardens the stability spine:
   one island's arrivals never perturb another island's layout.
2. **The loose shelf** — singleton components don't scatter on canvas; they collect in a labeled
   tray ("14 unconnected"). Chips in the tray are C1 targets and promote onto the canvas when they
   gain an edge (a §2 materialize moment).
3. **Component as focus scope** — "only the island containing X": focus mode generalized, cheaper
   cognitively than n-hop.

**Subtlety:** components are **per-lens/per-filter**, not global — the dependency subgraph
partitions differently than the full edge set, so union-find runs over the active edge-type set.
Realtime cost: `edge.upsert` unions incrementally; `edge.deleted` breaks incrementality → full
recompute, debounced (sub-millisecond at our scale — honest and cheap beats clever and stale).

### Tier 1 — facts that answer standing questions (v1)

- **Critical path** — longest unresolved chain in the `depends_on` DAG, highlighted in dependency
  mode ("what actually gates delivery"). Upgrades the existing red blocked-path treatment.
- **Blast radius** — select a blocked task → shade its transitive downstream cone: "if this stays
  stuck, all *this* is stuck." Plain BFS.
- **Cycle detection (SCC)** — a `depends_on` cycle is a pathology (mutual permanent block). The
  graph finds it and says so: block-colored badge, "3 tasks depend on each other." Never render a
  cycle as if it were a healthy chain.
- **Temporal hot subgraph** — nodes+edges with activity inside the time window, rest collapsed.
  This is the formal definition of the **Now lens** — a temporal filter over one engine, which is
  what keeps C's second lens a projection rather than a second view.

### Tier 2 — cheap and useful (v1 if free-ish)

- **Degree centrality as tie-breaker** — which entity *names* a collapsed cluster / stays labeled
  at far zoom: the most-connected member, not arbitrary parent order. Incremental, trivial.
- **Transitive reduction (dependency mode only)** — hide `A→C` when `A→B→C` exists; toolbar states
  "2 implied edges hidden." Cleaner skeleton, semantics intact.

### Tier 3 — inference, later, labeled as such

- **Bipartite actor projection** — actor–entity graph projected onto actors: agents link when their
  work touches the same entities → a collaboration/collision view ("scout-2 and builder-1 are
  converging"). Genuinely novel for multi-agent awareness; belongs in the Now lens's future.
- **Community detection (Louvain / label propagation)** — emergent grouping from edge density.
  Parked: hierarchy already gives semantically-true clusters; inferred communities may only ever
  appear as labeled suggestions.
- **Betweenness centrality** — broker/bottleneck entities. Computationally fine at ≤1k nodes
  (Brandes); waiting on a concrete UI story before it earns pixels.

### Deliberately out

PageRank-style importance (no user question it answers here) · edge bundling (reads as false
grouping — anti-ATELIER ambiguity) · MST skeletons (transitive reduction covers declutter with
semantics intact) · force-directed layout (motion law; §3-B trade-offs).

## 9. Open questions for the user (each changes the design)

- **Q1 — Attention model.** When something important happens off-screen (agent starts, task blocks), may the canvas ever act on its own — auto-pan, or an opt-in "follow live" camera — or is attention strictly user-initiated (ticker + affordances only)? This decides whether we design a follow-cam and what "important enough" means.
- **Q2 — The full view's default lens.** Space-wide showcase: does it open in **Structure** (the whole map, activity as heat) or **Now** (live working set, structure on demand)? This is really "what is the graph view *for* when you open it cold" — and it sequences which lens gets designed first.
- **Q3 — Time.** Is replay/scrubbing of recent activity (last ~30 min, from the bounded `activityFeed`) worth v1 surface, or does live heat + the clickable ticker cover the "what happened while I was away" need? (Deep history would need a server read we don't currently have — that's a Phase-2 conversation with the master, not a store tweak.)
- **Q4 — Semantic zoom vs. literal Z2-only.** T3-6 says Z2 cards as nodes. At 500+, literal Z2-only forces aggressive caps/collapse. Is chip-at-far-zoom an acceptable bend (cards remain the identity at working zoom), or is the card mandate absolute and we cap harder instead?
- **Q5 — Motion budget for live edges.** Is the slow marching-dash on live `working_on` edges inside the calm-instrument ethos, or is the pulse dot on the session card the entire liveness vocabulary? (One sustained animation vs. zero — this sets the canvas's whole temperature.)
- **Q6 — Hand layouts.** The old graph supported saved hand-arranged layouts per saved view. In scope for v1? If yes: where do realtime arrivals land in a hand-made layout (arrivals gutter + manual placement?) — auto-placing into someone's arrangement is its own kind of dishonesty.
