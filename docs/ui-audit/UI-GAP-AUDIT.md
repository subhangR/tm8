# tm8 UI — Gap Audit

**What to design and what to build for a complete UI set.**

| | |
|---|---|
| **Author** | Atlas (UI & design lead), reporting to Vega (CTO) |
| **Date** | 2026-07-25 |
| **Task** | `task_1784982669157_y5c1asy83` |
| **Nature** | READ-ONLY analysis. No code changed, no git run. |
| **Measured against** | `packages/contract` (81-op catalog + kinds) · `docs/COLLAB_V2_UI_DATA_CONTRACT.md` · `docs/collab-v2-ui-plan/` · `COLLAB_V2_UI_UX_BRIEF.md` (⚠ not in this repo — see D-0) · old maestro's shipped UI |
| **Evidence** | Four research lanes in [`_research/`](./_research/) + a live browser pass against the running app |

### Research lanes behind this report

| Lane | Deliverable | Scope |
|---|---|---|
| **A** | [`_research/A-inventory.md`](./_research/A-inventory.md) + [`A-inventory-pass2.md`](./_research/A-inventory-pass2.md) | Exhaustive code inventory of `packages/ui` — what exists, what is alive vs dead. **Two independent passes** that agree on every major finding; treat as cross-verification. |
| **B** | [`_research/B-contract-matrix.md`](./_research/B-contract-matrix.md) | 81-op catalog × UI consumption × server implementation |
| **C** | [`_research/C-old-maestro-benchmark.md`](./_research/C-old-maestro-benchmark.md) | What old maestro's UI actually shipped (the benchmark) |
| **D** | [`_research/D-design-intent.md`](./_research/D-design-intent.md) | The design corpus — what is specified vs never designed |
| **Live** | This document, §1.3 and §3 | Playwright pass over the running app at `:4611` |

---

## 0. Executive summary

**The graph half of this UI is real and good. The execution half does not exist as a product.**

tm8's UI is two codebases stitched at one seam: a 270-file `collab-v2` module built entirely
against mock data, and a ~2,900-line `real/` integration layer written for tm8. The module is
well-built — the entity component contract (Z1–Z4), the panel stack, the board, the Z3
inspector — and where the server can feed it, it is genuinely alive and pleasant. Tasks, Team,
Home, Docs, the entity panel and the board all work against real data.

Everything else falls into three buckets, and the distinction is the point of this report:

1. **Built but dead** — 34 of 53 `CollabFacade` methods have no server behind them (B). Eleven
   return typed empties, so Inbox, Leaderboard, Tracking and the graph canvas render as
   honest-but-permanently-empty screens. Twenty-one throw, which is why the *entire drag-drop
   grammar*, undo, reactions, points, pull, and axis/saved-view management are inert. This is
   **needs-build on the server**, not needs-design.
2. **Designed but not built** — the Graph screen renders the raw placeholder; six collection
   layouts exist but the Graph one is unreachable as a screen; the five golden workflows are
   acceptance criteria the app cannot currently satisfy.
3. **Never designed at all** — sessions, the terminal's place in the shell, auth, onboarding,
   account, projects, custom-kind authoring, files. These need **design before code**, and they
   are the majority of the remaining product.

### The findings that matter most

**F1 — There is no sessions surface, and a running agent is unrecoverable.**
`work_session` is a core kind and tm8 spawns real agents, but there is no sessions tab, list,
detail view, or nav entry. The entire execution UI is one transient modal (`SpawnDialog`) that
holds the session in React local state. Close it, or reload the page, and a **live agent with a
running PTY becomes unreachable from the UI** — nothing lists sessions. Old maestro devoted its
whole right panel plus four detail views to this (C). See §2.1.

**F2 — A sessions list needs no contract change and no new server handler.**
I verified `POST /v2/collections/query` with `kinds:["work_session"]` returns `200` today
against both `:4610` and `:4620`; `collections.query` is generic over kinds with no allowlist
(B, `handlers/collections.ts:185`). Zero UI code does this. This is the single highest
value-to-effort item in the report.

**F3 — The Settings screen hard-crashes the entire app to a white screen.**
`getSettings` returns a typed empty, and `SpaceProfileSection`, `InvitesSection` and
`TaskAxesSection` all dereference it unguarded. There is **no error boundary anywhere in
`packages/ui`**, so one screen's crash unmounts the shell — the only recovery is a page reload.
Settings also has no nav entry, so it is reachable only by typing the URL. Verified live, §3.1.

**F4 — The contract is not the bottleneck; the server is.**
Only **five** capabilities require a contract amendment (auth/login, account management, space
membership add/remove, project + custom-kind delete, and node settings — which has no catalog op
at all). Everything else — invites, files, saved views, axes, undo, placements, reactions,
inbox — already has a catalog op that merely answers 501 (B). The work is implementation, not
redesign.

**F5 — The test suite cannot see any of this.**
All ~534 module tests run against `MockFacade`; **not one exercises the real path.** That includes
the golden-workflow acceptance suites — workflow 2 is driven entirely by `pullEntity`,
`placements` and presence, all three of which throw or return empty against the real server. So a
screen can be blank or crashing in the running app and 100% green in CI. Any remediation plan
needs real-path integration tests, or it will re-accumulate exactly this drift.

**F6 — The "honest degradation" design was never wired up.**
`real/capabilities.ts` — the register of what this node cannot do — has **zero production call
sites** (imported only by `ModeBanner` and one test), because `collab-v2` never imports `real/`.
Nothing is gated, no emptiness is captioned, and the banner's promise that panels are "empty or
disabled on purpose" is therefore untrue: they are just empty, indistinguishable from a bug. This
is the design that was supposed to make all the 501s survivable, and it is inert.

**F7 — tm8 cannot state its own acceptance criteria from its own repo.**
`COLLAB_V2_UI_UX_BRIEF.md` — the master UI spec holding the view catalog, the five golden
workflows and the state inventory — was never vendored into tm8, despite
`09-IMPLEMENTATION-PLAN.md:41` promising exactly that. Gates **G1, G2 and G3 are all defined
against it** (D-0). Vendoring it is a five-minute fix and should happen before any UI planning.

