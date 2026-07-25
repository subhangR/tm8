# tm8 — Workspace Layout & Domain Terminology (DRAFT)

**Status:** DRAFT — user-directed design (2026-07-25), pending independent review + Vega adoption. Proposes ONE contract amendment (project → entity kind) and ONE terminology rename (container "workspace" → **hubspace**). Everything else is UI/navigation structure that composes existing primitives.
**Authors:** user + design session `sess_1785002773084_597assyz9`.
**Supersedes (on adoption):** prior nav sketches in the collab-v2 UI plan shell layer; the "two-paradigm" split between the transplanted maestro workspace and the entity/zoom UI — this doc unifies them.
**Does NOT touch:** the entity envelope, edges/messages/reactions machinery, Z1–Z4 component contract internals, execution architecture, terminal streaming model. All inherited unchanged.

---

## 1. Terminology (binding on adoption)

| Term | Meaning | Delta vs current docs |
|---|---|---|
| **server** | A tm8 node the client connects to — local or remote. The top of the navigation hierarchy. | Nav-level name for what 02-NODE-AND-GATEWAY calls a node. |
| **hubspace** | The root container one server instance serves (one owner): space list, identity, sessions. | **RENAME** of the container previously called "workspace". Bridge becomes hubspace↔hubspace; "hosted workspaces" become **hosted hubspaces**. Known naming caution: "hub" also means a gateway-enabled server; accepted by the user, revisit only if it demonstrably confuses. |
| **space** | The sharing/permission boundary with its own entity graph. Unchanged. | none |
| **workspace** | **The three-panel working view inside a space** (entity list \| terminal/detail \| entity list) — the transplanted maestro UI, generalized. | **NEW meaning.** The word no longer refers to the container. |
| **project** | = repository. ONE concept, named `project`. Configured in space settings (repo URL / working dir / trust); **auto-materialized as a first-class graph entity**. GitHub link is a project field. | Promotion from linked-resource to entity kind (§5). "Repository" is not a separate term. |
| **teammates** | `team_member` entities (agent personas + org tree), surfaced in the Workspace nav group. | Nav label only. |
| **members** | Space members (human accounts), surfaced in the Collab nav group. | Nav label only. |
| **feed** | The space's default channel (a real `channel` entity, auto-created). | Convention, not new mechanism. |
| **activity** | The system event stream (graph mutations). **Later scope.** | none |

**Terminology pass requirement:** on adoption, docs 00–06 + STATE.md get ONE complete workspace→hubspace pass. Half-renamed docs are worse than either name — the pass is all-or-nothing.

## 2. Navigation hierarchy

```
SERVERS rail (leftmost)            — local node + connected remotes/hubs
  └─ SPACE tab bar (top)           — the selected server's spaces (maestro ProjectTabBar position)
       └─ SPACE MENU (left rail, collapsible)
            Home        → dashboard · feed · activity(later)
            Workspace   → (click = the composed 3-panel view)
                          tasks · work_sessions · docs · teammates   (each = Entity View)
            Tracking    → projects · pull_requests                   (each = Entity View)
            Collab      → members · leaderboard(later)
            Channels    → channel list → Channel View
```

**Menu semantics (ruled):** clicking **Workspace** opens the composed three-panel view. Clicking a **sub-item** (tasks, docs, projects, …) opens the **Entity View** for that kind. Two different nav targets; the sub-items are NOT pre-selectors for the workspace panels.

Deferred from nav (extend later via the same generic components): spells, skills, collections, files, commits, custom kinds (`c:*`), activity, leaderboard/points.

## 3. The two reusable primitives

Everything below composes exactly two pieces:

