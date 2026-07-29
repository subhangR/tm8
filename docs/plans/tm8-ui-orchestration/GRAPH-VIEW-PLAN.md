# Graph View — Direction C Phased Plan

Seat: Graph Designer (Fable 5) · 2026-07-28 · Companion to `GRAPH-VIEW-IDEAS.md` (the ideas doc
holds the concepts, grammar, and trade-offs; this doc holds the staging).

> **STATUS 2026-07-29 — P1 PROTOTYPE SHIPPED ON FIXTURES (user-directed re-scope).** The user
> directed this seat to build; the working prototype is in the tree, uncommitted:
> `src/graph/` (model + GraphView + css + 8 model tests), `src/fixtures/graph.ts` (mock edges over
> the EXISTING gate entities + scripted replay timeline), menu row ◉ Graph (SHIPPED_DEFAULT_MENU
> revision 2), center hosting in WorkspaceView (graph owns the empty centre; C1 push takes the
> stack over it, close returns). **Contract widened additively**: `MenuViewRef` += `'graph'`
> (contract.ts + zod enum) — R4-additive, flagged to the master. Three tests that encoded
> "graph is R7-deferred" were updated to the new ruling, with rationale in-file. Suites green:
> tm8-ui 782/782, contract 43/43, `vite build` clean. Custom SVG/HTML canvas — the xyflow+dagre
> dependency decision is deferred to the real build; own layered layout per §2's engine shape.
> Not yet in the prototype: n-hop focus via graph.query (fixture seam), semantic zoom (Q4),
> minimap, saved layouts (Q6).
>
> **Boundary ledger (master ruling 2026-07-29, R17-grade):** `packages/tm8-ui/src/graph/**` is
> this seat's carve-out; everything below is FE-lane, touched ONCE by this seat pre-ruling and
> frozen for FE broker review + ceremony landing with dual attribution — no further edits from
> this seat:
> - `packages/contract/src/contract.ts` (MenuViewRef += 'graph') · `packages/contract/src/schemas.ts` (MenuViewRefSchema enum)
> - `packages/tm8-ui/src/domain/menu.ts` (SHIPPED_DEFAULT_MENU rev 2 + graph row)
> - `packages/tm8-ui/src/shell/menu-resolve.ts` (VIEW_PRESENTATION graph entry)
> - `packages/tm8-ui/src/views/GateApp.tsx` — the ONE view-file touch after the 07-29 rehost: the D65-shaped graph branch (mounts `src/graph/GraphScreen` full-width beside the EntityView branch) + graph fixture imports
> - `packages/tm8-ui/src/views/WorkspaceView.tsx` — **FULLY REVERTED to FE state** in the 07-29 rehost (the user rejected three-column hosting: the graph screen must not show the side lists); zero graph residue, grep-verified
> - `packages/tm8-ui/src/fixtures/graph.ts` (new) · `packages/tm8-ui/src/fixtures/index.ts` (export line)
> - `packages/tm8-ui/src/main.tsx` (graph.css import)
> - `packages/tm8-ui/src/domain/menu.test.ts` + `packages/tm8-ui/src/shell/menu-resolve.test.ts` (graph left the R7-deferred set)

**Decisions recorded so far (user):**
- **Direction C** — one engine, two lenses (Structure / Now), built A-first.
- **Connected components adopted** — islands layout, loose shelf, component-as-focus-scope (ideas §8).
- Open: Q1 attention model · Q2 full-view default lens · Q3 time-scrub vs Now-window · Q4 chips at
  far zoom · Q5 live-edge motion · Q6 hand layouts · Q7 shelf/packing inside the panel-body ◉.

---

## 1. Engine shape (what all phases share)

One pure, framework-free view-model pipeline (the reference `model.ts` proves this style works —
337 lines, fully vitest-able without xyflow):

```
domain store (entities, edges, activityFeed, liveness)   graph.query (hydration / focus / clusters)
        └──────────────┬───────────────────────────────────────┘
                 scope selector        (collection query result | space-wide)
                 lens projection       (Structure | Now — P3)
                 graph analysis        (components/union-find; P2: critical path, SCC, reachability)
                 layout                (dagre per component + island packing; collapse; cap)
                 salience              (heat from activityAt, liveness from snapshot, blocked)
                 render adapter        (xyflow nodes/edges; Z2 EntityCard nodes; C1 wiring)
```