### Scale of the remaining work

| Category | Surfaces | Design needed | Build effort | §|
|---|---|---|---|---|
| Sessions & execution | 9 | **All of it** | XL | 2.1, 2.2 |
| Auth / account / onboarding | 10 | **All of it** | L | 2.5, 2.6 |
| Collab: spaces, members, invites | 7 | Partial — contents listed, every flow absent | L | 2.7 |
| Projects & trust | 4 | **All of it** | M | 2.8 |
| Custom kinds & files | 8 | Authoring undesigned; rendering designed | L | 2.9, 2.10 |
| Node settings | 4 | **All of it** (+ contract amendment) | M | 2.11 |
| Existing-screen completion | 9 screens | Designed already | L — mostly server-side | 2.12 |
| Built-but-unreachable (recover) | 11 | Designed already | M | 2.13 |
| Interactions | 9 | Designed already | M | 2.14 |
| Live defects | 11 | — | S–M | 3 |

**Roughly: one third of the work is design-first, two thirds is build-only** — and a large share
of the build-only portion is server implementation of ops that already exist in the catalog.

---

## 1. What exists today

### 1.1 The shell

`ShellLayout` composes five regions (`shell/ShellLayout.tsx:86-94`):

```
IconRail │ LeftRail │ CenterHost │ pinned splits │ Z3 PanelStack │ ⌘K palette
```

- **Icon rail** (far left) — space switcher + home + inbox. Against the live node it is a column
  of ~17 conformance-suite leftover spaces (`conf-projects-…`, `conf-idem-…`), which is itself a
  finding: there is no way to rename, archive, or hide a space.
- **Left rail** — space name, member name, seven nav destinations, and a channel tree.
  `RAIL_SECTIONS` (`shell/LeftRail.tsx:20-27`) is exactly: **Home · Tasks · Docs · Team ·
  Tracking · Graph · Leaderboard**. There is **no Settings entry and no Sessions entry.**
- **Center host** — the current view, resolved through a `ViewRegistry`; any unregistered view
  falls back to `PlaceholderView`.
- **Panel stack** — Z3 panels that peek from the right, stack with breadcrumbs, pin into splits
  (capped at `MAX_PINNED`), and promote (⤢) to the Z4 route.
- **Command palette** — ⌘K.

### 1.2 Screens

Ten views are registered in `CollabV2App.tsx` (`VIEWS`): home, inbox, tasks, docs, team,
leaderboard, channel, tracking, settings, entity. **`graph` is absent from the registry**, so
the Graph nav item — a designed top-level screen — renders the placeholder.

| Screen | In nav | Alive against the real server? |
|---|---|---|
| Home | ✅ | **Alive.** Three columns + activity feed. Columns read 0 because no task is pulled/in-flight; the activity feed is populated and correct. |
| Tasks | ✅ | **Alive and good.** Board/Tree/Select, group by None/Status/Assignee, real cards with status, priority, acceptance counts, blocked badge. |
| Docs | ✅ | **Mostly alive.** Reader works; **version history is dead** (`getVersions` → empty). |
| Team | ✅ | **Alive.** Member cards + agent org rows with model and live status, and a `+ Spawn` affordance. |
| Tracking | ✅ | **Honest-empty.** Renders correct empty states; `trackingRefresh`/`linkPr` throw, so nothing can ever populate it. |
| Graph | ✅ | **Placeholder.** Renders the literal blurb "Full-page canvas over the seeded subgraphs." over a row list. `queryGraph` returns empty anyway. |
| Leaderboard | ✅ | **Permanently empty.** `getLeaderboard`/`getAwards` return typed empties. Degrades gracefully. |
| Inbox | ✅ (icon rail) | **Permanently empty.** `getInbox` returns empty. Degrades gracefully. |
| Channel | ✅ (tree) | **Partially alive.** Thread works; `getChannelTabs` is dead, so the auto-tabs projection is missing. |
| Settings | ❌ **no nav entry** | **CRASHES THE APP.** See §3.1. |
| Entity Z4 | route only | Alive. |

### 1.3 The three regions the user asked about

**The middle view (center host).** This is the strongest part of the UI. The board renders real
task cards with status pills, priority, acceptance progress (`✓ 0/2`), assignee avatars, a
blocked badge, and a reactions/points/messages footer. Group-by pivots work. Empty columns say
"drop a card here" — but *the drop does nothing*, because `placements` throws (B). The teaching
empty states ("no tasks linked yet — drag one here, or press ⌘K") advertise a grammar that is
not wired.

**The right-side view (Z3 entity inspector).** Also strong, and richer than I expected. Verified
live on a task: breadcrumb trail → pin 📌 → promote ⤢ → close ✕; an inline status changer with
the full `WorkStatus` enum; a reactions bar; an action bar of **Link · Add child · Pull · Start ·
Complete… · Spawn agent**; four tabs **Content / Discussion / Connections / Activity**; body with
description, priority, type axis, acceptance checklist; footer with author, version and activity
(`v1 · active 56m ago`). Deep-links as `?p=<entityId>`.
Caveats: several action-bar buttons are inert (Pull, react, points all throw); and the panel is
**visually clipped at the right edge** at 1600px — the title and the footer's `active 56m ago`
are cut off (§3.4).

**The terminal.** Assessed from source (`real/SessionTerminal.tsx`) — I did not spawn a real
agent, since that starts a real process. It is a single `@xterm/xterm` instance, DOM renderer,
no addons (a deliberate and correct choice — WebGL allocates one GPU context per terminal and
stalls the whole tab). 12px monospace, hardcoded `#0b0c10` theme, 5,000-line scrollback,
bidirectional: keystrokes go out as binary frames over `/v2/ws?sessionId=`, output is coalesced
16ms server-side and one animation frame client-side. Chrome is two lines: the word "Terminal"
and a status string `live · streaming · type to interact`.

It lives **inside the spawn modal**, which switches to a `min(1500px, 96vw) × 94vh` card once a
session exists. So the terminal is technically excellent and contextually homeless — see §2.2.

### 1.4 What is built and genuinely good