1. **EntityListPanel** — kind selector + Create + sort options + tile list (the maestro task-tile shape: expandable, run affordances). Generalizes the transplant's MaestroPanel (tasks) and SessionsSection (sessions) into ONE component parameterized by kind. Used as workspace left panel, workspace right panel, and channel-view entity list.
2. **EntityDetailPanel** — the generic tabbed detail: header · action bar · tabs **Content / Discussion / Connections / Activity** (same order for every kind, inherited law) · footer. Used as the entity-view right panel, the entity-view promoted center, and the workspace center overlay.

Views (list / tree / graph, + board for tasks) are ONE generic view component per mode, reused across kinds; per-kind extra views (channel feed, doc gallery) are later extensions of the same registry.

## 4. The five view archetypes

### 4.1 Home views
Dashboard (`spaces.home` derived-truth op) · Feed (the default channel rendered as Channel View) · Activity (later).

### 4.2 Workspace View (the composed view)
```
| EntityListPanel |   CENTER (stack)                       | EntityListPanel |
| (kind select,   |   base: work_session terminal          | (kind select,   |
|  create, sort,  |   overlay: EntityDetailPanel           |  create, sort,  |
|  tiles)         |   slim persistent session bar (top)    |  tiles)         |
```
- Left and right panels are the **same component**, independently kind-selected; both drive the same center.
- **Center is a stack, not a swap:** the terminal stays mounted at the base (keep-mounted + suspend model, STATE.md stamped — the covered terminal is exactly the mounted-hidden/socket-suspended case; the overlay costs nothing new). Clicking any entity anywhere overlays its EntityDetailPanel; clicking a work_session brings the terminal forward.
- **Dismiss (close/esc) returns to the terminal**, AND a **slim persistent session bar** (status dot + session name, one-click to terminal) sits above the overlay whenever a session is live underneath — a running agent is never invisible.

### 4.3 Entity View (generic, all kinds)
- Center: the kind's collection in **list / tree / graph** (+ **board** for tasks).
- Click an entity → **right EntityDetailPanel** opens (four tabs).
- **Expand** → detail promotes to center; the previous view slides left into a collapsible left panel. **Expand is a route change — deep-linkable** (URL encodes server/space/entity/view; layout state like collapsed-panels stays local/persisted). Browser back, reload, and shareable links all work.

### 4.4 Leaderboard View — **later scope** (with points). When built: rank members/teammates by points earned, entity-kind filter.

### 4.5 Channel View
Chat (Thread) + EntityListPanel. Entity chips in messages open the right EntityDetailPanel; expandable to the promoted center per §4.3 grammar.

## 5. Contract amendment proposal: `project` as an entity kind

Follow the **work_session pattern exactly**:
- **Creation:** via space settings only (the existing `projects.*` ops); **excluded from `entities.create`**.
- **Single writer:** the server materializes/updates the project entity from the settings resource — settings are the source of truth; the entity is its graph shadow.
- **Detail fields:** name, repo/GitHub URL, working dir, trust level (mirrors the frozen `project` resource; `space_projects` and `projects.*` survive as the config surface).
- **Why an entity at all:** tasks target different repos — "task X changes repo Y" must be an edge, and edges require entities. Registered edges: `task → project`, `work_session → project` (spawn records which repo it ran in), `pull_request → project`.
- Envelope capabilities (messages, reactions, hierarchy) come free; hierarchy for projects is expected to go unused in v1.

`pull_request` and `commit` are already core kinds — no change; only `pull_request` enters nav now (Tracking), `commit` stays deferred.

## 6. Adoption checklist (for Vega, on GO)
1. Log the amendment (project entity + hubspace rename) in STATE.md per the post-freeze amendment rule.
2. One-pass terminology sweep, docs 00–06 + STATE.md.
3. UI convergence is mostly reuse: MaestroPanel + SessionsSection → EntityListPanel; ProjectTabBar → space tab bar; collab-v2 collection views + EntityPanel → §4.3 as-is. The pixel-transplant lanes' acceptance law (screenshot vs reference) continues to apply to the workspace view.
4. Nothing here unblocks or changes AM-5 — this is design; build waits for user direction.
