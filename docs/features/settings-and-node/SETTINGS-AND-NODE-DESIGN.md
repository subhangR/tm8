# Settings & Node management — design

**Status:** design only. Nothing here is built by this document.
**Verified against:** working tree at `1b3040e` (branch `agent/session-message-replies`), 2026-08-07.
**Oracle:** `docs/design-canvases/2026-07-28-round-2/T2 Settings, Trust & Authoring Hi-Fi.dc.html`
and `T3 Files, Node & Inbox Hi-Fi.dc.html` (frame **T3-5 · Node settings & status**).

---

## 0. The correction this design starts from

The brief says *"currently there are no settings pages, and no server management
pages defined and implemented."* That is not what is in the tree, and the
difference changes what the work actually is.

| Claimed missing | Actually |
|---|---|
| No settings page | `settings-space/` ships a **10-section shell**, mounted at `views/GateApp.tsx:530-537`, reachable from the rail (`domain/menu.ts`, group `settings`) |
| No server management | `servers/server-registry.ts` ships add / switch / health-probe, backed by 4 live catalog ops and a **real HTTP proxy** (`server/src/http/remote-proxy.ts`) |

What is actually wrong is narrower and more specific:

1. **The space-settings backend is done; the browser seam does not expose it.**
   `spaces.invites.create|revoke`, `spaces.taskAxes.create|update|delete`,
   `spaces.menu.update`, `spaces.update`, `entityKinds.create|update`,
   `projects.link|unlink|update`, and the whole `interactionProfiles.*`
   lifecycle are **all registered handlers** (`facade/handlers/w2/*.ts`) with
   input schemas. `data/seam.ts` exposes exactly **one** settings write:
   `commands.updateProfile` (line 378). Nine of ten sections render
   disabled-with-reason not because tm8 cannot do the thing, but because the
   browser has no verb for it.

2. **`settings-governance/` is built and never imported.** Three screens, a
   port, a model, tests — `grep` for the directory name outside itself returns
   nothing. `SettingsShell` accepts a `sections` prop precisely so this module
   can be injected; `GateApp` never passes it, so *Linked projects* and
   *Custom kinds* render "built in another module and not mounted here".

3. **The node surface does not exist at all.** T3-5 is fully drawn — health,
   concurrency slots, agent commands, data & backup — and there is **zero**
   backend and **zero** UI for it. No `node.*` catalog family. This is the only
   part of the brief that is genuinely net-new, and it is the part that would
   have answered the real operational failures this project has already hit
   (`exit 127 · codex: command not found`; pool exhaustion; session cap).

So: mostly **wiring**, some **new ops**, and one **new surface**.

---

## 1. The organizing ruling: settings has three scopes, not one

Today one word covers three different things that differ in *who may change
them*, *where they persist*, and *what breaks when they are wrong*. The shell
already smears all three together — `account` (you) and `models` (your browser)
sit in the nav between `Members` and `Linked projects` (a space) — and there is
no home at all for the third.

| Scope | Governs | Persists in | Authority | Home |
|---|---|---|---|---|
| **You** | display name, avatar, email, global id; theme; model catalog | identity row + `localStorage` | yourself, always | Account menu › **Your settings** |
| **Space** | members, roles, invites, task axes, menu, custom kinds, linked projects, defaults, danger | `spaces.*`, `space_menu_configs`, `entity_kind_definitions` | space role (`owner` / `admin` / `member`) | rail › **Settings** |
| **Node** | health, concurrency, agent CLIs, database, data dir, backup, server connections, project registry & trust | process env + `~/.tm8` + `server_connections` | `isNodeAdmin` | rail › **Node** (new) |

**R1 — Scope determines home, and every settings surface states its scope in
its header.** `Space · atelier` (already rendered, `SettingsShell.tsx:107`),
`Node · dockyard`, `You · @ada`. A user must never have to infer blast radius.

**R2 — Node surfaces are graphite in both themes; space surfaces stay paper.**
Straight from the canvas ("the machine room reads terminal-adjacent"). This is
not decoration: it is the only thing stopping "I changed a setting" from
meaning "I changed it for my space" when it meant "I changed it for everyone on
this machine".

**R3 — `isNodeAdmin` gates the Node view; space role never does.** The field
already exists end to end (`data/seam.ts:169` ← `identity.get` ←
`identity/pg-auth.ts:96 is_node_admin`) and the UI has never read it. A space
*owner* on someone else's node is not an operator of that node. Non-admins get
the read-only status panel and a stated reason for the rest — never a hidden
tab, because "where do I see why my agent won't start" must have one answer.