Worth stating plainly, because the gap list is long: the entity component contract (Z1 chip /
Z2 card / Z3 panel / Z4 full view) driven by a kind registry; the panel stack with pin-splits and
URL-addressable state; six collection layouts; the thread subsystem; the paper/ink design
language (Newsreader + Hanken Grotesk + JetBrains Mono) which is distinctive and well-executed;
~850 passing UI tests including five golden-workflow acceptance suites (against mock). The
foundation is sound. Most remaining work is *surfaces on top of it* and *server behind it*.

### 1.5 Measured against old maestro

Old maestro is the only shipped reference for what an agent-orchestration UI needs, and the
comparison is lopsided in a specific way: **tm8 is ahead on the graph, far behind on execution.**

| Capability | Old maestro | tm8 today |
|---|---|---|
| Sessions list | Whole right panel — avatar rail + expanded list, refresh, board view, history dropdown with per-row Resume, session-tools menu | **Nothing** |
| Session grouping | Recursive spawn tree (parent→child, indent rails, collapse), team boxes, ensemble groups | — |
| Session filters | Terminals / Agents / Docs / Drawings, plus Open / Done / Archived / Huddles lifecycle tabs, "N live" toggle | — |
| Session tile | Live dot (solid = alive, pulsing = streaming), status glyph, needs-input override, mode dropdown, model/worktree badges, task chips, doc pills | — |
| Session detail | **Four** views incl. a 1,440-line post-mortem (`SessionStatsView`): outcome ring, stacked token bar, tool-call chart, timeline, docs produced, sub-sessions, run config | — |
| Session controls | Close (cascades the whole subtree), Mark-done (intent marker, leaves terminals running), Restore, Resume, Copy reference | Prompt / Terminate, in a modal |
| Terminal placement | Full-bleed centre pane; switch by selecting a session | Inside a modal |
| Terminal chrome | Rich strip — context gauge, token counts, tool count, duration, model pill, docs menu, attach-files, draw, cast-spell, hide | Two words |
| Multi-terminal | Team View reparents live xterms into a coordinator/worker grid; Multi-Project Board; Huddles | One terminal, ever |
| Terminal input | Bracketed paste, image-paste → upload → `@path`, drag-drop files/tasks, Shift+Enter as CSI-u | Keystrokes only |
| Terminal theming | 5 font presets, size 9–22, 5 weights, 3 cursor styles, 22-slot colour editor | Hardcoded |
| Layout persistence | Per-workspace-key | Panel stack in URL (**tm8 is better here**) |
| Entity graph, Z1–Z4, board, panel stack | — | **tm8 is well ahead** |
| Auth | Effectively auth-free (password overlay short-circuits under Tauri) | Also auth-free |
| Global search | None | None (`search.query` reserved) |

Two lessons worth carrying: old maestro's **single-click contract** (`willOpenStatsOnClick` derives
both the click target *and* the Resume button's visibility from one predicate, so the UI cannot
lie about whether a terminal is alive), and its **subtree semantics** (closing a coordinator
cascades to descendants; marking done is a pure intent marker that leaves processes running).
Both are exactly the decisions tm8's sessions design will have to make, and both are already
answered well next door.

---

## 2. Gaps by surface

Legend — **D** = needs design first · **B** = needs build only (design exists) · **D+B** = both.
Priority: **P0** blocks basic use · **P1** needed for a coherent product · **P2** completeness ·
**P3** polish. Effort for one competent engineer: **S** ≤1d · **M** 2–4d · **L** 1–2w · **XL** >2w.

### 2.1 SESSIONS — the missing surface ⚠ largest gap

**Verdict: NO DESIGN EXISTS** (D §2.10). The corpus has a data model, a streaming law, a
one-line registry instruction and an op family — but no sessions screen appears in the UX brief's
view catalog, the implementation plan's Layer 5, or the screens directory. The kind that
distinguishes tm8 from Collab V2 is the one kind the UI corpus predates.

**What exists today:** a modal. `SpawnDialog` is mounted as a sibling of the shell
(`main.tsx:89`), opened by a `window` CustomEvent, holding `session` in `useState`, polling
`entities.get` every 1500ms. There is no store, no route, no list, no persistence.

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| S1 | **Sessions list view** + nav entry — running and past sessions, status, agent, task, project, started-at | **D+B** | **P0** | `collections.query` (works today, F2) | M |
| S2 | **Session full view (Z4)** — status, task links, transcript, the terminal, controls | **D+B** | **P0** | `entities.get`, `execution.*` | L |
| S3 | **Reattach to a running session** — today a reload orphans a live agent | **B** | **P0** | `collections.query`, `execution.streams.attach` | S |
| S4 | **Session Z3 panel** — a registry entry *does* exist, and its Content renderer prints, verbatim, *"No terminal stream: this tm8 node exposes no PTY route yet, so session output cannot be shown"* (`tm8Kinds.tsx:111-114`). **That is no longer true.** Opening a `work_session` panel shows a paragraph denying the terminal exists, while the spawn modal streams one. Stale copy, and the clearest evidence the panel was never designed. | **D+B** | P1 | `entities.get` | M |
| S5 | **Filters + grouping** — by status, agent, task, project; spawn-tree grouping as old maestro had | **D+B** | P1 | `collections.query` filters | M |
| S6 | **Live status without polling** — status is polled at 1500ms; the events WS cannot carry graph events (B) | **B** | P1 | `events.*` + amendment | L |
| S7 | **Multi-session view** — old maestro reparented live terminals into a coordinator/worker grid | **D+B** | P2 | — | L |
| S8 | **Ghost-session UX** — sessions stuck `running` after a restart are real today (`STATE.md:134`) and invisible | **D+B** | P1 | `execution.terminate` | S |
| S9 | **Concurrency-cap feedback** — the 8-slot cap and `limit_exceeded` have no UI concept | **D** | P2 | taxonomy exists | S |

> **Start here.** S1 + S3 together are roughly a day's work on top of ops that already answer,
> and they convert the execution feature from "demo" to "usable".

### 2.2 THE TERMINAL

The component is good; its **placement** is the gap. There is no design for where a terminal
lives in the shell (D §2.9) — the modal was an integration expedient, not a design decision.

