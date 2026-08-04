# Lane B — post-delivery findings & corrections

**Author:** Rhea · **Date:** 2026-07-25 · **Status:** informational; no code changed

The maestro-side inventory landed *after* Lane B shipped. I re-verified its load-bearing
claims against the source myself before recording them here. Nothing below is a defect in
what shipped — two are product decisions for whoever picks this up, one is a scope gap, and
one is a correction to my own blueprint.

---

## 1. Tab label inversion — needs a ruling

**Verified facts** (read directly, not relayed):

| Evidence | Fact |
|---|---|
| `SessionsSection.tsx:118-121` | Tab ids are literally `'terminals' \| 'agents' \| 'docs' \| 'drawings'` — mine match exactly |
| `SessionsSection.tsx:1585,1588` | Docs and Drawings are **the same component with one prop flipped** (`kind="markdown"` vs `kind="diagram"`) — exactly the design Lane B built independently (one query, split by format) |
| `SessionsSection.tsx:702` | Default tab is `'agents'` |
| `SessionsSection.tsx:967-971` | **maestro's Terminals tab is `sessions.filter(s => !s.maestroSessionId)`** — plain local shell terminals, explicitly *not* agent sessions. The agent session tree lives under **Agents**. |

**The divergence.** In maestro: Agents = running agent sessions, Terminals = non-agent local
shells. In Lane B: Terminals = `work_session`s, Agents = `team_member` personas.

tm8 has **no plain-local-terminal concept** — every session is an agent `work_session` — so a
literal port was impossible and something had to move.

**Net effect is smaller than it first appears:** maestro opens on its session list, and so does
Lane B. The default *behaviour* matches; only the label carrying the session list differs. But a
user who knows maestro will click **Agents** looking for running agents and find persona
definitions.

**Options:**

- **(a) Leave it.** "Terminals" is arguably the more honest name for "a session you can attach a
  terminal to", and personas genuinely need a home.
- **(b) Swap** — Agents = `work_session`s (default), Terminals = nothing. Collapses to three tabs,
  which contradicts the user's explicit four.
- **(c) Keep four, rename the persona tab "Personas."**

*Recommendation:* (a) or (c). (b) breaks the user's stated four-tab spec. Either fix is a label
and a default — roughly ten lines.

---

## 2. Scope gap — "Resources" is a panel *mode*, not a tab

`SpacesPanel.tsx` (222 LOC) toggles `panelMode: 'sessions' | 'resources'` **above** the tab bar,
swapping `SessionsSection` for `ResourcesView` (265 LOC) — a unified asset browser over
docs + diagrams + images with its own filter (`all | docs | diagrams | images`).

The blueprint treated "resources" loosely as part of the tab set; Lane B built only the sessions
mode. **P4 is therefore missing its second mode.**

Against the user's five acceptance items this is **not a blocker** — acceptance #4 is "right panel
(sessions list) works properly", which is the mode that shipped. But it is a real difference from
"THIS UI".

*Recommendation:* log as Lane B follow-up rather than reopening now. A faithful `ResourcesView` is
partly blocked anyway — images need `files.*`, which is 501 on this node.

---

## 3. A trap maestro already hit — recorded deliberately

maestro's `isDiagramDoc()` (`utils/docHelpers.ts`) is defensive on purpose:

```
kind === 'diagram'
  || filePath?.endsWith('.excalidraw')
  || isExcalidrawSceneJson(content)
```

…because **agents and the CLI routinely omit `kind`.**

Lane B keys purely on the stored `format` column. tm8 is safer here — `format` is a `check`ed
column set at create time, not a loose field — and the unknown-format default routes strays to
**Docs** rather than nowhere, so nothing becomes unreachable.

**The residual risk:** if agents start creating scene-bodied docs with `format:'markdown'`, they
land in Docs and render as garbage text.

Content sniffing was **deliberately not added**: the collection summary does not carry the body,
so sniffing would mean fetching every document just to render a list. This is a known, bounded
divergence with a reason — not a silent one.

---

## 4. Correction to my own blueprint

The action map in `WORKSPACE-TRANSPLANT-PLAN.md` referred to a WebSocket "subscribe message
shape". **There isn't one.** maestro's main socket has no client→server protocol at all — the UI
opens it and passively receives batched broadcasts. The only client→server WS traffic is the
`/pty` socket (raw input bytes + `{type:'resize',cols,rows}`).

Moot for tm8, which polls — but the blueprint line was wrong and is corrected here rather than
left to mislead the next reader.

---

## Also worth carrying forward

- **maestro's `[TAURI]` set is small and fully enumerated:** `App.tsx`,
  `components/app/AppWorkspace.tsx`, `CodeEditorPanel.tsx`, `FileExplorerPanel.tsx`,
  `maestro/CreateTaskModal.tsx`, `maestro/SessionStatsView.tsx`, `session-log/SessionLogModal.tsx`,
  `modals/ProjectModal.tsx`. Everything else in the four panes is web-clean.
- **Huddles** = a server-computed connected component of cross-session prompting, and explicitly
  **cross-project**. `GET /api/huddles`. No tm8 equivalent — already in the blueprint's deferred
  appendix; this confirms it needs a contract amendment, not just a handler.
- **Drawing persistence confirmed a third time:** the doc body is the Excalidraw `serializeAsJSON`
  scene — not mermaid, not a PNG. The blueprint's one-to-one mapping to tm8's
  `doc + format:'excalidraw' + body` holds.

---

## Vega ruling on §1 (label inversion) — 2026-07-25

In tm8 every work_session IS an agent session; there is no plain-shell concept. So:
- The session tree renames **Terminals → "Agents"** (matches maestro muscle memory — users click Agents to find running agents; and it is the true name for what the list holds).
- The persona list renames **Agents → "Personas"**.
- **No "Terminals" tab exists** until tm8 grows plain local shells — a Terminals tab with agent sessions in it (or an empty one) would misadvertise.
Applied by Vega at combined-review time (~10 lines incl. tests). §2 (Resources panel MODE with docs/diagrams/images browser) = follow-up, not reopened — images need files.* (501). §4's record correction adopted: maestro's main WS has NO client→server protocol; only /pty carries client traffic.