Two hard laws from the ideas doc bind every phase: **settled layout never moves uninvoked**, and
**structure renders as fact / inference renders as labeled suggestion**.

---

## 2. Phase 1 — "The living structure graph" (working and usable)

Goal: open the ◉ layout on any collection (and the full-view shell space-wide) and get a **stable,
honest, live** structure graph you can navigate and act from. Every item below is load-bearing for
"usable"; everything deferrable is deferred.

### In scope

**Engine + layout**
- Revive the proven mechanics: dagre TB free mode with containment clusters (server
  `GraphResult.clusters`), collapse with edge re-aggregation, dependency LR mode with the red
  blocked path, hover-neighborhood dimming. (All exist in reference `model.ts` — port, don't
  reinvent.)
- **Islands**: union-find over the active edge set → per-component layout → packed placement.
  Incremental union on `edge.upsert`; debounced recompute on `edge.deleted`.
- **Loose shelf**: singleton components collect in a labeled tray; a shelf chip promotes onto the
  canvas (with the §2 materialize moment) when it gains its first edge.
- Pan/zoom with keyboard access (T3-6 law); minimap in full view only.

**Data + realtime**
- Hydrate via `graph.query` (scope = the collection's query, or space-wide), then live-apply the
  domain store: `entity.upsert/deleted`, `edge.upsert/deleted` reduce straight into the view model.
- **Stability spine**: arrivals slot in or land in the arrivals gutter; `Re-layout (n new)`
  affordance; zero uninvoked movement.
- Arrival grammar (ideas §2): materialize ring, pill-swap flash, edge draw-in, ghost removal.
  `prefers-reduced-motion` = instant application.
- **Recency heat** (two-step in P1: fresh <2 min / resting — the full decay ramp can wait).
- **Liveness honesty**: pulse dot + live treatment only from the `execution.liveness` snapshot;
  running-without-PTY renders stale (wait + word); `unknown` renders neutral. (R-UI-5.)
- **Minimal ticker**: last 5 `activityFeed` entries, mono strip, click → pan + ring-flash. (The
  store already holds the feed; this is a cheap strip with outsized "what's happening" value.)
- Connection honesty: `polling`/`offline` states render as the standard degraded banner — a frozen
  canvas must say why.

**Nodes, interaction, filters**
- Nodes are registry-rendered **Z2 EntityCards** — core kinds, custom `c:*`, unknown-kind generic.
  No graph-only node visual.
- **C1**: click any node → its Z3 panel on the stack. Click an edge label → connections context.
- Filter chip bar over `GraphQuery` fields: kinds, workStatus/sessionStatus, edge-type set. (Actor,
  project, and time-window chips are P2 — the bar's *shape* ships in P1, the full field set doesn't.)
- Focus mode: center-on-entity n-hop via `graph.query focusId+hops` (server already computes it).

**Scale + placement + polish**
- Cap ladder without semantic zoom (Q4 open): clusters collapse by default above ~120 renderable
  nodes; hard cap with the honest banner ("Showing 150 of 763 — expand a cluster or refine
  filters"); off-view events → ticker counter chip (`+n outside view`).
- Both placements: ◉ in the six-layout switcher (compact chrome) + the showcase full view
  (Structure lens only in P1; the lens *switch control* renders with Now disabled-with-reason —
  the seam stays visible, honestly).
- Light + dark, C8 accessibility pass, empty/overloaded/offline states per ideas §7.

### Explicitly out of P1 (and why)

| Deferred | To | Why |
|---|---|---|
| Now lens projection | P3 | Needs Q1/Q2 rulings; Structure lens is usable alone |
| Critical path, SCC badges, blast radius, transitive reduction | P2 | Insight layer on a working canvas — additive, not load-bearing |
| Semantic zoom (chips at far zoom) | P2 | Q4 is an open ruling; P1's collapse+cap ladder is honest without it |
| Marching-dash live edges | Q5 gate | Pulse dot is P1's entire liveness vocabulary until ruled |
| Hand layouts / saved layouts | Q6 gate | Arrivals-into-hand-layouts needs its own design |
| Time-window slider / replay | P2–P3 (Q3) | Now lens is the natural host |
| Actor bipartite projection, community detection, betweenness | Later | Tier-3 inference (ideas §8) |

### P1 acceptance ("working and usable" made falsifiable)

1. Open ◉ on a 30-entity collection → laid-out graph in well under a second; open full view on a
   500+ space → collapsed clusters + honest cap banner, never a frozen canvas.
2. An agent starting work appears as a `working_on` edge draw-in within one event roundtrip — no
   refresh concept anywhere.
3. Nothing already placed moves without the user invoking re-layout (watch it under a 20-event
   burst).
4. Every node C1-clicks to its Z3 panel; keyboard pan/zoom works; both themes pass; reduced-motion
   honored.
5. Kill the WS → the canvas banners `polling`; kill the server → `offline`. A live pulse is never
   shown without a fresh liveness snapshot.
6. The shelf holds the unconnected; islands don't perturb each other on arrivals.

## 3. Phase 2 — the insight pass

Critical path highlight (dependency mode) · blast-radius cone on blocked-node select · SCC cycle
badges · transitive reduction with "n implied edges hidden" · full filter field set (actor,
project, time window) · full heat decay ramp · ticker maturation (grouping, outside-view counter
polish) · semantic zoom **if Q4 rules yes** · saved filter views. Each item is additive on P1's
canvas; none reshapes the engine.

## 4. Phase 3 — the Now lens

Temporal hot-subgraph projection (the lens switch goes live) · "what is this agent doing" focus
from any session card app-wide · time-window slider on the Now lens (the likely Q3 answer) ·
follow-cam **if Q1 rules yes** · later: actor bipartite collaboration/collision view. P3 is where
Direction C's second half lands — on an engine P1 already proved.

## 5. Sizing (tree-grounded, 2026-07-28)

Anchors: the proven reference graph is **~1,000 lines** (model 337 · canvas 374 · nodes+composer
142 · css 171), all portable; repo calibration point: `EntityListPanel.tsx` is 1,204 lines.

P1 ≈ ported engine (~1,000, mostly port) + islands 150–250 + live application layer 200–300 +
arrival grammar/heat/liveness 150–250 + ticker 100–150 + filter bar 150–250 + cap/banners/states
100–150 + full-view shell/switcher 150–250 → **~2,000–2,600 product lines, ~4–5k all-in with
tests** (the pure view-model style keeps the logic vitest-able). Effort ≈ 2–3× EntityListPanel:
one focused wave, 2–3 workers for a few days. P2 ≈ 500–800 (pure model functions). P3 ≈ ~1k.

**Costs the line count hides:**
1. **Z2 EntityCard does not exist yet** (`src/kit/` has Chip/Pill/Avatar; `Chip.tsx` references the
   Z2 preview as future). T3-6 makes it the node visual, and it's a shared component other views
   want — a cross-seat dependency for the master to assign deliberately (~250–400 lines,
   kind-registry rendered).
2. **New deps**: `@xyflow/react` + `dagre` are not in `packages/tm8-ui` (currently react + zustand
   only) — a deliberate dependency addition.
3. **Server ready**: the graph facade module is among the mounted W2 modules — `graph.query` exists;
   no P1 server work.

## 6. Risks the plan is honest about

- **xyflow + live burst churn**: P1 must throttle view-model emission (animation-frame batching)
  or a chatty space will thrash the canvas. The store's seq spine makes batching safe.
- **graph.query scope drift**: hydration snapshot vs. live stream can diverge on filtered scopes
  (an entity edited *into* scope arrives as an upsert the hydration never saw — must upsert
  cleanly, and does, since reducers are upsert-shaped; the inverse — edited out of scope — needs a
  scope re-check on upsert).
- **Two placements, one engine** is a discipline, not a given: the panel-body ◉ must stay a chrome
  reduction (Q7 decides how much of shelf/packing it keeps).
