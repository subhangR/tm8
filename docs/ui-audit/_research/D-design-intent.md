# D — Design-Intent Baseline and the Undesigned Surfaces

**Lane:** tm8 UI gap audit, worker D. **Read-only.** No code changed, no git run.
**Date:** 2026-07-25
**Question this answers:** what has the design corpus actually *specified*, versus what has
never been designed at all and must be designed from scratch.

## Sources read (every claim below cites one)

In `/Users/subhang/Desktop/Projects/tm8`:

- `STATE.md` (delivery stamp, amendments AM-1…AM-6, drift ledger, backlog)
- `docs/COLLAB_V2_UI_DATA_CONTRACT.md` — DTOs, route matrix, command matrix, events
- `docs/COLLAB_V2_ENTITY_GRAPH_DESIGN.md` — domain semantics (Supabase-era)
- `docs/COLLAB_V2_GAPS_AND_EXTENSIONS.md` — Parts A/B/C/D backlog
- `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md`, `02-ORCHESTRATION-PLAN.md`
- `docs/collab-v2-api-design/00..05`
- `docs/tm8-architecture/00-VISION`, `01-LAWS`, `02-NODE-AND-GATEWAY`,
  `03-ENTITY-GRAPH-DELTAS`, `04-EXECUTION-TRANSPLANT`, `05-DECISIONS`,
  `06-SEQUENCING-AND-REVIEW`, `07-ARCHITECTURE-REVIEW`, `09-IMPLEMENTATION-PLAN`,
  `10-SECURITY-MODEL`
- `docs/ops/CONFIG.md`
- `packages/ui/README.md`, `packages/ui/TRANSPLANT.md`
- `packages/contract/src/contract.ts`, `packages/contract/src/catalog.ts`
- code confirmation of `packages/server/src/identity/`, `packages/server/src/http/`,
  `packages/ui/src/real/`, `packages/ui/src/collab-v2/screens/`

## ⚠ Finding 0 — the master UI spec is NOT in this repo

**`COLLAB_V2_UI_UX_BRIEF.md` is not vendored into tm8.** It is the logical UI spec: the
design principles, the Entity Component Contract, the five universal subsystems, the
navigation architecture, the drag/drop grammar, the **view catalog (§9)**, the **five
golden workflows (§10)**, and the state inventory (§11). Everything in Part 1 below
traces to it.

It is referenced as normative in four places — `00-VISION.md:51`,
`06-SEQUENCING-AND-REVIEW.md:68`, `07-ARCHITECTURE-REVIEW.md:6`,
`collab-v2-ui-plan/02-ORCHESTRATION-PLAN.md:69` — all of which point at
`branch feat/collab-v2-supabase-backend` or the collab-v2 worktree, i.e. **outside tm8**.
`09-IMPLEMENTATION-PLAN.md:41` explicitly promised the opposite: *"**Corpus snapshot
in-repo:** workers never read from agent-maestro at runtime; everything they need is
vendored into `docs/` at M0."*

This matters because gates **G1, G2 and G3 are all defined against it**:

- `09:87` — G1: *"five golden workflows executable as scripted HTTP sequences"*
- `09:96` — G2: *"five golden workflows in the running app against the real backend"*
- `09:109` — G3: *"all golden workflows + a two-agent orchestration scenario green"*

tm8 currently cannot state its own acceptance criteria from its own repo. I read the
brief from `/Users/subhang/Desktop/Projects/maestro/collab-v2-ui-wt/docs/COLLAB_V2_UI_UX_BRIEF.md`
(340 lines) and quote §10 verbatim in Part 1.9 below. **Recommendation: vendor it.**

---

# PART 1 — THE DESIGNED-SURFACE REGISTER

Everything the corpus specifies. "Designed" here means *specified in prose or a table*,
which for most of this corpus is the ceiling — there is no visual design system spec, no
Figma, no annotated flows. The one visual artifact (`Modular Collab Workspace UI/*.dc.html`
prototype, cited at `ui-plan/02:69-74`) is also **not in tm8**.

## 1.1 Design laws that constrain every surface

| Law | Source | Text |
|---|---|---|
| Composition maxim | brief §2.1; `01-LAWS.md:21` (T-L2) | *"if a surface can't be composed from entity components, collection views, and the two axes — it doesn't belong in the product."* |
| Kinds are data | brief §2.1; `01-LAWS.md:31` (T-L4); `ui-plan/01:51-53` | *"Adding a kind = adding a registry entry. No `if (kind === 'task')` outside the registry."* |
| Two axes always visible | brief §2.2 | vertical = hierarchy (breadcrumb up / children down); horizontal = edges rail. *"Every detail surface shows both."* |
| Placement always means something | brief §2.3 | *"placement always *means* something explicit: an edge of a visible type, a parent change, or an embed message. No mystery relationships."* |
| Talk where the work is | brief §2.4 | *"Never send users 'somewhere else' to discuss. Every entity carries its thread inline."* |
| Peers with provenance | brief §2.5 | agent vs human authorship *"always visibly typed … never buried."* |
| Zoom, don't navigate | brief §2.6 | prefer peek/stack/split over page swaps |
| Live by default | brief §2.7 | presence, typing, working-status, unread, staleness |
| Screens compose only | `ui-plan/01:47-50`; `ui-plan/02:36` | *"a screen importing the facade for entity rendering or containing bespoke entity markup is a defect"* |
| Terminal frames are exempt | `01-LAWS.md:70` (T-L10, R16) | *"the panel around it is an entity component; the canvas inside it is not"* |

## 1.2 Shell / navigation model

`brief §5`, `ui-plan/01` Layer 3 (L3), owner Framer (`ui-plan/02:91`).

```
Space switcher (far-left icon rail: spaces + inbox + home)
└─ Left rail (per space): Home · Channels(tree) · Tasks · Docs · Team · Tracking · Graph · Leaderboard
   └─ Center: current PRIMARY view (a full view or collection view)
      └─ Panel stack (right): peek/stacked Z3 panels navigated from anywhere
         └─ Any panel → pin to split | promote to full (becomes primary)
```
*(brief §5, verbatim)*

- **Panel stack** (brief §5 bullet 1; `ui-plan/01:174-180`): click chip/card → Z3 peeks
  over the right edge; a chip *inside* a panel stacks another (breadcrumbed, ⌫/swipe pops);
  📌 pin docks it as a persistent split, **2–3 splits max** ("channel feed + task panel +
  doc panel side by side"); ⤢ promotes to Z4 and the current center view becomes the back
  target.
- **URL-addressable everything** (brief §5 bullet 2; `ui-plan/01:179-180`):
  `#/s/{space}/{view}` · `#/s/{space}/e/{entityId}` · **stack state encoded**
  (primary + panels) → *"Back/forward = graph browsing history."* Hash-based, no router dep.
- **Left-rail sections are just saved collection views** (brief §5 bullet 3) —
  *"Tasks/Docs/Team/Tracking are not bespoke pages."*
- **Keyboard map** (`ui-plan/01:181`): ⌘K palette, ⌫ pop panel, `g+t`/`g+d`/`g+h` view
  jumps, arrows in collections.
- **Exit criteria L3** (`ui-plan/01:183-185`): deep-link to any view/entity/stack state
  reproduces the layout; back/forward walks history; 3-split pinning works.

## 1.3 The Entity Component Contract (Z1–Z4)

`brief §3`; `ui-plan/01` Layer 1 table (lines 128-134); owner Forma (`ui-plan/02:90`).

| Zoom | What it is | What it must show | Interactions |
|---|---|---|---|
| **Z1 Chip** | inline token | kind icon + name + state tint | hover → Z2 popover; click → push panel (Z3); drag → place/link (§6.2). Used in message text (mentions/refs), edge rails, breadcrumbs, board cells, composer autocompletes. Mention/ref variant for inline text. (brief §3 Z1; `ui-plan/01:130`) |
| **Z2 Card** | summary tile | chip + **2–4 kind-specific fields** + universal footer (reaction counts, points, message count, key edge chips, actor avatars) + badges (blocked ⚠, working ●, stale, restricted) + skeleton variant | **THE cell for every collection, embed, and graph node.** (brief §3 Z2; `ui-plan/01:131`) |
| **Z3 Panel** | the workhorse detail view, **~420–560px column** in the panel stack | ① header: breadcrumb (clickable ancestors), kind icon, inline-editable title, work/status control, overflow (copy link, copy to space, watch, delete) ② action bar: react 👍👎⭐, grant points, **Link** (edge composer), **Add child**, Pull where meaningful, kind primaries ③ **body tabs — universal set, same order everywhere: Content · Discussion · Connections · Activity** ④ footer: presence (who's viewing), created-by chip, version + last activity | (brief §3 Z3; `ui-plan/01:132`) |
| **Z4 Full view** | panel promoted to route, URL `/s/{space}/e/{entityId}` | kind layout variants: **doc** = reader/editor + chapter-tree sidebar + margin threads; **channel** = full hub (§7); **task** = subtree board + dependency mini-graph; **member/TM** = profile page; **generic fallback** = prose + children grid | every panel has "expand ⤢"; every full view collapses back to a panel (brief §3 Z4; `ui-plan/01:133`) |
| **Tombstone** | deleted chip/card that *"keeps history shape"* | | `ui-plan/01:134`, brief §11 |

**Z2 kind specifics named in brief §3:** task → status, type, assignees, dep/blocked badge;
doc → excerpt, child-count; member/team_member → role, live status; PR → repo#, state;
message → author + body preview; channel → topic, unread, last activity.

**Per-kind registry entry** (`ui-plan/01:129`): icon, tint, chip label fn, Z2 summary
fields renderer, Z3 Content-tab renderer, Z4 layout variant, primary actions, creation form
schema. **"All 11 kinds + tombstone."** ← see Part 4 debt: tm8 has 13 core kinds + `c:*`.

**Exit criteria L1** (`ui-plan/01:136-137`): a gallery page renders all 11 kinds ×
Z1/Z2/Z3 (+ skeleton + tombstone) from mock data.

## 1.4 The two axes

- **Hierarchy (vertical)** — brief §0 cap.1: *"Every entity has an optional same-kind
  parent and ordered same-kind children. Task trees, doc chapters, team-member org trees,
  message threads — all the same mechanism. A subtree is a self-contained context unit."*
- **Edges (horizontal)** — brief §0 cap.2, taxonomy: `assigned_to`, `attached_to`,
  `tracks`, `depends_on` (hard/soft, kind-aware resolution), `pulled`, `working_on`,
  `completed_by`, `equips`, `copy_of`, `relates_to`, plus free-form `x:*`.
  tm8 adds `contains` (collection→any) and `member_of` (`03-ENTITY-GRAPH-DELTAS.md:23,62`).

## 1.5 The five universal subsystems

`brief §4`; `ui-plan/01` Layer 2 (lines 142-163).

**1. Thread (Discussion)** — brief §4.1; `ui-plan/01:143-150`; owner Weave.
One component for channel feed, task comments, doc margin threads, member wall. Required:
real-time append; **replies as collapsible child-message subtrees**; `@member`/`@agent`
mentions **and** `#entity` refs → chips; **drop-chip-to-composer → live Z2 card embedded in
the message**; attachments (files); reactions on messages; edit/soft-delete → tombstone;
**unread line + jump-to-unread**; per-anchor unread badge; composer with pending states.
Two variants: *feed* (channel; system/activity items collapsed) vs *comment* (task/doc).
Agent messages: *"visually distinct (agent chip + persona avatar + subtle rail tint) but
in-flow — never ghettoized. **Progress reports from agents ARE messages here.**"*

**2. ConnectionsRail** — brief §4.2; `ui-plan/01:151-156`; owner Railway.
Two stacked sections. *Hierarchy:* parent chip up, ordered children cards down, with
add/reorder/drag-reparent + "open as tree/board" for big families. *Edges, grouped by type
with direction labels:* "Assigned to", "Tracks", "Depends on ⚠ (2 unresolved)", "Attached",
"Pulled by", "Related", custom `x:` groups. Per-item resolution (HARD ✓ / HARD ⚠), blocked
rollup, hover previews, click-hops stack, inline "+" per group, remove on hover.
*"This rail is how users feel the graph without ever seeing the word 'graph'."*

**3. ReactionsPointsBar** — brief §4.3; `ui-plan/01:157-159`.
👍/👎 mutually exclusive, ⭐ independent, **points control: tap = +1, hold = amount picker,
hover = pool total + top granters**. *"Full identical behavior on every entity, including
messages."*

**4. CommandPalette (⌘K)** — brief §4.4; `ui-plan/01:160-162`; owner Pulse.
*"the graph's front door."* Universal search (entities by kind/title/content **once search
ships**) + actions ("create task in…", "link A → B", "go to…", "pull…"). Context-aware:
opened on a panel, actions apply to that entity. **"This is also the keyboard path for
EVERY edge/hierarchy operation the mouse can do."** Results render as chips.

**5. Live layer** — brief §4.5/§4.6; `ui-plan/01:163-166`.
Presence avatars-on-entity (viewing now); typing in threads; **agents at work** — a
`team_member` chip anywhere shows a live pulse when it has an active `working_on` edge,
hover → *"working on {task chip} since {t}"*; channel/task lists show **"🤖 2 working"**
aggregates. **Staleness:** per puller, *"v7 pinned · content v9 → stale"* + softer
*"discussion moved since pull"* + **one-click re-pull**. **Blocked:** badge +
"waiting on {chips}", auto-clears with *"a satisfying unblock moment (activity +
notification)"*.

**Exit criteria L2** (`ui-plan/01:165-166`): each drivable standalone on the gallery page;
thread handles 10k-message virtualization; rail handles 50-edge grouping.

## 1.6 Collection system + the six layouts

`brief §6.1`; `ui-plan/01` Layer 4 (lines 190-208); owner Lens.

`CollectionView(query, layout, groupBy, sortBy)`. Query = kinds + filters (workStatus, any
axis, assigneeIds, edge-predicates, `subtreeOf`, `parentId`, `readyToPull`,
`inReviewForActorId`, `mentionedActorId`, `deleted`) — the DTO is
`COLLAB_V2_UI_DATA_CONTRACT.md:155-170`.

**groupBy accepts any axis** — brief §6.1: *"the UI never special-cases one axis over
another"*; `ui-plan/01:193`: *"default and manual axes indistinguishable"*.

**Six layouts** (brief §6.1; `ui-plan/01:194-196`): **List · Board** (group columns, drag
card between columns = the matching mutation, ghost preview) **· Tree** (hierarchy,
expand/collapse, paged children, drag-reparent) **· Feed** (activity order) **· Gallery**
(Z2 grid) **· Graph**.

**GraphCanvas** — brief §8; `ui-plan/01:197-204`. @xyflow/react + dagre. Nodes = Z2 cards
(kind-shaped); edges typed/labeled/directional; **hierarchy = collapsible containment
clusters, visually distinct from edges (dashed boxes vs drawn lines)**; subgraph switcher;
filter by kinds/edge types; **focus mode (entity + N hops)**; **dependency mode
(topological LTR, blocked = red path)**; hover dims non-neighborhood; click node → panel
stacks (canvas stays); **drag node→node → edge composer**; layout persistence per saved
view. brief §8: *"This view must be genuinely useful (dependency untangling, onboarding
'how does this space fit together'), not a demo toy."*