| # | Gap | D/B | Priority | Effort |
|---|---|---|---|---|
| T1 | **A home in the shell** — terminal as a Z3/Z4 region or a dockable pane, not a modal | **D+B** | **P0** | M |
| T2 | **Multiple terminals** — the visibility driver's suspend/resume already exists and is unobservable because only one terminal ever mounts (`STATE.md:142`) | **D+B** | P1 | L |
| T3 | **Terminal chrome** — old maestro shipped a rich strip: context gauge, token counts, tool count, duration, model pill, docs menu, attach-files, hide (C). tm8 has two words. | **D+B** | P1 | M |
| T4 | **Prompt composer** — today prompting uses `window.prompt()`, a browser modal with no history and no record of what was sent | **D+B** | **P0** | S |
| T5 | **Transcript view** — a non-terminal reading surface; the corpus says "it's a doc entity", which nobody has validated for terminal output | **D** | P1 | M |
| T6 | **Theming** — hardcoded `#0b0c10`, no font/size/color control; old maestro had 5 font presets and a 22-slot color editor | **D+B** | P3 | M |
| T7 | **Search / copy affordances** — no search addon (old maestro lacked this too) | **D+B** | P3 | S |
| T8 | **Attach files, drag-drop, image paste → `@path`** (old maestro shipped all three) | **D+B** | P2 | M |

### 2.3 THE MIDDLE VIEW (center)

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| M1 | **Graph screen** — designed as a full-page canvas; renders the placeholder. `GraphCanvas` is built but registered nowhere as a view; its **only** route is a channel tab's layout switcher, which is itself dead (see M6). So the graph canvas is **entirely unreachable in the running app.** | **B** | P1 | `graph.query` (501) | M |
| M2 | **Drag-drop does nothing** — board columns invite drops; `placements` throws | **B** | **P0** | `placements.apply` (501) | M |
| M3 | **Saved views** — designed; `listSavedViews` empty, CRUD throws | **B** | P2 | `savedViews.*` (501) | M |
| M4 | **Task axes** — designed (manual axes, pivot on any axis); `getTaskAxes` empty, CRUD throws | **B** | P2 | `taskAxes.*` (501) | M |
| M5 | **Bulk select → bulk ops** — "Select" mode exists; bulk mutations depend on throwing methods | **B** | P2 | `entities.patch`, `edges.*` | M |
| M6 | **Layout switcher unreachable** — the switcher (the only route to Board/Tree/Feed/Gallery/Graph on a collection) lives in the channel hub's auto-tabs, and `getChannelTabs()` returns `[]` against the real server, so the hub renders the feed pane only. Five of six layouts are dead on arrival. | **B** | P1 | `channels.tabs` (501) | M |

### 2.4 THE RIGHT-SIDE PANEL (Z3 inspector)

Structurally complete. The gaps are inert affordances and one layout defect.

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| R1 | **Panel clipped at right edge** — title and footer cut off at 1600px (§3.4) | **B** | P1 | — | S |
| R2 | **Reactions / points inert** — bar renders, `setReaction` and `grantPoints` throw. `entities.points.add` is *implemented server-side* but the client throws anyway (§3.3) | **B** | P1 | `entities.react` (501), `entities.points.add` (**live**) | S |
| R3 | **Pull inert** — `pullEntity` throws | **B** | P2 | `entities.pull` (501) | S |
| R4 | **Connections tab** — edge composer, add/remove per group; `patchEdge`/`deleteEdge` throw | **B** | P1 | `edges.*` (501) | M |
| R5 | **Delete / move** — `deleteEntity`, `moveEntity` throw | **B** | P1 | `entities.delete`, `entities.move` (501) | M |
| R6 | **Presence** — viewers/typing designed; `getPresence` returns empty | **B** | P2 | `presence.*` (501) | M |
| R7 | **`work_session` panel body** — see S4 | **D+B** | P1 | — | M |

### 2.5 AUTHENTICATION, ONBOARDING, OWNER SETUP

**Verdict: NO DESIGN EXISTS** (D §3.1). Not one screen, flow, or field anywhere in the corpus.
Today the node silently auto-owners on loopback with zero UI. **A second human cannot sign in at
all** — and this is one of only four capabilities the *contract* cannot express (B): there is no
`auth.*`, `login`, or `logout` op in the catalog.

| # | Gap | D/B | Priority | Blocker | Effort |
|---|---|---|---|---|---|
| A1 | **Login screen** | **D+B** | P1 | ⚠ **contract amendment** | M |
| A2 | **First-run owner setup** — name the owner, name the node, create the first space | **D+B** | P1 | ⚠ contract (account mgmt) | M |
| A3 | **Onboarding** — first-run orientation; old maestro had a 2-screen theme+volume flow (C) | **D** | P2 | — | M |
| A4 | **Session expiry / re-auth / logout** | **D+B** | P2 | ⚠ contract | M |
| A5 | **Non-loopback posture** — token auth, Origin checks; `10-SECURITY-MODEL.md` specifies the model, no UI expresses it | **D+B** | P2 | AM-4 defers | L |

> Note the sequencing trap: auth is **P1 not P0** only because tm8 is loopback-only today.
> The moment it binds to a non-loopback interface, A1/A2 become P0 and the contract amendment
> is on the critical path.

### 2.6 ACCOUNT / IDENTITY

**Verdict: NO DESIGN EXISTS** (D §3.2). `identity.get` exists and **the UI never calls it**.

| # | Gap | D/B | Priority | Blocker | Effort |
|---|---|---|---|---|---|
| I1 | **Account menu / "who am I"** — the left rail prints "Owner" as text with no affordance | **D+B** | P1 | `identity.get` (**live**) | S |
| I2 | **Profile edit** — display name, avatar | **D+B** | P2 | ⚠ contract (account mgmt) | M |
| I3 | **Credentials** — set/change password, tokens | **D+B** | P2 | ⚠ contract | M |
| I4 | **Acting-as** — the claims model supports it; no UI concept | **D+B** | P3 | partial | M |
| I5 | **Node-admin surface** | **D+B** | P3 | ⚠ contract | M |

