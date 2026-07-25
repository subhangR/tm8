# C — Old-Maestro UI Benchmark

**What this is:** a feature-level record of what the shipped old-Maestro desktop UI
(`/Users/subhang/Desktop/Projects/maestro/agent-maestro`, package `maestro-ui/`) actually
puts in front of a user. It exists so the tm8 rebuild can be measured against a concrete
baseline rather than against memory.

**Method:** oriented via the repo's graphify knowledge graph (`graphify query` / `explain` /
`path`), then read the source files it pointed at. Read-only; no code or git was touched.

**Scale of the thing being benchmarked:** ~102k lines of TS/TSX in `maestro-ui/src`,
43 Zustand stores, ~90 top-level CSS files (one per surface), ~70 hooks.

All paths below are relative to `maestro-ui/src/` unless stated otherwise.

---

## 0. The app shell at a glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ProjectTabBar  [●proj A 3] [★proj B 1] [+]        ⊞ ✎ 🔊 ⚙ ☾ 🔍 ⌘K        │  top bar
├───┬──────────────────┬────────────────────────────────┬───────────────┬────┤
│Ic │ MaestroPanel     │  main / terminalArea           │ SpacesPanel   │ Sp │
│on │  Tasks           │   ┌──────────────────────────┐ │  Sessions ▾   │ ac │
│Ra │  Members         │   │ TerminalStrip (log bar)  │ │  ─────────    │ es │
│il │  Teams           │   ├──────────────────────────┤ │ [Terminals]   │ Ra │
│   │  Skills          │   │                          │ │ [Agents]      │ il │
│ ▤ │  Lists           │   │  SessionTerminal (xterm) │ │ [Docs]        │ (av│
│ 👥│  Graphs          │   │  · or SessionStatsView   │ │ [Drawings]    │ at │
│ ⚙ │  Files           │   │  · or Excalidraw         │ │  open/done/   │ ars│
│ ✦ │  Collab Space    │   │  · or CodeEditor         │ │  archived/    │ )  │
│   │                  │   │  · or SpaceWindow        │ │  huddles      │    │
│   │                  │   └──────────────────────────┘ │  session tree │    │
│   │                  │   + TaskDetailOverlay          │               │    │
│   │                  │   + SessionDetailOverlay       │               │    │
│   │                  │   + DocViewer / AppModals      │               │    │
│   │                  │   + AppSlidePanel (right slab) │               │    │
└───┴──────────────────┴────────────────────────────────┴───────────────┴────┘
                     MobilePanelNav (≤768px only)
```

Assembled in `App.tsx:566-720`. Left = `components/AppLeftPanel.tsx`, middle =
`components/app/AppWorkspace.tsx`, right = `components/SpacesPanel.tsx`.

---

## 1. SESSIONS SURFACE (highest priority)

### 1.1 Design / UX

Sessions live in the **right-hand panel**, not the left. The right panel has two states: a
narrow **avatar rail** (`SpacesRail`, ~48px, one circular button per session) and an
**expanded list** (`SpacesPanel` → `SessionsSection`, resizable). The expanded list is the
real sessions surface: a project header, a quick-launch chip row, a four-way segmented
filter, a four-way lifecycle sub-tab bar, and then a **recursive tree of session tiles**
where children are the sessions a coordinator spawned. Live status is carried on the tile
by a green dot (solid = terminal alive, pulsing = PTY currently streaming bytes), a status
glyph, and a `NEEDS INPUT` badge; the same signals bubble up to the avatar rail and further
up to the project tab in the top bar.

Clicking a tile does one of exactly two things, decided by a single shared predicate
(`utils/sessionClickRouting.ts` → `willOpenStatsOnClick`): if a live terminal exists it
switches the center pane to that terminal; if not it opens `SessionStatsView`, a full
post-mortem page, in the same box. The Resume button's visibility is locked to the *same*
predicate so the affordance can never disagree with what a click does.

### 1.2 Sessions list — concrete features

**Container / chrome**
- Right panel, collapsible to an icon rail; width persisted (`--right-panel-width`,
  `useUIStore.rightPanelWidth`, clamped `MIN/MAX_RIGHT_PANEL_WIDTH`); drag handle
  `sidebarLeftResizeHandle` in `App.tsx:679`.
- Panel header tabs: **Sessions** (with count) / **Resources** — `SpacesPanel.tsx:138-155`.
- Header `Sessions` + action icons: **Refresh tasks**, **Open board view**, **Session
  history** (with count badge), **Session tools** ⚙ menu — `SessionsSection.tsx:1256-1355`.
- Session tools menu items: `Agent shortcuts`, `Manage terminals`, `Manage persistent
  terminals`.
- **Session history dropdown** — portalled panel listing past sessions with a virtualized
  list and per-row Resume (`SessionsSection.tsx:1360-1390`, `VirtualizedHistoryList`).

**Quick launch row** (`pn-quick`, `SessionsSection.tsx:1393-1436`)
- Icon-only chips: New terminal (`>_` mark), then Claude / Codex / Hermes / Gemini in the
  fixed order `QUICK_AGENT_ORDER = ['claude','codex','hermes','gemini']`, each rendering the
  vendor logo via `AgentLogo`.

**Segmented content filter** (`SESSION_FILTER_TABS`, `SessionsSection.tsx:113-124`)
- `Terminals` / `Agents` / `Docs` / `Drawings`, each with an inline count badge.
  Default is `agents`. Docs and Drawings swap the whole list for
  `ProjectDocsList` (project-wide paginated doc lists, `kind="markdown"` / `kind="diagram"`).

**Lifecycle sub-tabs** (`SessionsSection.tsx:1441-1470`)
- `Open` · `Done` · `Archived` · `Huddles`, each with a count.
- Routing is purely server-persisted (`utils/sessionLifecycle.ts:18-24`):
  `archivedAt` → Archived (wins), else `humanCompletedAt` → Done, else Open.
  **Liveness is explicitly *not* a routing criterion** — a "done" coordinator can still
  have live workers.
- `Huddles` is a *virtual, cross-project* tab backed by `GET /api/huddles`; no session
  resolves to it.
- **`N live` toggle chip** — filters to only sessions with a live terminal.
- **View-options menu** (sliders icon) with four persisted checkboxes:
  `Task details`, `Completed sub-sessions`, `Model & mode badges`, `Elapsed time`
  (`useUIStore.sessionShowTaskDetails / sessionShowCompletedSubSessions / sessionShowBadges
  / sessionShowElapsed`, all localStorage-backed).

**Grouping**
- **Spawn tree** — the primary grouping. `hooks/useSessionTree.ts` +
  `SessionNodeRenderer` render `parentSessionId` hierarchy recursively with indent rails
  (`pn-kids`), a disclosure arrow, and a child count.
- **Team boxes** — a coordinator root whose team is known is wrapped in a labelled
  `pn-team` frame: team color dot, team name, `N sessions` (`SessionsSection.tsx:1600-1620`,
  `utils/teamGrouping.ts`).
- **Ensemble groups** — dashed-frame groups above the tree for spell ensembles, expandable,
  leader marked with ★ (`components/spells/EnsembleGroup.tsx`).
- Plain (non-Maestro) terminals render in a **separate drag-sortable list** below the tree
  (`@dnd-kit` sortable, 300ms press delay).

**Empty states** — per sub-tab, with a distinct glyph, title and coaching hint, e.g.
Archived: "Sessions you close with ✕ are dismissed here. Restore them anytime."

### 1.3 Session tile (`components/maestro/SessionListItem.tsx`)

One tile = one Maestro session. Row contents, left → right:

- Disclosure arrow + child count (sub-sessions).
- **"Mark done" radio** — pure intent marker: stamps `humanCompletedAt`, moves the root to
  the Done tab, and deliberately leaves every terminal in the subtree running. Archived
  tiles show a static archive glyph instead.
- Agent logo (`AgentTile`, claude / codex / gemini / initial-letter fallback) + session title.
- Tags: `archived`, `done`.
- **Live indicator** — `pn-dot--run` (solid green = live terminal, click opens it) with
  `pn-dot--live` pulse only while bytes are actually streaming (`agentWorking`, 2s idle
  debounce in `useSessionStore`); or a "stopped" marker meaning click → stats view.
- Doc count mini-pill; worktree branch mini-pill (`gitBranch` icon).
- **Status glyph** — one of `spawning | idle | working | completed | failed | stopped`
  (`MaestroSessionStatus`, `app/types/maestro.ts:6`), overridden by `needsInput`.
- **Action buttons**: Team view (only if it has children) · Resume (only when a click would
  open stats; disabled if `isAgentToolResumable` is false) · Close ✕ (danger; stops the
  terminal and archives the **whole subtree**) · Restore ↺ (archived only) · Copy session
  reference (`"Name (id)"` to clipboard, with a check-mark confirmation) · Expand caret.
- Optional info row: mode badge, model badge, elapsed / time-ago.
- Optional task lines: per-linked-task status glyph + title.

**Expanded tile meta** (caret) adds:
- Status badge, an **editable mode dropdown** (portal popover, writes the session mode),
  model badge, strategy badge, worktree branch badge, start time.
- Linked tasks as chips (first 4 + `+N`).
- **Docs as clickable pills** (`M↓` markdown / `⬡` diagram / `{}` other) that open the
  shared `DocViewer` overlay.
- An `Details` button opening the full `SessionDetailOverlay`.

Concentric **spell rings** are drawn around the tile, the rail avatar, and the terminal
container when spells are active on that session, with a `+N` overflow pill that opens the
spellbook scrolled to that session (`utils/spellRings.ts`, `useActiveSpellsStore`).

### 1.4 Session detail views (there are four, deliberately)

1. **`SessionDetailOverlay.tsx`** — the full-screen-ish modal. Header shows breadcrumb
   `Session`, an **editable title input**, status/model/mode badges. Tabs:
   `Info` · `Sub-sessions` (count) · `Tasks` (count) · `Docs + Timeline`. Footer shows the
   copyable session id.
2. **`SessionStatsView.tsx`** (1440 lines) — the *center-pane* session page shown whenever
   a session has no live terminal. Sections, in order:
   `Tasks` (N linked) · `Tokens & tools` · `Last messages` · `Transcript` ·
   `Command usage` (N CLI commands) · `Timeline` (N events) · `Docs produced` ·
   `Sub-sessions` · `Session prompts` · `Run configuration` · `Identity details`.
   It renders a hero card (avatar, name, role, team-member chips, the agent's **final
   message** with expand), an outcome ring (`success` / `failure` / `neutral` /
   `human-done` / `archived`), Duration / Started / Completed, a **stacked token bar**
   (cache read / input / cache create / output with % legend), a **tool-call bar chart**,
   assistant-msgs / user-prompts / tool-calls counters, a rendered **last-messages thread**
   with markdown-inline, and `Restore` / primary-action buttons. It is drill-down capable
   (`ssv-back`, re-root at a sub-session).
3. **`SessionDetailModal.tsx`** — lighter modal used from the sidebar status badge.
4. **`MaestroSessionContent.tsx`** — the inline expansion *inside* a terminal-list row:
   queue status, session tree header, linked task list with subtasks and jump-to-task links.

**Timeline** (`SessionTimeline.tsx`) filters events by `thisTask` / `milestones` /
`errors` / `all`. `TimelineEvent.tsx` renders individual entries.

### 1.5 Session ↔ task relationship display

- Tile task-lines and task chips (status glyph + title), capped at 4 with `+N`.
- `sessionTaskChip--<status>` chips on the active terminal row.
- Jump-to-task buttons inside `MaestroSessionContent` and `SessionInTaskView.tsx`
  (the reverse view: sessions listed inside a task).
- `hooks/useSessionTasks.ts`, `useTaskSessions.ts`, `useTaskSessionCount.ts`.
- Drag a task card onto the terminal to inject `[Task: <title>] <initialPrompt|description>`
  as a prompt (`AppWorkspace.tsx:322-341`, MIME `application/maestro-task`).

### 1.6 Session controls

| Control | Where | Effect |
|---|---|---|
| Spawn (agent) | `NewSessionModal`, quick-launch chips, task "Work on this", `ExecutionBar` | `POST /api/sessions/spawn` → WS `session:spawn_request` → local PTY |
| Quick start | quick-launch chip row / `NewSpaceDropdown` | one-click Claude/Codex/Gemini/Hermes terminal |
| Prompt | `sendPromptToActive` / `sendPromptToSession` / `sendPromptFromCommandPalette`, modes `'paste'` \| `'send'` | queued delivery with byte accounting, drain, overflow warning (`useSessionStore.ts:60-160`) |
| Stop / Close | tile ✕, row `Close` | confirm modal, then stop terminal + archive **entire subtree** |
| Mark done | tile radio | stamps `humanCompletedAt` only |
| Restore | archived tile ↺ | un-archives subtree |
| Resume | tile / history / stats view | revives terminal via agent-tool resume (`isAgentToolResumable`) |
| Attach (persistent) | `PersistentSessionsModal` | attach/kill detached persistent terminals |
| Reorder | drag on plain terminals | `reorderSessions(draggedPersistId, targetPersistId)` |
| Copy reference | tile | `"Name (id)"` for pasting into another agent |

Close-app guard: closing the window with live sessions raises
**"Close App and All Running Sessions?"** listing every running session grouped by project
(`App.tsx:723-770`).

### 1.7 Multi-session management

- **Team View** (`components/maestro/TeamView.tsx`) — a full-screen grid that
  **reparents the actual xterm DOM elements** into slot hosts (`appendChild`, restored on
  close), so you watch a coordinator and all its workers live, side by side. Breadcrumb
  trail lets you re-root at any node; each slot has a header, worktree badge, sub-agent
  stats badge (`total / active / inactive`), Resume button, and a drill-in for slots that
  themselves have children. Esc closes.
- **Multi-Project Board** (`MultiProjectBoard.tsx`) + **MultiProjectSessionsView.tsx** —
  cross-project view with per-session **resizable, collapsible columns**, each toggling
  between `Terminal view` and `Timeline view`.
- **Avatar rail** — always-visible per-session avatars with working pulse and needs-input
  dot, grouped by team.
- **Project tabs** roll session count, working-agent count and needs-input up to the top bar.
- **Huddles** — cross-project clusters of inter-session prompts, rendered as cards with
  member avatar chips that click through to the session.

### 1.8 Navigation between sessions

- Click tile → terminal or stats (single predicate, see above).
- Click rail avatar → activate.
- `⌘E` next session, `⌘R` previous session (Ctrl on Windows/Linux).
- `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle.
- `⌘W` close active session.
- Command palette (`⌘K`) session search.
- Jump-to-session from a task (`handleJumpToSessionFromTask`).
- Deep-select of an inactive session sets `useUIStore.inspectedSessionId`, which is the
  single source of truth for "which tile is highlighted".