Plus: layout switcher on **any** collection; save view (name + share-to-space, persisted via
facade); **empty states that teach the grammar** ("no tasks linked yet — drag one here or ⌘K").

## 1.7 The drag/drop grammar

`brief §6.2`; `ui-plan/01` Layer 6 (lines 235-247); owner Motion. Single source of truth
module `interactions/grammar.ts` (`ui-plan/02:124`): *source kind × target surface → meaning*.

| Source | Target | Meaning |
|---|---|---|
| any chip | **channel** (feed or shelf) | `attached_to` edge + optional embed message |
| doc/file/spell/skill | **task** | `attached_to` |
| member/team_member | **task** | `assigned_to` |
| task | **task** | 3-zone drop menu: **attach \| depend \| subtask** |
| task | **member/TM** | `assigned_to` |
| any chip | **composer** | embed in message |
| same-kind | **parent-zone** | reparent (hierarchy move) |

Rules: **ghost label previews the meaning before drop**; ambiguity → drop menu, ≤3 options;
every drop = one `placements` command → **undoable** (toast with Undo, facade undo token) +
lands in Activity. *"The **Link button + palette** is the exact keyboard equivalent."*

**Creation flows** (brief §6.3; `ui-plan/01:243-245`): "+" is everywhere and
context-seeded — from a channel (creates + attaches), from a parent (creates as child),
from the palette; **creation modal = Z3 Content tab fields only**; **promote message →
task/doc** (creates entity, `relates_to` the message, quotes it).

**Optimistic mutations** (`ui-plan/01:246-247`): apply patch → pending → reconcile by
`clientMutationId` → typed-error rollback; **409 shows "edited by X just now" toast +
latest state; no merge dialogs** (brief §11).

## 1.8 The view catalog — eleven screens

`brief §9` (nine rows) expanded by `ui-plan/01` Layer 5 (lines 214-227) to eleven.

| Screen | Composition (brief §9 / ui-plan L5) |
|---|---|
| **Home ("My Work")** | 3 collections: *Ready to pull* (open, unblocked, assigned-to-me-or-my-agents, w/ PULL action) · *In flight* (pulled/working by me/my agents, with staleness) · *Needs me* (in_review, approval-requested, mentions) + compact space activity feed. *"The daily driver. Agents' work appears under their owner with attribution."* |
| **Inbox** | Cross-space notification items (mentions, assignments, awards, unblocks, approvals) with read state; click → panel. Lives at the far-left rail level. |
| **Channels** | Rail tree + channel hubs (§7). Default channel = space general. |
| **Tasks** | CollectionView over tasks: Board (columns = status, assignee, or **any axis**) · Tree · List · Graph(dependency); **axis pivot switcher is one click**. Board cards show blocked/agent-working badges + axis value chips. **Bulk select → bulk edge/axis ops.** |
| **Docs** | CollectionView (gallery/tree) → Z4 reader/editor: chapter tree (children), margin threads (anchored messages), version history, **"split to child docs"** action. *"Versioned artifact + discussion; NO live co-editing (non-goal)."* |
| **Team** | Members grid; member profile Z4 = wall (thread) + their team_member tree (org chart of personas) + their work + their score; TM profile = identity, memories, equipped spells/skills, work history. `ui-plan/01:219` adds: member cards with stats (points/done/agents) and *"nested agent org-tree rows (mode, model, live status, **SPAWN affordance**, empty state)"*. |
| **Tracking** | PRs/commits list with task chips, state, refresh, stale-fetch indicator; per-row + refresh-all. *"v1 is manual-link; design the slot for live webhook states."* |
| **Graph** | §8 full-page GraphCanvas; `ui-plan/01:221` adds 3 seeded subgraphs + saved-view switcher. |
| **Leaderboard** | Member scores (ledger sums), recent awards feed, per-task award breakdowns. *"Tasteful, not casino. Completion award = brief celebratory moment on the task + feed item."* |
| **Channel Hub** (§7, called out separately by ui-plan) | see 1.8.1 |
| **Entity Z4** (`ui-plan/01:225`) | the generic full-view route, reachable from every panel |
| **Space settings** | brief §9: *"Members/roles, invites (link/code), space profile — **Existing v1 parity**."* `ui-plan/01:226` adds **task-axis management (add/edit manual axes)**. |

### 1.8.1 Channel hub — the one screen with a full anatomy spec

`brief §7`, the most detailed screen in the corpus.

- **Header:** name, topic, members+agents present, unread state.
- **Tab strip — Feed + auto-tabs:** tabs appear automatically for whatever is linked —
  *Tasks* (tasks `attached_to` this channel, **default Board**), *Docs* (gallery/list),
  *Team* (members+TMs attached, with live work status), *PRs* (tracking list), custom saved
  views. **Empty kinds = no tab (no clutter).** *"This makes a channel scale from pure chat
  → full project room with zero configuration."*
- **Feed:** the Thread component. Entity drops render as **living embedded cards** —
  *"a task embed shows live status; completing it updates in place."* System/activity events
  (task completed, PR merged, member joined) appear as **compact, collapsible feed items,
  distinct from human/agent speech.**
- **Shelf (pinned):** horizontal strip of pinned entity cards under the header — the
  channel's "important things". **Pin = edge prop** (`attached_to.props.pinned`).
- **Channel hierarchy:** channels nest via the same parent mechanism; left-rail renders the tree.

## 1.9 THE FIVE GOLDEN WORKFLOWS — verbatim

`COLLAB_V2_UI_UX_BRIEF.md` §10, quoted in full. Header: *"Golden workflows (design these
end-to-end, **they are the acceptance tests**)"*.

> 1. **Author & stage:** human creates task in a channel context (auto-attached),
>    sets type/acceptance criteria, drags in a design doc (attach), drags onto an agent
>    TM (assign), grants 20 points (bounty). Everything visible on the task's
>    Connections rail; channel gets a feed embed.
> 2. **Agent pulls & works:** agent pulls (CLI) → task shows "pulled by 🤖 Forge · v3
>    pinned", then live "working". Its progress messages land in the task thread —
>    visible in the channel embed too. Human replies with a correction mid-flight; agent
>    (via CLI) reads and acknowledges in-thread.
> 3. **Ship & review:** agent links PR (`tracks` edge appears, PR entity card on rail),
>    sets in_review. Reviewer opens task panel + PR panel side-by-side (pinned splits),
>    discusses in-thread, stars the work, hits **Complete** → tags completers (agent +
>    human pair) → points award moment → leaderboard/feed update → unblock ripple to
>    dependent tasks (badges clear, notifications fire).
> 4. **Knowledge grows:** during review someone promotes a thread message to a doc
>    ("promote to doc" — like promote-to-task); doc lands as child of the spec doc,
>    `relates_to` the message; searchable, linkable forever.
> 5. **Orient a newcomer:** new member joins → Home explains itself; opens Graph focus
>    on the milestone task → sees the subtree, deps, people, docs; joins the channel and
>    reads pinned shelf. Zero tribal knowledge needed.

`ui-plan/01:267-277` restates these as Layer 8 with a definition of done
(`ui-plan/01:279-280`): *"all five run clean; gallery page covers every kind × zoom ×
state; contract test-suite green; no console errors; type-check clean."*

**Three observations the audit must carry:**

- **WF2 and WF4 are only half-designed as UI.** WF2's agent side is *"(CLI)"* — the brief
  never says what the human sees while an agent works beyond the pulse/staleness badges.
  WF5 says *"new member joins"* with no design for how joining happens (see Part 3.3).
- **WF3 is the only workflow that names a layout mechanic** ("pinned splits").
- **WF4 requires "promote to doc"**, which appears nowhere else in the corpus — the
  creation-flow spec (`brief §6.3`, `ui-plan/01:244-245`) designs "promote to task" and
  says promote-to-doc is *"like promote-to-task"*.