**R4 — Servers (connections) are a *place selector*, and their *management*
lives in the Node view.** Switching servers already belongs in the rail and
stays there. But editing, removing, inspecting reachability, and storing
credentials for a connection are node-local operations on the node you are
pointed at (`server_connections` is a table on *that* node) — so they belong in
`Node › Connections`, not in Space settings and not in a modal.

---

## 2. Rulings that make the surface honest

**R5 — One composite read per scope.** `spaces.settings` already returns
`{ space, members, invites, taskAxes, menu, defaultChannelId,
defaultInteractionProfileId, settingsRevision }` in a single call
(`contract/src/schemas.ts:2291`), and the handler is live
(`handlers/w2/identity-spaces.ts:59`). `SettingsShell` ignores it and fires
**four** unrelated reads (`port.ts:141-163`) that between them do not even
cover invites or axes — which is exactly why those two sections say "no
capability" when the capability is one call away. Replace the four with
`seam.spaceSettings(spaceId)` plus `seam.identity()` (which is not
space-scoped). Net deletion of code; three sections gain real data for free.

**R6 — `settingsRevision` is the concurrency token for the space-settings
surface.** It is already returned and already monotonic. Every write echoes the
revision it was composed against; a stale one is refused with *"someone else
changed settings — reload"*. This is what makes the canvas's menu-editor
"version-lock" state implementable rather than decorative.
*Open question (§6 Q1):* the menu config carries **its own** `revision`
(`domain/menu.ts:30`, `space_menu_configs.revision`) distinct from
`settingsRevision`. Which one `spaces.menu.update` actually checks must be read
out of the RPC before the editor is wired — guessing here produces a save
button that silently clobbers.

**R7 — A refusal is only removed when its write is proven end to end.** The
`DisabledAction reason={...}` grammar (`panels/honesty/`) is the mechanism and
it must survive this work. An enabled button that no-ops is strictly worse than
today's honest refusal, and it is the specific regression this codebase has
paid for before. Each work item below flips **exactly one** refusal, and its
acceptance is a real row changing on a real node — not a green unit test.

**R8 — Every settings write re-reads its composite.** `SettingsShell` already
does this for profile (`refreshIdentity`, line 94) with the right reasoning
written above it: the server is the authority on what was written. Generalize
it; never patch local state optimistically on a settings surface.

**R9 — Env vars are *configuration*, not *settings*, and are read-only in the
UI.** ~65 `TM8_*` variables are resolved once at boot (`server/src/http/config.ts`).
They are the operator's, set before the process starts, and there is no restart
path from the browser — so a UI that edited them would be lying about when the
change takes effect. The Node view **displays the effective resolved config**,
which is the thing that turns "why did my spawn die" into one glance.

**R10 — Secrets are shown as names, never values.** The precedent is already
set and enforced: `record_session_manifest` stores env variable *names only,
never values* (`execution/src/spawn/types.ts:272`). The Node view inherits that
rule verbatim, including for `TM8_LIVEKIT_API_SECRET`, `TM8_DATABASE_URL` and
`TM8_AGENT_TOKEN`.