### 1.9 Stores backing the sessions surface

- **`useSessionStore.ts`** (1677 lines) — the local terminal sessions array, `activeId`,
  new-session form state, prompt delivery queue with byte budget + drain + overflow warning,
  `agentWorking` detection from PTY bytes, session ordering per project, recent-session
  keys, close/quick-start/SSH-connect/attach flows.
- **`useMaestroStore.ts`** (1571 lines) — server entities: `sessions`, `tasks`,
  `teamMembers`, `teams`, fed by the WebSocket bridge.
- **`usePersistentSessionStore.ts`** — detached/persistent terminal registry, the
  `Persistent terminals` and `Manage terminals` modals.
- **`useUIStore.ts`** (613 lines) — `iconRailActiveSection`, `inspectedSessionId`,
  `teamViewRootId`, `multiProjectBoardOpen`, panel widths, the four session view-option
  flags, slide-panel tab.
- Supporting: `useSessionTree`, `useMaestroSessions`, `useMaestroWebSocket`,
  `useSessionActions`, `useSessionLifecycle`, `useSessionOrdering`, `useSessionDocs`,
  `useRecentSessionManager`, `stores/sessionRestore.ts`.

---

## 2. TERMINAL

### 2.1 Where it lives and how it looks

The terminal is the **center pane** and the app's default content. It is not a tab, not a
drawer, not a bottom panel — the whole middle column is `terminalPane > terminalDeck`, and
every other center-pane surface (stats view, whiteboard, file editor, collab space) is an
alternative *to* it in the same box.

Visually it is a **full-bleed dark xterm** with no window chrome of its own. There are no
terminal tabs. Instead:

- **Above it**: `TerminalStrip` — a single horizontal bar in normal flow (explicitly *not*
  an overlay), described below.
- **Overlaid top-left**: `ModeChip` — the session's role (coordinator / worker).
- **Around it**: an optional `coordinator-glow` border for coordinator sessions and
  concentric **spell rings** for active spells.
- **Empty state**: an ASCII art box, a blinking `> ready for instructions_` prompt line, and
  the hint "Launch a session from the sidebar to begin" (`AppWorkspace.tsx:530-548`).

Terminal switching is by **selecting a session in the right panel** or by keyboard, not by
tabs. One terminal is visible at a time; the exceptions are Team View and the Multi-Project
Board, which reparent multiple live xterms into a grid.

### 2.2 Single vs multi terminal — the mounting model

This is the most load-bearing design decision in the terminal stack
(`AppWorkspace.tsx:136-230`):

- **Web**: "render one terminal" — only the **active** xterm is mounted. Every other
  terminal is unmounted (freeing its xterm, up to 5000 lines of scrollback, and its DOM),
  and its socket is `suspend()`ed so it stops receiving and VT-parsing PTY output. On
  switch-back the terminal remounts and calls `requestFullReplay()` against the server's
  ring buffer. Mounted cost is O(1) regardless of how many agents are running.
- **Tauri (desktop)**: mounts everything — the native PTY is one shared event channel, so
  per-session suspend doesn't exist there.
- **Team View / Multi-Project Board open** → force `mountAll`, because those views pull
  terminal DOM out of the deck by `[data-terminal-id]`.
- **`services/terminalVisibilityDriver.ts`** (web) does the finer-grained version: it reads
  the DOM computed `visibility` of each mounted xterm (so it transparently handles the
  reparenting views), keeps a **warm LRU of 3** terminals live, suspends only after
  **10s of continuous invisibility**, resumes immediately on becoming visible, and flushes
  the write scheduler before suspending so the resume offset can't skip or duplicate bytes.
- **`services/terminalWriteScheduler.ts`** batches writes into xterm.

### 2.3 The chrome around the terminal — `TerminalStrip`

`components/session-log/TerminalStrip.tsx` (495 lines) is the terminal's header bar. It is
a row above the terminal containing, left → right:

1. **`Session Log` toggle** — chevron + label + a pulsing live dot + a `LIVE` tag when the
   agent's JSONL log is still being appended.
2. **Stats rail** (edge-faded, horizontally scrollable):
   - A small **circular context gauge** — `contextTokens / 200,000` with a percentage
     tooltip and a compact label (`12.4k`).
   - `out <tokens>` (cumulative output), `<N> tools`, and duration (`3m 12s`).
3. **`SessionDocsMenu`** — inline doc/diagram tabs that open in the shared doc overlay.
4. **Model badge** — a brass pill showing the model, stripped to e.g. `opus-4-5`.
5. **Actions**: 📎 *Attach files* (native file dialog → injects `@path` refs into the
   session), ✎ *Draw* (opens an Excalidraw board wired to send its PNG back into the
   session), ✦ *Cast spell* (opens the spell launcher targeting this session), × *Hide*.

**Expanding the strip** drops a **full agent transcript** down below the bar (it does not
overlay the terminal): parsed Claude/Codex JSONL grouped into conversation groups and
rendered by `LogMessageGroup`, auto-scrolled while pinned to the bottom.

When hidden, the strip collapses to a small floating `▾ Session Log` restore button in the
terminal's top corner, keeping zero layout footprint.

Implementation notes worth carrying over: the strip finds the agent's log by walking up to
**12 cwd ancestors** (the agent's cwd drifts as it `cd`s, but the log lives under the launch
dir) and matching by unique maestro session id; it polls every **2000ms**; and it retains
only the last **400 messages**, folding trimmed ones into running aggregates so displayed
totals stay exact without unbounded memory growth.

### 2.4 Input handling, copy, paste

`SessionTerminal.tsx` (1009 lines):

- **Copy**: `⌘C` (or `Ctrl+Shift+C`) with a selection copies via
  `copyToClipboardOrWarn(term.getSelection(), "Selection")` and swallows the key.
- **Paste**: a capture-phase native `paste` listener on the container runs *before* xterm's
  textarea handler. Plain text goes through `term.paste()` (bracketed paste, so a multi-line
  paste never auto-submits). **Images** are intercepted, uploaded, and injected as `@path`
  references — never base64 — following a "paste, don't submit" contract.
- **Drag-and-drop**: files/images dropped onto the terminal follow the same path.
  Maestro *tasks* dropped on it inject `[Task: …]` prompt text.
- **`Shift+Enter`** is intercepted at all event phases and rewritten to the CSI-u sequence
  `\x1b[13;2u`, so it inserts a newline in the agent's composer instead of submitting.
- Command detection: submitted input lines are parsed out of `onData` and reported to
  `onCommandChange(id, line, "input")`; OSC sequences drive `onCwdChange`.
- **Read-only mode** for exited/closing sessions (`readOnly={Boolean(s.exited || s.closing)}`).

### 2.5 Sizing, scrollback, search

- `FitAddon` + a `ResizeObserver`; the fitted `cols/rows` is pushed to the PTY via
  `platform.terminal.resize()`, with caches (`serverPtySizes`, `lastFittedSize`) kept
  coherent. Font/spacing changes re-fit and re-ship the size explicitly, because the
  container box doesn't change and the observer wouldn't fire.