## 1.10 States & edge cases (must be designed, not defaulted)

`brief §11`; `ui-plan/01` Layer 7 (lines 258-262).

Empty states (grammar-teaching, per collection) · loading skeletons (*"panels never
blank-flash"*) · soft-deleted tombstone chips in threads/rails · stale projection · blocked
task · conflict handling (*"last-write-wins on distinct fields; show 'edited by X just now'
toasts rather than merge dialogs"*) · **offline/degraded (read-only cached views + queued
messages with clear pending state)** · **`restricted` badge slot — chrome must tolerate it
without layout change (A4)** · scale (10k-message virtualized thread, 200-child paged tree,
50-edge grouped rail with "show all").

Plus a11y (`ui-plan/01:265-266`): full keyboard paths incl. palette parity, focus management
in the stack, ARIA on boards/trees, **status is always color + word, never color alone**
(`ui-plan/01:116-117`).

## 1.11 Realtime / presence

- Event union: `COLLAB_V2_UI_DATA_CONTRACT.md:267-275` — `entity.upsert|deleted`,
  `edge.upsert|deleted`, `message.created|updated|deleted`, `counter.changed`,
  `activity.created`, `notification.created|read`, `presence.changed`, `typing.changed`.
- `PresenceSnapshot { viewers, typingActorIds, updatedAt }` (`:217`).
- UI obligations (`:263-264`, `:278-280`): de-duplicate by event id, reconcile optimistic
  `clientMutationId`s; *"`entity.upsert` changes collection membership, board columns,
  staleness and blocked badges without waiting for a refresh."*
- ⚠ this doc's envelope is **superseded** — see Part 4.

## 1.12 Design system

`ui-plan/01:111-117` — the only visual spec in tm8: paper/ink `--pn-*` palette; Newsreader
(serif display) + Hanken Grotesk (body) + JetBrains Mono (meta); pill/status colors
(**green working, red blocked, blue review, amber stale**); card shadows; **avatar system:
humans round, agents rounded-square**; primitives `Pill`, `Avatar`, `Eyebrow`, `Kbd`,
`IconBtn`. Ported from the prototype `_ds` bundle — **which is not in tm8** (see Finding 0).

---

# PART 2 — `work_session` AND THE EXECUTION SURFACE

**The question:** tm8 promoted `work_session` to a CORE kind. The mock-era UI had no
sessions screen. Does ANY design exist for one?

**Answer: no screen, no spawn UX, no terminal placement, no prompt-delivery UI.** What
exists is (a) a data/lifecycle design for the kind, (b) a law about where terminal bytes
flow, and (c) one exemption clause. Every one of those is backend-shaped. Precisely:

## 2.1 SPECIFIED — the kind and its lifecycle

`03-ENTITY-GRAPH-DELTAS.md:11-19` (§1.1 `work_session` — the execution shadow):

- Detail table: `(entity_id PK, node_id/home, project_ref, status ∈ spawning|running|
  idle|exited|failed, agent_tool, model, started_at, exited_at, share_mode ∈
  none|space|explicit, transcript_doc_id)`.
- *"Created by the execution block's spawn transaction; edges: `working_on → task`,
  spawned-by attribution via `created_by`."*
- *"Timeline = messages + activity anchored to the entity (**no bespoke timeline table**)."*
- *"Transcript on exit = a document entity `attached_to` the work_session (reviewable
  history without byte recording)."*
- `work_session.status` has a **single writer** [R29].

Contract types: `packages/contract/src/contract.ts:101-103` (state: status, agentTool,
model, shareMode, startedAt, exitedAt) and `:148-151` (content: nodeId, projectId,
`workingOn: EntitySummary[]`, `transcriptDoc: EntitySummary | null`); `:621-624`
(`WorkSessionStatus`, `WorkSessionShareMode`). `contract.ts:421-426`: **`work_session` is
excluded from `entities.create`** — *"it is born only from"* `execution.spawn`.

## 2.2 SPECIFIED — streams law and the panel/canvas boundary

`01-LAWS.md:66-72` (T-L10): *"The graph announces, sockets deliver."* Session **state**
lives in the graph; session **output** lives on the socket; the reviewable record is a
transcript artifact, *"not a byte recording"*. Forbids *"ambient live-terminal visibility
(sharing is an explicit act)"*.

`01-LAWS.md:70` — the single most UI-relevant sentence in the whole architecture set:

> The xterm frame surface *inside* a `work_session` panel is stream UI, explicitly exempt
> from the entity-component contract at the frame level — **the panel around it is an
> entity component; the canvas inside it is not** [R16].

`02-NODE-AND-GATEWAY.md:80-83` (§6, streams & terminal sharing applied):

- *"Session state (status, machine, task edges, progress messages) = `work_session` entity
  in the graph → visible to space members everywhere, **renders as chip/card/panel like
  anything else**."*
- *"Broadcast ('share my terminal to the space') = **explicit act**: flip share state on the
  work_session (command → WorkspaceEvent → **LIVE chip everywhere**), viewers attach to the
  existing PTY fan-out as additional subscribers. **View-only vs drive (input) is a later
  permission tier** on the same path."*
- *"After exit: transcript artifact attached to the work_session entity."*

That is the total of the terminal-in-UI design: *a panel, with an exempt canvas, and a LIVE
chip when shared.* **Where the panel lives, how wide it is, whether a terminal survives a
panel pop, how N running sessions are viewed at once — none of it is designed.** Note the
tension: the Z3 panel is specified at **~420–560px** (brief §3 Z3) and terminal perf parity
with old maestro's **desktop** terminal is the G3 bar (`STATE.md:68`).

## 2.3 SPECIFIED — the registry entry, one line

`09-IMPLEMENTATION-PLAN.md:93` (M2 deliverable):

> **KindRegistry runtime path** (review §12): generated default renderers for
> `entity_kinds` rows (custom kinds) + registry entries for **`work_session` (panel =
> entity chrome; terminal canvas exempt per T-L10/R16)** and `collection`.

This is the *only* instruction anywhere for how a `work_session` should render. There is no
Z2 card field list, no Z3 Content-tab spec, no Z4 variant, no primary-action list — the four
things `ui-plan/01:129` says a registry entry must define.

## 2.4 SPECIFIED — spawn/prompt/terminate/attach as *operations*, not as UI

`04-EXECUTION-TRANSPLANT.md:79-84` (§5, the execution operation family, [R16]):
`execution.spawn` · `execution.prompt` · `execution.terminate` · `execution.streams.attach`.
Contract inputs at `contract.ts:717-774` (`ExecutionSpawnInput` carries `teamMemberId`,
`taskIds[]`, `projectId`, `workdir {mode: project|worktree, baseRef}`, `mode`, `model`,
`agentTool`, `title`, `promptExtra`; `StreamAttachGrant` returns a ws URL + mode + token).

`execution.spawn`'s input is, in effect, **an unwritten form spec**: nine fields a human
must supply or defaults must cover. No document designs that form. The one that exists
(`packages/ui/src/real/SpawnDialog.tsx`, 256 lines) was authored inside the wiring lane, not
from a design.

## 2.5 SPECIFIED — `session prompt` as a delivery *mechanism* (and nothing about typing it)

`04-EXECUTION-TRANSPLANT.md:86-88` (§6) is emphatic and entirely backend:

> Today `maestro session prompt <id> --message` *injects text into the target session's
> PTY* — it makes an agent act. An anchored message is inert unless something delivers it.
> … Without this, every coordinator↔worker protocol breaks *silently* … **This is the
> single most dangerous silent-failure seam in the transplant; it is a named v1
> requirement, not an option.**

Also `07-ARCHITECTURE-REVIEW.md:163` [R17], `09:104`, `09:134` (G3 asserts the round-trip
**on PTY output, not on graph state**).

