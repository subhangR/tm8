# 01 — Requirements & Brief

What tm8 is, the mental model the UI must express, the hard constraints, and the surfaces the final UI must contain. This is the document the design works *from*.

---

## 1. The product

**tm8 is a collaboration workspace shared by humans and AI agents, built on an entity graph, with real agent execution.** Humans plan and review; agents pull work, run in real terminal sessions, and report back — in the same rooms, on the same objects.

The one-sentence product: *a space where you can drop anything next to anything, talk about everything where it lives, always see how it all connects — and watch your agents actually work.*

Two halves, one app:

- **The graph half** (mature, well-designed already): everything is an entity — tasks, docs, channels, messages, teammates (agent personas), members (humans), files, pull requests, commits, projects. Every entity has the same four capabilities: hierarchy (parent/children), typed edges to anything, an inline discussion thread, and reactions/points. The UI renders every entity at four zoom levels: **Z1 chip** (inline token) → **Z2 card** (summary tile) → **Z3 panel** (detail column) → **Z4 full view** (immersive route).
- **The execution half** (the reason tm8 exists, historically under-designed): a **work_session** is a live agent running in a real PTY terminal on the server. Sessions are entities too — they appear in lists, have discussions, connect to tasks and projects — and their detail panel's Content IS the live terminal.

### Vocabulary the UI uses

| Term | Meaning |
|---|---|
| **Server** | The root domain a client connects to (like a Discord server). Phase 1: exactly one, local, implicit — no server UI chrome needed. |
| **Space** | The sharing boundary. Each space has its own entity graph, members, menu, and settings. |
| **Workspace** | The composed three-panel working view *inside* a space (list · center panels · list). A view, not a container. |
| **Project** | A configured execution root (a working directory, optionally a repo). Registered at node level, linked into spaces. Trust-gated: agents only run in trusted projects. |
| **work_session** | A live or historical agent terminal session. May be associated with multiple projects, or none (scratch). |
| **Teammate** | An agent persona (owned by a human member). Renders as a peer of humans, always visually distinct (agent chip / squared avatar). |
| **Channel / Feed** | Channels are entities whose content is a message thread. Each space has a default channel ("Feed"). |

---

## 2. The mental model the UI must teach

1. **Entity = component.** One component system renders every kind at Z1–Z4. If a surface can't be composed from entity components + collection views, it doesn't belong.
2. **Two axes, always visible.** Vertical = where does this live (breadcrumb up, children down). Horizontal = what does this connect to (Connections tab). Every detail surface shows both.
3. **Talk where the work is.** Every entity carries its thread inline (the Discussion tab). Never send users elsewhere to discuss.
4. **Peers with provenance.** Agents and humans share every surface; authorship is always visibly typed (agent vs human) and never buried. Convention already in the system: humans get round avatars, agents get rounded-square avatars.
5. **Zoom, don't navigate (mostly).** Prefer in-place expansion — panels that stack and pin — over full page swaps. Full routes exist for deep work.
6. **Live by default.** Presence, live session dots, streaming state — the space should feel inhabited, especially by agents at work.
7. **Honesty is a design feature.** The UI never fakes: an unavailable action renders disabled *with its reason*; a permanently-empty panel says *why* it's empty; a session that looks alive but isn't says "stale — node restarted". A list that lies about liveness is worse than no list.

---

## 3. Hard constraints (non-negotiable, already ruled)

These come from binding user rulings and a closed 12-round design review. Design within them.

- **C1 — One rule, zero exceptions:** click an entity anywhere → its detail panel opens (pushed onto the center stack). No base layer, no special screens.
- **C2 — The terminal IS the work_session detail's Content.** Not a modal, not a separate app region. See §4.
- **C3 — The space menu is data.** The left menu renders a per-space config (groups → items → optional one-level children). Design the *rendering grammar* (group header vs plain row vs caret-expandable view row), never a fixed menu. No menu item may be hardcoded.
- **C4 — Two primitives carry every list and every detail.** EntityListPanel (kind selector + create + filters + tiles) and EntityDetailPanel (header · action bar · Content/Discussion/Connections/Activity tabs · footer). Per-kind differences are configuration (which sections, which badges, which tabs), never new components.
- **C5 — Six collection layouts are universal:** List, Board, Tree, Feed, Gallery, Graph — available on every kind; a kind's config may default/hide modes but the switcher is one control.
- **C6 — Keyboard contract is fixed** (engineering owns it): `/` opens the palette, `g`-chords navigate, `j/k` + Enter in lists, Esc pops the top panel, `p` pins, and a focused terminal owns the entire keyboard except physical `Ctrl+backtick` to exit. Design consequence: the **exit-terminal affordance must be a visible chip** in the terminal chrome ("exit terminal ⌃`"), and every keyboard action needs a visible pointer path.
- **C7 — Panels: max 3 pinned + 1 stacked visible; 320px minimum column width.** Geometry in `02-LAYOUT-SPEC.md`.
- **C8 — Accessibility is release criteria:** state conveyed by text, never color/position alone; reduced motion; 200% zoom; full keyboard operation; screen-reader labels on all icon buttons.
- **C9 — The ATELIER design language is the palette** (see `03-DESIGN-LANGUAGE.md`). The design refines within it; it does not replace it. Light and dark themes both exist.

---

## 4. The terminal — verbatim transplant (user directive, 2026-07-27)

The user's ruling: *"the terminal streaming and handling should be exactly transplanted [from maestro]. That particular component and the wiring, all parts. Even the backend part."*