### 2.7 COLLAB — spaces, membership, invites, sharing

**Verdict: PARTIALLY SPECIFIED** (D §3.3) — the settings screen's *contents* are enumerated
(members/roles, invites, space profile, task axes) but **every flow is absent**: create, switch,
invite-send, invite-redeem, join. And the screen that would hold them crashes (§3.1).

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| C1 | **Fix the Settings crash** | **B** | **P0** | — | S |
| C2 | **Space profile** — name, description, avatar; today spaces cannot be renamed | **B** | P1 | `spaces.update` (501) | M |
| C3 | **Membership list + roles** | **D+B** | P1 | `spaces.members.list` (501, read-only) | M |
| C4 | **Add / remove member, change role** | **D+B** | P1 | ⚠ **no op exists** | M |
| C5 | **Invites** — create, list, revoke, and **redeem**. Redeem is the hard one: `POST /v2/invites/redeem` is a *space-less* route for someone not yet in the space, so it needs a landing surface and a URL scheme, and it collides head-on with the missing auth UI (§2.5) | **D+B** | P1 | `invites.*` (501) | L |
| C6 | **Space create / archive / delete** — the icon rail shows 17 junk conformance spaces with no management | **D+B** | P1 | `spaces.create` (live), archive (501) | M |
| C7 | **Sharing** — share an entity to a space | **D+B** | P2 | partial | M |

### 2.8 PROJECTS MANAGEMENT

**Verdict: NO DESIGN EXISTS** (D §3.4) — projects post-date the UI brief entirely. This matters
more than it looks: **project trust gates spawning**, and today the only place a project is ever
visible is a list inside the spawn modal, where untrusted ones render disabled with the reason.

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| P1 | **Projects screen** — list, working dir, trust, linked spaces | **D+B** | **P0** | `projects.list` (live) | M |
| P2 | **Create / link / unlink a project** | **D+B** | **P0** | `projects.create`/`link` (live), `unlink` (501 + no `delete` op) | M |
| P3 | **Trust management** — mark trusted/untrusted, with the consequence stated | **D+B** | **P0** | `projects.update` | M |
| P4 | **Worktree semantics** — `workdir{mode: project\|worktree}` is in the contract with no UI | **D+B** | P2 | `execution.spawn` input | M |

> Without P1–P3 a user cannot add a project without leaving the app, and therefore cannot
> spawn an agent anywhere new. This is why they are P0 despite having no design.

### 2.9 CUSTOM KINDS (`c:*`)

**Verdict: PARTIAL** (D §3.5) — *rendering* is designed (generated Z2/Z3 from `fieldSchema`);
*authoring* is not designed at all. And there is a latent crash: `registryFor()` is typed
`=> KindEntry` but is a bare object index with **no fallback**, dereferenced at ~20 sites (B).
**The first `c:*` entity ever rendered white-screens the app.** It is unreachable today only
because `entityKinds.create` has no handler — i.e. the bug is masked, not fixed. This is the
defect `STATE.md:120` already flagged as "Atlas's to make, and it is the real defect".

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| K1 | **`registryFor` fallback entry** — unknown kind degrades to a generic chip instead of crashing | **B** | **P0** | — | S |
| K2 | **Custom-kind authoring UI** — define/edit a kind and its field schema | **D+B** | P2 | `entityKinds.*` (501; no delete op) | L |
| K3 | **Generated renderers from `fieldSchema`** | **B** | P2 | `entityKinds.list` (501) | M |

### 2.10 FILES / BLOBS

**Verdict: NO DESIGN EXISTS** for the UI. The `files.*` lifecycle was added to the contract by
AM-2 (initiate/complete/abort upload, authorized download) and every op answers 501. `file` is a
kind in the data contract with no upload, download, preview, or attachment UI anywhere.

| # | Gap | D/B | Priority | Contract ops | Effort |
|---|---|---|---|---|---|
| F1 | **Upload** (drag-drop, picker, progress) | **D+B** | P2 | `files.*` (501) | L |
| F2 | **Download / authorized fetch** | **D+B** | P2 | `files.download` (501) | M |
| F3 | **Attachments on messages and tasks** | **D+B** | P2 | `files.*` + `edges.*` | M |
| F4 | **Previews** (image, pdf, text) | **D+B** | P3 | — | M |
| F5 | **Quotas / GC surface** | **D** | P3 | — | S |

### 2.11 NODE-LEVEL SETTINGS

**Verdict: NO DESIGN EXISTS.** Ports, sidecar/Postgres lifecycle, agent commands
(`TM8_AGENT_CMD`), concurrency caps, data directory — all are environment variables today with
no surface. Old maestro exposed a good deal of this.

| # | Gap | D/B | Priority | Effort |
|---|---|---|---|---|
| N1 | **Node status** — server, db, sidecar health; the `/health` payload is already rich | **D+B** | P1 | S |
| N2 | **Agent command config** — which binary, which model, default flags | **D+B** | P2 | M |
| N3 | **Concurrency cap control** (the 8-slot limit) | **D+B** | P2 | S |
| N4 | **Data / backup / export** | **D+B** | P3 | L |

### 2.12 PER-SCREEN FEATURE GAPS (the nine existing screens)

| Screen | Missing vs its design | D/B | Priority |
|---|---|---|---|
| **Home** | Ready-to-pull PULL action inert; staleness/RE-PULL never fires; agent work attribution under owner unverified | B | P1 |
| **Tasks** | Drag-to-change-status inert (M2); axis pivots beyond status/assignee (M4); bulk ops (M5) | B | P1 |
| **Docs** | Version history dead; margin threads; "split to child docs"; editor vs reader | B | P2 |
| **Team** | TM profile depth (identity, memories, equipped via `equips`, work history); spawn affordance leads to the modal | B | P2 |
| **Tracking** | Cannot ever populate — `linkPr`/`trackingRefresh` throw; no webhook state | B | P2 |
| **Graph** | Not built as a screen at all (M1) | B | P1 |
| **Leaderboard** | Permanently empty; award moment / completion celebration unbuilt | B | P2 |
| **Channel** | Auto-tabs projection dead; pinned shelf; living embeds | B | P2 |
| **Settings** | Crashes; no nav entry; every section dead (§2.7) | B | **P0** |