**R11 — Node status reports *consequence*, not just state.** The canvas is
explicit: a degraded row names the cause *and* what it prevents ("provider
'openai' unreachable — runs with it fail with reason"). A green/amber/red dot
with no sentence after it is not status, it is decoration.

---

## 3. The three surfaces

### 3.1 Space settings — the existing shell, unrefused

Keep the shell, the nav, the section-slot seam. Change what the sections can
do. Two sections **move out** (see §3.2), two get **injected** from the
already-built governance module.

| Section | Today | Target |
|---|---|---|
| Profile (space) | read-only, edit refused | editable → `spaces.update` |
| Your profile | **works** | *moves to You* (§3.2) |
| Models | works, browser-local | *moves to You* (§3.2) |
| Members & roles | rows, all writes refused | role change + remove → **needs new ops** (§4 T-B) |
| Invites | "no capability at all" | full create / copy / revoke → `spaces.invites.*` |
| Task axes | "nothing to read" | list + CRUD → `spaces.taskAxes.*` |
| Linked projects | not mounted | inject `settings-governance/ProjectsTrustScreen` → `projects.link|unlink` |
| Menu | editor built, save refused | save → `spaces.menu.update` (see R6 / Q1) |
| Custom kinds | not mounted | inject `settings-governance/CustomKindsScreen` → `entityKinds.create|update` |
| Danger zone | both refused | stays refused — **needs new ops** (§4 T-B) |
| *Interaction profiles* | built, no nav row | **new nav row**, inject `InteractionProfilesScreen` → `interactionProfiles.*` |

`InteractionProfilesScreen` is built, tested, and has no way in. Adding the nav
row is the cheapest capability in this whole document.

### 3.2 You — your settings, out of the space

`account` and `models` are not properties of a space; showing them under
`Space · atelier` implies they are. Move both behind the Account menu
(`account/AccountMenu.tsx` already exists) as a small two-section sheet:

- **Profile** — `IdentityProfileSection`, moved unchanged. Already writes.
- **Preferences** — theme, model catalog (`ModelsSection`, already node-keyed
  and browser-local), default landing view.

Nothing new is needed server-side. This is a relocation that removes a
category error.

### 3.3 Node — the machine room (net-new)

New top-level view `node`, a new `MenuViewRef` alongside `dashboard` / `graph` /
`settings` (`shell/menu-resolve.ts` `VIEW_PRESENTATION`, `domain/menu.ts`
`SHIPPED_DEFAULT_MENU`). Graphite (R2). Gated by `isNodeAdmin` (R3). Sections
follow the T3-5 canvas:

**Status** — subsystem rows, each `dot + word + mono facts + consequence`:
- *server* — uptime, contract version, mounted vs implemented op counts, WS clients
- *database* — reachable, pool in-use / max (`TM8_DB_POOL_MAX`), migration head
- *agent host* — which agent CLIs resolve on this node's `PATH`, per tool

  `/health` already carries `{ ok, server, contractVersion, operations,
  implemented, db }` (`http/server.ts:172-206`) and the UI already probes it
  (`server-registry.ts:97`) to render one boolean. The status panel renders the
  payload that is already there, and the new op (§4 T-C1) extends it.

**Concurrency** — `TM8_SESSION_CAP` (default 8, `facade/execution-handlers.ts:613`)
as filled / hollow slot pills with the live sessions named below. The cap is
already enforced and already refuses spawns; today it is invisible until you
hit it.

**Agent commands** — per tool (`claude-code`, `codex` — the only two with a
resume contract, `SpawnService.ts:685`): resolved binary path, version, a **test
launch** that reports real exit code and stderr. This is the single highest-value
panel in the design: `exit 127 · codex: command not found` is a failure this
project has hit on a live host, and it is currently diagnosable only by SSH.
*A provider registry — adding arbitrary tools — is explicitly Phase 2.*

**Data** — `TM8_DATA_DIR`, database size, artifact/file store size and count, all
mono. Read-only. **Backup and restore are Phase 2** and appear as
disabled-with-reason rather than as absent, because "where are my backups" must
resolve to an answer.

**Connections** — the `server_connections` table with reachability, plus add /
remove. Moves `AddServerDialog` here from its rail-footer modal; the rail keeps
switching only. Needs `serverConnections.update` (§4 T-B) for edit.

**Configuration** — the effective resolved `TM8_*` config, grouped, values shown
except for secret-named keys which show `set` / `unset` only (R9, R10).

---

## 4. Work tiers, by cost

### Tier A — wiring only (no new backend)

Every op below is an implemented handler with an input schema. The work is
`seam.ts` verbs + `real/ops.ts` calls + `port.ts` + flipping one refusal each.

| # | Item | Op(s) |
|---|---|---|
| A1 | Composite read (R5) — replaces 4 reads with 1 | `spaces.settings` |
| A2 | Mount governance sections into `sections` prop | — (import only) |
| A3 | Interaction-profiles nav row | `interactionProfiles.*` |
| A4 | Invites: create / revoke / copy | `spaces.invites.create|revoke` |
| A5 | Task axes CRUD | `spaces.taskAxes.create|update|delete` |
| A6 | Menu save (blocked on Q1) | `spaces.menu.update` |
| A7 | Space profile edit | `spaces.update` |
| A8 | Custom kind create / update | `entityKinds.create|update` |
| A9 | Linked projects link / unlink / trust | `projects.link|unlink|update` |
| A10 | Move `account` + `models` to the Account menu | — |

A1 → A2 → A3 first: A1 is a net deletion that unblocks A4 and A5 by supplying
data those sections currently claim does not exist, and A2/A3 mount ~16 files
of already-tested UI by adding import lines.

### Tier B — new backend ops

| # | Item | Why it does not exist |
|---|---|---|
| B1 | `spaces.members.updateRole` | no op; the members table cannot change a role |
| B2 | `spaces.members.remove` | no op |
| B3 | `spaces.transferOwnership` | no op; Danger zone item 1 |
| B4 | `spaces.delete` | no op. **Today deleting a space is raw SQL only** (`scripts/purge-spaces.sql`) — ordering-sensitive, no CLI verb. Danger zone item 2 |
| B5 | `serverConnections.update` | list / create / get / delete exist; edit does not |

Each is a catalog row, and **adding one catalog row is a repo-wide change** —
count pins, digest, manifest and guard tests all move together. Budget
accordingly; do not schedule these as "small".

B4 in particular is a correctness item, not a convenience one: an irreversible
operation whose only implementation is a hand-ordered SQL script is a
foot-gun with a UI button drawn for it.

### Tier C — the node surface (net-new)

| # | Item | Shape |
|---|---|---|
| C1 | `node.status` | read: subsystems, uptime, pool, migration head, WS clients |
| C2 | `node.config` | read: effective `TM8_*`, secret keys redacted to `set`/`unset` |
| C3 | `node.agentTools` | read: per tool — resolved path, version, `ok`/`missing` |
| C4 | `node.agentTools.test` | command: real spawn, returns exit code + stderr verbatim |
| C5 | `node.capacity` | read: session cap + live sessions (may fold into C1) |
| C6 | Node view + graphite theme + `isNodeAdmin` gate | UI |
| C7 | Connections panel; `AddServerDialog` relocated | UI + B5 |

C1 and C3 alone are worth more than the rest of Tier C combined: between them
they answer *"is this node healthy"* and *"can this node actually launch an
agent"*, which are the two questions every operational failure in this
project's history has started from.

**Explicitly Phase 2, drawn but not built:** backup / restore / schedule, and
the arbitrary agent-provider registry with `{workdir}` `{profile}` templating.
Both render disabled-with-reason.

---

## 5. Sequence

1. **A1** — composite read. Net deletion; unblocks A4/A5 with data.
2. **A2 + A3** — mount what is already built and tested. Highest ratio in the doc.
3. **A4, A5, A7** — the three cheapest real writes. Each proves the R6 revision
   loop once, on a low-stakes surface, before the menu editor depends on it.
4. **Q1**, then **A6** — menu save. Do not start A6 before Q1 is answered.
5. **A8, A9, A10**.
6. **C1 + C3 + C6** — the node view, read-only. Ships standalone value.
7. **B1, B2, B5** — new ops, one catalog change each.
8. **C4, C5, C7**.
9. **B3, B4** — last, deliberately. Irreversible acts get a UI only once
   everything around them is proven.

---

## 6. Open questions — answer before building the item that depends on them

**Q1 — Which revision does `spaces.menu.update` check?** There are two
(`settingsRevision` on the composite; `revision` inside `MenuConfig`). Read the
RPC. Blocks A6. Guessing produces a save that silently clobbers a concurrent
edit — the exact failure class this project has already paid for.

**Q2 — Does `spaces.settings` respect RLS for a non-owner member?** The whole
surface is composed from it. If it over-returns (invite codes to a `member`) or
under-returns, sections will be wrong in ways a single-owner dev space cannot
reveal. Verify with two distinct principals, not one.

**Q3 — Is `isNodeAdmin` ever `true` in practice?** It is set at boot for the
node owner. On a node with auto-owner behaviour it may be true for *everyone*,
which would make R3 a gate that gates nothing. Blocks C6.

**Q4 — Do the `spaces.*` write handlers enforce role?** If role enforcement
lives only in the RPC and not the handler, Tier A ships buttons that a `member`
can press and that fail at the database with an unhelpful error. Determines
whether Tier A also needs role-aware disabling in the UI.

**Q5 — Does the Node view proxy?** When the active server is a remote
connection, does `Node` describe *that* node or the local one? The proxy
forwards `/health` and `/v2/*` (`remote-proxy.ts:32`), so remote node status is
reachable — but `server_connections` is local-only, so the Connections panel
must stay pinned to local while the rest follows the active server. Two scopes
on one screen needs an explicit ruling before C6.

---

## 7. What this design does not do

- Does not redesign the settings visual language. The T2 and T3-5 canvases are
  the oracle; this is a plan for reaching them.
- Does not add per-member server-side preferences. Theme and model catalog stay
  browser-local (`localStorage`, node-keyed) — there is no `member_settings`
  table and this design does not propose one.
- Does not make env vars editable (R9).
- Does not add feature flags, metrics export, or multi-region settings.
- Does not touch auth or the identity model; `auth/` and `account/` are their
  own surface and are referenced, not changed.