- Resizing is by dragging the panel splitters, not by a terminal-owned splitter.
- Scrollback is a user setting (default 5000 in practice; `DEFAULT_SCROLLBACK` in
  `useTerminalSettingsStore`).
- **There is no in-terminal search UI** — no xterm `SearchAddon` is wired. Search over
  session content is done through the expanded Session Log transcript, `SessionLogModal`,
  and the command palette.

### 2.6 Theming

`stores/useTerminalSettingsStore.ts` (498 lines) + `components/TerminalSettings.tsx` (623
lines) give a genuinely deep terminal appearance editor, persisted to localStorage and
applied live to every open xterm:

- **Font presets**: JetBrains Mono (default) · System Mono (SF Mono) · Menlo · Monaco ·
  Courier. Font size 9–22 (default 13).
- **Font weight**: Light 300 / Regular 400 / Medium 500 / SemiBold 600 / Bold 700, plus a
  separate bold weight.
- **Line height** and **letter spacing** sliders with explicit min/max/step.
- **Cursor style**: Block / Underline / Bar. **Inactive cursor style**: Outline / Block /
  Bar / Underline / None. **Cursor blink** toggle (auto-disabled on inactive terminals to
  save a repaint timer).
- **Scrollback** size.
- **Full 22-slot color editor**: Background, Foreground, Cursor, Cursor Accent, Selection
  BG, Selection FG + all 16 ANSI colors, each with a color input; plus named presets
  (e.g. *Warm Atelier*, the house palette: fg `#D9D2C4`, cursor `#E0A45A`).
- The terminal stays dark in both app themes; the background flips between two dark values
  to match the chrome gutter unless the user sets an explicit override. A `MutationObserver`
  on `document.documentElement[data-theme]` re-applies the theme live.
- **Renderer**: the working tree is **DOM-renderer only**, with an explicit in-code
  rationale at `SessionTerminal.tsx:222-230` — xterm's WebGL renderer allocates one GPU
  context *per terminal*, and with many terminals mounted the browser blows past its ~16
  context limit and the whole UI (not just the terminal) goes laggy. A WebGL-on-web variant
  with a DOM fallback exists in recent commit history (`3d357dd`) but is not what the
  current tree renders. **Carry the constraint, not the addon.**

### 2.7 The non-terminal alternatives

There is **no "Chat" tab on `main`** — that work lives on a feature branch. What ships on
main as terminal alternatives, all transcript-powered:

- **`TerminalStrip` expanded log** — inline, in-place transcript (§2.3).
- **`SessionLogModal` / `SessionLogViewer` / `ContextPanel`** (`components/session-log/`) —
  a standalone full log reader, opened per session from the `Logs` button.
- **`SessionStatsView`** — the read-only session page with a rendered `Last messages`
  thread and `Transcript` section (§1.4). This is what replaces the terminal for any
  session with no live PTY, which is the common case for finished work.
- `platform/logs.ts` abstracts the two log backends (native FS read vs server endpoint);
  `utils/claude-log/` parses the JSONL into messages/groups.

---

## 3. LAYOUT / PANELS

### 3.1 Top bar — `components/ProjectTabBar.tsx` (817 lines)

- Draggable, reorderable **project tabs**. Each tab: a status dot
  (`wait` if any session needs input / `run` + live pulse if agents are working / `idle`),
  a ★ for master projects, the name, a working-agent count pill, a session count pill, and
  (on the active tab) a gear opening **Project Settings**.
- `+` menu: `NEW PROJECT` · `OPEN SAVED PROJECT`.
- Right cluster: team gateway link (gateway mode only) · **Multi-Project Board**
  (`⌘⇧B`) · **Whiteboard** (`⌘⇧X`) · **mute/unmute sounds** · **Settings** · **theme
  toggle** (sun/moon) · **search** · **command palette** with a visible `⌘K` key cap.
- `UpdateBanner` sits directly beneath.

### 3.2 Left — icon rail + `MaestroPanel`

- **`IconRail`** (`components/IconRail.tsx`): a 8-item vertical rail with the brand mark on
  top — `Tasks` (badge: open task count), `Members` (badge), `Teams` (badge), `Skills`,
  `Lists`, `Graphs`, `Files`, `Collab Space`. Clicking toggles the section; clicking the
  active one collapses the panel entirely.
- **`MaestroPanel`** (853 lines) renders the selected section. Primary tabs
  (`PanelIconBar.tsx`): `tasks | lists | team | skills | graphs | profiles | collab`;
  `team` has sub-tabs `members | teams`; `tasks` has sub-tabs
  `current | pinned | completed | archived` (empty copy: `NO TASKS IN QUEUE`,
  `$ maestro new task`).
- Selecting `Files` swaps in `FileExplorerPanel` instead.
- The panel is **kept mounted once opened** (`hasMountedMaestroRef`) and hidden with CSS —
  remounting it was expensive.
- Width via `--maestro-sidebar-width`, resize handle in `App.tsx:657`, clamped
  `MIN/MAX_MAESTRO_SIDEBAR_WIDTH`, persisted. The resize writes a CSS var, not React state,
  so dragging never re-renders the heavy panel (`hooks/useAppLayoutResizing.ts`).

### 3.3 Middle — `AppWorkspace`

A flex row of up to three panes (`AppWorkspace.tsx:424-780`):

1. **`terminalPane`** — TerminalStrip + terminal deck (or stats / whiteboard / collab
   space / file-space editor, which take over the whole row).
2. **`codeEditorPanel`** — lazy-loaded Monaco editor, opened per workspace key, with
   persisted editor state, an `openFileRequest` channel, and a `workspaceResize` splitter.
3. **`fileExplorerPanel`** — file tree with rename/delete, "open terminal at path", persisted
   expansion state, and a distinct SSH-remote variant.

Widths are CSS vars (`--workspaceEditorWidthPx`, `--workspaceFileTreeWidthPx`) driven by
`useWorkspaceStore`, persisted **per workspace key** — the key is
`ssh:<projectId>:<persistId>` for SSH sessions, otherwise project-scoped — so each
session/project remembers its own editor/tree layout independently.

Overlays that live inside the terminal area: `TaskDetailOverlay`, `SessionDetailOverlay`,
`DocViewer`, `AppModals`, `AppSlidePanel`.

### 3.4 Right — `SpacesPanel` / `SpacesRail`

Covered in §1.2. Two modes (rail / expanded), two tabs (`Sessions` / `Resources`),
resizable and persisted, collapsible with `⌘.`.

### 3.5 Slide panel — `SlidePanel.tsx` + `components/AppSlidePanel.tsx`

A right-edge slab with its own resize handle and four tabs:
**Prompts** · **Recordings** · **Assets** · **Settings**.
- Prompts: pinned section + all prompts; pinned slots 1–5 are sendable with `⌘1`–`⌘5`.
- Recordings: date-grouped (`Today` / `Yesterday` / `This Week` / `Older`).
- Settings: `Auto-create` (create missing files on new sessions, with a per-project
  disable note), `Templates`, `Appearance`.
- Toggled by `⌘⇧P` (prompts), `⌘⇧R` (recordings), `⌘⇧A` (assets).

### 3.6 Modals & overlays

`components/app/AppModals.tsx` centralises them; `components/modals/` holds 18:
`AgentModalViewer`, `ApplyAssetModal`, `ConfirmActionModal`, `ConfirmDeleteProjectModal`,
`ConfirmDeleteRecordingModal`, `ManageTerminalsModal`, `NewSessionModal`, `PathPickerModal`,
`PersistentSessionsModal`, `ProjectModal`, `ProjectSoundSettings`, `RecordingsListModal`,
`ReplayModal`, `SecureStorageModal`, `SshManagerModal`, `SoundSettingsModal`,
`StartRecordingModal`, `UpdateModal`. Most are portalled to `document.body`.

Full-screen takeovers: **Team View**, **Multi-Project Board**, **Startup Settings Overlay**,
**Command Palette**, `GatewayLoginGate` / `LoginOverlay`.

### 3.7 Responsive / mobile

`hooks/useBreakpoint.ts` → `mobile` at ≤768px. `useMobilePanelStore` switches between
`maestro` / `main` / `spaces` panels with a bottom `MobilePanelNav`, and `AppWorkspace` gets
a sub-view switcher (`primary` / `editor` / `files`) that auto-falls-back when a sub-view
isn't available.

### 3.8 Layout persistence summary

| Thing | Key / store |
|---|---|
| Active icon-rail section | `STORAGE_ICON_RAIL_SECTION_KEY` (localStorage) |
| Maestro sidebar width | `useUIStore` → CSS var, clamped, persisted |
| Right panel width | `useUIStore.rightPanelWidth`, clamped, persisted |
| Editor / file-tree widths | `useWorkspaceStore`, **per workspace key** |
| Editor open state, open file, tree expansion | `useWorkspaceStore` per key |
| Session view options (4 toggles) | `useUIStore`, localStorage |
| Terminal appearance (all of §2.6) | `agents-ui-terminal-settings-v2` etc. |
| Session order per project | `useSessionStore.sessionOrderByProject` |
| Collab space section per space | `space.<id>.section` |
| Theme, zoom, sound | `useThemeStore`, `useZoomStore`, `soundManager` |

---

## 4. TASKS, TASK DETAIL, TEAM MEMBERS, TEAMS, PROJECTS

Core enums (`app/types/maestro.ts:4-10`):
- `TaskStatus` = `todo | in_progress | in_review | completed | cancelled | blocked | archived`
- `TaskPriority` = `low | medium | high`
- `TaskSessionStatus` = `queued | working | blocked | completed | failed | skipped`
- `AgentMode` = `worker | coordinator | coordinated-worker | coordinated-coordinator`
  (legacy aliases `execute | coordinate`)
- `AgentTool` = `claude-code | codex | hermes | gemini`
- `TeamMemberStatus` / `TeamStatus` = `active | archived`; `TeamMemberScope` = `project | global`

### 4.1 Tasks — list and board

**Design.** The left panel is a dense, monospace-flavoured "terminal" list: project header,
a sub-bar with a green `+ New task` and four icon sub-tabs, a `Search tasks` box with a `⌘K`
hint, a filter-chip strip, an execution bar, then single-line task tiles (`pn-tt`) that
expand a meta panel in place. The board is a separate full-screen portal with three tabs and
five kanban columns of draggable cards.

- Sub-tabs with counts: `current` · `pinned` · `completed` · `archived`
  (`MaestroPanel.tsx:641-644`).
- **Fuzzy search** (`hooks/useTaskSearch.ts`) — Fuse over `title` 0.4, `description` 0.3,
  `initialPrompt` 0.15, `status` 0.1, `priority` 0.05; threshold 0.4. The index is built
  **only while a query is active** (unconditional re-indexing on every WS tick was
  measurable jank).
