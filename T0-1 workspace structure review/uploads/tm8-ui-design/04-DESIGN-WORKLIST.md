# 04 — Design Worklist (ranked)

Everything that needs visual design, ranked by what it blocks. Tier 0 blocks the shell — nothing can be accepted without it. Each item states its requirements; the geometry behind items lives in `02-LAYOUT-SPEC.md`.

Legend: every item must be designed in **light AND dark**, at full width AND at its narrowest legal state, with **worst-case content** (UUID-length titles, 50-edge rails, 10k-message threads).

---

## TIER 0 — blocks the shell (design first)

### T0-1 · The shell + workspace wireframe (the master screen)
Space tab bar · menu rail (expanded 220 / collapsed 48) · workspace view: left list panel, center (live-session bar + up to 3 pinned + 1 stacked detail panel), right list panel. This screen becomes the approved reference the whole build is measured against. Requirements: 02 §1–2; empty-center state (02 §2.2) included.

### T0-2 · Terminal chrome strip
The one pixel-frozen region. A single compact row above the terminal canvas: session identity (persona name, provider), live/exited status word + dot, and the visible **"exit terminal (⌃`)"** chip. Must survive 320px panel width. Also design the **exited fallback** (read-only status + transcript link replacing the canvas). The canvas below it is a black box — do not design inside it.

### T0-3 · EntityListPanel — the universal list primitive
One component, per-kind configured. Design the anatomy: kind selector · header row (Create, quick-launch, live count) · filter/sort chips · tile list. Then its two hardest kind configurations:
- **Tasks:** current/completed sections, hierarchy expansion, inline status change, priority badges, Run/Coordinate primary actions.
- **Sessions:** lifecycle tabs (open/done/archived), the nested coordinator→worker tree with guide lines, live dots (solid=alive, pulsing=streaming), "stale — node restarted" rows, a "NEEDS YOU" group sorted above idle, `● N live` count.
Other kinds (docs, teammates, pulls…) are lighter variants of the same anatomy.

### T0-4 · EntityDetailPanel chrome
The fixed Z3 anatomy (02 §3): header (breadcrumb, glyph, inline-editable title, status pill, overflow/pin/promote/close), action bar, the four tabs, footer. Plus the work_session Content layout with the reserved toolbar seam (02 §3.1).

### T0-5 · Live-session bar + roster
The fixed center top row (`● forge — 3 live`) and the roster it opens (also the empty-center state). A running agent must never be invisible.

---

## TIER 1 — blocks navigation & responsiveness

### T1-1 · Menu rail rendering grammar
Three row types: label-only group header (never clickable) · plain row (view or kind ref) · **caret view row** (row click opens the view; caret expands ≤8 child rows, exactly one level). Collapsed 48px state: icon-only for every ref — an icon system for views AND entity kinds is required. Active state, unread/count badges, the expand/collapse toggle.

### T1-2 · Command palette
Search + jump to entities and views; context actions; and the **disabled "not available yet" discovery row** for deferred features (Leaderboard, Activity) — visible, labeled, not clickable.

### T1-3 · Responsive states
The right-stacked, both-stacked, and full-width-sheet modes (02 §5). These have equations but zero design. Include: how a stacked side panel collapses/expands, sheet enter/dismiss, and where the live-session bar goes at phone-ish widths.

### T1-4 · The honesty vocabulary (used everywhere, design once)
- **Disabled-with-reason:** any affordance whose backend isn't available renders disabled with a short reason (tooltip + inline caption pattern).
- **Hollow-value caption:** a permanently-zero stat says why ("no data on this node yet").
- **Overflow notice:** one toast pattern for "some panel/pin/filter state wasn't carried in this link".
These three are a single visual family; they are the difference between "broken" and "honest" for every unbuilt feature.

### T1-5 · Panel-stack behaviors on non-workspace views
The right-edge peek (~440px), stacking with breadcrumbs, pin-to-split, promote-to-full transition, swipe/Esc pop. Mostly exists in the old UI — needs a refreshed pass consistent with T0-4.

---

## TIER 2 — domain-config & settings surfaces (design exists for none)

### T2-1 · Space settings
Sections: space profile · members/roles · invites (create/list/revoke + the **redeem landing page** for someone not yet in the space) · task axes · Linked Projects (T2-2) · Menu editor (T2-3).