**Nowhere does any document say where a human types that prompt.** Not a composer, not an
action-bar button, not a palette action. The Thread spec (brief §4.1) designs a composer for
*messages*; `execution.prompt` is explicitly **not** a message (that is R17's whole point),
so the designed composer is the wrong affordance and no other is specified.

## 2.6 SPECIFIED — progress-in-thread (this one IS fully designed)

The best-covered piece of the execution surface, and it is designed as *messages*, not as a
session UI:

- brief §4.1: *"Progress reports from agents ARE messages here."*
- brief §10 WF2 (quoted in 1.9): progress messages land in the task thread, *"visible in the
  channel embed too"*; human correction mid-flight; agent acknowledges in-thread.
- `04-EXECUTION-TRANSPLANT.md:34`: *"Report-back writes become graph appends: progress →
  messages anchored to the work_session/task … **Session timeline is retired in favor of
  anchored messages + activity**."*
- `04:47`: `maestro session report …` → *"message anchored to own work_session + status"*.

Consequence worth flagging for the audit: agent progress is designed to land on **two
different anchors** (the task, per WF2; the work_session, per `04:34/47`) and no document
reconciles which thread a human reads.

## 2.7 SPECIFIED — live status semantics that the UI must surface

- `04-EXECUTION-TRANSPLANT.md:92` (§7, v1 execution parity acceptance): *"spawn from a task
  (any team_member persona, any mode) → terminal opens → agent boots with correct
  manifest/prompt → progress/report-back lands in the graph → **session card/panel reflects
  live status** → exit produces transcript artifact"*.
- `07-ARCHITECTURE-REVIEW.md:169` [R20]: status flips (spawning→running→idle→exited) are
  frequent; **idle flapping is debounced in the execution block before it touches the
  graph** — so the UI is guaranteed a non-chattering status but is never told how to render
  the five states.
- `10-SECURITY-MODEL.md:38` (S10): per-node concurrent-session cap, **default 8** →
  `limit_exceeded`. The UI must surface a 429 that means "you are at your session cap" —
  no design says how.
- `10-SECURITY-MODEL.md:40` (S12): *"v1 does not sandbox — trust is informed consent, and
  **that is stated honestly in the UI copy**."* See Part 3.4 — this is a UI copy requirement
  with no surface to put it on.

## 2.8 MERELY MENTIONED — the spawn affordance

Exactly one mention in the entire corpus, in a table cell describing the Team screen
(`ui-plan/01:219`):

> **Team** | Member cards (stats: points/done/agents) with nested agent org-tree rows (mode,
> model, live status, **SPAWN affordance**, empty state) …

Two words. No dialog, no field set, no confirmation, no post-spawn transition, no error
states. The word "affordance" is doing all the work.

## 2.9 NOT SPECIFIED — the exhaustive list

| Surface | Status |
|---|---|
| A **sessions screen / view** (list of running + past sessions) | **ABSENT.** Not in brief §9's nine rows; not in `ui-plan/01` Layer 5's eleven; not in `ui-plan/02:121-123`'s ownership map; not in `packages/ui/src/collab-v2/screens/` (which holds exactly `channel docs home inbox leaderboard settings tasks team tracking`). The only corpus hint is `04:50` mapping `maestro session siblings` → *"collection query: work_sessions in space"* — an op, not a screen. |
| **Spawn UX** (form, defaults, worktree choice, untrusted-project confirm) | **ABSENT.** See 2.4/2.8. `contract.ts:729` even defines a *projectless scratch session* mode with no UI concept attached. |
| **Prompt delivery UI** | **ABSENT.** See 2.5. |
| **Terminal placement in the shell** | **ABSENT.** See 2.2. Only "a panel" is implied. |
| **Multi-terminal / N-sessions-at-once** | **ABSENT** — and `STATE.md:142` records it as a live consequence: *"visibility-driver suspend/resume benefit not yet observable — UI mounts one terminal (SpawnDialog); lands with a multi-terminal view."* The multi-terminal view has no design to land against. |
| **Terminal input (drive mode)** | **ABSENT** as UI. Backend tier named at `02:82` and `10-SECURITY-MODEL.md:42` (S14: *"v1 grants input only to the spawning owner"*). `STATE.md:142` item (2): *"no client→server stdin"*. |
| **Terminal sharing UX** (flip `share_mode`, the LIVE chip, viewer list) | **ABSENT** beyond `02:82`'s one sentence. |
| **Transcript reading UI** | **ABSENT** beyond "it's a doc entity" — so it inherits the doc Z4 reader by default, which nobody has said is right for terminal output. |
| **Session cap / `limit_exceeded` UX** | **ABSENT.** See 2.7. |
| **Ghost/orphaned sessions after restart** | **ABSENT**, and it is a real user-visible state today (`STATE.md:134`). |
| **Modals raised by agents mid-run** | **Named as data only** — `03-ENTITY-GRAPH-DELTAS.md:72`: `session_modals` is *"an operational side table + immediate-class WorkspaceEvent, **never an entity**"*, and [R29] requires the compat adapter to carry the `modal` verbs. Because it is never an entity, **it can never render through Z1–Z4** — so old maestro's modal UI has no home in tm8's design at all. This is a genuine hole: the composition maxim (T-L2) forbids a surface that isn't entity-composed, and modals are explicitly not entities. |

## 2.10 Verdict for Part 2

**No design exists for a work_session/execution UI.** What exists is a data model
(`03 §1.1`), a streaming law with a one-line panel/canvas boundary (`01-LAWS` T-L10),
a one-line registry instruction (`09:93`), an operation family (`04 §5`), and two words in
a table cell (`ui-plan/01:219`). The *acceptance* sentence at `04:92` ("session card/panel
reflects live status") is the closest the corpus comes to a requirement, and it names a
card and a panel that were never specified.

This is the largest single design gap in tm8: the kind that distinguishes tm8 from Collab V2
is the one kind the UI corpus predates and therefore never designed.

---

# PART 3 — THE UNDESIGNED SURFACES

Verdict scale: **(a) DESIGN EXISTS** — a surface is specified · **(b) PARTIALLY
SPECIFIED** — some of it is specified, the rest is not · **(c) NO DESIGN EXISTS** — must be
designed from scratch.

**Summary table (read this first):**

| # | Surface | Verdict | One-line reason |
|---|---|---|---|
| 1 | Authentication / first-run / onboarding | **(c) NO DESIGN** | Not one screen, flow, or field anywhere in the corpus. Backend law only. |
| 2 | Account / identity / acting-as / node-admin | **(c) NO DESIGN** | `identity.get` exists and the UI never calls it. No profile, no account menu, no node-admin surface. |
| 3 | Collab: spaces, membership, invites, sharing | **(b) PARTIAL** | Contents enumerated (settings screen row, invite "link/code"); zero flows — create, switch, invite-send, **invite-redeem**, join. |
| 4 | Projects management + trust | **(c) NO DESIGN** | Projects post-date the UI brief entirely. One UI sentence exists (S12 "stated honestly in the UI copy") with no surface to hold it. |
| 5 | Custom kinds (`c:*`) | **(b) PARTIAL** | *Rendering* is designed (generated Z2/Z3 from `fieldSchema`). *Authoring* — define/edit a kind — is not designed at all. |
| 6 | Files / blobs | **(b) PARTIAL** | `file` is a first-class kind with chip/card/attach grammar. The blob lifecycle (upload, download, preview, quota) has no UI design. |
| 7 | Node-level settings | **(c) NO DESIGN**, and **no backend surface either** | Env-vars + one hardcoded constant; `/health` is the only introspection; zero catalog ops. |

---

## 3.1 AUTHENTICATION — login, first-run owner setup, onboarding

### Verdict: **(c) NO DESIGN EXISTS.**

There is no login screen, no first-run/owner-setup flow, no onboarding, no logout, no
session-expiry handling, and no unauthenticated state anywhere in the corpus. Not in the
brief's view catalog (§9, nine rows), not in `ui-plan/01` Layer 5 (eleven screens), not in
`ui-plan/02:121-123`'s ownership map, not in `COLLAB_V2_UI_DATA_CONTRACT.md`'s route matrix
(§3, thirteen rows), not in `05-COHERENCE-MATRIX.md §1` (seventeen UI-surface rows). The
brief's §11 state inventory — which deliberately enumerates *"States & edge cases (must be
designed, not defaulted)"* — lists empty/loading/deleted/stale/blocked/offline/permissions/
scale and **not** unauthenticated.

**What exists instead is backend law:**

- `01-LAWS.md:50-54` (T-L7): *"Auth is always on; local is the degenerate case … A
  single-user local node **auto-authenticates its owner**: one account, one member row per
  space — the same code path with one row in it."* Forbids *"'local mode skips auth'"*.
- `05-DECISIONS.md:15` (T-D9), `:13` (T-D7 — identity is node-local).
- `09-IMPLEMENTATION-PLAN.md:76` (§3.2): *"v1 local mode: **first run creates the owner
  account and auto-authenticates** (T-L7 degenerate case — same code path, one row) … **No
  remote-facing surface yet** (that's the gateway, Phase 2)."*
- `09:94` (M2 browser-app boot): *"tm8-server serves the production UI bundle (4610); Vite
  dev on 4611; **auth = auto-owner**; sidecar managed by tm8-server."* ← the entire boot-flow
  design, three words.
- `06-SEQUENCING-AND-REVIEW.md:14`: *"single-user auth (auto-owner)."*

### Confirmed in code: tm8 silently auto-owners on loopback with zero UI

- `packages/server/src/identity/loopback.ts:90-112` — `resolveLoopbackOwner` calls
  `resolve_account_credential('owner')`; on a miss it calls `ensure_account(...)` with
  `is_owner=true, is_node_admin=true, password_algorithm=null, password_hash=null`.
  Constants at `:40-41` (`'owner'` / `'Owner'`). Memoized in-flight at `:127-138`.
  The file's own header (`:14-18`) states the posture: *"It is sound only because the node
  binds loopback (S1); the moment that changes, this is replaced by the bearer path (S8)."*
- `packages/server/src/http/security.ts:102` — `autoOwnerResolver` returns
  `{ kind: 'auto-owner' }` and **reads no headers**. `security.ts:53-70` — `checkHost`
  (S2), Origin (S3/S4), CSRF (S6) are all **named no-ops returning `ALLOWED`**;
  `security.ts:4-8`: *"exactly ONE rule from 10-SECURITY-MODEL is enforced in this pass:
  S1."*
- `packages/server/src/main.ts:144-149` — the production resolver still reads no headers.
- `packages/server/src/http/config.ts:58-63` — refuses to start non-loopback:
  *"refusing to bind … non-loopback binding requires token auth (10-SECURITY S1/S8), which
  is not implemented yet."*
- A **complete account/credential/session service exists but is unreachable**:
  `identity/service.ts` (467 lines) has `verify`/`issueSession`/`verifyToken`/
  `resetCredentials`/`revokeSession`/`listSessions`/`disableAccount`/`canActAs` — grep for
  `IdentityServiceImpl` finds hits **only** in `packages/server/test/identity/`.
  Its Postgres backing `identity/pg-store.ts` is **dead against the shipped migrations**
  (`STATE.md:153`, three independent breaks).
- **The UI sends no credential at all**: `packages/ui/src/real/TmClient.ts:98-102` sends
  only `content-type: application/json`.
- `packages/ui/src/real/` contains no login/auth/account component (9 files, listed in 3.2).

### What 10-SECURITY-MODEL says the eventual model is

- **S1** (`10:20`): loopback-only default; *"Non-loopback binding (`TM8_BIND`) is an explicit
  opt-in and **requires token auth (S8) — the server refuses to start non-loopback with auth
  disabled**."*
- **S5** (`10:27`): *"v1 local mode auto-authenticates the owner (T-L7) — but **auto-auth
  only applies to requests that pass S1–S4** (loopback + Host + Origin discipline). A
  cross-site form-POST or rebound-DNS request never gets the auto-owner identity."*
- **S6** (`10:28`): cookies `HttpOnly; SameSite=Strict` + a custom header `X-TM8-Client` on
  state-changing endpoints; bearer clients exempt.
- **S8** (`10:33`): *"`tm8` CLI and spawned agents authenticate with a **node-issued bearer
  token** (from `auth_sessions`), delivered to agent sessions via the manifest env, scoped
  to the agent's `team_member` identity … **Tokens are revocable** (session row deletion) and
  expire per R6 lifecycle."*
- **R6** account lifecycle (`02-NODE-AND-GATEWAY.md:53`): *recovery* — *"node admin resets
  credentials"*; *revocation* — *"disabling an account kills gateway sessions and bridge
  tokens; **the member entity and authored history remain**"*; *re-key* — `identity_id`
  opaque and immutable.
- **Phase 2** (`10:61`): the remote-facing auth surface is the gateway's; *"None of this is
  reachable in v1: there is no remote surface (S1)."*
- **AM-4** (`STATE.md:87`) deferred all of it past G1A: *"v1-now security = bind 127.0.0.1,
  nothing else."*

### What an authentication design must cover

1. **First-run / owner setup.** Today's silent auto-owner produces an account named
   `owner`/`Owner` with a null password that the user never sees, names, or consents to. A
   design must decide whether first run is (i) invisible-and-loopback-only forever,
   (ii) a "name yourself" step, or (iii) full credential creation. This is a *product* fork,
   not a UI detail: (i) means the account is undisplayable, which collides with 3.2.
2. **Login screen** for the moment S1 stops holding (non-loopback bind, hub, hosted
   workspace, mobile thin client per R23). Username/password per `service.ts`; the account
   store already models `is_owner` / `is_node_admin` / `status`.
3. **Unauthenticated + expired-session states** — the states the brief §11 inventory never
   enumerated. Includes the WS/PTY socket dying on token expiry mid-terminal.
4. **Logout** (no concept exists anywhere; note `STATE.md` records no logout op).
5. **Token/session management UI** (S8 says tokens are revocable — nothing surfaces them;
   `service.ts:307` `listSessions` exists and is uncalled).
6. **The honest-posture banner.** Today `packages/ui/src/real/ModeBanner.tsx` states
   REAL/MOCK/unbuilt-op-count. The security posture ("this node trusts anything on
   loopback") is not stated to the user anywhere.
7. **Onboarding.** Nothing exists. Note the corpus *assumes* onboarding is solved by the
   product itself — brief §10 WF5: *"new member joins → **Home explains itself** … Zero
   tribal knowledge needed."* That is an onboarding *philosophy* (self-explaining Home +
   Graph + pinned shelf) and it is the one asset a design can build on.

**Backend/contract concepts it must expose:** `identity.get` (`catalog.ts:32`, GET
`/v2/identity`, **implemented**, `facade/index.ts:88`) — the only account-facing op in the
81-op catalog. Everything else needed does **not exist as an operation**: no `auth.login`,
no `auth.logout`, no `auth.sessions.*`, no `accounts.*`. The error taxonomy already carries
`unauthenticated` → 401 (`contract.ts:320-335`) but nothing in the live path raises it.
`http/types.ts:22-29` already types `kind: 'auto-owner' | 'bearer' | 'anonymous'` with an
unused `token?: string`. **So an auth UI is blocked on contract work first** — a
Vega-approved post-freeze amendment.

---

## 3.2 ACCOUNT / IDENTITY — profile, credentials, acting-as, node-admin

### Verdict: **(c) NO DESIGN EXISTS** — with one adjacent surface that is *not* the same thing.

**The adjacent surface** (do not confuse them): brief §9 Team row and `ui-plan/01:219`
design a **member profile Z4** (wall thread, team_member org tree, their work, their score)
and a **team_member profile** (identity, memories, equipped spells/skills, work history).
Those are *entities inside a space* — `member` is *"that human's presence in a space"*
(`COLLAB_V2_ENTITY_GRAPH_DESIGN.md:433-437`, three layers: User → Member → TeamMember).
The **account** (the User layer — the thing you log in as, that owns credentials, that spans
spaces, that carries `is_node_admin`) has **no UI design at any zoom level**.

**Evidence of absence:**
- No account/profile/preferences screen in brief §9, `ui-plan/01` L5, `ui-plan/02:121-123`,
  or `packages/ui/src/collab-v2/screens/` (9 dirs, none of them account-shaped).
- **The UI never asks who it is.** `identity.get` is one of the 28 implemented ops and
  `packages/ui/src/real/RealFacade.ts` never calls `/v2/identity`. There is no viewer name,
  avatar, or account menu sourced anywhere today. (`SpaceNavigation.viewer: ActorSummary`
  exists at `contract.ts` — a *space* viewer, again not the account.)
- `packages/ui/src/real/` in full: `RealFacade.ts`, `TmClient.ts`, `capabilities.ts`,
  `SpacePicker.tsx`, `SpawnDialog.tsx`, `SessionTerminal.tsx`, `tm8Kinds.tsx`, `events.ts`,
  `ModeBanner.tsx` (+ `terminal/`). No account component.

**Acting-as** is fully specified as *mechanism* and never as UI:
- `03-CONSUMER-SURFACES.md:87`: *"requests may name `actorId` (a team_member persona); the
  backend proves the signed-in user owns it (`can_act_as`). **Agents therefore act as
  themselves with human-anchored auth**."*
- `STATE.md:199` (claims contract, RULED): *"Identity block still computes full ClaimSet
  server-side for facade capability gating + **acting_as pre-verification (UX pre-check;
  RLS is authority)**."* ← a UX pre-check with no UX.
- `packages/server/src/facade/context.ts:53-65` binds `tm8.actor_id` **only** when the
  request body explicitly carries one. Nothing in the UI ever sets it, so **every human
  action in tm8 today is authored by the owner and nothing can be authored as a persona
  from the UI.**
- `contract.ts` `CommandContext` carries `actorId` on every command — i.e. the contract has
  an actor-switcher-shaped hole in every mutation and no design fills it.

**Node-admin** is a first-class role in the architecture and has zero surface:
- `01-LAWS.md:52` (T-L7): *"**Node-level roles (node admin: accounts, invites, resource
  limits) are distinct from space-level roles (owner/admin/member) and never mixed.**"*
- `05-DECISIONS.md:15` (T-D9) same.
- `02-NODE-AND-GATEWAY.md:38`: gateway-on makes the operator *"additionally **node admin**"*;
  `:48` [R5]: *"**Execution is disabled by default on hosted workspaces** — enabling it is a
  node-admin capability per workspace, never a space role."*
- `:53` [R6]: node admin resets credentials; disabling an account kills sessions/tokens.
- DB: `accounts.is_node_admin` exists (`STATE.md:153` names the real column) and the claim
  `tm8.node_admin` is one of the four trusted GUCs (`identity/claims.ts:37-42`).
  `10-SECURITY-MODEL` F1 (`STATE.md:199`): *"`ensure_account` raises 28000 unless
  zero-accounts-first-run or node-admin caller."*

So the node-admin *authorization* exists end-to-end in the DB and there is no screen through
which a node admin can do a single one of the things the docs say a node admin does.

### What an account/identity design must cover

1. **Viewer identity in the chrome** — who am I, which account, which node. Nothing today.
2. **Account profile**: display name, avatar, email (nullable in `ensure_account`),
   `identity_id` (opaque, immutable — must be *shown* but never editable, per R6 re-key).
3. **Credentials**: set/change password (`service.ts:212-236` `verify`, `:325`
   `resetCredentials`); the first-run null-password case must be reconciled with 3.1.
4. **Sessions/tokens**: list, revoke (`service.ts:303-311`), including the agent bearer
   tokens S8 issues per spawned session — a user should be able to see and kill them.
5. **Acting-as switcher**: pick a `team_member` persona to author as; must be visually
   unmistakable (brief §2.5 "peers with provenance") and must respect `can_act_as`.
   Pairs with the palette (brief §4.4 is the keyboard path for everything).
6. **Node-admin console**: accounts list, create/disable/enable/reset, node-admin grant,
   per-workspace execution enable [R5], resource limits.
7. **Account ≠ member disambiguation** in the UI language — the corpus's own three-layer
   model is subtle and today's UI has no word for the top layer.

**Backend/contract concepts to expose:** `identity.get` only. **No `accounts.*` family
exists in the 81-op catalog.** Node-admin ops, credential ops, session-list ops, and an
acting-as capability read all require new contract operations. `EntityState` for `member`
(`contract.ts:91`) carries `role: 'owner'|'admin'|'member'` — that is the *space* role, not
the node role; a design that renders node-admin from it would be wrong.

---

## 3.3 COLLAB — space management, membership + roles, invites, sharing

### Verdict: **(b) PARTIALLY SPECIFIED** — contents enumerated, flows absent.

### What IS covered

**A Space-settings screen exists as a named surface with a content list** — in four places,
each one line:

- brief §9: *"**Space settings** | Members/roles, invites (link/code), space profile |
  **Existing v1 parity**."* ← the entire design; "v1 parity" defers to an app being replaced.
- `ui-plan/01:226`: *"Members/roles, invites, space profile, **task-axis management
  (add/edit manual axes)**."*
- `COLLAB_V2_UI_DATA_CONTRACT.md:198`: `GET /v2/spaces/:spaceId/settings` → *"space
  profile, members/roles, invite summaries, task axes | **Settings commands require admin
  capability**."*
- `05-COHERENCE-MATRIX.md:26`: → `spaces.get/update`, `spaces.members.list`,
  `spaces.invites.*`, `spaces.taskAxes.*`, *"admin capability gated"*.

**Its data shape is fully specified** — `contract.ts:585-591` `SpaceSettings { space,
members: [{actor, role: 'owner'|'admin'|'member', joinedAt}], invites: [{id, code, maxUses,
uses, expiresAt, revoked}], taskAxes }`. So *what to render* is unambiguous.

**And it was built** — `packages/ui/src/collab-v2/screens/settings/` ships
`SettingsScreen.tsx`, `SpaceProfileSection.tsx`, `MembersSection.tsx`, `InvitesSection.tsx`,
`TaskAxesSection.tsx` (owner Harbor, `ui-plan/02:98,123`).

**Space switching** is in the nav model: brief §5 *"Space switcher (far-left icon rail:
spaces + inbox + home)"*; `ui-plan/01:172` *"Icon rail (spaces + Inbox unread dot + home)"*;
`COLLAB_V2_UI_DATA_CONTRACT.md:188` gives it `spaces.list` + `spaces.navigation`.
Bootstrapping is real in code: `packages/ui/src/main.tsx:45-59` lists spaces, honors a
`#space=` hash, falls back to `spaces[0]`, and renders `SpacePicker.tsx` (114 lines:
loading / failed / no-spaces / choose / create) until a space is chosen — **the only
pre-shell screen that exists in tm8**, and it was written in the wiring lane, not designed.

