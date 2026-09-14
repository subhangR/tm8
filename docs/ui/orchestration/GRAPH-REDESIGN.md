# Graph UX Redesign — measured proposal

Seat: CLI & Prompt Ergonomics Planner · 2026-09-14 · task `01a0a1c3-e8c2-786b-a7c2-d4d81443fecd`
Visual: tm8 artifact **`01a0a1cc-d16b-75da-9008-c6fa87dda9ea`** — “The Graph, Redrawn”
(now/next side by side, on the real 150-node read).

> **STATUS: PROPOSAL. Nothing in `packages/` was modified.** This doc plus the artifact are
> the approval gate. No PR until Tarkesh answers §6.

Companion to `GRAPH-VIEW-PLAN.md` (the staging) and `GRAPH-VIEW-IDEAS.md` (the concepts).
This doc is neither — it is a **measurement of what shipped**, and five changes that follow
from it. Every claim below cites a file:line that was opened, or a number that was computed.

---

## 1 · How this was measured

One read, the same shape the app issues:

```
tm8 graph query --space 019fbd5a-3c5b-71ea-9b91-1d3baa50da25 --limit 150
```

`limit: 150` is `GRAPH_NODE_LIMIT` (`views/useGateData.ts:232`), sent at
`useGateData.ts:1127-1131`. The result — **150 nodes, 277 edges** — was then fed to the
product's own `buildGraphModel` (`graph/model.ts`) with the same arguments `GraphView`
passes, and the geometry read off the returned `GraphModel`. Type sizes are arithmetic on
the fit scale that geometry implies, not pixel measurements of a browser.

**Limits of the measurement, stated up front:**

- **No screenshot of the running UI.** The layout is the product's; the *rendering* in the
  artifact is a faithful reconstruction against the real stylesheet. A pixel capture is
  worth doing before anything ships.
- **The `Live` lens measuring 0 nodes is an artifact of the harness, not proof of a
  defect.** `livenessOf` reads the seam's snapshot verdict (R-UI-5); the CLI cannot produce
  one, so an empty `liveIds` set was passed. In a browser Live seeds on genuinely running
  sessions. Treat that cell as *unmeasured*.
- **One space, one instant.** But the message dominance below is **structural, not
  incidental** — every message writes exactly two edges by construction — so any space
  carrying conversation converges to the same shape.

---

## 2 · What the canvas actually draws

Viewport 1512 × 806. “Opens at” is `fit()`'s solved scale (`GraphView.tsx:396-405`),
clamped only at `ZOOM_MIN = 0.35` (`GraphView.tsx:83`).

| Lens | Cards | Excluded | Islands | Canvas | Opens at | 15px title paints at |
|---|---:|---:|---:|---|---:|---:|
| Live | 0 | 133 | 0 | — | — | — |
| **Active work** (default) | **9** | 124 | 4 | 1312 × 972 | 0.83 | 12.4px |
| Everything | 125 | 0 | **115** | 1932 × **5812** | **0.35** | **5.3px** |

Composition of the 150-node read:

| | count | share |
|---|---:|---:|
| `message` nodes | **112** | 75% |
| `anchored_to` + `authored_from` edges | **224** | 81% |
| task + work_session + project nodes | 10 | 7% |
| distinct titles among the 38 non-message nodes | **21** | — |
| nodes with degree 1 (the only ones `foldLeaves` can collapse) | 5 | 3% |
| message nodes with degree ≠ 2 | **0** | — |

**All 112 messages resolve to two anchors** — 93 on “Floating AI Website”, 19 on “Build a
ppt artifact for CXO presentation”. The canvas spends 90% of its cards and 5,812px of
height drawing two conversations one bubble at a time.

**Counterfactual, same payload, message cards removed:**

| | now | messages rolled up |
|---|---:|---:|
| cards placed | 125 | **13** |
| islands | 115 | **1** |
| canvas | 1932 × 5812 | **588 × 1560** |
| fit scale | 0.35 | 0.52 |

---

## 3 · Five changes, ordered by leverage

### 3.1 Conversation is a volume, not a hundred nodes — **NEW, model layer**

**Defect.** Folding requires degree exactly 1 (`relevance.ts:430`). A message always has
two edges (`anchored_to`, `authored_from`), so folding can never reach one. Measured: 17
folds, none of them a message.

**Change.** Before layout, `buildGraphModel` rolls message nodes onto their
`state.anchorId`. The anchor card gains a **conversation meter** — count, voices, recency.
Clicking it opens the thread in the aside, which is already where a thread is read.
The meter obeys the same accounting law as the fold badge: it *states what it moved*.

**Not a regression of `docs/features/graph/03-FIX-MESSAGES-INVISIBLE.md`.** The message
stays a node, stays traversable, stays counted. It stops being a 240 × 124 card.