- **Filter chips** (`TaskFilters.tsx`): quick pills `All` / `High` / `Overdue`; multi-select
  `Status · N` and `Priority · N` popovers; `Sort` popover; an expand toggle showing the
  active-filter count. Status options carry glyphs: `Todo ○`, `In Progress ◉`,
  `In Review ◎`, `Completed ✓`, `Blocked ⊘`, `Cancelled ✕`.
- **Sort**: `Custom` · `Updated` · `Created` · `Priority` · `Due Date`. `Custom` swaps the
  list for a dnd-kit `SortableTaskList` (300ms press delay) with persisted ordering.
- Non-custom sorts split `Current` into **`In progress`** and **`Up next`** sections with
  count badges (`TaskTabContent.tsx:86-113`).
- ASCII empty states: `NO TASKS IN QUEUE` / `$ maestro new task`, `NO PINNED TASKS`,
  `NO COMPLETED TASKS YET`, `NO ARCHIVED TASKS`.
- **Task tile** (`TaskListItem.tsx`, 917 lines): selection checkbox (execution mode),
  subtask chevron + child count, one-click status radio (`completed ⇄ todo`), title,
  live-session dot, priority tag `HIGH`/`MED`/`LOW`, stacked assignee avatars, doc count,
  `▶` run button. Expanded rows add: status dropdown (all 7 statuses), priority badge,
  multi-select assignee popover (+ `New Member`), a model badge embedding
  `LaunchConfigDropdown`, `YOLO`/`Safe` (`dangerousMode`) and `worktree`/`in-place`
  (`useWorktree`) toggles, `Share`, session chips (max 3 + `+N`) reading `NEEDS INPUT` /
  `DONE` / status, doc pills (`M↓`, `{}`) and diagram pills (`⬡`) plus `+ Diagram`.
- Every task row is HTML5-draggable, writing `application/maestro-task` and a `text/plain`
  fallback `[Task: <title>] <content>` — this is what makes drag-onto-terminal work.
- Delete confirm `[ DELETE TASK ]`, confirm label `Delete All (N)` when it has descendants.
- **Board** (`MultiProjectBoard.tsx` + `ProjectKanbanRow.tsx`): tabs `Tasks` / `Sessions` /
  `Dashboard`; layout toggle `Grouped by project` vs `Unified kanban`; stat chips
  (active/pending/blocked/review/done). Columns: `BACKLOG ○` · `BLOCKED ✗` ·
  `IN PROGRESS ◉` · `REVIEW ◎` · `DONE ✓`. Per-column collapse to a vertical rail;
  drag-over highlight; virtualized unified view (`@tanstack/react-virtual`, est. 110px).
  Project sidebar with `Select All` / `Deselect All`, colour swatch, `★` master marker,
  `N tasks` / `N sess`, persisted to `maestro-board-selected-projects`.
- **Batch execution**: `ExecutionBar` turns on `executionMode` (checkboxes on every tile),
  offers `execute` vs `orchestrate` batch modes over the selection, and `Save as team`.

### 4.2 Task detail

**Task detail is the same component as task creation** — `CreateTaskModal` in `mode="edit"`,
rendered by `TaskDetailOverlay` with `variant="overlay"`. It reads like a document editor:
breadcrumb crumb line, a large borderless title input, a `@`-mentions description textarea
with attachment chips, a bottom tab strip that opens a ≤220px inline drawer, and a two-zone
footer. Edits **auto-save on a 1000ms debounce** with a `Saving… / Saved / Save error` dot.

- Tabs (`task-modal/TaskTabBar.tsx`): `Subtasks` (`done/total`) · `Skills` (count) ·
  `Sessions` (count) · `Ref Tasks` (count) · `Gen Docs` (count) · `Timeline` · `Details`.
- **Details tab** edits: `Priority` pills, `Model` (`ModelPickerChip`), `Due date`
  (`<input type="date">` + `Clear`), `Isolation` (`Git worktree` / `In-place`),
  `Permissions` (`YOLO` / `Safe`), `TaskSpellAssignment`, read-only `status: … · id: …`.
- **Subtasks tab**: `N/M completed (P%)`, inline `+ Add` (Enter adds, Esc cancels), per-row
  toggle / play / delete.
- Images: paste anywhere in the modal, document-level paste fallback, DOM drag-drop, **and**
  Tauri native `onDragDropEvent` for file paths; staged files upload after draft creation;
  full-screen preview with filename + size.
- **Draft lifecycle**: typing a title/prompt or attaching an image auto-creates a server
  draft named `Untitled N`; closing with unsaved content opens `ConfirmDiscardDialog`.
- Footer left: assignee chip (`Assign…` / member / `N members` / team) opening a portalled
  `TeamTaskPicker` (assigning a team clears members and vice-versa; teams flattened with
  depth + cycle guards); `YOLO`/`Safe`; `worktree`/`in-place`; model chip; a gear that swaps
  the body for `LaunchConfigPanel`; the auto-save indicator.
- Footer right by state: edit → `Close` + `▶ Run`; draft → `Close` + `▶ Run`; fresh create →
  `Cancel` + `Create` + `▶ Create & start`. `Run` saves then spawns with
  `mode: "worker", strategy: "simple"` plus any per-member overrides.
- `LaunchConfigPanel` per-member override editor: `agentTool`, `model`, `accessMode`,
  `skillIds`, `commandOverrides` across the same six command groups as the member modal.
- `⌘/Ctrl+Enter` saves (edit) or submits (create).

### 4.3 Task lists

`TaskListsPanel.tsx` — header `Task Lists` / "Organize tasks into curated lists." + `+ New
List`; draggable list cards showing chevron, name, `N tasks`, description, and
`↑ ↓ Add Tasks Edit Delete`. Expanding reveals a separately sortable nested task list with
status/priority badges and `Remove`.

- Two independent dnd-kit contexts (list order and intra-list task order), both persisted;
  `↑`/`↓` buttons as a keyboard fallback.
- Missing references render `Missing task reference (<id>)` / `Task no longer exists`.
- `TaskListModal` edits `name` (required) + `description`. `TaskListAddTasksModal` is
  `[ ADD TASKS TO LIST ]` with Fuse search + checkbox multi-select.
- Data: `TaskList { id, projectId, name, description?, orderedTaskIds, createdAt, updatedAt }`.

### 4.4 Team members

`TeamMemberList` shows collapsed rows (emoji avatar with a ring if `isDefault`, name + role,
model/profile/`🌐 GLOBAL`/`DEFAULT` badges). The editor `TeamMemberModal` (1204 lines) is a
large modal: name as title, a 4-field top row, a `@`-mentions Identity editor, an agent-tool
tile picker with model + permission selects, a Memory read-out, three tabs, and a footer
model-profile selector.

**Every editable field:**

| Field | Control |
|---|---|
| `name` | title input (disabled for built-in defaults) |
| `avatar` | text input, `maxLength=2`, default `🤖` |
| `role` * | text, `e.g. frontend specialist, tester` |
| `mode` | segment `Worker` / `Orchestrator` |
| `scope` | toggle `🌐 Global` / `🌐 Project` |
| `identity` | `MentionsInput` with `@` trigger — "Describe this team member's persona, expertise, and how they should approach tasks…" |
| `agentTool` | tiles `Claude` / `Codex` / `Gemini` / `Hermes`; switching resets model to `DEFAULT_MODEL_BY_AGENT_TOOL[tool]` |
| `model` | select from `MODELS_BY_AGENT_TOOL[agentTool]` |
| `permissionMode` | `Accept edits` / `Interactive` / `Read only` / `Bypass — auto-approve` (values `acceptEdits`/`interactive`/`readOnly`/`bypassPermissions`) with a "⚠ All tool calls will be auto-approved…" warning |
| `memory` | read-only numbered list; "Memory is managed by the agent via CLI" |
| `capabilities` | 4 switches: `Spawn Sessions`, `Edit Tasks`, `Report Task-Level`, `Report Session-Level` |
| `workflowTemplateId` / `customWorkflow` | `Default (auto from mode)`, per-template, `Custom workflow...` (prefills from template phases) |
| `commandPermissions.commands` | collapsible groups with `(enabled/supported)` counts, per-command switches, greyed "Not available for current mode" |
| `skillIds` | `ClaudeCodeSkillsSelector` |
| `soundInstrument` | `piano`/`guitar`/`violin`/`trumpet`/`drums` + a 12-row sound-signature grid with `▶` previews |
| `modelProfileId` | `Custom model` or `Profile: <name> (<launch label>)`; when bound, shows `resolves at spawn` |

- **Command groups**: `Root` (whoami/status/commands) · `Task` (12) · `Session` (9) ·
  `Team Member` (create/list/get) · `Show` (show:modal) · `Modal` (modal:events).
- **Built-in defaults**: `simple_worker` ⚡, `coordinator` 🎯, `batch_coordinator` 📦,
  `dag_coordinator` 🔀, `recruiter` 🔍, `standup` 📋. Defaults get a `Reset Default` button.
- Auto-save (1000ms) in edit mode; validation `Name is required` / `Role is required`.
  Create mode auto-assigns an unused instrument for ensemble diversity.
- List sections: defaults → custom → `Global Members` → collapsible `Archived · N`.
  Row actions: `▶ Run`, `Edit`/`Configure`, `↗ Share`, `Archive`; archived get
  `Restore` / `Delete`.
- Supporting: `TeamMemberIntroDialog` (a `New teammate` walkthrough card),
  `WhoamiPreview` (collapsible preview of the generated manifest text),
  `ModelProfileModal` + `panels/ModelProfilesPanel` (reusable Heavy/Balanced/Fast classes).

### 4.5 Teams

Same tab, toggled by a segment between `List` and `Org chart`, with `+ Create Team`.

- `TeamModal` fields: `name` *, `description`, `avatar` (2-char, 👪), `Leader` * (select of
  active project members), `Members (N)` switch list, `Sub-teams (N)` switch list.
- The leader is auto-added to `memberIds` and cannot be deselected. Sub-team candidates
  exclude self and **all computed ancestors** (walking `parentTeamId` *and* reverse
  `subTeamIds`) to prevent cycles.
- `TeamListItem` inner tabs: `Members N` (per-member role / mode / `★ Leader` / agentTool /
  model badges) · `Sub-Teams N` (recursive, indented `depth * 16px`) · `Details`
  (description, created, updated, copyable `Team ID`, parent team).
- Action bar: `▶ Run` ("spawn coordinator session"), `Edit`, `Copy ID`,
  `Archive`/`Unarchive`, `Delete Team` (archived only, `[ DELETE TEAM ]`).
- `TeamOrgChart` fetches a resolved tree per root via `getTeamTree`; cards show avatar,
  name, `N members · M sub-teams`, status dot, collapse chevron, member chips with a
  `✨ Lead` badge, and `N hidden` when collapsed. Per-root loading/retry states.
- `TeamLaunchConfigModal` — `Launch configuration` with per-member `COORD` badges, command
  permissions, "Save overrides for this launch context", "Save this configuration as a
  reusable team".