**Invites exist as a data design** — `01-DATA-MODEL.md:34`: `space_invites (code, max_uses,
use_count, expires_at, revoked_at)` with RPCs `create_invite` (admin) / `revoke_invite`
(admin) / `redeem_invite` (*"creates member entity+row+counter, idempotent per user"*);
`COLLAB_V2_ENTITY_GRAPH_DESIGN.md:486-487`; `01-LAWS.md:25` files invites under
*"operational"* side tables.

**Roles are specified** — `COLLAB_V2_ENTITY_GRAPH_DESIGN.md:697`: *"**Role gates:** space
settings, invite management, member removal → `owner`/`admin`"*; capability gating is a
contract citizen (`EntityCapabilities`, `/actions`, `03-CONSUMER-SURFACES.md:11`:
*"the UI greys a button"*).

### What is NOT covered

| Missing | Note |
|---|---|
| **Space creation flow** | `spaces.create` and `CreateSpaceInput {name, description?, visibility?: 'private'\|'public', githubRepo?}` (`contract.ts:513-518`) exist. No doc designs the form, and **nothing anywhere designs a UI for `visibility: public`** — yet `01-DATA-MODEL.md:175` warns *"`spaces` SELECT blocks public-space rows even for discovery"* and the entity-graph design has `discover_public_spaces` / `join_public_space` (`01-DATA-MODEL.md:20`). **Public-space discovery + join is a designed backend concept with zero UI concept.** |
| **Invite *send* flow** | "link/code" is the whole spec. No design for: generating, choosing max-uses/expiry, copying, revoking, or what the recipient receives. |
| **Invite *redeem* flow** | **The biggest hole in this surface.** `spaces.invites.redeem` is `POST /v2/invites/redeem` (`catalog.ts:44`) — a **space-less route**, i.e. it is reached by someone who is not yet in the space. There is no design for the landing surface, no URL scheme (the nav model's URLs are all `#/s/{space}/…`), and no design for the unauthenticated-recipient case, which collides directly with 3.1's total absence of auth UI. brief §10 WF5 opens with *"new member joins"* and never says how. |
| **Member management actions** | Roles are listed for *display*; no design for change-role, remove-member, transfer-ownership. `COLLAB_V2_ENTITY_GRAPH_DESIGN.md:697` names "member removal" as a role-gated action with no surface. |
| **Sharing** (what "sharing" means as an act) | `05-DECISIONS.md:14` (T-D8) / `02-NODE-AND-GATEWAY.md:21`: *"Space = the unit of sharing. **Inviting someone shares *a space*, nothing else.**"* So sharing ≡ inviting — and inviting has no flow. Separately, **terminal sharing** (`share_mode`, `02:82`) and **saved-view sharing** (`shareMode: 'private'\|'space'`, `contract.ts:505-510`) are two more sharing acts with no designed affordance. |
| **Leaving a space / space deletion / archive** | No op, no design. |
| **Restricted visibility chrome** | brief §11 requires the chrome to tolerate a future `restricted` badge *"without layout change"* (A4). The badge slot is designed; nothing that *sets* visibility is. |

### The severity multiplier: the built screen is backed entirely by 501s

Of the operations `05-COHERENCE-MATRIX.md:26` maps this screen to, **every single one is
unimplemented**: `spaces.update` ⛔, `spaces.settings` ⛔, `spaces.members.list` ⛔,
`spaces.invites.list/create/revoke/redeem` ⛔⛔⛔⛔, `spaces.taskAxes.list/create/update/
delete` ⛔⛔⛔⛔ (verified against `packages/server/src/facade/index.ts:86-125`;
`packages/ui/src/real/capabilities.ts:50,53` marks `getSettings`/`getTaskAxes` unavailable;
`RealFacade.ts:274-282` synthesizes settings from `/v2/spaces/:id` alone).
**Space settings is the most complete screen in the mock-era UI and the least connected one
in tm8.**

### What the design must cover, and what it must expose

Cover: create-space (incl. the private/public fork and what public means), switch/reorder
spaces, space profile edit, member list + role change + removal + ownership transfer,
invite create (max-uses/expiry) + copy + revoke, **invite redeem as a first-class
entry-point surface with its own URL and unauthenticated path**, public-space discovery +
join, leave/archive/delete, and the "you are not an admin" degraded rendering.

Expose: `spaces.list/create/get/update`, `spaces.navigation`, `spaces.settings`,
`spaces.members.list`, `spaces.invites.list/create/revoke/redeem`, `spaces.taskAxes.*`
(all in `catalog.ts:33-48`); DTOs `SpaceSummary`, `SpaceNavigation`, `SpaceSettings`,
`CreateSpaceInput`, `UpdateSpaceInput`, `TaskAxis` (`contract.ts:513-591`).
**Missing from the catalog and needed:** member role change, member removal, ownership
transfer, leave-space, public-space discovery/join. Those are new operations.

---

## 3.4 PROJECTS management — create/link/unlink, working dirs, worktrees, TRUST

### Verdict: **(c) NO DESIGN EXISTS.**

Projects are **not in the UI corpus at all** — and the reason is chronological. The brief,
the UI data contract, the entity-graph design and both ui-plan docs are all pre-tm8; the
`project` resource entered the architecture on 2026-07-25 via the AM-2 implementation review
(`05-DECISIONS.md:26` T-D22; `STATE.md:72`), which is **after** every UI document was
written. So no UI document could have covered it, and none was amended to.

**What exists is architecture + contract, and it is complete:**

- `02-NODE-AND-GATEWAY.md:9-18` (container hierarchy): *"linked **PROJECTS** (repos /
  working dirs) — **many-to-many** with spaces: a space can link multiple projects; a
  project can appear in multiple spaces. **Projects are linked resources of a space, not
  containers.**"* Superseded "one space per project" per `05-DECISIONS.md:23` (T-D17).