### 2.13 BUILT BUT UNREACHABLE (dead code)

A distinct category from "dead against the server": these are **finished components that ship in
the bundle and no code path ever opens.** They represent work already paid for that a small
wiring effort would recover — and they are also a warning about how the mock-era build drifted.

| Component | State | To recover | Effort |
|---|---|---|---|
| **`CreationHost`** — the context-seeded "+" creation modal | Mounted; nothing ever opens it. Palette creation uses a separate path. | Wire the "+" affordances | S |
| **Keyboard parity surface** — `MoveToMenu`, `LinkMenu`, `openMoveTo`, `openLink` | `InteractionMenusHost` mounted, never opened. **Drag-drop therefore has no keyboard equivalent at all** — an a11y gap, not just a missing feature. | Wire + a11y pass | M |
| **`EdgeComposer`** (rail edge creation) | Wired to `createEdge` but requires an injected `pickEntity` that **no production call site supplies** → "Choose entity…" is permanently disabled | Supply the picker | S |
| **`ProfileZ4View`** — member/agent full view with wall and rail | Built, exported, unwired; `EntityZ4Route` claims the route | Register it | S |
| **`TypingIndicator`**, **`usePresenceChannel`**, **`DiscussionPanel`** | Zero references anywhere, including tests | Wire (needs presence server-side) | M |
| **`Gallery`** (`#/gallery`) | Mock-only *by construction* — hardcodes seed ids and resets app-wide stores to its own world | Keep as QA-only; document it | — |
| **Sort UI and filter UI** | **Do not exist anywhere in the collections layer** — the query supports both; no surface offers them | Design + build | M |
| **Offline UI** | Does not exist. `stores/connection.ts` has **zero UI readers** (their own `gaps-static.test.ts` asserts this). The only offline signal is the integration layer's `ModeBanner`. | Design + build | M |
| **`isHollow()` / `hollowReason()`** | Built precisely so a screen can caption a permanently-zero value. **No screen calls either.** (See F6.) | Wire | M |
| **`EntityPanel` "Link" / "Add child"** | Render with the title *"arrives in W4"* and do nothing. "Copy to space" is hardcoded disabled; "Watch" is local `useState` with no facade call. | Build | M |
| **Drop surfaces** | Only **three** exist in the whole app; two grammar rows (composer, parent-zone) have no registered target | Build | M |

Also noted by both passes: **Z4 is never kind-specific** — there are five shared layouts and eight
kinds fall through to `generic`. The plan specified kind layout variants (doc = reader + chapter
tree + margin threads, channel = hub, task = subtree board + dep mini-graph, member = profile).
That is a designed-but-unbuilt gap, and `ProfileZ4View` above is the half-built proof.

Smaller structural debt from the inventory: two hash codecs, two `EdgeComposer`s, two `initials()`
helpers, two testid conventions, N+1 reads in Tracking, **no pagination on six surfaces**, and ARIA
roles without their keyboard contracts.

### 2.14 INTERACTIONS

| # | Interaction | State | D/B | Priority |
|---|---|---|---|---|
| X1 | **Navigation** | Works. 7 rail destinations; Settings and Sessions unreachable | B | P0 |
| X2 | **Deep links** | Mostly good — `#/s/{space}/{view}` and `?p=<entityId>` verified live. **But `channel` is unreachable from a URL** (§3.9): a channel deep link, reload, or back/forward lands on the generic entity route instead of the channel hub. | B | P1 |
| X3 | **Panel stack** | Works — peek/stack/pin/promote, breadcrumbs, ⌫ pops | — | — |
| X4 | **Drag & drop** | **Entirely inert, at a single point.** Every grammar drop — all 7 rows × every surface — commits through one call, `interactions/execute.ts:90` → `facade.placements()`, which throws. It fails *gracefully* (a toast), but targets still highlight and ghosts still promise "Attach to #general", so the UI advertises a grammar it cannot perform. **The highest-leverage single fix in this report.** Also: only 3 drop surfaces exist, and there is no keyboard equivalent (§2.13). | B | **P0** |
| X5 | **Keyboard** | Map exists (⌘K, ⌫, g+t/g+d/g+h, arrows); a11y parity unverified against real data | B | P2 |
| X6 | **Command palette** | Renders; `search` throws, so entity search is dead — it can only offer recents | B | P1 |
| X7 | **Realtime** | **Poll-only at 1500ms.** The events WS can never carry a graph event — three independent breaks, needing a contract amendment *and* a log→publish bridge (B). PTY WS is true push and works. | B | P1 |
| X8 | **Undo** | Designed (toast + undo token); `undo` throws | B | P2 |
| X9 | **Optimistic mutation + 409 reconcile** | Implemented in stores; unexercised against real conflicts | B | P2 |

---

## 3. Defects found (live)

### 3.1 Settings crashes the app — **P0**

```
TypeError: Cannot read properties of undefined (reading 'name')  at SpaceProfileSection (…:8:77)
TypeError: Cannot read properties of undefined (reading 'map')   at InvitesSection    (…:15:15)
TypeError: Cannot read properties of undefined (reading 'map')   at TaskAxesSection   (…:64:12)
```

Navigating to `#/s/<space>/settings` yields `bodyTextLen=0`, `shellPresent=0` — a white page.
Two compounding causes: the sections assume `getSettings` returns populated data, and **there is
no error boundary anywhere in `packages/ui`**. Fix both: guard the sections *and* add a boundary
so no future screen can take down the shell.

### 3.2 A live agent becomes unreachable on reload — **P0**

Session state lives in `SpawnDialog`'s `useState`. Reload, or press Close, and the PTY keeps
running with no way back to it. Compounded by ghost sessions (`STATE.md:134`) counting against
the 8-slot cap. Fix is §2.1 S1+S3.

### 3.3 `grantPoints` throws against a server that implements it — **P1**

`entities.points.add` is genuinely implemented (`facade/index.ts:110` → `grant_points` RPC), but
`RealFacade.grantPoints` throws `not_implemented` (`RealFacade.ts:357`) and `capabilities.ts:55`
lists it as unimplemented. The only case where the UI is *more* pessimistic than the server —
two live affordances fail needlessly. One-line fix.