**Where.** `graph/model.ts` (a pre-layout pass beside `foldLeaves`), `graph/relevance.ts`
(exempt rolled-up messages from the DOI budget so the budget buys work), `GraphView.tsx`
+ `graph.css` (the meter). No server change — `anchored_to` already carries it.

**Open:** Q1 in §6 — does a *searched* or *selected* message still earn a card?

### 3.2 A fit that owes the reader legibility — **PORT from 2.0**

**Defect.** `fit()` solves `min(w/W, h/H, 1)` clamped at `ZOOM_MIN`
(`GraphView.tsx:396-405`). On this space the height term wins, the graph opens at the floor,
and a 15px title paints at 5.3px, an 11px footer at 3.9px.

**Change.** Split the two callers:

- the canvas choosing a zoom *for* the reader owes legibility → `fitAt(FIT_FLOOR)` on the
  first, uninvoked fit;
- a reader pressing ⤢ or `0` has asked to see everything → `fitAt(ZOOM_MIN)`, unchanged.

Below the floor, `data-lod="far"` on `.gv-canvas` puts cards into **semantic zoom**: shed
`__head`/`__body`/`__foot`/`__focus`, keep the family stripe, the title at `--pn-fs-h3` with
a 3-line clamp, and a liveness mark (filled pulsing dot for live, *hollow* ring for stale,
so the distinction does not depend on resolving a hue at that size). Hidden words move into
the card's `title` attribute — colour + word-in-title, exactly how `Minimap` already
resolves the same tension for a 4px rect.

`FIT_FLOOR = 0.72` is **derived, not chosen**: the shortest text-bearing row on a card is
`__foot` at 16.5px, and 16.5 × 0.72 = 11.9px of box carrying 10px type.
`LOD_FAR_BELOW = 0.62`, and `LOD_FAR_BELOW < FIT_FLOOR` is the invariant — assert it as a
unit test: *the view the reader is given is never in far mode.*

**Prior art, and its current state.** This was derived and measured in `GRAPH.md`. The CSS
still stands at `tm8_ui_2.0/src/graph/graph.css:1341-1391`. The constants do **not** exist
in that package's `GraphView.tsx` any more, while `tm8_ui_2.0/src/graph/godseye.test.tsx:26`
still imports `FIT_FLOOR` and `LOD_FAR_BELOW` from it — so that suite cannot resolve its own
import today. **Recover the work from `GRAPH.md` and the CSS, not from a running build**, and
fix or retire `godseye.test.tsx` as part of the port. The bundles swapped roles on
2026-09-03 (`server/src/http/static.ts:32-35`); this is what rode the swap.

Note this closes **GRAPH-VIEW-PLAN Q4** (semantic zoom), which that plan left open and
deferred to P2.

**Size.** ~60 lines in `GraphView.tsx`, one CSS block, one unit test.

### 3.3 Group by the question you are asking — **PORT from 2.0**

**Defect.** The only partition is connected components, and it produces **115 islands for
125 nodes**. A partition where nearly every member is its own group informs nobody.

**Change.** One control beside the lens: group by Status, Assignee, Signal, Project,
Recency, Kind, or None. Groups render as **bands** across the canvas with edges still drawn
between them. Every grouper is **total** — a node the signal cannot speak about lands in a
named residual band (“No assignee”, “Not a task”), never silently dropped, because a card
missing from the canvas is indistinguishable from a card that was never loaded.

**Prior art.** `packages/tm8_ui_2.0/src/graph/grouping.ts` — ten groupers, pure functions of
one entity plus a resolved context, §15.2-clean (a kind-grouper returns `kindRef` and lets
the caller resolve presentation through the registry). Tests at
`GraphView.grouping.test.tsx`. `packages/tm8-ui/src/graph/` has no equivalent file.

**Size.** Port a pure module + one toolbar control + band placement in the island packer
(`model.ts` `layoutComponent` / packing loop at `model.ts:760-790`).

**Open:** Q2 in §6 — does grouping replace islands as the default, or sit beside them?

### 3.4 A card that says *which* one it is — **NEW, presentation (except commit)**

**Defect.** The card leads with `title`, and `title` frequently does not identify the node:

- 11 commit cards whose title is the literal string `"commit"`;
- a task and three of its sessions all reading “Floating AI Website”, because a
  `work_session` is titled after its task;
- 21 distinct titles across 38 non-message nodes.

**Change.** Two lines instead of one.

- **Identity line** (title weight) — what makes *this* node this node. Session → teammate
  `state.teammate.displayName`; commit → sha + subject; task → its own title.
- **Relation line** (secondary) — the edge this card is standing in, in words:
  “working on · redesign the graph UX”.

Footer carries `state.checkoutBranch`, `state.model`, recency, hub/fold badges.

**Everything needed is already on the wire** — a session node ships
`state.teammate.displayName`, `state.model`, `state.agentTool`, `state.checkoutBranch`,
`state.status`. The card spends none of them today.