### 4.6 Projects

Browser-style tabs in the top bar (see §3.1) plus:

- **Project settings dialog** — tabs `Info` / `Sounds` / `Terminal`. Info: read-only `Name`,
  `Path`, `Sessions` count, `Created`. A **`Master Project` switch** ("Sessions in this
  project can access all other projects"), applied optimistically with rollback. Buttons
  `Close project` and `Delete project` (danger).
- **App settings dialog** — vertical tabs `Theme` / `Display` / `Sounds` / `Git` /
  `Shortcuts` (a 12-row shortcut table).
- **Create/rename modal** (`ProjectModal`) — `[ NEW PROJECT ]` / `[ PROJECT SETTINGS ]`:
  `Title`, `Base path` with `Use current tab` / `Home` + a collapsible `Browse`
  (`InlineFolderBrowser`), `Environment (.env)` select + `Manage`, `Assets` checkbox
  ("Auto-create enabled assets on new sessions"), collapsible `Notification Sounds`.
- **Delete confirm** `[ DELETE PROJECT ]`. The store *blocks* deletion when the project has
  sessions/tasks: `Cannot delete "<name>": project has <parts>. Remove them first.`
- Creating a project auto-spawns a first session; deleting the last project creates a
  fallback (`hooks/useProjectManager.ts`).
- `MaestroProject` fields the UI touches: `name`, `workingDir`, `basePath`, `description?`,
  `isMaster?`, `environmentId`, `assetsEnabled?`, `soundInstrument?`, `soundConfig?`,
  `githubUrl?`.


---

## 5. SPAWN FLOW UI

**There is no single spawn dialog.** Old maestro has three distinct spawn surfaces, and the
agent configuration does not live in any of them — it lives on the *task* and on the *team
member*. This is the single most important structural fact in this section.

### 5.1 `[ NEW TERMINAL ]` modal — the only literal "new session dialog"

`components/modals/NewSessionModal.tsx` is 93 lines and startlingly thin. It receives props
for `command`, `cwd`, `commandSuggestions`, `onBrowseCwd`, `canUseProjectBase`,
`canUseCurrentTab` — and **renders none of them**. One field ships:

- Title `[ NEW TERMINAL ]`, hint "Enter a name for your new terminal session"
- `Terminal Name`, placeholder `e.g., main shell`; autofocus after 100ms
- Buttons `Cancel` / `Create Terminal`
- Validation is a single rule (`useSessionActions.ts:190-221`): `invoke("validate_directory")`,
  else `"Working directory must be an existing folder."` The name is not validated.

Backing state (`hooks/useNewSessionForm.ts`): `newName`, `newCommand`,
`newPersistent` (defaults **true**), `newCwd` (defaults `activeProjectBasePath ?? homeDir`).

Quick launch (`hooks/useQuickLaunch.ts`) builds presets from pinned `agentShortcutIds` +
all `PROCESS_EFFECTS` alphabetically + a trailing `shell`. Command suggestions are the last
50 distinct launch commands from existing sessions.

### 5.2 Task-driven spawn — the real agent-launch path

The Create/Edit Task modal's `▶ Run` button is how a configured agent actually starts. It
saves the task, then spawns with `mode: "worker", strategy: "simple"` plus any per-member
overrides. Everything that in another product would be a spawn-dialog field is a **task
field** here: model (`ModelPickerChip` → `Auto` / grouped by tool), `Isolation`
(`Git worktree` / `In-place`), `Permissions` (`YOLO` / `Safe`), assignee (member *or* team),
skills, priority, due date.

### 5.3 `ExecutionBar` — batch / team spawn

Two entry buttons: `run` ("single worker") and `coordinate` ("spawn a team").

- **Execute mode**: `Team Member:` dropdown (rows read `avatar name role · model`), a `⚙`
  "Configure launch options" button, and `run (N tasks)` disabled at zero selection.
- **Orchestrate mode**: `Coordinator:` dropdown (filtered to coordinator-capable modes) and
  `Team Roster:` multi-select (`select all` / `clear`), plus two danger toggles:
  `🛡️ COORD ⇄ ⚠ COORD` (sets the coordinator's `accessMode: 'fullAccess'`) and
  `🛡️ WORKERS ⇄ ⚠ WORKERS` (sets `delegatePermissionMode: 'bypassPermissions'`).
  Submit reads `coordinate (N tasks, M members)`.
- Orchestrate always injects `mode: 'coordinator'` and `skillIds: ['maestro-orchestrator']`.
- Errors surface as `Failed to create session: …` / `Failed to create orchestrator session: …`.

### 5.4 Model / tool / permission pickers

**`LaunchConfigDropdown`** — a two-pane popover. Left: `Launch With` (agent tools). Right:
`Model`, `Intelligence`, `Access`, `Speed`.

- **Agent tools**: `claude-code` → "Claude" ◈, `codex` → "OpenAI" ◇, `hermes` → "Hermes" ✶,
  `gemini` → "Gemini" ◆.
- **Claude models**: Fable 5, Fable 5 1M, Opus 5, Opus 5 1M, Opus 4.8 (default),
  Opus 4.8 1M, Sonnet 5, Sonnet 5 1M, Sonnet 4.6, Haiku 4.5.
- **Codex**: 5.6 Sol (default), 5.6 Terra, 5.6 Luna. **Gemini**: Gemini 3 Pro Preview.
  **Hermes**: a routing list (Anthropic / Nous / OpenRouter / Codex-OAuth variants).
- **Intelligence** (reasoning effort): `Minimal`, `Low`, `Medium`, `High`, `Extra High`,
  `Max` — Claude drops `minimal`; Codex drops `minimal` + `max` unless on a 5.6 model;
  Hermes/Gemini show no Intelligence section at all.
- **Access** (label + inline description): `Safe` ("Ask before risky actions"),
  `Accept Edits` ("Edit files without prompts"), `Plan` ("Read-only planning mode"),
  `Full Access` ("Bypass prompts and sandbox").
- **Speed** (OpenAI only): `Standard` ("Default speed, normal usage"),
  `Fast` ("1.5x speed, increased usage").
- `Clear override` when an override is set. Switching provider immediately commits a
  provisional config so the launch config can't dangle on the previous provider.

**`TeamLaunchConfigModal`** — `▶ Launch` crumb, `Launch configuration`, `N member(s)` badge.
Per-member card (coordinator gets a `COORD` badge and brand tint) with three selects
(`Agent Tool`, `Model`, `Access`) and a chevron expanding **Skills** and **Command
Permissions** (the six groups from §4.4, with `(enabled/supported)` counts and greyed
"Not available for current mode" rows). Footer: `Cancel`, `Save`, `Save as Team` (inline
`Team name...` → `Back` / `Save & Launch`), `▶ Launch`.

**`ClaudeCodeSkillsSelector`** — collapsible `Skills (N selected / M available)`,
`Search skills…` over name/description/triggers/tags, cards split into `PROJECT` and
`GLOBAL`, each expanding to description, `Triggers:`, `Tags:`, `N reference file(s)`, and
source path. Empty: "No skills found. Expected at `~/.claude/skills/` or `~/.agents/skills/`".

### 5.5 Spawn feedback — the weakest part of the old UI

- **No spinner, no toast, no progress on spawn.** `useMaestroSessions.ts:36-93` de-dupes on
  `${projectId}:${name}` for 2s and calls `reportError("Failed to spawn terminal session")`
  on failure. Success just appends the session and sets it active.
- "Working" state is *inferred from PTY output heuristics*
  (`markAgentWorkingFromOutput` / `scheduleAgentIdle`, ~2s idle debounce, 900ms
  resize-noise suppression) — not from a server signal.
- `handleAddTaskToSessionRequest` is a raw
  `alert("Select a session to add this task to (Not implemented yet)")`.
- The one polished animation system is **prompt travel**, not spawn:
  `PromptSendAnimation.tsx` + `usePromptAnimationStore.ts` render a dot gliding between
  project tabs (`bar`), between rail avatars (`rail`), or arcing across the session tree
  (`tree`), capped at 6 concurrent, auto-removed after 1500ms, degrading to a pulse under
  `prefers-reduced-motion`. It is genuinely good and worth copying.
- `utils/claudeCliBuilder.ts` is dead code — a full CLI arg assembler nothing calls; the
  server emits the real command.

---

## 6. SETTINGS, AUTH, ONBOARDING

### 6.1 App Settings dialog

Vertical tabs `Theme` · `Display` · `Sounds` · `Git` · `Shortcuts`.

- **Theme** — two independent axes. `App Style`: `Terminal` ("Neon hacker aesthetic"),
  `Material` ("Clean Material Design"), `Glass` ("Frosted glassmorphism"),
  `Minimal` ("Ultra-clean & focused"). `Color Theme`: six variants per style (Terminal:
  Matrix Green / Cyber Blue / Neon Purple / Retro Amber / Tron Cyan / Hot Pink; Material:
  Indigo / Teal / Deep Purple / Rose / Amber / Emerald; Glass: Frost Blue / Lavender / Mint
  / Coral / Gold / Violet; Minimal: Slate / Blue / Violet / Orange / Emerald / Rose).
  Applied as `<html data-style>`. A **separate** light/dark axis (`<html data-theme>`) is
  toggled by the top-bar sun/moon button.
- **Display** — `UI Scale`: `Small 88%` / `Normal 100%` / `Large 113%` /
  `Extra Large 125%`, applied via `--app-zoom-scale` + `body.style.zoom`, with a live
  Preview pane and `Reset UI Scale to Default`. Then embeds the whole Terminal settings
  panel.
- **Terminal** — see §2.6 (Preview / Font / Cursor / Behavior / Colors). Note: labelled
  per-project in the Project Settings dialog but it is actually global (admitted in a code
  comment at `TerminalSettings.tsx:294-296`).
- **Sounds** — `Enable Sound Effects`, `Volume` (0–1, step 0.05), `Multi-Member Sessions`
  (`Ensemble (combine)` — "All team members' instruments play together as a chord" vs
  `Primary (first member)`), `Enable All` / `Disable All`, and per-category toggles grouped
  as `High Priority` (Success, Errors, Critical Errors, Warnings, Attention Required,
  Achievements) · `Activity` (Actions, Progress, Loading) · `Changes` (Creation, Deletion,
  Updates) · `Relationships` (Link, Unlink) · `Other` (Neutral) · `Notifications` (nine
  notify-* categories) — each with a description and a `Test sound` button.
- **Git** — `Environment` capability pills `git` / `gh` / `gh auth` with install/auth hints;
  `Default base branch` (placeholder `auto-detect (e.g. main)`); `Branch naming scheme`
  (default `maestro/{slug}-{id}`, with a live preview); `Auto-discard worktree after merge`;
  `Reset to Default`.
- **Shortcuts** — a read-only `Action / macOS / Windows / Linux` table of 12 rows.

### 6.2 Project Settings dialog

Tabs `Info` · `Sounds` · `Terminal` — see §4.6. The Sounds tab
(`ProjectSoundSettings`) adds per-project `Template` selection (`Use Global Defaults` +
built-ins + custom), an `Instrument` picker (piano / guitar / violin / trumpet / drums),
`Save as Template`, `Reset to Global`, and per-category overrides with preview buttons.

### 6.3 Other configuration surfaces

- **Secure storage** (`SecureStorageModal`) — `Encrypt with macOS Keychain (recommended)`
  vs `Store unencrypted (no Keychain prompts)`, with a warning when environments are
  already `enc:v1:`-encrypted.
- **SSH manager** (`SshManagerModal`) — `Host` autocomplete over `~/.ssh/config`;
  `Exit on forward failure (ExitOnForwardFailure)`; `Port forwarding only (no shell, -N)`;
  a port-forward table (`Local (-L)` / `Remote (-R)` / `SOCKS (-D)`, `Bind (opt)`, `Port`,
  `Dest host`, `Dest port`) with a live command preview + copy. Four distinct validation
  messages.
- **Agent shortcuts** (`AgentShortcutsModal`) — configure the quick-launch chips.
- **Environments** (`useEnvironmentStore`) — `.env` config editor with lock and delete
  confirmation; hosted from `AppModals`, with no settings tab of its own.
- Legacy `AppSlidePanel` → `Settings` tab still carries an `Appearance` section
  (ThemeSwitcher + ZoomSetting).

### 6.4 Auth — **old maestro is effectively auth-free**

This is the answer tm8 most needs. There are three auth code paths and **all of them no-op
in the shipped desktop build**:

1. **Password overlay** (`LoginOverlay.tsx`) — web only. Logo `M`, `Agent Maestro`,
   "Enter password to continue", one field, `Sign in`. Backed by `/api/auth/status|login|
   logout`. `useAuthStore.checkStatus` **short-circuits to
   `{ authEnabled: false, authenticated: true }` whenever `IS_TAURI`**.
2. **Gateway Firebase gate** (`GatewayLoginGate.tsx`) — `Maestro Hub`, "Sign in with your
   Google account to open your private workspace.", one `Continue with Google` button.
   Gated entirely on the build flag `VITE_MAESTRO_AUTH_MODE === 'firebase'`. When active it
   gates the **entire** app and injects `Authorization: Bearer <idToken>` on REST plus
   `?token=` on WS/PTY. In every normal build it is never mounted.
3. **`/gateway` route** (`GatewayPage` / `GatewayDashboard`) — a read-only team control
   centre: `online now`, `agents working`, `team members`, `running sessions`, `CPU · N
   cores`, memory, `Maestro servers live`, a `TRUSTED TEAM / Members` list with presence
   dots, `Signed in as <email>`, polling `/gateway/api/overview` every 5s.

**Firebase auth is not an app gate** in normal builds — it gates *only* Collab Space.
The single sign-in a desktop user ever sees is the in-panel `SignInView` inside the Collab
tab, and only if they open that tab.

Net: the app opens straight into the workspace. **tm8, being web-only and multi-user,
cannot inherit anything useful here — it has to design auth from scratch.**

### 6.5 Onboarding — one overlay, two steps

`StartupSettingsOverlay.tsx`, shown once (`STORAGE_SETUP_COMPLETE_KEY`).
- Title `Welcome to Maestro`; step pips `1 — 2`.
- Step 1 "Choose your style and color theme": `App Style`, `Color Theme`, `UI Scale`.
- Step 2 "Configure sound preferences": `♫ Sounds On` / `✕ Sounds Off` + `Volume`.
- Footer `Back` / `Get Started`.

That is the entirety of onboarding. **No product tour, no project-creation walkthrough, no
first-spawn coaching, no team/agent setup step, no account step.**

### 6.6 Collab Space (Firebase) — where the multi-user UI actually lives

A parallel, Firestore-backed collaboration product bolted onto the desktop app. Everything
is **GitHub-repo scoped** and requires a Firebase sign-in.

**Entry point** — `components/maestro/CollabSpacePanel.tsx` (832 lines), reached from the
`Collab Space` icon-rail item. Signed-out shows an in-panel `SignInView` (Google +
email/password + sign-up). Signed-in header: `Signed in as <email>` +
`CollabNotificationBell` + sign-out.

- `Repo` row with the detected/manual GitHub remote. Hard constraint, enforced twice:
  "Collab Spaces currently require a canonical GitHub repository."
- `+ Create Space` → `Name`, `Description`, read-only `GitHub repo`, visibility radios
  `Public — any signed-in Maestro user can find and join it` /
  `Private — invite-only`.
- Lists `Your Spaces` and `Public Spaces` with member counts and per-row `Join`.
- `PrivateInviteJoinCard` — paste a full invite link or a join code.
- Joined spaces also appear in the right-hand **SpacesRail** below a divider.

**Space window** (`components/space-window/SpaceWindow.tsx`) — eight tabs:

| Tab | What it covers |
|---|---|
| `Messages` | Firestore channels + live stream; `ChannelList` + `Create channel` (`Name`, `Description`); composer `Message #<channel>` with `@`-mentions of **humans and agents** and file attachments; optimistic sends with retry/dismiss, edit, soft-delete, `loadOlder` pagination |
| `Tasks` | `Shared Tasks` + count, `Search tasks…`, status filter, `+ Push from local` |
| `Team Members` | `Shared Team Members`, `Search agents…`, publish / pull |
| `Spells` | `Shared Spells`, create, pull-to-local with rename |
| `Docs` | `Shared Docs`, search, share / pull / delete-with-confirm |
| `Files` | `Shared Files`, upload with `Add a caption (optional)` |
| `Members` | count, `+ Invite`, `you` / `owner` / `admin` badges, overflow menu `Make admin` / `Make member` / `Remove from space` |
| `Settings` | `Space name`, `Description`, `Visibility` radios, `Save changes` / `Discard` / `✓ Saved`; `Admins` list; **Danger zone** `Leave space` and `Delete space` (owner only) |

**Invites** (`InviteMemberModal` + `firebase/spaceInvite.ts`) — type radios
`Invite link` / `Join code`; `Expires after` `24 hours` / `7 days` (default) / `30 days`;
`Maximum uses` 1–1000 (default 1); copyable value with `Copy`/`Copied`; an existing-invite
list showing `N/M uses · <status>` (`active` / `expired` / `revoked` / `full`) with
`Revoke`. Codes are 12 chars from a Crockford-ish alphabet; links are 32 random bytes
base64url.

**Sharing out** (`ShareToSpaceModal`) — four kinds: `Share task…`, `Publish team member…`,
`Publish spell…`, `Share doc to a Collab Space`. Team-member shares carry an explicit
warning: "The identity prompt and command permissions become visible to every member of the
space." Entry points include an `↗ Share` button on every task card, team-member row, and
doc.

CSS footprint for this area alone: `styles-space-window.css` 44 KB,
`styles-spaces-panel.css` 40 KB, `styles-collab-space.css` 22 KB,
`styles-messaging.css` 21 KB, plus sharing/docs/files sheets.

---

## 7. OTHER SURFACES

### 7.1 Docs viewer & docs management

A doc is a `DocEntry` produced by an agent or the user (markdown, code, or `.excalidraw`).
Users reach docs three ways: a per-session chip strip under the terminal, a paginated
per-project list in the panel, and card grids inside task/session modals. Markdown and code
open in a shared full-screen overlay; diagrams become an Excalidraw whiteboard *space*.

- **`DocViewer.tsx`** — kind glyph (`⬡` diagram / `M↓` markdown / `{ }` other), title,
  filename, `.ext` badge. Actions: `Share` (to a Collab Space; disabled with "Open the
  document's project before sharing it."), `Edit`/`View` toggle for diagrams, fullscreen
  toggle, close. Metadata rows `Path` · `Added` · `By` · `Session`. Opens fullscreen by
  default; first Esc exits fullscreen, second closes.
- Markdown via `react-markdown` + `remark-gfm`. Fenced blocks tagged `mermaid`,
  `sequenceDiagram`, `erDiagram`, `flowchart`… render as diagrams, and untagged blocks are
  **auto-sniffed** against 20 mermaid keywords.
- **`SessionDocsMenu`** — two fixed chips only (`docs M↓`, `diagrams ⬢`) with counts, so the
  terminal strip height stays constant. Menu flips up/down based on available space.
- **`ProjectDocsList`** — sub-tabs `Open` / `Done` / `All` with counts. Doc status is
  **client-only localStorage** (`maestro-doc-status-v1`), never synced. Per row: done radio,
  `↗` share, open, `x` close. Meta line `session: <name>` / `task: <id8>…` / `project`.
  Infinite scroll (`IntersectionObserver`, 200px rootMargin, page size 50).
- **`MermaidDiagram`** — theme "Atelier"; click to open a zoom overlay with
  `Zoom out (-)` / `Reset zoom (0)` (shows `NN%`) / `Zoom in (+)`, Esc to close.
- **`ExcalidrawBoard`** — `Send to session`, `Export to Session`, `Export to Task`,
  `Import` (`.excalidraw`, images), close. `⌘⇧X` toggles.
- **`CodeEditorPanel`** (Monaco, 1062 lines) — tab strip with scroll-left/right, an
  `Open files` overflow menu, unsaved dot, `Save (Ctrl/Cmd+S)` with `Saving…`/`Saved`,
  dirty-close confirm (`Discard` vs `Close`), SSH/remote provider.
- **`FileExplorerPanel`** (1283 lines) — context menu: `Open terminal here`,
  `Copy relative path`, `Copy full path`, `Open folder in Finder`, `Download file`/`folder`,
  `Rename`, `Delete`. Rename validation, download-failure modal.
- Known dead end: `InlineExcalidrawEmbed` (```` ```excalidraw ```` blocks) never fetches —
  it always renders a placeholder (`DocViewer.tsx:62-94`).

### 7.2 Spells UI

Spells are user-authored automations: a named, coloured, icon'd bundle of `trigger → action`
rules. The surface is a modal **Spell Studio** with three nav sections plus a full-screen
editor overlay. Cast spells become "active spells" that paint concentric rings on session
tiles, appear as chips, and land in a global **Spellbook** drawer. Every cast produces a
5-second undo toast.

- **Library (S1)** — search "Search spells by name, description, or rule…", filter chips
  `All` · `Recent` · `Seed` · `Custom` · `Runs commands` · `Loops` · `Notifies` · `Injects`.
  Risky spells carry a `Side effects` badge. Cards coloured via `--spell-{id}-*` vars.
- **Detail (S2)** — every rule expanded, Cast / Edit / Duplicate / Trash / Share-to-space.
- **Editor** — `Icon` picker, `Name` (`e.g. Lint on Edit`), `Description`, `Color` swatch.
  Rules list with `Collapse all`/`Expand all`, per-rule enable checkbox, move up/down,
  duplicate, remove, `Label`. Sections `When this fires` / `Then do this`.
  - Hook events: `Pre-tool`, `Post-tool`, `Prompt submit`, `Stop`, `Subagent stop`,
    `Notification`, `Session start`, `Session end`.
  - Actions: `Inject prompt`, `Feed context`, `Run command`, `Continue loop`,
    `Notify (in-app)`.
  - Loop styles: `single-shot`, `continue until done`, `plan · execute`, `critic · refine`.
  - Structured tool matcher list: Bash, Edit, Write, Read, Glob, Grep, WebFetch, WebSearch,
    Task, TodoWrite, NotebookEdit.
  - Seed spells are read-only with a `Duplicate to edit` banner; discard guard
    "Discard unsaved changes?".
- **Cast (S4)** — spell picker, `Cast mode` segmented control: `Single` ("Cast onto one
  session"), `Broadcast` ("Cast independently onto each selected session"), `Coordinate`
  ("Selected sessions form a named ensemble", reveals an ensemble-name field). Target list
  filters to the active project and excludes completed/stopped/failed. Risky spells require
  an explicit "This spell has side effects" confirm.
- **Casts / Entities (S10)** — target selector, one-shot casts, an inline custom-prompt
  editor with `Edit` / `Delete` per row.
- **Active-spell chips** — loop progress `N/M`; chip menu `Enable`/`Disable`,
  `Reset loop`, `View in Spellbook`, `Deactivate`.
- **Spellbook drawer** — "Spellbook — active spells across all sessions", `N active · G
  sessions`, grouped per session with `Open ↗` jump, plus a "Live updates paused —
  reconnecting" staleness banner.
- **Ensembles** — editable `Objective`, member rows with `leader` badge and `Make leader`,
  `Message all members`, `Disband` with confirm, `Add a session…` picker.
- **Undo toast** — 5000ms window, `✦ <summary>`, `Undo` / `Undoing…`, or
  `Already executed` when blocked.
- **Activity feed (S8)** — live `spell:rule_fired` stream, `aria-live="polite"`.
- 7 spell stores; `styles-spells.css` alone is 65 KB.

### 7.3 Notifications

Three parallel systems coexist, each with its own cap and timeout, and each also firing a
synthesized musical sound.

- **Collab bell** (`CollabNotificationBell`) — badge caps at `99+`; panel with
  `Mark all read` / `Clear`; prefs `Notify me about` (`All messages + Collab activity` vs
  `@mentions + Collab activity`) and a `Desktop notifications` checkbox that annotates
  itself `(blocked in browser)` / `(unavailable)`. Empty: "You're all caught up."
  Per-kind icons: mention 📣, channel 💬, task ✅, team_member 🤖, spell ✦, doc 📄, file 📎,
  invite ✉️, member 👤, space ⚙️.
  Rules: own/deleted messages silent; muted space/channel silent; focused channel = read,
  no toast; desktop only when the tab is hidden **and** desktop is enabled.
  Clicking deep-links into the space + section + channel and clears the badge.
- **Collab toaster** — 6000ms, mention toasts get a distinct modifier.
- **Spell toasts** — `TOAST_CAP = 4`, `HISTORY_CAP = 100`, per-level styling.
- **Legacy notices** — `showNotice(msg, 4500)`; `reportError(prefix, err)`; global
  `window.onerror` → "Unexpected error" and `unhandledrejection` → "Unhandled promise
  rejection", both at `critical` sound level.
- **Sounds** (`services/soundManager.ts`, 1067 lines + `soundTemplates.ts`) — a full
  `EventSoundType → SoundCategory` map covering WS entity events (created/updated/deleted/
  link/unlink), timeline events (`session_started`, `task_completed`, `task_failed`,
  `needs_input`, `milestone`, `doc_added`…), notify events, and status transitions.
  Instrument templates: `Classic Piano`, `Acoustic Guitar`, `Orchestral Violin`,
  `Jazz Trumpet`, `Percussion Kit`, plus user templates. Per-project and per-team-member
  sound config.
- **Tray** (`useTrayManager`, Tauri) — pushes working count, sessions-open, active project /
  session, recording count; a recent-sessions menu of up to 10 entries labelled
  `<name> (REC) — <project>`; handles tray actions `recent-session`, `new-terminal`,
  `start-agent`.

### 7.4 Command palette & keyboard shortcuts

`⌘/Ctrl+K` opens a fuzzy palette over prompts, recordings, sessions, quick-start agent
presets, and a fixed action list. Groups render in order: `New Sessions`, `Prompts`,
`Recordings`, `Sessions`, `Actions`.

- Actions: `New Session` (chip `T`), `SSH Connect`, `New Prompt`,
  `Start Recording`/`Stop Recording`, `Open Prompts Panel` (`⇧P`),
  `Open Recordings Panel` (`⇧R`), `Open Assets Panel` (`⇧A`), `Secure Storage Settings`.
- Quick-start rows read `New {preset}` / `Runs: {command}`. Pinned prompts get chips `1`–`5`.
- Fuzzy scoring: exact 100, prefix 90, substring 70, subsequence `30 + 5×maxConsecutive`.
- In-palette: `↑`/`↓`/`Enter`/`Esc`, plus `⌘1..5` to fire a pinned prompt without leaving.

**Global bindings** (`hooks/useKeyboardShortcuts.ts`):

| Keys | Effect |
|---|---|
| `⌘/Ctrl+K` | Command palette |
| `Esc` | Close palette → close slide panel → unwind a 20-deep modal stack |
| `⌘/Ctrl+B` | Toggle left icon rail |
| `⌘/Ctrl+⇧B` | Toggle Spellbook drawer |
| `⌘/Ctrl+⇧S` | Spell Studio (route `cast` if a session is focused, else `library`) |
| `⌘/Ctrl+.` | Toggle right spaces panel |
| `⌘T` / `Ctrl+⇧T` | New task |
| `⌘N` / `Ctrl+⇧N` | New terminal session |
| `⌘D` (mac) | New terminal session (alias) |
| `⌘E` (mac) | Next session |
| `⌘R` (mac) | Previous session |
| `⌘W` / `Ctrl+⇧W` | Close active session |
| `⌘⇧P` / `Ctrl+⇧P` | Prompts panel |
| `⌘⇧R` / `Ctrl+⇧R` | Recordings panel |
| `⌘⇧A` / `Ctrl+⇧A` | Assets panel |
| `⌘1..5` / `Ctrl+1..5` | Send pinned prompt N |
| `Ctrl+Tab` / `Ctrl+⇧Tab` | Next / previous session |
| `⌘/Ctrl+⇧X` | Whiteboard |
| `⌘/Ctrl+S` | Save in code editor |

- **`AgentShortcutsModal`** — configure the quick-launch chips: `Shortcuts` list with
  move up/down/remove, `Add agent` chips, `Reset defaults`, `Done`.
- Known gaps: non-mac users get no next/previous-session binding beyond `Ctrl+Tab`; the
  palette footer prints literal `↑↓↵` escapes instead of arrows.

### 7.5 Search

There is **no global search**. Search is per-surface: the Fuse task index (§4.1), the filter
bar, and `Search …` inputs in `AppSlidePanel` (prompts / recordings / assets),
`ResourcesView` ("Search resources…"), `ExportToSessionPicker`, `ExportToTaskPicker`,
`ClaudeCodeSkillsSelector`, the Spell Library, and each Collab space section
("Search agents…", "Search docs…", "Search spells…", "Search tasks…").

### 7.6 Git panel

Per-session panel (`GitPanel.tsx`, 1015 lines) showing the worktree's branch, divergence
from base, changed files with insert/delete counts, an expandable unified diff, branch
rename, merge-to-base, GitHub PR creation via `gh`, and worktree discard.

- Header: branch chip, base chip, `↑N ahead of base` / `↓N behind base`, dirty dot,
  `Refresh`.
- **Changes**: `{n} files`, `+ins`, `-del`, `{n} commits`; keyboard-activatable rows.
- **Diff**: collapsible unified diff with `file` / `hunk` / `add` / `del` / `ctx` line
  classes.
- **Branch rename**: inline input with four distinct validation messages.
- **Merge**: `Merge` → `Merge into {target}?` → `Confirm`; conflicted-file list on failure.
- **Pull request**: existing-PR chip with state (`Open`/`Merged`/`Closed`/`Draft`), checks
  (`passing`/`failing`/`pending`/`none`), reviews (`approved`/`changes requested`/
  `review required`), `↗` to GitHub. Create form `Title` / `Body` / `Base` → `Open PR`.
  Explicit unavailable copy for "gh is not installed" and "gh is not authenticated".
- **Worktree**: `Discard worktree` gated on the session being completed/stopped/failed.
- `PrChip` (`🔀 PR #N ↗`) and `WorktreeBadge` (`🌿 <branch>`) surface the same info on tiles.

### 7.7 Messaging / huddles

- **Collab messaging** (`components/maestro/messaging/`) — a Slack-like channel view inside
  a Collab Space: `ChannelList` with `Create channel`, `MessagesPane`, `MessageBubble`
  (pending `sending…` state, `Attachments`, per-message `Edit` / `Delete`, dead-attachment
  state), `MessageComposer` with `@`-mentions (agent-tagged chips) and file attach.
  Sends are optimistic with a `tempId`, retry/dismiss, and fire `notifyAgentMentions`.
  Non-members see "Join this space to read messages."
- **Huddles** (`HuddlesList.tsx`) — read-only cross-project clusters of sessions that
  exchanged prompts. Cards show up to 4 overlapping hashed-colour avatars + `+N`,
  `{n} sessions · {n} prompts`, and a relative time; expanding lists the prompts
  (`PromptList`, truncated at 220 chars, sent vs received per perspective). Member chips
  click through to the session.

### 7.8 Dashboard & stats

- **Dashboard** (`Dashboard.tsx`, 563 lines) — `Time Range` pills `7D` `14D` `30D` `90D`
  `6M` `1Y` `All`; KPI tiles `Total Tasks`, `Completed`, `In Progress`, `Blocked`,
  `Sessions`, `Team Members`, `Overdue`, `Avg Completion`; charts `Task Activity`
  (Created/Completed), `Tasks by Status`, `Tasks by Priority`, `Session Activity`
  (Spawned/Completed); a GitHub-style **Activity Heatmap** (5 opacity levels, month/day
  labels, per-cell tooltip); `Upcoming Deadlines` (top 10, overdue highlighted); a
  `Team Members` table with `Assigned` / `Done` / `Sessions` / `Rate`.
- **Session stats** — see §1.4.

### 7.9 Recording / replay

Recording captures **only the user's keystrokes** into a session; replay steps them back
into a (possibly newly created) terminal.

- `StartRecordingModal` — `Name`, `Start`, plus an explicit privacy line: "Records only your
  input (may include secrets)" + either "Stored encrypted at rest (key in macOS Keychain)"
  or "Stored unencrypted on disk (secure storage disabled)".
- `RecordingsListModal` — per-row `View / replay`, `View all inputs`, `Delete recording`.
- `ReplayModal` — summary `CWD / Name / Boot / {index}/{n} steps sent`; two modes:
  `Next input` (single step) and `Flow` (grouped tree with `├─`/`└─` markers, a `next`
  badge, `⏎` for bare newlines, `aria-current="step"`). Buttons `Close`, `View flow`/
  `View next`, `Send next` ("Creates a new replay tab if needed").
- `useReplayExecution` resolves the target cwd from recording meta → active session →
  project base path → home dir, derives a bootstrap command, and splits trailing newlines
  into N Enter presses. Tauri-only.

### 7.10 Remaining modals & chrome

- `AgentModalViewer` — renders **agent-authored HTML** in a sandboxed iframe
  (`sandbox="allow-scripts allow-same-origin"`), header `📋 <title>` + the raw modal id.
  This is the surface behind `maestro show modal`.
- `ApplyAssetModal` (`Apply` vs an overwrite variant), `ConfirmActionModal` (generic),
  `ManageTerminalsModal` (reorder terminals), `PathPickerModal` (`[ SELECT FOLDER ]`),
  `PersistentSessionsModal` (`open` / `detached` badges, `Attach`, `Kill session`),
  `UpdateModal` (`Check GitHub Releases for a newer version`).
- `SlidePanel` — right drawer, width 320–500, tabs `Prompts` / `Recordings` / `Assets` /
  `Settings`.
- `ResourcesView` — unified doc/diagram/image browser with `All (n)` / `Docs (n)` /
  `Diagrams (n)` / `Images (n)` pills.
- `QuickPromptsSection` — up to 5 pinned prompts with `★` and `⌘{n}` chips
  ("Click to send, double-click to edit").
- `UpdateBanner` — "New version {latest} available. You have v{current}." with `Download`.
- `DeploymentVersion` — probes `/gateway/health` then `/health`, renders
  `Gateway · <commit>` or `Maestro · <commit>`.

---

## 8. What old maestro had that a fresh entity-graph UI would still need

Ranked by how much a user would miss it. tm8 already spawns real agent sessions and has
**no sessions surface at all**, so the top of this list is not "nice to have" — it is the
gap between a demo and a usable product.

### Tier 1 — the product does not work without these

**1. A sessions list, at all.**
Nothing in tm8 shows what is running. Old maestro's minimum viable version is: a panel that
lists sessions, each row showing name, agent logo, status, and a live dot; clicking one
opens it. Everything below is refinement on top of that.
→ `SessionsSection.tsx`, `SessionListItem.tsx`

**2. A live terminal / output view per session.**
An agent session with no way to watch it is a black box. Old maestro's answer is a
full-bleed xterm as the center pane, with the "render one terminal, suspend the rest"
model (`AppWorkspace.tsx:136-230`, `terminalVisibilityDriver.ts`) that is the *only* reason
20 concurrent agents don't melt the browser. **Copy the suspend/warm-LRU/replay-on-remount
architecture before copying anything cosmetic.** For a web-only rebuild this is mandatory,
not optional — it is exactly the case old maestro's web path was built for.
→ `SessionTerminal.tsx`, `services/terminalVisibilityDriver.ts`, `terminalWriteScheduler.ts`

**3. Session status that is honest and legible.**
Six statuses (`spawning | idle | working | completed | failed | stopped`) plus a
`needsInput` override that outranks all of them, plus a *separate* liveness signal (solid
dot = terminal alive; pulsing = bytes streaming right now). `needsInput` rolls all the way
up to the project tab. Users learn to scan for the pulse and the `NEEDS INPUT` badge.

**4. The spawn tree.**
Coordinators spawn workers; a flat list destroys that. Old maestro renders
`parentSessionId` recursively with indent rails, a child count, collapse, and
"hide completed sub-sessions". Without it a 20-agent fleet is unreadable.
→ `hooks/useSessionTree.ts`, `SessionNodeRenderer`

**5. A single, non-ambiguous click contract.**
`willOpenStatsOnClick(session, link)` decides *one* thing: live terminal → open it;
no terminal → open the session page. The Resume button's visibility is derived from the
same predicate so the affordance can never lie. This is a small idea that prevents a whole
class of "I clicked and nothing happened".
→ `utils/sessionClickRouting.ts`

**6. Session controls: stop, resume, mark done, archive/restore — with subtree semantics.**
The genuinely hard-won design here: **Close (✕) cascades the whole subtree** (stop every
live descendant, archive every node), while **Mark done is a pure intent marker** that
stamps `humanCompletedAt` and deliberately leaves terminals running. Liveness is decoration,
not lifecycle. Getting this wrong produces orphaned children and stranded archived nodes.
→ `utils/sessionLifecycle.ts`, `SessionsSection.tsx:1189-1230`

**7. Open / Done / Archived triage.**
Sessions accumulate fast. Three server-persisted buckets with an explicit precedence
(`archivedAt` > `humanCompletedAt` > open) plus a `N live` filter keeps the list usable
after week one.

### Tier 2 — the difference between usable and good

**8. A session detail / post-mortem page.**
`SessionStatsView` is the highest-value surface old maestro built and the one tm8 would
most obviously lack: for any finished session, a hero card with the agent's **final
message**, an outcome ring, duration, a stacked token breakdown (cache read / input /
cache create / output), a tool-call bar chart, message counters, a rendered
last-messages thread, timeline, docs produced, sub-sessions, prompts, run configuration
and identity. It is what you look at when you come back to a fleet that ran overnight.

**9. Session ↔ task linkage, shown on both sides.**
Task chips on the session tile; sessions listed inside the task; jump-to links in both
directions; drag a task onto a terminal to inject it. For an *entity-graph* product this
should be table stakes, and it is the one place tm8's model should make it easier.

**10. The terminal chrome bar (`TerminalStrip`).**
Context-window gauge, output tokens, tool count, duration, model badge, docs menu, and
inline Attach / Draw / Cast-spell actions — all in one non-overlaying row, with an
expandable inline transcript and a zero-footprint hide. Its retention discipline (400
messages, running aggregates for the rest) is why it stays fast on a long session.

**11. A transcript view that is not the terminal.**
Most sessions a user reviews are already finished. Old maestro gives three: the expanded
strip, `SessionLogModal`, and the stats view's message thread. A rebuild needs at least one.

**12. Multi-session watching.**
Team View (reparented live terminals in a coordinator/worker grid with a re-rootable
breadcrumb) and the Multi-Project Board (resizable, collapsible per-session columns
toggling terminal ⇄ timeline). This is the "watch the fleet" mode; nothing else substitutes.

**13. Layout persistence, per workspace key.**
Panel widths, which panels are open, editor state, tree expansion — all persisted, and the
editor/tree widths keyed *per session/project* so each context remembers its own layout.
Resizes write CSS vars rather than React state so dragging never re-renders heavy panels.

**14. Prompt delivery with feedback.**
`sendPromptToSession` with `paste` vs `send` modes, a byte-budgeted delivery queue with
drain and overflow warning, plus the prompt-travel animation that shows a message moving
between sessions. The animation is not decoration — in a multi-agent product it is the only
visible evidence that inter-agent messaging happened.

**15. Keyboard navigation.**
`⌘K` palette, `⌘E`/`⌘R` and `Ctrl+Tab` session cycling, `⌘B` / `⌘.` panel toggles,
`⌘W` close, `⌘1–5` pinned prompts, and an Escape stack that unwinds ~20 overlay levels in
a defined order.

### Tier 3 — real value, safely deferrable

**16. Docs surface.** Agent-produced docs with markdown + auto-sniffed mermaid, a
per-session chip strip, a per-project paginated list, and diagram editing. Note the two
things *not* to copy: doc status is localStorage-only and never syncs, and the
`excalidraw` inline embed is dead code.

**17. Spawn configuration UI.** The model / reasoning-effort / access-mode / skills /
command-permission pickers. tm8 needs *some* version, but old maestro's is spread across
three surfaces and the "spawn dialog" itself is a single name field — **do not port the
shape, port the option sets.** Also: old maestro gives essentially **no spawn feedback**
(no spinner, no toast), which is a known weak point worth fixing rather than copying.

**18. Team member editor.** Persona/identity prompt, agent tool, model, permission mode,
four capability switches, per-command permission groups gated by mode, skills, workflow
template. This is the entity that makes agents differ from each other; an entity-graph
product needs it, but not on day one.

**19. Teams + org chart, task lists, task graphs.** Grouping constructs. Valuable once a
user has >10 members, invisible before that.

**20. Dashboard / analytics.** Time-range KPIs, four charts, activity heatmap, per-member
throughput table. Pure retrospective value.

**21. Git panel.** Branch, divergence, diff, merge, PR-via-`gh`, worktree discard. Strong
for a worktree-based workflow; entirely skippable otherwise.

**22. Spells.** A whole automation sub-product (studio, editor, cast modes, ensembles,
rings, spellbook, undo toasts, activity feed). Impressive but orthogonal to the core loop.

**23. Sounds.** A synthesized per-event, per-instrument, per-project, per-member audio
system. Distinctive; nobody would block launch on it.

**24. Recording / replay, SSH manager, secure storage, whiteboards, code editor + file
explorer.** Desktop-era adjacencies. Most are Tauri-only anyway and do not translate to a
web-only rebuild.

### Things tm8 must design fresh — old maestro is no help

- **Auth.** The desktop app is auth-free by design; the only real sign-in is the Firebase
  gate behind a build flag, and it gates Collab Space, not maestro. A multi-user web product
  needs an auth model that has no precedent here.
- **Onboarding.** Two screens of theme and volume pickers. No tour, no first-project or
  first-agent walkthrough, no account step.
- **Global search.** There isn't one — only a Fuse index over tasks and a dozen
  surface-local `Search …` boxes. For an entity-graph product, cross-entity search is an
  obvious win with no prior art to copy.
- **Spawn feedback.** See §5.5.

### Anti-patterns worth *not* inheriting

- xterm WebGL renderer — one GPU context per terminal breaks the whole UI at fleet scale
  (`SessionTerminal.tsx:222-230`).
- ~90 hand-written per-surface CSS files with three overlapping class families
  (`terminal*`, `maestro*`, `pn-*`) and documented dead sheets.
- 43 Zustand stores with overlapping ownership (`useSpacesStore` = local workspace spaces,
  `useCollabSpaceStore` = Firebase Collab Spaces — unrelated things, similar names).
- Three independent toast systems with three different caps and timeouts.
- Client-only state that pretends to be server state (doc `open`/`done` status).
- Duplicate/legacy components left wired in (`AgentSelector`, `KanbanColumn`,
  `hooks/useAgentShortcuts`, `utils/claudeCliBuilder`, `TaskStatusControl`, `TaskTimeline`).