### T2-2 · Projects & trust
- **Space settings → Linked Projects:** link/unlink projects into the space; unlink refusal states ("blocked: 2 live sessions still use this root").
- **Node admin → Project Registry:** create/edit projects (working dir, repo URL, trust level); the over-cap "link frozen" badge with its actionable list.
- **Trust is safety UI:** untrusted projects render with the consequence stated ("agents cannot run here until you trust it"); the confirm-untrusted consent moment; scratch sessions (no project) labeled as sandboxed/untrusted.
- Sessions ↔ projects are many-to-many: a session detail shows its associated projects (editable chips) plus an immutable "launched from" provenance line — two different things, visually distinct.

### T2-3 · Menu editor
Admin UI for the per-space menu config: reorder groups/items, add view/kind refs, one-level children under a view row, rename groups. Conflict state ("menu changed by someone else — reload"), and the "edited by a newer version" locked state.

### T2-4 · Interaction Profiles
A restricted entity kind: list + detail with lifecycle states (draft → active → retired), preview, and defaults (per-teammate, per-space). Most generic actions are disabled-with-reason (T1-4 vocabulary). Sessions show their pinned profile as immutable provenance.

### T2-5 · Custom-kind authoring
Define a kind (name, icon, field schema) → its entities render through the generic chip/card/panel automatically. Includes the fallback rendering for an unknown kind (generic glyph card).

---

## TIER 3 — never-designed product surfaces

### T3-1 · Auth & first-run
Login screen · first-run owner setup (name yourself, name the node, create first space) · logout/expiry state. Today the app silently auto-signs-in on localhost; these screens are required the moment tm8 leaves one machine.

### T3-2 · Onboarding / orientation
First-open orientation for a new member: what a space is, where agents live, the click-anything grammar. Lightweight — the empty states carry most of the teaching.

### T3-3 · Account menu
"Who am I" affordance (currently a bare text label), profile edit, and the seam for acting-as.

### T3-4 · Files
Upload (drag/picker + progress), attachment chips on messages/tasks, download, preview (image/pdf/text), failure states.

### T3-5 · Node settings & status
Server/database/agent-host health (a rich health payload already exists), agent command config, concurrency cap display ("8 slots, 3 in use"), data/backup.

### T3-6 · Graph canvas
The showcase view: any collection as an actual graph — Z2 cards as nodes, typed directional edges, hierarchy as containment, dependency mode (topological, blocked = red path), focus mode (entity + N hops), click node → panel stacks. Designed as a concept in the corpus; never visually designed.

### T3-7 · Inbox
Notification list with read state, grouped by type (mentions, assignments, replies, delivery failures), personal vs teammate audience separation, click-through behavior.

---

## TIER 4 — cross-cutting states (a matrix, not screens)

Design one canonical treatment each, applied everywhere:

| State | Requirement |
|---|---|
| Empty | Teaches the grammar in place ("no tasks linked yet — drag one here or press /") |
| Loading | Skeleton chips/cards/tiles; panels never blank-flash |
| Tombstone | Soft-deleted entities keep their place as labeled tombstones in threads/rails/feeds |
| Stale | Pulled/pinned content shows "v7 pinned · content v9 → stale" + one-click re-pull |
| Offline / reconnecting | Read-only cached views, queued-state banner, disabled sends |
| Error | Per-panel error boundary card (the app never white-screens); retry affordance |
| Conflict | "edited by X just now" toast (last-write-wins; no merge dialogs) |
| Share/handoff states | The drag-onto-session ghost label; the two-facet result (delivery: delivered/refused/**unknown** — unknown is a warning, never styled as success; record status separate); the withdrawn badge (decorates, never rewrites history); `sourceMissing` |
| Permission-lost | Non-leaking "you can't see this" state (no titles/counts leak) |

---

## PHASE 2 (spec'd, sequenced last — do not block anything on these)

- **P2-1 · Chat surface:** the Terminal|Chat switch in the reserved toolbar seam; message bubbles with provenance labels ("To/From this session"); artifact cards; state-change rows; collapsed low-level mutation groups; the 8-state delivery badge set (pending / sending / delivered / failed-retryable / failed / unknown / expired / cancelled); composer with reply context + attachments; "Send again" (never "Retry") affordance; every loading/empty/failure state. Full behavioral spec exists in the repo (`TM8-CHAT-UI-AND-LAYOUT-DESIGN.md`).
- **P2-2 · Server rail:** the 48px multi-server rail (Discord-style) for when tm8 connects to more than the one local server.
- **P2-3 · Leaderboard & Activity screens**, saved-views & axes management UI.
- **P2-4 · Multi-terminal dock / Team-view grid.**