**One exception, and it is a real blocker.** A commit node arrives with `title: "commit"`
and `state.fields: {}`. **The sha and subject are not on the wire at all**, so the UI cannot
fix commit alone. Either ship the honest version (who / when / where it landed, and name
the gap) or hold this change until the contract carries the fields. See Q3 in §6.

### 3.5 A “what's happening” that has ever happened — **DELETE or WIRE**

**Defect.** `gv-ticker` (`role="log"`, aria-label “Recent graph events”, `GraphView.tsx:1158`)
is fed only by `GraphViewProps.timeline`. The single place the product mounts `GraphScreen`
— `views/GateApp.tsx:2101-2119` — does not pass it. Only a scripted fixture ever has. In
production it has rendered zero rows since it shipped, and it promises a screen reader a live
region that never speaks.

**Change.** Feed it from the seq spine that already drives the canvas, or delete it. Keeping
a dead `role="log"` is worse than either.

**Precedent.** 2.0 replaced it with `tm8_ui_2.0/src/graph/Building.tsx`, fed by `activityAt`
plus the liveness verdict — data the seam already delivers on every drawn node, so it says
something true in the real app.

---

## 4 · What does not change

The laws this canvas was built on are why it is worth repairing rather than replacing:

- **Status is colour + word**, never colour alone.
- **Liveness is the seam's snapshot verdict** (R-UI-5), never inferred from recency. Heat
  stays `activityAt`. These remain two different facts with two different sources.
- **The settled layout never moves uninvoked.** Grouping bands are a re-layout the reader
  *asks for*; arrivals still slot in place behind `⟳ re-layout (n new)`.
- **No kind literals** (§15.2) — presentation resolves through the domain registry.
- **Nothing is hidden silently.** The fold badge, the shelf and the exclusion banner each
  keep accounting for what they moved. The conversation meter is one more of those, not an
  exception to them.

One honest correction belongs here too: the `atCeiling` banner advises “narrow the window”,
but `outOfWindow` measured **0** at both 24h and all-time on this space, so that remedy is a
no-op here. Once 3.1 lands the ceiling stops binding for a space this size; the banner's
copy should be revisited then, not before.

---

## 5 · Sequence and cost

| # | Change | Where | Kind |
|---|---|---|---|
| 1 | Conversation roll-up | `graph/model.ts`, `relevance.ts`, css | NEW · pure model |
| 2 | Fit floor + semantic zoom | `GraphView.tsx`, `graph.css` | PORT from 2.0 |
| 3 | Grouping bands | new `graph/grouping.ts` + toolbar + packer | PORT from 2.0 |
| 4 | Card identity + relation lines | `GraphView.tsx`, `graph.css` | NEW · presentation |
| 5 | Commit title (sha + subject) | contract + server | **SERVER** · blocks 4 |
| 6 | Ticker: feed or remove | `GraphView.tsx` / `GateApp.tsx` | EITHER |

1 and 2 are the entire visible difference. 3 and 4 are what make it hold. Do not start 5
inside this lane — it crosses into contract/server and wants its own ruling.

**Blast radius note.** None of 1–4, 6 adds a catalog operation, so none of them moves the
hardcoded count pins, `CATALOG_DIGEST`, or the conformance manifest. 5 does.

---

## 6 · Three decisions needed before any PR

**Q1 — Does a message ever earn a card of its own?**
Proposal: no by default; yes when *pinned* by search or selection, matching how the canvas
already protects live and selected nodes from truncation. Confirm, or rule that messages are
never cards.

**Q2 — Does grouping replace islands, or sit beside them?**
2.0 ships “No grouping” as a real option, keeping islands the default. I think bands should
be the **default** on a work canvas and islands the opt-in — 115 islands for 125 nodes is not
a default worth defending. That is larger than a port, so it is your call.

**Q3 — Is the commit title worth a server change now?**
Eleven identical cards is the ugliest single thing on the canvas and the UI cannot fix it.
Either ship 3.4's honest version immediately and open the contract change separately, or hold
3.4 until sha and subject are on the wire.

---

## 7 · Reproducing the measurements

The three scripts used are throwaway and were not committed. To redo them: read the space
with `tm8 graph query --space <id> --limit 150 --format json`, then import
`packages/tm8-ui/src/graph/model.ts` directly under `bun` (it imports only types from
`@tm8/contract` and `./relevance`, so it runs standalone) and call `buildGraphModel` with
`lens`, `windowMs: windowSpec(id).ms`, empty `liveIds`/`matchIds`/`pinnedIds`, `fold: true`.
Read `width`, `height`, `placed.length`, `componentCount`, `foldedCount`, `outOfLens` off the
result; the fit scale is `min(1.75, max(0.35, min(w/width, h/height, 1)))`.