- `STATE.md:72` (AM-2 P0-1): *"**Projects first-class:** `project` resource (repoUrl,
  workingDir, trust level), `space_projects` many-to-many, `projects.*` operation family,
  working-dir/worktree semantics; `execution.spawn` takes a real projectId, not an untyped
  ref."*
- `contract.ts:628-696` — `ProjectResource {id, name, repoUrl?, workingDir, trust,
  defaults, createdAt, updatedAt}`; `ProjectTrustLevel = 'trusted' | 'untrusted'`;
  `ProjectDefaults {model?, agentTool?, mode?}`; `ProjectCreateInput` (*"**Defaults to
  'untrusted' — trust is an explicit grant.**"*); `ProjectUpdateInput`; `ProjectLinkInput`;
  `SpawnWorkdir {mode: 'project'|'worktree', baseRef?}`. Note `contract.ts:628-633`
  explicitly says a project **is not an entity** — *"no hierarchy, edges, messages, or
  reactions"* — which means **projects are the one first-class noun in tm8 that cannot be
  rendered by the entity component contract.** Under T-L2's composition maxim a projects
  surface is, strictly, a surface the laws don't have a shape for. That is a real design
  question, not a technicality.
- Ops (`catalog.ts:98-103`): `projects.list/create/get/update/link/unlink` — five of six
  **implemented** (`facade/index.ts:98-102`); `projects.unlink` ⛔.

**The trust gate is the part that most needs UI, and it has exactly one sentence:**

`10-SECURITY-MODEL.md:40` (S12): *"A `project` carries `trust: trusted|untrusted` (AM-2).
Spawning into an `untrusted` project requires an explicit per-spawn confirmation flag
(`confirmUntrusted: true`); manifests for untrusted projects note the trust level so agent
prompts can warn. **v1 does not sandbox — trust is informed consent, and that is stated
honestly in the UI copy.**"*

That is the only sentence in the entire corpus that assigns UI copy to a project concept —
a copy obligation with no screen. Its acceptance test (`10:68`) is *"Untrusted project spawn
without `confirmUntrusted` → `forbidden`"*. Note also that the contract's
`ExecutionSpawnInput` (`contract.ts:717-738`) **has no `confirmUntrusted` field** — so the
security model's UI-facing consent mechanism is not in the frozen contract.

**Today's reality in code** (the whole projects UI): a picker inside the spawn dialog.
`RealFacade.ts:427-431` `createProject` posts `{ trust: 'trusted', ...input }` with the
comment at `:422-426` that a project created *from this UI* is one the operator just named —
i.e. **the UI silently inverts the contract's untrusted-by-default grant**, exactly the kind
of decision a design should make rather than a facade. `SpawnDialog.tsx:11-13`: *"An
untrusted project is shown and DISABLED with the reason."*

### What a projects design must cover

1. **Where projects live in the shell.** They are workspace-scoped (`POST /v2/projects` is
   not space-scoped) and *linked* to spaces — so they belong to neither the space left-rail
   nor an entity route. This is the first genuinely new navigation question tm8 raises.
2. **Create/register a project**: name, `workingDir` (a filesystem path — needs a picker or
   validated text input; the browser cannot browse the server's disk, so this is a
   server-assisted input with no precedent in the corpus), `repoUrl`, defaults
   (model/agentTool/mode).
3. **Trust grant/revoke as a deliberate, legible act** — with the S12 informed-consent copy,
   and a resolution of the contract-default vs facade-default conflict above.
4. **Link/unlink to spaces** (M2M, both directions: from the space and from the project),
   including what unlinking does to sessions that ran there. `projects.unlink` is 501.
5. **Worktree semantics** (`SpawnWorkdir.mode`, `baseRef`) — the choice between running in
   the working dir and getting an isolated worktree is a per-spawn decision the user must
   understand; there is no design and no explanatory copy.
6. **Path-safety error surfacing** — S11 (`10:39`) says computed paths that escape the
   project root give `invalid_input`; the UI must render that comprehensibly.
7. **Projectless scratch sessions** (`contract.ts:729`) — a modelled mode with no UI concept.

**Expose:** `projects.list/create/get/update/link/unlink`; `ProjectResource`,
`ProjectTrustLevel`, `ProjectDefaults`, `SpawnWorkdir`; `ExecutionSpawnInput.projectId`.
**Needs contract work:** `confirmUntrusted` on spawn (S12 requires it, contract lacks it);
project delete; a working-dir validation/browse op if the path input is to be assisted.

---

## 3.5 CUSTOM KINDS (`c:*`) — defining/editing a kind, and how its entities render

### Verdict: **(b) PARTIALLY SPECIFIED** — *rendering* is designed in one paragraph;
### *authoring* has no design at all.

**Covered — how a custom kind's entities render.** `03-ENTITY-GRAPH-DELTAS.md:49` is the
whole of it, and it is genuinely a design decision, not a hand-wave:

> **UI:** the KindRegistry consumes `entity_kinds` rows and **generates default renderers
> (Z2 = top schema fields; Z3 Content = field list; filters/group-by over jsonb,
> GIN-indexed)**. The registry must accept **runtime-registered kinds** (generated-renderer
> path) — **a compile-time-only registry is insufficient** (review §12).

Reinforced at `09-IMPLEMENTATION-PLAN.md:93` (M2: *"generated default renderers for
`entity_kinds` rows (custom kinds)"*) and `07-ARCHITECTURE-REVIEW.md:84`.

Also covered, and important for what a custom-kind panel looks like:
`03-ENTITY-GRAPH-DELTAS.md:47`: *"Envelope capabilities (hierarchy, edges, messages,
reactions/points, collection views, panel tabs) work with **zero additional wiring**."*
So a `c:*` entity gets the full Z3 chrome — header, action bar, Content/Discussion/
Connections/Activity — for free, and only the **Content tab body** and the **Z2 field
selection** are generated. That is a coherent, small, correct design.

And the constraint that shapes the authoring form:
`03-ENTITY-GRAPH-DELTAS.md:51` [R8]: *"**Fields are scalars only in v1** (`text|number|
bool|date|enum`). There is no `entity_ref` field type … **If a relation matters, it is an
edge, full stop** — the custom-kind panel has the Connections rail for exactly this."*

**Not covered — the authoring surface.** There is no design for:

| Missing | Detail |
|---|---|
| **Where you create a kind** | Not a screen, not a settings section, not a palette action. `entityKinds.create` is space-scoped (`POST /v2/spaces/:spaceId/entity-kinds`, `catalog.ts:140`) so it plausibly belongs in Space settings — whose designed content list (3.3) is *"Members/roles, invites, space profile, task-axis management"* and does not include it. |
| **The kind-definition form** | name (with the enforced `c:` prefix — is the prefix shown? typed? implicit?), icon picker, capability toggles (`capabilities: Record<string, boolean>` — *"which universal capabilities are surfaced (all default on)"*, `contract.ts:866-867`), and the **field-schema builder** (add/reorder/remove field, type, required, enum values). This is a nested repeating form — the most structurally complex form in the product, and the only one with no spec. |
| **Schema evolution UX** | `03-ENTITY-GRAPH-DELTAS.md:52` [R9]: edits are *"additive-or-relaxing by default"*; a **tightening** edit (new required field, narrowed enum) *"is refused unless the space admin runs it as an explicit backfill action."* The contract exposes `allowTightening?: boolean` (`contract.ts:889`). **The "explicit backfill action" is a UI flow named by the architecture and designed nowhere** — including what the admin sees about how many rows are affected. |
| **Grandfathered rows** | `[R9]`: *"reads tolerate missing fields (render empty) … old rows are grandfathered until touched."* Nothing designs how a stale row reads — "empty" vs "not set" vs "predates this field" are three different truths and the corpus picks none. |
| **Kind management** | list/browse existing custom kinds, delete/deprecate (**no delete op exists** — `catalog.ts:139-141` has list/create/update only), promotion-to-core (a migration per T-L4, so arguably no UI — but that should be said). |
| **Creating an entity of a custom kind** | `ui-plan/01:129` requires a per-kind *"creation form schema"* in the registry; for `c:*` that form must be generated from `fieldSchema` too, and no doc says so. |
| **Collection filters over custom fields** | `03:49` promises *"filters/group-by over jsonb"*, but `CollectionQuery` (`COLLAB_V2_UI_DATA_CONTRACT.md:155-170`) has `groupBy?: 'workStatus'|'assignee'|\`axis:${string}\`` — **no custom-field group-by**, and `filters` has no custom-field slot. The designed capability is not expressible in the frozen query DTO. |

### Two hard blockers on the record

1. **Custom kinds currently white-screen the app.** `packages/ui/TRANSPLANT.md:54-79` and
   `STATE.md:120-124`: `registryFor(kind)` *"promises `KindEntry` and can return
   `undefined`"* — *"**Any unknown kind white-screens the app — including any `c:*` custom
   kind, which the contract explicitly supports.**"* The durable fix (a fallback generic
   chip) is an open defect assigned upstream to Atlas. **Any custom-kind design must specify
   the unknown-kind fallback rendering**, which is the same design work.
2. **All three `entityKinds.*` ops are 501** (`catalog.ts:139-141`, none in
   `facade/index.ts:86-125`), and **AM-5 parked the work**: `STATE.md:89` moves *"custom
   kinds runtime UX"* to post-Phase-1.

**Expose:** `entityKinds.list/create/update`; `EntityKindDef`, `CustomFieldDef`,
`CustomFieldType` (scalars only), `EntityKindCreateInput`, `EntityKindUpdateInput`
(`allowTightening`), `CustomEntityKind = \`c:${string}\``, `CustomEntityState`/
`CustomEntityContent {kind, fields}` (`contract.ts:35-37, 107, 154, 845-890`).
**Needs contract work:** kind delete/deprecate; custom-field filtering and `groupBy` in
`CollectionQuery`; a backfill/impact-preview read for the tightening flow.