### 3.4 Z3 panel clipped at the right edge — **P1**

At 1600×1000 the panel's inner card overflows: the header title renders as `T-101 · Schema foun|`
and the footer's `v1 · active 56m ago` is cut. Double-header nesting (outer frame + inner card).

### 3.5 `TmClient` has no `delete()` or `put()` — **P1**

Only `get/post/patch` exist, so **nine catalog ops are unreachable by transport even once
implemented**: `entities.delete`, `edges.delete`, `messages.delete`, `taskAxes.delete`,
`savedViews.delete`, `projects.unlink`, `entities.react`, `inbox.markRead`, `readMarks.upsert`.
`entities.react` already has four live call sites. A trap waiting for whoever implements those.

### 3.6 `events.poll` cursor type mismatch — **P1**

Server sends `nextCursor` as a String (`poll.ts:135`); the UI accepts only a number
(`events.ts:136`), so **the server cursor is always ignored**. This defeats the anti-wedge
design: on a skipped row the client re-requests the same page forever.

### 3.7 `registryFor()` has no fallback — **P0 (latent)**

Typed `=> KindEntry`, actually a bare object index returning `undefined`, dereferenced at ~20
sites, with no error boundary to catch it. Any unknown kind — including any `c:*` custom kind the
contract explicitly supports — white-screens the app. Masked today only because
`entityKinds.create` has no handler.

### 3.8 `RealFacade` inverts the project-trust default — **P1, security-relevant**

`RealFacade.ts:427-431` silently defaults a project to `trust: 'trusted'` when the server does
not say otherwise. The contract's default is **untrusted** — deliberately, because trust gates
whether an agent may execute in a directory. A UI that defaults to trusted is a UI that will
eventually offer a spawn the user never vouched for. Related: `10-SECURITY-MODEL.md` S12 requires
a `confirmUntrusted` step that is **absent from the frozen contract** entirely.

### 3.9 Channel deep links are broken — **P1**

`toHash` serialises `view:'channel'` as `#/s/{space}/e/{id}` (`nav.ts:131-133`), but
`hydrateFromHash` maps *any* `/e/{id}` back to `view:'entity'` (`nav.ts:151-153`). So `'channel'`
is **unreachable from a URL**: a channel deep link, a reload, or back/forward lands on the generic
Z4 entity route rather than the channel hub, and the rail's channel row loses its active state.
Two adjacent bugs in the same codec: an unrecognised view segment silently coerces to `home`, and
both codecs can emit `/e/` with an empty id when `entityId` is null.

### 3.10 The `work_session` panel denies the terminal exists — **P2**

`tm8Kinds.tsx:111-114` still renders *"No terminal stream: this tm8 node exposes no PTY route
yet"*. The PTY route shipped. Stale user-facing copy that actively misinforms.

### 3.11 Stale `STATE.md` claims (corrections)

- `STATE.md:142` "no client→server stdin" is **stale** — stdin is fully wired end to end
  (`SessionTerminal.tsx:93` → `ptyTransport.ts:425` → `pty-ws-server.ts:237` → `pty.write`). The
  limitation is the *UI surface*, not the backend.
- `main.ts:95-97`'s "InMemorySeqSource is a skeleton stand-in" is a stale comment over correct
  code (`seq.ts:82`).
- The parked "EntityProjector injection" item is ambiguous — `poll.ts:100` already injects a real
  `PgEntityProjector`.

---

## 4. What the backend cannot yet serve

**Class B — no operation exists; needs a contract amendment (five):**

1. **Authentication** — no `auth`/`login`/`logout` op anywhere in the catalog. Only
   `identity.get`. A second human cannot sign in.
2. **Account management** — `ensure_account` / `resolve_account_credential` are DB RPCs with no
   HTTP binding. (A full 467-line account service exists at `identity/service.ts` and is
   **test-only**; `pg-store.ts` is dead against the shipped migrations.)
3. **Space membership add/remove/role** — `spaces.members.list` is read-only; no mutation op.
4. **Project delete and custom-kind delete.**
5. **Node settings** — zero catalog ops; everything is an env var (`docs/ops/CONFIG.md:52`) and
   the 8-slot concurrency cap is hardcoded (`execution-handlers.ts:104,342`). `/health` is the
   only introspection. Design cannot be implemented here without an amendment first.

Also missing from the frozen contract though required by the security model: **`confirmUntrusted`**
(S12), and a **client→server WS subscribe frame** (see below).

**Class A — the op exists and answers 501; needs implementation only:** invites, sharing, files,
saved views, task axes, undo, placements, reactions, inbox, `entityKinds`, graph query, presence,
versions, leaderboard, awards, search, move, delete, edge writes, pull, tracking.

**The contract is not the bottleneck.** 28 of 80 operations are implemented; the remaining 53
are deliberate AM-5 honest-501s. Most of this report's "dead" findings resolve as those land.

**One structural blocker:** the realtime WS can never carry a graph event without *both* a
contract amendment (no client→server subscribe frame exists) and a log→publish bridge
(`publishDurable` has zero production callers). Until then the graph UI is poll-only.

### 4.1 Design debt in the corpus itself

Anyone designing from these documents will be misled unless these are fixed first (D Part 4):

- **The vendored UI data contract is stale.** `COLLAB_V2_UI_DATA_CONTRACT.md` still specifies
  Firebase/Supabase/RTDB, `/api/collab/v2`, an `X-Collab-Firebase-Token` header, per-kind routes,
  and event de-duplication by `eventId` — **all of which W1a removed.** tm8 is plain Postgres with
  loopback identity and a `{spaceId, seq}` envelope.
- **The renderer decision contradicts itself.** `STATE.md:140` says "DOM renderer only, forever"
  (with a hard-won rationale); `04:15` and T-D21 still say WebGL-on-Chromium. STATE is right.
- **`09:87` still says "nothing UI-shaped starts until G1 is green"** — superseded by AM-3, which
  put the UI inside G1A.