Design consequences:

- The **xterm canvas is a black box**: a dark (near-black), full-bleed terminal surface, minimum height 160px, that scrolls internally. Do not design inside it — no overlays on it, no restyling of its content.
- What you DO design is the **terminal chrome strip** directly above the canvas: session identity (persona, provider), live/exited status, and the exit-terminal chip. This strip is the one pixel-governed region of the whole app (it carries "crop invariants" — its layout is frozen once approved).
- The **exited state**: when a session ends, the terminal region becomes a read-only fallback — status + a link to the transcript. Design this state.
- A **Content toolbar row** sits between the outer tabs and the chrome strip. In Phase 1 it is nearly empty; it exists so a `[ Terminal | Chat ]` two-tab switch can be added in Phase 2 **without relayout**. Reserve the space; design the switch itself as a Phase-2/Tier-late item.

---

## 5. Chat — deferred to Phase 2 (user directive, 2026-07-27)

Chat is a graph-backed peer surface inside the work-session panel (bubbles for explicit messages, cards for artifacts, activity rows — never a parsed terminal transcript). It is fully specified in the repo (`docs/plans/TM8-CHAT-UI-AND-LAYOUT-DESIGN.md`) but **sequenced after the whole app runs and the terminal works properly**. For now:

- Design Phase 1 as terminal-only sessions (no switch rendered).
- Do not design anything that forecloses Chat: the toolbar seam (§4), and message/delivery badge vocabulary (worklist Tier 4) should be Chat-compatible.
- Chat visual design is Tier P2 in the worklist — do it last or in a later pass.

---

## 6. Navigation model

```
SPACE TAB BAR (top)  — space switcher; Phase 1 has no server rail
  └─ SPACE MENU (left rail, collapsible 220px ⇄ 48px; rendered from per-space config)
       Home        → Dashboard · Feed · Inbox
       Workspace ▾ → (row click = the 3-panel view; caret expands:)
                     Tasks · Sessions · Docs · Teammates
       Tracking    → Projects · Pull requests
       Collab      → Members
       Channels    → channel list + tree
       Settings    → Space settings (incl. Linked Projects, Menu) · [node admin: Project Registry]
```

- Group headers are labels only, never clickable. "Workspace ▾" is the one special row type: clicking the row opens the workspace view; the caret expands child items. Every child item is a pre-filtered entity view — one grammar.
- **Command palette** (`⌘K` / `/`): jumps to any entity and any implemented view. Deferred features (Leaderboard, Activity) appear only as *disabled "not available yet" discovery rows* — design that row state.
- Everything is a URL: space, view, entity, panel stack, pins, per-panel tab. Back/forward = graph browsing history. (Engineering owns the codec; design owns nothing here except that share/reload must land looking right.)

---

## 7. The views the UI must contain

| View | Composition |
|---|---|
| **Home / Dashboard** | "My Work": Ready-to-pull · In-flight · Needs-me collections + compact activity feed. |
| **Feed** | The space's default channel (a Thread). |
| **Inbox** | Notifications (mentions, assignments, replies, delivery failures) with read state; click → panel. |
| **Workspace** | The core: EntityListPanel · center (live-session bar + pinned panels + stack top) · EntityListPanel. Full spec in `02-LAYOUT-SPEC.md`. |
| **Entity Views** (`k/tasks`, `k/sessions`, `k/docs`, `k/teammates`, `k/pulls`, `k/projects`, …) | CollectionView in any of the six layouts; clicking a card opens the detail panel from the right edge; expand promotes to Z4. |
| **Channels / Channel** | Channel list; a channel = Thread + entity list, pinned shelf, auto-tabs for linked content. |
| **Entity Z4** | Full-view layout variants per kind: doc = reader with chapter tree; channel = hub; task = subtree board; member/teammate = profile; session = full-height terminal panel. |
| **Settings** | Space settings: profile, members/roles, invites, task axes, **Linked Projects**, **Menu editor**; node-admin: **Project Registry**. |
| Deferred (visible only as disabled palette rows) | Leaderboard, Activity screen, saved-views/axes management UI. |

Additionally in scope for design (never designed anywhere before — see worklist Tiers 2–3): auth/login/first-run owner setup/onboarding, account menu, projects + trust management, Interaction Profiles, custom-kind authoring, files (upload/attach/preview), node settings/status, the Graph canvas screen.

---

## 8. Sessions & agents — the behavior the design must express

- **Live-session bar** (fixed top row of the workspace center): `● {focused session} — N live`. N counts ALL live sessions in the space. Click = open/raise; the count opens a roster. A running agent must never be invisible or unreachable.
- **Session tiles** show: live dot (solid = alive, pulsing = streaming), status, persona, model, associated task chips; sessions nest (coordinator → workers) as an indented tree with guide lines.
- **Liveness never lies:** a session whose status says running but whose process is gone renders "stale — node restarted", visually distinct from live.
- **Needs-you:** a session blocked on human input sorts into a "NEEDS YOU" group above idle ones.
- **Terminate cascades** (confirm dialog must state the blast radius: "this closes N descendant sessions"); **complete** is an intent marker that leaves processes running — two different verbs, two different visual weights.
- **Drag an entity onto a live session = share it into the agent's context.** Drop targets: the session panel, the live-session bar, roster rows, session tiles. The drop is recorded in the graph; it is irreversible (no undo affordance). Its state renders as two independent facets — delivery (delivered / refused / unknown) and record — never collapsed into one badge.