---

## 3.6 FILES / BLOBS — upload, download, attachments, previews, quotas

### Verdict: **(b) PARTIALLY SPECIFIED** — `file` as an *entity* is designed; the *blob
### lifecycle* has no UI design at all.

**Covered — `file` as a first-class kind:**

- One of the eleven kinds (brief §0), so it gets Z1–Z4 through the registry
  (`ui-plan/01:129`: *"All 11 kinds"*).
- Z2 state shape: `{ kind: 'file'; name; mimeType; sizeBytes }` (`contract.ts:98` /
  `COLLAB_V2_UI_DATA_CONTRACT.md:97`).
- **Drag grammar**: brief §6.2 — *"onto a **task** → `attached_to` (docs/**files**/spells)"*;
  `ui-plan/01:238`: *"doc/file/spell→task = attach"*.
- **Thread attachments**: brief §4.1 — *"**attachments (files)** and entity embeds"*;
  `ui-plan/01:146`. DTO `FileAttachment {fileEntityId, name, mime}` (`contract.ts:160` /
  data contract `:135`); `messages.post` takes `attachments` (`02-API-ARCHITECTURE.md:124`).
- **Channel hub Docs tab** (brief §7) surfaces attached docs; files ride the same
  `attached_to` registry expansion (`COLLAB_V2_UI_DATA_CONTRACT.md:246-257`).
- Storage/authz law: `03-ENTITY-GRAPH-DELTAS.md:80` — blobs under the node data dir,
  *"the same membership checks as the graph (inherited invariant: **graph RLS and blob
  authz must never disagree**)"*; `10-SECURITY-MODEL.md:51` (S17) adds server-generated
  names (*"client-supplied filenames are metadata, never paths"*), checksum verification,
  `X-Content-Type-Options: nosniff`, conservative `Content-Disposition` for non-media.

**Not covered — everything a user does with a file:**

