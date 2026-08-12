# Git UI Placement Map

**Scoping document only. No product code.**

Measured on `origin/main` @ `e36e6a4` unless a ref is named otherwise. The stranded work was
measured on `origin/feat/git-ui-wave` @ `d371c06` (PR #121, closed unmerged) and open PRs
#127/#128/#129/#130/#131. Every claim below names its ref. Authored 2026-08-12 by the
Git UI Cartographer scoping lane (task `019ff6d1-c2fe-74c5-acc3-c9992ed43c64`).

---

## 0. Corrections to the brief (measurement over compliance)

The launch brief carried three claims that are **stale on `origin/main` @ e36e6a4**:

1. **"WorktreeManager has NO caller" — false.** It is instantiated at
   `packages/server/src/facade/execution-handlers.ts:1212` (`resolveWorktreeManager`) and
   injected into `SpawnService` in both runtime factories.
2. **"create_worktree has no TypeScript caller" — false.** `SpawnService.provisionWorktreeFor`
   → `provisionWorktree` (`packages/execution/src/spawn/worktree-provisioning.ts:199`) →
   `graph.createWorktreeEntity` (`execution-handlers.ts:849`) → DB RPC `public.create_worktree`.
3. **"--workdir worktree is refused by session spawn" — false.** The CLI accepts
   `worktree` as a first-class workdir (`packages/cli/src/commands/session.ts:63`), the
   contract schema accepts `{mode:'worktree', baseRef?}` (`contract/src/schemas.ts:2004`),
   and `SpawnService.spawn` provisions a real worktree (`SpawnService.ts:680-682`).
   Worktrees ARE created through the product today — by session spawn.

The real, measured gap is different: **the mutating git verbs (checkpoint / rollback /
stage / commit / merge) exist only as CLI-local operations** (`cli/src/commands/session-git.ts`,
`worktree-git.ts` calling `execution/src/worktree/git-mutations.ts` on the CLI host).
There is **no server catalog op** for any of them — `catalog.ts` exposes exactly four
git-related ops: `projects.branches.list`, `entities.commands.linkPr`,
`entities.commands.linkCommit`, `tracking.refresh`. A web UI that is not the node host
cannot invoke a single git mutation today. Note: the stranded wave's
`packages/server/src/facade/services/execution-git.ts` (six `execution.git*` ops, on
`feat/git-ui-wave`) is precisely the missing server operation family — it exists, unmerged.

---

## 1. Surface inventory — every tm8-ui surface on origin/main

All paths under `packages/tm8-ui/src/` unless noted. `packages/ui/` is a second, separate
UI package that `App.tsx` never reaches — nothing in it is shipped. Everything shipped
composes from `App.tsx → AuthGate → GateApp`.

### 1.1 Root & chrome

| Surface | File | Shows today | Who / when |
|---|---|---|---|
| App root | `App.tsx` | `<AuthGate><ConnectedGateApp/></AuthGate>`; GateApp keyed on server id | everyone, always |
| GateApp | `views/GateApp.tsx` (~990 ln) | Master screen: SpaceTabBar, MenuRail, CommandPalette, PromptsOverlay, NoticeHost, dialogs; center region switched on `activeTarget` | everyone, always |
| Boot states | in GateApp | AuthFlow, unreachable / no-spaces / forbidden cards, BootLoader | on error/boot |

Center-region routing in GateApp: `entity`→ChannelView (voice→placeholder), `view:graph`→GraphScreen,
`kind`→EntityView, `view:files`→FilesExplorerScreen, `view:dashboard`→HomeScreen,
`view:settings`→SettingsShell, other views→honest "not built yet", default→WorkspaceView.

### 1.2 The five EntityDetailPanel host sites (four components)

Per the `views/usePanelPrimaries.ts` docblock the detail panel mounts at **five sites in
four components** — the "fifth host" is EntityView's third-column aux panel:

| Host site | File | Shows today | Who / when |
|---|---|---|---|
| WorkspaceView | `views/WorkspaceView.tsx` (704 ln) | 3-column grid: left EntityListPanel (default kind `task`), center PanelStack of detail panels, right EntityListPanel (default `work_session`); LaunchSheet | the daily driver — operators running tasks + sessions |
| EntityView (primary) | `views/EntityView.tsx` (865 ln) | wide kind list + center detail panel | reached from a MenuRail kind row |
| EntityView (aux) | `views/EntityView.tsx` ~:802 | third-column reference detail panel (`host="stack"`) | comparing two entities |
| ChannelView | `views/ChannelView.tsx` (387 ln) | channel header, pinned shelf, Feed + collection tabs, composer, aside detail panel | channel-centric collaboration |
| GraphScreen | `graph/GraphScreen.tsx` (265 ln) | graph canvas; node click opens detail panel aside; takes a narrow structural port, not GateData | structure exploration |

Wiring health: the prior audit's "only 1 of 5 call sites passed a needed prop" referred to
`attachments` / `debugSurface` / `graphSurface` (once passed only by EntityView) and
`onAction` (once passed by none — Terminate permanently disabled). **On e36e6a4 all four
host files pass all of these**, and a static-scan test (`views/panel-host-wiring.test.ts`)
guards new mount sites. Placement rule this history teaches: **any new session surface
must be composed once and handed to `usePanelPrimaries`/the shared composer, never wired
per-host by hand.** The stranded wave's `views/gitSurface.tsx` follows this rule.

### 1.3 Lists, detail, session surfaces

| Surface | File | Shows today | Who / when |
|---|---|---|---|
| EntityListPanel | `panels/EntityListPanel.tsx` (2753 ln) | one component, every kind: Open/Done/Archived tier tabs, FilterRow (status, sort, people, lens), list/board/tree/gallery/feed modes, sections, quick-create, quick-launch | everyone scanning any kind |
| Task tile | `panels/list/MaestroTaskTile.tsx` | control-card anatomy; badges via `list/tile-badges.ts` | task triage |
| Session tile | `panels/list/MaestroSessionTile.tsx` | session-tree anatomy, live ●, ✕ terminate | session monitoring |
| EntityDetailPanel | `panels/EntityDetailPanel.tsx` (1026 ln) + `panels/detail/chrome.tsx`, `tabs.tsx` | header (breadcrumb, title, StatusPill — `STATUS_FIELD` already maps `prState→state`), tabs Content·Discussion·Connections·Activity, ActionBar, footer | anyone opening any entity |
| Detail bodies | `panels/bodies/*` | TerminalBody (session), SubtreeBody (task), ProfileBody, ReaderBody (doc), HubBody (channel), GenericBody — **pull_request / commit / worktree render as `generic`** (link-summary + fields + collections); project renders `governed` (path-row, trust-card, live-sessions, unlink) | per kind |
| Session chips | `panels/bodies/WorkSessionContent.tsx` | exactly four chips, fixed order: **Terminal · Chat · Debug · Graph** (Chat only if profile.chatEnabled) | anyone inside a session |
| Session Debug | `panels/bodies/SessionDebugBody.tsx` | spawn config, transcript/journal stats, per-command table, HTTP calls | debugging a session |
| Session Graph | `session-graph/SessionGraphBody.tsx` | "what this session touched", hop rings, polls 20s while live | provenance at a glance |
| Channel/chat | `channel-screen/*` | message list, composer, @mentions (spawn), entity-attach chips, threads. **No PR/commit rendering in message bodies** — only generic entity chips | conversation |
| HomeScreen | `home/HomeScreen.tsx` | dateline, quick actions, "My work" triage + "Space activity" feed | start of day |
| AttentionInbox | `attention/AttentionInbox.tsx` | needs-attention triage grouped by entity (shown in detail-centre when nothing open) | interrupt handling |
| InboxScreen | `inbox/InboxScreen.tsx` | notifications (component built; route is a placeholder in GateApp) | — |
| Files explorer | `files-explorer/FilesExplorerScreen.tsx` | roots, breadcrumb, list/tree/gallery, trash, upload | file management |
| Attachments | `files/AttachmentStrip.tsx` etc. | `file` kind attached to entities | in detail panels |
| Memories / Artifacts / Loops / Spells / Collections | registry kinds via EntityView | generic/profile panels | librarians |

### 1.4 Settings & governance

| Surface | File | Shows today |
|---|---|---|
| SettingsShell | `settings-space/SettingsShell.tsx` | Profile (read-only Repo row), Members, Invites, Task axes, Models, Agent credentials, **Linked projects**, Menu, Custom kinds, Danger zone |
| Linked projects → branches | `projects/BranchTopologyList.tsx` via `ProjectBranchesSection` | **the only real git-topology UI on main**: trunk + provenance, per-branch current/default/merged/stale pills, ↑ahead ↓behind vs trunk, last-commit date+subject, upstream; read-only, per-project lazy expand |
| Credentials | `settings-credentials/CredentialsSection.tsx` | per-member agent logins: anthropic / openai / **github** (PTY login; `gitCredentialStore` verdicts) |
| Governance | `settings-governance/*` | ProjectsTrustScreen, InteractionProfilesScreen, CustomKindsScreen (built, injected sections) |

### 1.5 Menu & registry (`domain/menu.ts`, `domain/registry.ts`)

`SHIPPED_DEFAULT_MENU` (revision 8): Home; Workspace ▾ (Tasks · Sessions · Docs · Channels ·
Teammates · Memories · Artifacts · Loops; Graph); Library (Files · Spells · Collections);
**Tracking → Projects · Pull requests · Worktrees**; Collab (Members); Voice; Settings.

Registry already declares four git kinds as first-class (all `strategy: collection`):
`pull_request` (slug `pulls`, ⑂, chip tinted by prState, launchable, generic panel),
`commit` (slug `commits`, ◉, feed mode, generic panel), `worktree` (slug `worktrees`, ⎇,
launchable, CHECKOUT fields, forward-only status, no quickCreate — server-provisioned),
`project` (⬢, governed panel).

### 1.6 Existing-but-dormant git anchors

- `kit/DiffView.tsx` + `kit/diff-parse.ts` — a bounded unified-diff renderer, exported,
  **built and unmounted** (only fixtures consume it). A ready primitive awaiting a surface.
- LaunchSheet copy already names "a pull request or a worktree" as launch subjects.
- `shell/LiveSessionBar.tsx` exists but is unmounted (D64).

---

## 2. Backend reality (what a UI can actually call, origin/main)

- **Server ops (catalog.ts):** `projects.branches.list` (read, live `readBranchTopology`),
  `entities.commands.linkPr`, `entities.commands.linkCommit`, `tracking.refresh`. Nothing else.
- **Entity reads:** `worktree`, `pull_request`, `commit` are entity kinds — the UI reads
  them via generic entity/edges/feed reads, not bespoke endpoints. Commit→session provenance
  is a `created_in` edge stamped by `tracking/commit-recorder.ts` (60s job). Ledger events:
  `git.commit_recorded`, `git.pr_state_changed`, `git.worktree_status_changed` (migration 082).
- **Mutations:** all of `git-mutations.ts` (checkpoint/rollback/stage/commit/mergeFromRef,
  conflict-as-data, mutable-worktree guard) is **CLI-local only**. The six `execution.git*`
  ops that would serve the web UI exist only on `feat/git-ui-wave`
  (`server/src/facade/services/execution-git.ts`, 466 ln).
- **Worktree lifecycle** (create/lease/reconcile) is live server-side via spawn; there is
  deliberately no user-facing create op — worktrees are provisioned by launching a session.
- **Forge:** `tracking/github.ts` + `observer.ts` poll PR/commit facts into the DB.
  The closed-loop watcher (migration 084, nudges) is unmerged (#130/#129). The fix that
  makes PR state actually reach `graph.query` (`entity-read serves pull_request state`,
  cab6608) exists **only in #129** — any chips UI is dark without it.
- **Docs:** `docs/features/worktrees/*` are design-time snapshots that predate the shipped
  code; most "DESIGNED" items are now reality, and its "worktree remains a future execution
  capability" line (§1.2:122) is stale. Still promise-only: auto-checkpoint per-turn hook
  ("designed here, shipped manual"), and the server-side git operation family.
  `docs/features/git/` did not exist before this document. `docs/ui/orchestration/*` are
  placement briefs, not shipped surfaces. **No external agent-orchestrator prior-art doc
  exists in the repo** — the only benchmark doc is against maestro (tm8's predecessor), on
  PTY behavior, naming no competitor git features. The parent task's "look at agent-orchestrator
  prior art docs" resolves to: there is nothing to look at on main; competitor git analysis
  would be net-new work.

---

## 3. Complete git feature list

### Band A — pure git

A1 status (branch, dirty, ahead/behind) · A2 diff (working tree / range / per-file patch) ·
A3 log / commit history · A4 blame · A5 file history · A6 branches (list, create, delete,
rename) · A7 checkout/switch · A8 commit (stage + message) · A9 merge · A10 rebase ·
A11 cherry-pick · A12 stash (save/list/pop/drop) · A13 conflict resolution ·
A14 tags · A15 reset/revert · A16 bisect · A17 reflog · A18 submodules · A19 push/pull/fetch

### Band B — forge

B1 PR lifecycle state (open/draft/merged/closed) · B2 PR review (approve/request-changes,
inline comments) · B3 CI/checks status · B4 merge-state (mergeable/conflicting/blocked) ·
B5 issues import/linkage · B6 PR comments/threads · B7 releases · B8 PR creation from a lane ·
B9 review-assignment / requested-reviewers · B10 merge the PR (land a lane on base via
the forge — the sanctioned landing path; see §4.3)

### Band C — git × tm8 (the interesting band)

C1 session→commit provenance (`created_in`) · C2 per-session diff ("what did this agent
change") · C3 which-agent-edited-which-line (blame × sessions) · C4 contention map between
concurrent lanes (overlapping touched paths) · C5 worktree lanes (lane list, owning session,
status) · C6 checkpoint / rollback of an agent's work · C7 task↔branch/PR linkage (`tracks`) ·
C8 completion gates (task can't Complete until PR merged — migration 082 `set_task_gate`) ·
C9 review-agent's-diff-before-merge (human gate on lane merge) · C10 merge lane → session
branch (the four verbs) · C11 git activity in feeds (ledger `git.*` events) · C12 PR/commit
chips as shared vocabulary across tiles/detail · C13 forge observer nudges ("CI went red on
the PR your task tracks") · C14 auto-checkpoint per turn (promised, unshipped) · C15 per-turn
diff stepping (checkpoint timeline ↔ transcript) · C16 branch-topology per project ·
C17 cross-lane cherry-pick (move a fix between lanes) · C18 git credentials (account-level,
migration 093) · C19 launch-session-from-PR/worktree (LaunchSheet already contemplates it) ·
C20 stale-lane reaping (merged/abandoned worktree cleanup surfacing)

---

## 4. THE MAP — feature → exact surface, placement, reason

Verdict column on stranded-wave placements: **AGREE / AGREE± / DISAGREE**.

### 4.1 The session Git rail — `WorkSessionContent` fifth chip

**Placement:** a **Git chip** on the session surface switcher in
`panels/bodies/WorkSessionContent.tsx` (order Terminal · Chat · Git · Debug · Graph),
body = wave's `git/SessionGitBody.tsx`, composed ONCE in `views/gitSurface.tsx` and handed
through `usePanelPrimaries` to all five host sites — exactly as `debugSurface` is.
**Wave verdict: AGREE.** This is the highest-value git surface in the product: the session
is where an agent's work lives, and the panel-host-wiring lesson (§1.2) says the composer
pattern is the only safe wiring. Carries:

| Feature | Placement within the rail | Verdict vs wave |
|---|---|---|
| A1 status | header row: branch, dirty counts, ↑↓ vs base | AGREE |
| C2 per-session diff | diff digest section (reuse dormant `kit/DiffView.tsx` — the wave brought its own rendering; prefer mounting the existing kit primitive) | AGREE± |
| C6 checkpoint / rollback | verbs row, two-step inline confirm | AGREE |
| A8 commit, C10 merge base→lane | verbs row; landing on base deliberately absent (goes via PR) | AGREE — the restraint is correct |
| A13 conflict surfacing | banner naming conflicted paths, conflict-as-data | AGREE |
| A11 cherry-pick, A6 branch ops, A12 stash (#128) | overflow "More" section on the same rail, not four more top-level buttons | AGREE± — right surface, but tier-2 verbs should sit behind a disclosure to keep the rail scannable |
| C15 per-turn diff stepping | future: checkpoint timeline inside the rail, each checkpoint linking the transcript turn | net-new, same surface |

Honesty rules the wave established (available:false with named reason, DisabledWithReason
per verb) match the product's existing disabled-with-reason idiom — keep them.
**Dependency:** the six `execution.git*` server ops must land first (see §0); the rail is
dead UI without them.

### 4.2 Task detail — git section in `SubtreeBody`

**Placement:** a **Git section** rendered inside the task Content body
(`panels/bodies/SubtreeBody.tsx` region), composed via `views/taskGitSection.tsx`,
only when the task has `tracks` edges or a completion gate. **Wave verdict: AGREE** on
surface and composer, **AGREE±** on plumbing: it should ride the shared primaries object
rather than a second per-host prop, so the static wiring test covers it with one entry.

| Feature | Placement within | Verdict |
|---|---|---|
| C7 task↔PR/commit linkage | tracked-PR rows using `LinkedPullRequestChips` | AGREE |
| C8 completion gate | verdict line stating which PR blocks Complete, BEFORE the click | AGREE — pre-emptive honesty beats a failing action |
| C1 provenance | commit rows → `created_in` session click-through (cap 20) | AGREE |
| B3 CI status | chip on each tracked PR row (nullable = no claim) | AGREE |

### 4.3 PR / commit / worktree entity panels (registry kinds, `EntityDetailPanel`)

These kinds already have tiles, chips, StatusPill (`prState→state` mapping exists), and
generic panels on main. Placement:

| Feature | Surface + placement | Verdict |
|---|---|---|
| C12 / B1 PR chips | `panels/EntityListPanel.tsx` tile row (placement="tile") + `panels/EntityDetailPanel.tsx` detail header area (placement="detail") — the wave's `pull-requests/LinkedPullRequestChips.tsx` | AGREE. One chip vocabulary, consumed by tiles, detail, and TaskGitSection. Requires #129's `entity-read serves pull_request state` fix or chips render dark. |
| B4 merge-state | same chip set, nullable-optional (absent fact ≠ success) | AGREE — the nullable design is right |
| B2 PR review, B6 comments | PR entity panel Content tab: reviews/threads as collections blocks; **Discussion tab stays tm8-native** (don't conflate GitHub threads with tm8 discussion) | net-new; no wave placement |
| A2 PR diff | PR entity panel Content tab, mounting `kit/DiffView.tsx` | net-new |
| C9 review-before-merge | the human gate = PR entity panel (diff + approve) + C8 gate on the task; NOT a new "review queue" screen for v1 | net-new |
| C5 worktree lane detail | worktree entity panel (generic panel already shows CHECKOUT fields): add owning session link, dirty/ahead, status timeline from `git.worktree_status_changed` events | net-new; small |
| A3 commit detail | commit entity panel: message, stats, per-file patch (DiffView), `created_in` session chip (C1) | net-new |
| **B10 merge the PR** (land lane on base via the forge) | PR entity panel **ActionBar primary** ("Merge…", disabled-with-reason until: checks green or overridden, mergeable, review present when the tracked task gates on it). This is the missing counterpart to the rail's deliberate exclusion of landing-on-base — the wave said "goes via PR" but never placed the forge-side merge action. **Precondition: no forge WRITE client exists on main** — `tracking/github.ts` is read-only (PR/commit facts); a GitHub write capability (merge, and later review submit) must be built before this button can be real. Until then it renders disabled with that named reason. | net-new — omission in the wave AND in v1 of this map |
| B10 fallout: A19 push inside merge flow | not a separate button — pushing is an internal step of merge/PR flows, per §4.6 | — |

Not placed anywhere (deliberate): an arbitrary ref-to-ref diff picker. Range diffs surface
only where a question exists — session-vs-base (rail), PR (panel), commit (panel), file
revision (FileInspector). A free-form ref picker is a terminal task; the Terminal chip is
its surface.

### 4.4 Project Git screen — dedicated view, route `#/s/{s}/git`

**Placement:** wave's `git/ProjectGitScreen.tsx` mounted in `views/GateApp.tsx` center
region on `activeTarget.ref==='git'`, menu row first under the **Tracking** group
(migration 089). **Wave verdict: AGREE.** Tracking already holds Projects · Pull requests ·
Worktrees; a git overview is its natural head. Carries:

| Feature | Placement within | Verdict |
|---|---|---|
| C16 branch topology | reuse `projects/BranchTopologyList.tsx` per project — same component as Settings | AGREE (reuse, don't fork) |
| C5 worktree lanes | live lanes with owning session, click-through to workspace+panel | AGREE |
| C4 contention map | overlapping touched paths across live lanes | AGREE — this is the single most tm8-native git feature; it exists nowhere else |
| A4/A5 blame + file history (#127) | FileInspector tab (path input, History/Blame toggle) inside ProjectGitScreen, hunks rendered with `SessionAttribution` (C3) click-through | AGREE — survey tool, belongs on the survey screen, not in session panels |
| C20 stale lanes | merged/abandoned lanes listed with reap affordance (server-side reap op is future work) | net-new, same screen |

Keep Settings→Linked projects' branch section as-is (configuration context); the Git view
is the operational context. Same component, two mounts, no duplication of logic.

### 4.5 Ambient placements (existing surfaces, small additions)

| Feature | Surface + placement | Reason |
|---|---|---|
| C11 git activity | `channel-screen` feed + `home/HomeScreen.tsx` Space activity: render ledger `git.commit_recorded` / `git.pr_state_changed` / `git.worktree_status_changed` as feed rows with kind icons | events already exist (082); feeds already render ledger activity |
| C13 forge nudges | `attention/AttentionInbox.tsx` + notification Inbox: observer nudges (#130) arrive as attention items ("CI red on PR your task tracks") | attention is the product's interrupt surface; do not invent a new one |
| B3 CI red on session tile | one dot/badge via `panels/list/tile-badges.ts` on `MaestroSessionTile` when the lane's tracked PR has failing checks | tiles are glanceable; a failing check is glance-worthy |
| C19 launch from PR/worktree | WorkspaceView `LaunchSheet` — copy already names both; make the subjects real | finishing an existing promise |
| C18 git credentials | `settings-credentials/CredentialsSection.tsx` — account git credential rows (migration 093 read/set/delete) beside the GitHub provider | credentials surface exists; 093 has no UI |
| B5 issue import | ActionBar command on task kind ("Import issue…") wrapping #129's `task import-issue`; plus `linkPr`/`linkCommit` as task ActionBar commands (ops exist on main, no UI caller) | commands belong on the kind's ActionBar |
| Session Debug | `SessionDebugBody.tsx`: no git additions — git state belongs on the Git chip; Debug stays about the harness | keep chips orthogonal |
| Session Graph | `session-graph/SessionGraphBody.tsx`: commit nodes appear naturally once `created_in` edges are in hop queries — verify inclusion, add nothing bespoke | provenance already its job |

### 4.6 Features with NO good home — cut (for now)

| Feature | Why cut |
|---|---|
| A10 rebase | history rewriting on agent lanes breaks checkpoint/rollback semantics and the recorder's commits-ahead accounting; merge covers the need. CLI-only if ever. |
| A16 bisect, A17 reflog | interactive/forensic; a terminal task, not a panel. Sessions have a Terminal chip — that IS the surface. |
| A18 submodules | no product story; worktree lanes assume single-repo projects |
| A14 tags, B7 releases | release management is out of scope for lane orchestration; revisit if tm8 grows deploy features |
| A15 reset/revert | superseded by C6 checkpoint/rollback, which is the safe agent-shaped version of the same intent |
| A19 push/pull/fetch as UI buttons | plumbing, not product: push happens inside merge/PR flows; the observer fetches. A raw "push" button invites divergence from the lane model |
| A7 arbitrary checkout in the UI | a lane's branch is graph-bound (`assertMutableWorktree` guard); switching branches under a live session breaks the invariant by design |
| B8 PR creation UI | worth having eventually, but the agent (or CLI) opening the PR is the current model; don't build a PR-composer form before the review surface (§4.3) exists |
| B9 reviewer assignment | forge-side concern; tm8's assignment is the task's assignees |
| standalone "commit graph" visualization | BranchTopologyList's summary rows answer the real question (drift vs trunk); a DAG viz is prestige UI with no operator question behind it |

### 4.7 Surfaces that would need to exist and don't

1. **The Git view** (`#/s/{s}/git`) — designed by the wave (§4.4), not on main. Migration 089 + ProjectGitScreen.
2. **PR review surface** — the generic PR panel has no diff/review blocks; needed for C9 (§4.3). Smallest version: DiffView + review-state collections in the existing generic panel; no new screen.
3. **Server git operation family** — not a UI surface, but a precondition: without landing (or rebuilding) `execution-git.ts`'s six ops, every mutating placement above is display-only.
4. **Checkpoint timeline** (C15) — needs per-checkpoint records correlated to transcript turns; no backing data yet beyond commit records. Future.
5. **Forge write client** — `tracking/github.ts` on main is read-only. B10 (merge the PR from
   the PR panel) and any future review-submit (B2 write-side) need a GitHub write capability
   with the same typed-error honesty (rate-limit / unauthorized / not-found) as the reader.
   Until it exists, forge-write buttons render disabled with that named reason.

### 4.8 Where git would be noise

- **HomeScreen "My work"** — task/attention triage; git belongs only via the activity feed rows (§4.5), not as a dedicated widget.
- **Channel composer / message bodies** — auto-unfurling commits/PRs in chat: chips on attached entities are enough.
- **FilesExplorerScreen** — it browses tm8 file entities, not repo checkouts; blame/history belong to ProjectGitScreen's FileInspector, not here.
- **Doc/memory/artifact panels, MembersSection, voice** — no git dimension.
- **Task tiles** — resist per-tile PR chips beyond one badge; tiles are dense already. Detail + TaskGitSection carry the full state.

---

## 5. Stranded-work disposition note (context for whoever lands things)

The wave (#121, closed) is one coherent design duplicated across five open PRs:
#127 and #128 each re-contain the entire wave and conflict with each other; the PR chips
exist in four branches; the observer loops in three. #129 alone carries the
`entity-read serves pull_request state` fix without which every chips placement is dark.
This map endorses the wave's placements (with the § adjustments above); the outstanding
problem is packaging and sequencing, not design — and that needs a separate owner, per the
parent task thread.

**Suggested landing order** (scoping opinion only): server op family + entity-read fix →
session Git rail → PR chips → TaskGitSection → Git view + migration 089 → FileInspector
(#127) → tier-2 verbs (#128) → observer loops/nudges (#130).