- **The Entity Component Contract says "all 11 kinds"**; tm8 has 13 core kinds plus `c:*`.
- **The ⌘K palette is called "the graph's front door"** but is built on `search.query`, which is
  a permanently reserved slot.
- **Home is space-scoped; R25 requires workspace-scope.**
- **Agent progress has two anchors** — the task (golden workflow 2) vs the `work_session`
  (`04:34`). Pick one before building the thread.
- **File size limit disagrees with itself** — 25 MiB (`04-COMM`) vs 512 MiB (contract).
- **`session_modals` is "never an entity"**, so agent-raised modals cannot render through Z1–Z4
  at all — they have no lawful home under the composition maxim (T-L2). Old maestro's modal UI
  has nowhere to go in tm8's design. This needs an explicit ruling.
- **Real design work exists only in `TRANSPLANT.md`** — the three-class degradation policy and
  the permanent gap banner were produced under wiring pressure and are not in the design corpus.
  They should be absorbed into it.

---

## 5. Prioritized roadmap

### Wave 0 — Stop the bleeding (days, no design needed)

Pure build, all small, all high-impact.

1. **Fix the Settings crash** + add an app-wide error boundary (§3.1).
2. **`registryFor` fallback entry** (§3.7) — closes the known white-screen class.
3. **Sessions list from `collections.query`** (F2) + a nav entry + reattach (S1, S3).
4. **`grantPoints` unblock** (§3.3) — one line.
5. **Fix the Z3 panel clipping** (§3.4).
6. **Add `delete`/`put` to `TmClient`** (§3.5) and fix the `events.poll` cursor type (§3.6).
7. **Fix the channel deep-link codec** (§3.9) — a URL asymmetry, not a redesign.
8. **Correct the two stale user-facing strings** — the `work_session` "no PTY route" paragraph
   (§3.10) and the project-trust default inversion (§3.8).
9. **Vendor `COLLAB_V2_UI_UX_BRIEF.md`** into `docs/` (F7) so gates are stateable in-repo.

*Outcome: the app stops crashing, and a spawned agent stops being disposable.*

### Wave 1 — Design the execution surface (design-led)

The largest design gap, and the one that defines tm8. Design before code.

1. **Sessions information architecture** — where sessions live in the shell; list, Z3, Z4.
2. **The terminal's home** — panel vs dockable pane vs full view; and the multi-terminal model
   (the suspend/resume machinery already exists and is waiting for it).
3. **Terminal chrome** — status, tokens, duration, model, controls. Benchmark: old maestro's
   strip (C).
4. **Prompt composer** — replacing `window.prompt()`.
5. **Session lifecycle states** — spawning/running/idle/exited, ghosts, cap-exceeded.

*Then build S1–S6, T1–T4.*

### Wave 2 — Make the graph UI honest (build-led, server-heavy)

Everything here is already designed; it is dead only because the server answers 501.

0. **Wire `capabilities.ts` into the screens** (F6) so every hollow zero and disabled control says
   why. This is the cheapest way to make the whole 501 surface survivable, and it is the design
   that was already agreed and then never connected. Do it first — it changes how everything
   below *feels* while it is still being built.
1. `placements.apply` → the entire drag-drop grammar comes alive at one call site (X4, M2).
2. `edges.*` writes → Connections tab, link composer (R4).
3. `entities.move` / `entities.delete` (R5).
4. `entities.react` (needs `TmClient.put`) → reactions (R2).
5. `graph.query` + register the Graph screen (M1).
6. `inbox`, `leaderboard`, `awards` → three screens stop being permanently empty.
7. `search` → the command palette becomes useful (X6).

### Wave 3 — The undesigned product surfaces (design-led)

1. **Projects management + trust** (P1–P3) — P0-urgent despite needing design, because without
   it a user cannot add a project or spawn anywhere new.
2. **Space management** — create/rename/archive; membership; invites incl. the redeem flow.
   Requires the membership contract amendment.
3. **Account / identity** — start with I1, the account menu, which needs only `identity.get`.
4. **Node settings** — start with N1, node status, from the existing `/health` payload.

### Wave 4 — Auth and multi-user

Sequenced last *only* because loopback auto-owner works today. It moves to the front the moment
tm8 binds beyond loopback. Needs the contract amendment first: login, owner setup, onboarding,
session expiry, token posture.

### Wave 5 — Completeness and polish

Files/blobs · custom-kind authoring · saved views · task axes · docs versions and margin threads
· channel auto-tabs · presence · undo · terminal theming · realtime WS (needs the amendment) ·
a11y and keyboard parity · sort/filter UI · offline UI · kind-specific Z4 layouts · the five
golden workflows green against the real backend (G2).

### A standing requirement, not a wave

**Add real-path integration tests.** All ~534 existing tests run on `MockFacade` (F5), so today's
suite would stay green through every defect in §3 — including the Settings crash. Until at least
the golden workflows run against a live server, this audit will need repeating. Pair this with
wiring `capabilities.ts` (Wave 2.0): together they are the two mechanisms that would have caught
almost everything in this report automatically.

### Sequencing note

Waves 0 and 2 are **build-only** and can run in parallel with the design work in Waves 1 and 3 —
different people, no contention. The one true ordering constraint is that the **contract
amendments** (membership, auth, account, deletes, WS subscribe frame) gate Waves 3–5, so they
should be drafted early even though they are implemented late.

---

## 6. Appendix — how this was verified

- **Live browser pass** (Playwright/Chromium, 1600×1000) over `:4611` against the live server:
  boot, all nine views, the Z3 panel and its tabs, the command palette. Screenshots and console
  errors captured; the Settings crash, the panel clipping and the placeholder Graph screen are
  all reproduced findings, not inferences.
- **Server probes** — `POST /v2/collections/query` with `kinds:["work_session"]` returns `200`
  on both `:4610` and `:4620` (F2). `/health` reports `operations:80, implemented:28` on both.
- **Not done:** no real agent was spawned, so the terminal's *live* appearance is assessed from
  source rather than a screenshot. Recommend a follow-up visual pass on a real session before
  the Wave-1 terminal design is finalised.
- **Sources:** the four research reports in [`_research/`](./_research/) carry the file:line
  citations behind every claim summarised here.