| Missing | Detail |
|---|---|
| **Upload** | No design. The lifecycle is three ops + a raw PUT (`contract.ts:776-832`): `uploadInit` returns a `FileUploadGrant {uploadId, uploadUrl, token?, expiresAt, maxSizeBytes}` → client PUTs bytes → `uploadComplete` verifies size+checksum and creates the `file` entity → `uploadAbort` releases the slot. **That is a three-phase flow with progress, cancellation, expiry and a client-side SHA-256 (`checksumSha256` is required *at init*, so the whole file must be hashed before the first request) — and there is no design for any of it: no drop zone, no file picker, no progress bar, no cancel, no retry.** |
| **Download** | `files.download` (GET `/v2/files/:fileEntityId/download`) is *"the one read that returns raw bytes, NOT the DEV-6 JSON envelope"* (`contract.ts:834-841`). No download affordance is designed anywhere. |
| **Previews** | Nothing. `mimeType` is carried; brief §12 non-goals do not exclude previews; the corpus simply never mentions them. Note the doc kind has `format: 'markdown'\|'mermaid'\|'excalidraw'` (`contract.ts` / data contract `:88`) — so rich rendering is designed for *docs* and not for *files*. |
| **Quotas / limits** | `FILE_MAX_SIZE_BYTES_DEFAULT = 512 MiB` (`contract.ts:797`), overridable per deployment, and the grant carries the effective value — designed to be *shown*, and no design shows it. Error `payload_too_large` is in the taxonomy. (Historical drift: `04-COMMUNICATION-MODEL.md:176` says *"File upload | broker-issued signed URL, **≤ 25 MiB v1**"* — 20× smaller than the frozen contract's default.) |
| **GC / retention / restore** | `contract.ts:790-793`: orphaned slots GC'd after grant expiry; *"a soft-deleted file's bytes remain restorable until then"*. A user-visible retention promise with no surface. |
| **Failure states** | checksum mismatch, expired grant, size refusal, `forbidden` download — none designed. |

**Status:** all four `files.*` ops are **501** (`catalog.ts:106-109`, none in
`facade/index.ts`); `bridge.fetchBlob` is `status: 'reserved'` (Phase 2, cross-node blob
fetch — `catalog.ts:111`, and `07-ARCHITECTURE-REVIEW.md:108` explains why it matters:
without it *"golden workflow 1's 'drags in a design doc' produces a projection with dead
references on every remote node"*).

**Expose:** `files.uploadInit/uploadComplete/uploadAbort/download`; `FileUploadInitInput`,
`FileUploadGrant`, `FILE_MAX_SIZE_BYTES_DEFAULT`, `SHA256_HEX_RE`; the `file` `EntityState`;
`FileAttachment`; `attached_to` edge; `payload_too_large`. **Needs contract work:** a
per-space storage-usage read if quotas are to be shown; thumbnail/preview derivation if
previews are wanted.

---

## 3.7 NODE-LEVEL SETTINGS — ports, sidecar/db, agent commands, concurrency caps

### Verdict: **(c) NO DESIGN EXISTS — and, uniquely, no backend surface exists either.**

This is the only one of the seven where a design cannot even begin without new contract
operations, because **there is nothing in the 81-op catalog that reads or writes node
configuration.**

**Where the settings actually live** (all env-var or hardcoded; `docs/ops/CONFIG.md:52`:
*"All configuration is environment variables, prefixed `TM8_`"*):

| Setting | Mechanism | Location |
|---|---|---|
| Bind host | `TM8_BIND` (loopback-enforced) | `packages/server/src/http/config.ts:50,58-63` |
| HTTP port | `TM8_PORT` = 4610 | `http/config.ts:51`; `ops/CONFIG.md:67` |
| UI dev port | `TM8_UI_PORT` = 4611 | `ops/CONFIG.md:68` |
| Sidecar PG port | `TM8_PG_PORT` = 5442 | `ops/CONFIG.md:69` |
| Data dir | `TM8_DATA_DIR` (`~/.tm8` / `~/.tm8-dev`) | `ops/CONFIG.md:66` |
| Log level | `TM8_LOG_LEVEL` | `ops/CONFIG.md:70` |
| Max body | `TM8_MAX_BODY_BYTES` = 8 MiB | `http/config.ts:66` |
| Database URL | `TM8_DATABASE_URL` (unset ⇒ **no handlers registered at all**, every op 501) | `http/config.ts:76`; `main.ts:70,86-92` |
| **Agent command** | `TM8_AGENT_CMD` | `packages/execution/src/spawn/manifest.ts:194,207,271` |
| Permission mode | `TM8_PERMISSION_MODE` | `packages/execution/src/spawn/manifest.ts:122` |
| **Session concurrency cap** | **hardcoded `8`**, not even env-configurable | `packages/server/src/facade/execution-handlers.ts:104,342` (`deps.sessionCap ?? 8`); `main.ts:86` passes nothing |

The only introspection endpoint is unenveloped `/health`
(`packages/server/src/http/server.ts:108-122` → `{ok, server, contractVersion, operations,
implemented}`), and `packages/ui/src/real/capabilities.ts:24-25` tells screens to poll it
directly rather than route it through the facade.

**What the architecture says about these knobs, all operational rather than UI:**

- `10-SECURITY-MODEL.md:38` (S10): *"per-node concurrent-session cap (config, **default 8**)
  → `limit_exceeded`"* — a governance minimum, with `limit_exceeded` → 429 in the taxonomy
  (`contract.ts:320-335`; the UI maps it at `TmClient.ts:40,51-52`).
- `10:56-57` (S19/S20): `~/.tm8*` at `0700`; single-instance locking *"records pid+port for
  honest **`doctor`** diagnostics"* — a **CLI** diagnostic, explicitly not a screen.
- `09-IMPLEMENTATION-PLAN.md:83`: sidecar lifecycle per R15 — *"pinned major,
  backup-before-migrate, scheduled `pg_dump`, health-check-then-start, locking"*; `:84` the
  R26 scheduler (retention jobs). All server-side, no surface.
- `STATE.md:68` (AM-1 nuance (b)): *"with 'install the app' gone, the **one-command start
  story** … is a W0/W1 deliverable — **startup UX is part of the definition of done**,
  owned by Altair's sidecar/ops workstream."* The startup UX was scoped to Ops and landed as
  `bun run dev` + `docs/ops/CONFIG.md` — i.e. **as a terminal experience**, which is a
  defensible answer but was never re-examined after AM-1 made the product browser-only.

**Nothing in the UI corpus mentions node settings.** The word "settings" appears in the UI
docs only as *space* settings (`ui-plan/01:22,226`; brief §9; data contract `:198`;
`05-COHERENCE-MATRIX.md:26`).

### What a node-settings design must cover — and the prior question it must answer first

The prior question: **should node settings be a UI at all?** The corpus's implicit answer is
no (env vars + `doctor` + Ops docs), which was coherent when the product was a desktop app
you installed. Under AM-1/T-D21 (browser-only) and Phase 2 (hosted workspaces where the user
has no shell on the box), that answer weakens considerably. That is a decision to escalate,
not to assume.

If it is a UI, it must cover: node status/health (version, uptime, contract version, ops
implemented — `/health` already supplies this), sidecar/DB status (running, port, disk,
last backup, migration version), **backup/restore controls** (S18 requires restore to be
*"a tested path … not a hope"* and there is no surface), **the concurrency cap** as a
readable and editable number (the only setting with direct daily user impact — over-cap
spawns 429 today with no explanation and no place to raise it), **agent command / provider
configuration** (`TM8_AGENT_CMD`, `TM8_PERMISSION_MODE`, model catalogs), bind/port/data-dir
as *read-only diagnostics with restart guidance*, log level, retention/GC policy (R26), and
**the security posture statement** (which of S1–S20 are actually on — today
`security.ts:53-70` says most are no-ops, and the user is told nothing).

**Expose:** nothing exists. Requires a new catalog family — a `node.*` (or `admin.*`) read
op at minimum, gated on `is_node_admin` (`identity/claims.ts:37-42` already carries
`tm8.node_admin`), plus write ops for whatever is made editable. This is a Vega-approved
post-freeze contract amendment before any design can be implemented. **The frozen contract
is why this surface is a hard "no" rather than a "not yet".**

---

# PART 4 — DESIGN DEBT AND CONTRADICTIONS

Places where the corpus disagrees with itself, has been overtaken by amendments, or was
designed for a product tm8 is no longer building.

## 4.1 Documents vendored into tm8 that are factually wrong here

`05-DECISIONS.md:24` (T-D18) inherited the Collab V2 docs as tm8's contract *"(+ T-D3 auth
delta)"* — the delta was applied to the architecture docs and **not** to the inherited docs
themselves, which sit in `docs/` unamended and un-annotated. A UI worker reading them today
is misled:

| Vendored text | Killed by |
|---|---|
| `COLLAB_V2_UI_DATA_CONTRACT.md:26` — *"Reads are scoped by the **authenticated Firebase user** and RLS"* | T-D3 (`05-DECISIONS.md:9`): *"No Firebase, no Supabase, anywhere in tm8"* |
| `:183-184` — mounts at **`/api/collab/v2`**, authenticates with **`X-Collab-Firebase-Token`** | DEV-12 (`05-COHERENCE-MATRIX.md:68`); tm8 mounts at `/v2` (`catalog.ts:28`) |
| `:214` — presence is *"ephemeral **Firebase RTDB** data"*; `:260-262` — *"Durable graph data comes from **Supabase Realtime**… Presence and typing come only from Firebase RTDB"* | DEV-4 (`:60`); `03-ENTITY-GRAPH-DELTAS.md:76`: *"Presence/typing ride the WS bridge (no RTDB)"* |
| `:228-244` — per-kind command routes (`POST /v2/tasks`, `POST /v2/tasks/:id/complete`, `POST /v2/entities/:id/pulls`) | DEV-1/DEV-2 (`:57-58`) — generic `/v2/entities` + `/commands/*` |
| `:267-275` — `WorkspaceEvent` variants keyed by **`eventId`**, and `:263-264` *"must de-duplicate events by `eventId`"* | **Post-freeze W1a**: `STATE.md:160` — *"WorkspaceEvent: **eventId REMOVED**, envelope `{spaceId, seq per-space monotonic, occurredAt, schemaVersion:1}`, cmid on all mutation-derived variants."* The de-duplication key the UI is instructed to use no longer exists. |
| `:299-317` §7 "Availability boundary" — an entire section describing what the *Supabase branch* had deployed | irrelevant to tm8; reads as current status |
| `COLLAB_V2_ENTITY_GRAPH_DESIGN.md` throughout (`:46, :98, :106-107, :133, :701-703`) — Supabase Storage, `auth.users`, RTDB, FCM | T-D3 |

**Debt:** these are the four docs a UI designer would open first. Either annotate them with
a "superseded where" header or vendor amended copies. Compare the care taken with
`04-EXECUTION-TRANSPLANT.md`, which was *"rewritten in place for AM-1/T-D21"* (`04:3`).

## 4.2 Designed for desktop; must be re-thought for the browser (AM-1 / T-D21)

`STATE.md:62-68` and `05-DECISIONS.md:27` (T-D21) removed Tauri mid-W0. The architecture
docs were rewritten; **no UI document was**, because none of them named Tauri — they
inherited desktop assumptions implicitly instead.

1. **Entry point.** A desktop app is launched; a web app is *navigated to*. The nav model
   (brief §5) starts at the space switcher and the URL scheme (`#/s/{space}/…`) has no
   pre-space state — yet a browser needs one for cold-load, invite-redeem (3.3), and any
   future login (3.1). `packages/ui/src/main.tsx:45-59` + `SpacePicker.tsx` invented one.
2. **"Feels right" is a desktop claim.** `04-EXECUTION-TRANSPLANT.md:14` [R28]:
   *"spawn/modal immediacy is what makes **the desktop** feel right"* — carried verbatim into
   a browser product whose event path is now a WS bridge (and, at the transplant snapshot,
   a poll: `TRANSPLANT.md` "Honestly not done"; `STATE.md:136-138` records WS streaming
   shipped later).
3. **Notifications.** `05-DECISIONS.md:28` (T-D20) deferred R14 transport because
   *"nothing in v1 needs one (local nodes use in-app + **OS-native desktop notifications**)"*.
   Browser notifications require a permission prompt and a service worker — a UX with a
   consent step that nothing designs, and the justification for deferring is now false.
4. **Terminal at parity with a *desktop* terminal.** `STATE.md:68` (AM-1 nuance (a)): the G3
   bar *"is measured against old maestro's **desktop** terminal on the same machine"*. Also
   `STATE.md:140`: **"DOM renderer only, forever. No WebGL/Canvas addons"** — which
   contradicts `04:15` and `05-DECISIONS.md:27`, both of which still say *"xterm WebGL on
   Chromium + DOM fallback"*. **This is a live contradiction between STATE.md and the FINAL
   architecture docs**, and STATE.md is right (the root cause is recorded at `STATE.md:140`:
   one GPU context per terminal → browser ~16-context cap → tab-wide compositor stall).
5. **Filesystem paths in a browser.** Projects need `workingDir` (3.4) and old maestro had a
   native picker. There is no design for path entry from a browser.
6. **One-command start.** `STATE.md:68` made startup UX part of the definition of done and
   assigned it to Ops, who delivered a terminal story (`docs/ops/CONFIG.md`). For a
   browser-only product, "how does a non-technical user start this" is unanswered.
7. **Mobile.** brief §12 declares mobile layouts a **non-goal** (*"separate pass; keep
   components mobile-decomposable"*); `00-VISION.md:3` [R23] brings maestro-mobile in as a
   Phase-3 thin client. Not a contradiction yet, but the "mobile-decomposable" obligation is
   an untested claim about components built to a desktop layout spec.

## 4.3 AM-3 — the UI moved into gate G1A, and doc 09 still says the opposite

`STATE.md:83` (AM-3): *"**Gate G1A includes the NEW UI, wired.**"*
`09-IMPLEMENTATION-PLAN.md:87` (G1) still reads: *"This gate is the whole ballgame;
**nothing UI- or execution-shaped starts until it's green.**"* — and G1 (full conformance)
never happened; 28 of 80 ops are implemented (`capabilities.ts:4`).

The consequence is the defining fact of tm8's UI today: **the UI was wired to a backend that
implements roughly a third of the contract**, and the wiring lane had to invent a
degradation policy to survive it — `packages/ui/TRANSPLANT.md` "Degradation policy — three
classes, not two": unbuilt reads → typed empties; unbuilt writes → rejected
`not_implemented`; **hollow fields → prefer hiding the affordance** (*"A real '0 unread' and
an unbuilt '0 unread' are pixel-identical and only one is true"*). **That policy is real
design work, produced under wiring pressure, that no design document contains** — and it now
governs how most screens read. It belongs in the design corpus.

Also note the ordering inversion this created: `09:91` scheduled the transplant *"after
Atlas's W5 completes (T-D18)"*; AM-3 (`STATE.md:84`) pulled an **early snapshot** at W2
kickoff, and `packages/ui/TRANSPLANT.md` records the snapshot at `b422978`
("W5 — Sentinel acceptance suite"). The final re-sync Atlas owns has not happened.

## 4.4 AM-5 — most of the designed register is parked, indefinitely

`STATE.md:89` (AM-5) moves to post-Phase-1: *"channels/inbox/collections polish, **custom
kinds runtime UX**, points/awards surfaces, full 73-op conformance green, **golden
workflows**, Postgres FTS search, old-maestro import"*. `STATE.md:5`: *"**work is
STOPPED**"*.

So the five golden workflows — *"they are the acceptance tests"* (brief §10) — are parked,
and the gates that cite them (G1/G2/G3, §Finding 0) cannot close. This is a deliberate,
user-directed trim, not a defect; the audit should record it as **the reason the designed
register and the shipped surface diverge so far**, and as the fact that makes a UI gap audit
worth doing now.

## 4.5 Internal contradictions in the design itself

1. **Eleven kinds vs thirteen-plus.** Every UI document says *"All 11 kinds"*
   (`ui-plan/01:129`, brief §0). tm8's contract has **13 core kinds** —
   `+ work_session, collection` — plus unbounded `c:*` (`contract.ts:28-37`). So the Entity
   Component Contract, the corpus's central artifact, **has never been specified for three
   of the kinds it must render**. This is exactly the defect that white-screened the app
   (`STATE.md:112-124`; `TRANSPLANT.md:54-79`), and `registryFor` returning `undefined`
   remains open.
2. **The palette is the front door, and search is deferred.** brief §4.4 makes ⌘K
   *"the graph's front door"* built on *"Universal search"*; D12/DEV-13
   (`00-OVERVIEW.md:64`, `05-COHERENCE-MATRIX.md:69`) defer search entirely, leaving the
   palette *"recent/known entities"*. `search.query` is `status: 'reserved'`
   (`catalog.ts:95`) and the registry **refuses** to register it. AM-2 partially un-deferred
   it to 1B as Postgres FTS (`05-DECISIONS.md:26`); AM-5 re-parked it (`STATE.md:89`).
   The designed front door cannot do its job, and no fallback design exists.
3. **Home is space-scoped; R25 requires workspace-scope.** brief §9 Home is per-space;
   `09-IMPLEMENTATION-PLAN.md:158` [R25] requires a *"workspace-scope collections variant
   for Home/Inbox"*. **A workspace-level Home — the first thing a user sees when tm8 has
   several spaces — is not designed**, and `HomeSnapshot` (`contract.ts`) /
   `spaces.home` (`catalog.ts:38`) are space-keyed.
4. **Agent progress has two anchors.** brief §10 WF2 puts progress in the **task** thread;
   `04-EXECUTION-TRANSPLANT.md:34,47` puts it on the **work_session**. Nothing reconciles
   which thread the human reads (see 2.6).
5. **Modals cannot be composed.** `03-ENTITY-GRAPH-DELTAS.md:72` makes `session_modals`
   *"never an entity"*; T-L2's maxim forbids surfaces not composed from entity components.
   Old maestro's agent-modal UX therefore has no lawful home in tm8's design (see 2.9).
6. **Projects are a first-class noun that is not an entity** (`contract.ts:628-633`) — the
   same tension, for the surface in 3.4.
7. **Custom-field filtering is promised and not expressible.** `03:49` promises
   *"filters/group-by over jsonb"*; `CollectionQuery` has no slot for it (see 3.5).
8. **Space-settings is designed, built, and 100% 501-backed** (3.3) — including
   `spaces.update`, so *"space profile"* is unwritable.
9. **File size limit drift:** 25 MiB (`04-COMMUNICATION-MODEL.md:176`) vs 512 MiB
   (`contract.ts:797`).
10. **`confirmUntrusted` is required by the security model and absent from the frozen
    contract** (3.4) — the one place where a security control's UI mechanism has no wire
    representation.

## 4.6 Debt the transplant lane surfaced that the design corpus should absorb

From `packages/ui/TRANSPLANT.md` — all of it real design content produced outside the design
process:

- The **three-class degradation policy** (4.3) and its rule *"the right axis is user-invoked
  vs automatic, not read vs write"* (the `markRead` exception).
- **The permanent mode/gap banner** — *"A permanent banner states which world the app is in
  and how many operations are unbuilt, so a gap is never silent."* An honesty affordance
  with no design-corpus equivalent.
- **"No terminal" as a deliberate statement**: *"Session status is polled and the panel says
  so, in those words. There is no PTY route on this node; **an empty black rectangle would
  imply a live-but-quiet stream.**"* — a genuine design judgement about a surface that has
  no design (Part 2).
- The two silent-corruption failure modes of PTY attach (offset must snap to
  `AttachResult.next`; a `snapshot` replay must not be re-parsed as a `delta`), later shipped
  per `STATE.md:136-138`.

---

# Bottom line

- **Two of the seven surfaces have no design of any kind and no operations to build
  against**: authentication/onboarding (3.1) and node settings (3.7). Node settings is the
  harder blocker — it needs a frozen-contract amendment before design can be implemented.
- **Two more have no design but do have a complete contract**: account/identity (3.2, one
  op: `identity.get`, which the UI never calls) and projects (3.4, six ops, five
  implemented). These are the cheapest wins.
- **Three are partial**: collab/spaces (3.3 — contents listed, every flow missing, and the
  built screen is 100% 501-backed), custom kinds (3.5 — rendering designed in one paragraph,
  authoring not at all), files (3.6 — the entity designed, the blob lifecycle not).
- **`work_session` — the kind that makes tm8 tm8 — has no UI design** (Part 2): no screen,
  no spawn UX, no prompt-delivery affordance, no terminal placement, no multi-session view.
  The corpus predates the kind; the two words *"SPAWN affordance"* (`ui-plan/01:219`) are
  the entire spawn design.
- **The master UI spec is not in the repo** (Finding 0), so tm8's own gates cannot be read
  from tm8's own docs.
