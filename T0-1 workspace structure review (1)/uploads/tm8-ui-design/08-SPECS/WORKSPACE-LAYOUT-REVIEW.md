# Adversarial Review — Workspace Layout & Domain Terminology

> **Current design-ledger status (2026-07-26):** The original design ledger closed at Round 9; the RULING J delta closed at Round 11; the RULINGS K/L/M + C6/C7 delta closed at Round 12. The review history is non-monotonic, including the Round-6 NO-GO, before its later named closures. Implementation remains gated by the §8 amendment dossier and AM-5.
>
> **Design-status disclaimer:** This document records design dispositions and documentary verification. No statement here asserts implemented behavior.

## PARTIAL finding traceability

| PARTIAL id | Successor finding id(s) | Closing round |
|---|---|---|
| F4 | R2-1, R2-3, R2-4 → R3-7 | Round 4 |
| F10 | R2-2 → R3-1, R3-2; R2-8 | Round 4 |
| F12 | R2-2 → R3-1, R3-2; R2-7 → R3-8 → R4-6 | Round 5 |
| F14 | R2-7 → R3-8 → R4-6 | Round 5 |
| F15 | R2-2 → R3-1, R3-2; R2-9 | Round 4 |
| F17 | R2-10 → R3-8 → R4-6; R3-9 | Round 5 |
| R2-2 | R3-1, R3-2 | Round 4 |
| R2-4 | R3-7 | Round 4 |
| R2-5 | R3-5 → R4-3 | Round 5 |
| R2-7 | R3-8 → R4-6 | Round 5 |
| R2-10 | R3-8 → R4-6; R3-9 | Round 5 |
| R5-1 | R6-1 → R7-1 → R8-1; R7-2; R7-3 → R8-4, R8-5 | Round 9 |
| R5-3 | R6-3 → R7-1 → R8-1 | Round 9 |
| R5-6 | R6-4 → R7-5, R7-6, R7-7 | Round 8 |
| R6-1 | R7-1 → R8-1; R7-2; R7-3 → R8-4, R8-5 | Round 9 |
| R6-3 | R7-1 → R8-1 | Round 9 |
| R6-5 | R7-8 → R8-3 | Round 9 |
| R7-1 | R8-1 | Round 9 |
| R7-3 | R8-4, R8-5 | Round 9 |
| R7-8 | R8-3 | Round 9 |

# Round 1

**Review target:** `docs/plans/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` (DRAFT, 2026-07-25)  
**Verdict:** **NO-GO**  
**Finding count:** **5 BLOCKER · 14 MAJOR · 1 MINOR**

The direction is understandable, but the draft is not adoption-ready. It treats three architectural changes as labels or component reuse when they are not: a multi-origin navigation model, a node-level many-to-many resource becoming a space-scoped entity, and a new shell composition around a pixel-locked transplant. Each currently lacks an identity/lifecycle contract. The project proposal alone is substantially larger than “one contract amendment”; the hubspace rename is not a docs-only sweep; and the center overlay is not free under the stamped terminal model.

## Findings

### 1. [BLOCKER] “Server → spaces” collapses three different topology objects and cannot represent a hub

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:14-17,28-40`; `docs/tm8-architecture/01-LAWS.md:7-17,35-46,56-60`; `docs/tm8-architecture/02-NODE-AND-GATEWAY.md:35-48`; `docs/tm8-architecture/06-SEQUENCING-AND-REVIEW.md:18-25`; frozen `packages/contract/src/catalog.ts:30-142`.

The draft defines a server as a node the client connects to and a hubspace as the one root a server instance serves, but its navigation skips hubspace entirely: selected server → spaces. That works only for a direct connection to one tm8-server process. A public hub endpoint routes both the hub's ordinary workspace and zero or more per-user hosted workspaces, each backed by a separate tm8-server/database. The gateway is a connection/routing endpoint, not itself the graph root. The frozen catalog also has no connected-server list, hosted-workspace list, connection-auth, or origin-qualified space operation, so the proposed server rail is not an existing UI-only projection.

**Fix / ruling required:** choose and specify one model:

1. `connection endpoint (hub/direct) → server instance/hubspace → space`, including stable IDs, auth/token ownership, facade selection, failure state, and URL encoding; or
2. make each server-rail item an already-resolved tm8-server instance, not a gateway/hub, and explain how the gateway expands hosted instances into rail items.

Also rule the phase boundary: remote/hub rail entries are Phase 2 under `06-SEQUENCING-AND-REVIEW`; Phase 1 can have one implicit local server. If connected remotes are required now, that is another frozen-contract amendment, not navigation composition.

### 2. [BLOCKER] The “all-or-nothing workspace→hubspace pass” is neither safe nor docs-only

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:3,15-17,24,90-93`; `docs/tm8-architecture/01-LAWS.md:41-48,82-84`; frozen `packages/contract/src/contract.ts:246-291`; `db/migrations/003_read_model.sql:294-319`; `STATE.md:126-160`.

`workspace` currently names at least three different things:

- the root domain boundary in architecture prose and bridge law;
- frozen technical identifiers (`WorkspaceEvent`, `WorkspaceEventEnvelope`, `workspace_events`, event mappers/publishers); and
- the newly delivered UI route/component (`#/s/{space}/workspace`, `WorkspaceScreen`, workspace CSS/storage/test IDs), which the draft explicitly wants to keep under the new meaning.

A complete textual pass through docs 00–06 + STATE would corrupt the new UI meaning in STATE while still leaving the contract, DB, server, tests, gateway vocabulary, and downstream clients half-renamed. Renaming `WorkspaceEvent` or `workspace_events` is an incompatible contract/migration change, despite the draft claiming no event-machinery change.

**Fix / ruling required:** replace the sweep instruction with a semantic rename matrix. Explicitly grandfather stable protocol/DB symbols (`WorkspaceEvent`, `workspace_events`) or version and migrate them through the amendment process. List which uses mean root container, which mean the three-panel view, and which are legacy technical names. Run a repository-wide inventory, not only docs 00–06 + STATE, and define compatibility aliases for bridge, gateway, hosted-workspace, CLI/config, URL, and mobile terminology before adoption.

### 3. [BLOCKER] A singular project entity cannot model a node-level project linked to many spaces

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:18,79-86`; `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md:54-66`; `docs/tm8-architecture/05-DECISIONS.md:23`; frozen `packages/contract/src/contract.ts:626-685`; `db/migrations/001_core_graph.sql:240-271,329-345,762-772,785-792`.

The frozen project is one node-level resource and `space_projects` is many-to-many. Every entity envelope belongs to exactly one `space_id`; every edge is also space-scoped and rejects endpoints outside that same space. Therefore one project resource linked to spaces A and B cannot be “the project entity” in both. Reusing the resource UUID as the entity UUID fails because `entities.id` is globally primary-keyed and the envelope has only one space. One global project entity fails because there is no global entity graph and cross-space edges are forbidden.

**Fix / ruling required:** specify a per-link graph shadow, not a singular shadow—e.g. a durable mapping `(space_id, project_id) → project_entity_id`, with one entity in every linked space. Rule identity in API/URLs (resource ID versus shadow entity ID), creation/backfill attribution, title/content projection, link idempotency, and how clients resolve from one ID to the other. If per-space duplication is rejected, project cannot be a normal entity under the current envelope and edge laws.

### 4. [BLOCKER] The project materializer has no coherent write, relation, update-fanout, or unlink lifecycle

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:81-86`; `docs/tm8-architecture/01-LAWS.md:23-27`; frozen `packages/contract/src/contract.ts:95-103,146-151,626-738`; `db/migrations/001_core_graph.sql:694-746,898-922`; `db/migrations/007_rpc_catalog.sql:748-854,2020-2113`.

The draft calls three endpoint pairs “registered edges” but does not name an edge type. Registry rows require an exact type and allowed source/destination kinds. It also creates duplicate sources of relation truth:

- `work_sessions.project_id` already points to the project resource;
- `ExecutionSpawnInput.projectId` uses the resource ID;
- pull requests and commits carry required repository strings; and
- the proposal adds task/work_session/pull_request → project-entity edges.

No rule says which wins if the field and edge disagree or an edge is deleted. `projects.update` is node-scoped and has no space in its path, so updating one M2M resource must atomically fan out content/version/activity/events into every linked space shadow, each with its own `(spaceId, seq)` stream. `projects.unlink` currently refuses only live sessions; deleting a project shadow would cascade its edges, destroying task/PR history, while retaining it leaves a graph entity whose settings resource is no longer linked/readable. Generic `entities.patch/delete/restore/move`, hierarchy, reactions, and messages can also mutate the shadow independently unless explicitly gated.

**Fix / ruling required:** provide a transition table for `projects.create/update/link/unlink` and every generic entity command. Name the edge type(s) and choose one canonical relationship mechanism. Decide whether `work_sessions.project_id` and PR/commit repository fields are removed, denormalized caches maintained by one transaction, or retained as the authority (which would violate “edges are the only relationship mechanism” once project is an entity). Define multi-space event fanout, soft-delete/history behavior on unlink, relink behavior, resource deletion (there is currently no `projects.delete` op), and failure atomicity before approving the entity promotion.

### 5. [BLOCKER] The proposed global chrome cannot remain a verbatim pixel transplant

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:28-38,58-67,90-93`; `STATE.md:126-134,147-149`; `packages/ui/src/collab-v2/shell/ShellLayout.tsx:40-59,111-130`; `packages/ui/src/real/workspace/WorkspaceScreen.tsx:1-23,333-377`.

The accepted workspace reference is four panes/chrome: maestro icon rail + task panel + terminal + Sessions/Resources, with its project tab bar across the top. The current implementation deliberately makes `workspace` full-bleed because leaving the Collab shell rail around it creates double rails and invalid geometry/accessibility. The draft now requires a server rail, a space-menu rail, and then three workspace panels. That is at least five vertical regions before counting split handles, and it does not say which transplanted rail each new rail replaces. Yet the adoption checklist says the old screenshot acceptance law continues unchanged.

This is not a small label swap: adding global server/menu chrome changes every x-coordinate and panel width in the reference, while keeping both existing rails reproduces the exact double-chrome failure `ShellLayout` was written to prevent.

**Fix / ruling required:** publish one exact shell wireframe and mapping: which existing `IconRail`, `ProjectTabBar`, and panel chrome become server/space/menu controls, which are omitted in Workspace View, and which remain byte/pixel locked. Then either (a) preserve the current full-bleed four-pane crop and move server/space navigation into existing transplanted chrome, or (b) explicitly retire the old whole-window screenshot oracle and capture a new user-approved reference with crop-specific invariants. “Pixel law continues” cannot coexist with unspecified extra rails.

### 6. [MAJOR] “One amendment” and “does not touch the entity envelope” materially understate the frozen-contract blast radius

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:3,6,79-93`; `STATE.md:207-223` (especially the post-freeze rule at line 212); frozen `packages/contract/src/contract.ts:28-37,84-109,137-156,415-432,626-685`; `packages/contract/src/schemas.ts:51-63,650-662,801-839`; `tools/conformance/test/projects.test.ts:1-6,67-70`.

The frozen law deliberately says project is not an entity, and conformance explicitly asserts that `entities.create(kind:'project')` fails. A correct amendment touches at least:

- `CoreEntityKind`, state/content unions, Project state/content DTOs, KindRegistry/core kind schema, entity projector/read mapper exhaustiveness, and Zod schemas;
- the `CreateEntityInput` TypeScript exclusion **and** `CoreEntityKindSchema.exclude(...)` (adding the kind without both would accidentally make it client-creatable);
- semantics/results/events for `projects.create/update/link/unlink`, plus conformance and contract tests;
- a new additive migration (do not rewrite the delivered migration history): core `entity_kinds` row, per-space shadow mapping/detail storage, backfill, version/activity snapshots, edge registry, RPC/materializer functions, RLS, grants, event fanout, and negative tests;
- `spaces.githubRepo`, PR/commit repository fields, `ExecutionSpawnInput.projectId`, `work_sessions.project_id`, imports/exports, and bridge projections, depending on the source-of-truth rulings; and
- UI registry, generic creation capability, settings, collection results, routes, and mock/real facade fixtures.

**Fix / ruling required:** replace §5 with a formal post-freeze amendment dossier: exact contract diffs, compatibility policy, migration/backfill plan, RLS matrix, event semantics, conformance changes, and rollback/repair behavior. Logging one sentence in STATE is necessary but not sufficient under the freeze rule.

### 7. [MAJOR] “Follow the work_session pattern exactly” is a false analogy

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:81-84`; `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md:11-19`; frozen `packages/contract/src/contract.ts:618-624,700-738`; `db/migrations/001_core_graph.sql:691-746`; `db/migrations/007_rpc_catalog.sql:2020-2163`.

A work_session is born in one space from one `execution.spawn` transaction. Its **status**, not the entire entity, has the R29 single writer. It has no pre-existing node-level M2M resource and no update fanout across spaces. A project has exactly those complications. Saying “same pattern” hides the new identity and replication semantics instead of deriving them.

**Fix / ruling required:** describe project as a distinct “node resource + per-space graph projection” pattern with its own invariants. State precisely which fields are materializer-owned, which envelope fields remain normal graph state, which generic capabilities are disabled, and which trigger/RPC enforces each single-writer boundary.

### 8. [MAJOR] `project = repository` is false in the frozen execution model and leaves multiple repository truths

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:18,84-85`; frozen `packages/contract/src/contract.ts:95-97,532-540,651-695`; `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md:54-60`.

The frozen project is a configured execution root: `workingDir` is required, `repoUrl` is optional and vendor-neutral, spawn defaults live on it, and a server-managed worktree may be derived from it. A local non-git directory is still a valid project; two clones/working directories of one repository can be distinct configured projects. Meanwhile `SpaceSummary.githubRepo` and PR/commit `repository` strings remain separate sources. Calling GitHub “a project field” also narrows the generic `repoUrl` contract without ruling GitLab/SSH/local remotes.

**Fix / ruling required:** define project as a configured execution/repository root, not as equality with a repository, unless the model is deliberately changed. Keep the field vendor-neutral (`repoUrl`/remote URL). Decide migration/deprecation for `spaces.github_repo` and PR/commit repository strings, and document whether repository identity, checkout, worktree, and project are one object or separate concepts.

### 9. [MAJOR] “Created via space settings” conflicts with current authorization and the nav omits the required settings surface

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:18,28-42,81-84`; `db/migrations/007_rpc_catalog.sql:748-830`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:212-229`.

`projects.create` and `projects.update` require node admin; `projects.link` and `unlink` require space admin. A space admin is therefore allowed to attach an existing node project but not create or edit one. “Space settings only” conflates two scopes and implies an authorization path that does not exist. The proposed navigation also contains no Settings entry even though the workflow depends on it and the inherited screen contract has Space settings.

**Fix / ruling required:** split Node/Server Project Registry from Space Settings → Linked Projects. Show create/update only to node admins; show link/unlink to space admins; define the hosted-hub case where space admin is not node admin. Restore an explicit settings route/entry point (or name the non-nav affordance) and specify unavailable/forbidden states.

### 10. [MAJOR] A z-index overlay is not the stamped mounted-hidden/suspended terminal case, and hidden does not mean suspended

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:60-67`; `STATE.md:128,134,151-158,188-194`; `docs/ui-audit/TERMINAL-TRANSPLANT-NOTES.md:14-16,28-49,72-102`; `packages/ui/src/real/terminal/visibilityDriver.ts:1-26,40-49,67-112`; `packages/ui/src/real/workspace/CenterPane.tsx:173-227`.

Covering a terminal with an absolutely positioned detail panel does not change computed `visibility`; the visibility driver will still consider it visible, keep it in the warm LRU, parse output, blink unless `active` is cleared, and potentially fit/resize it under the overlay. Even if the terminal layer is set to `visibility:hidden`, the most-recent three hidden terminals are intentionally **never suspended**. Therefore “covered terminal is exactly mounted-hidden/socket-suspended” and “overlay costs nothing” are both false.

The correctness seam is also active: a transition to hidden/suspend must synchronously force-flush before socket close; an unmount/eviction requires offset 0 + full-ring replay and airtight cleanup. A detail overlay that toggles display/z-index without the current terminal activation protocol can produce CPU waste, hidden resize stomps, or a client-only offset hole.

**Fix / ruling required:** specify the overlay as a real center-layer state: terminal layer gets inherited `visibility:hidden`, `active=false`, `aria-hidden`/`inert`; the visibility reconciliation gets the same post-commit kick as terminal switching; close reverses those states before focus/fit; no xterm unmount occurs. Decide whether an entity overlay deliberately keeps the current socket warm (bounded non-zero cost) or adds a force-suspend reason that safely bypasses the warm LRU. Add browser tests with live output arriving during open/close, after the 10-second grace, during LRU eviction, and across reconnect/gap/epoch paths.

### 11. [MAJOR] A singular session bar cannot make “a running agent never invisible” when both lists are independently generic

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:48,60-67`; `packages/ui/src/real/workspace/ResourcePanel.tsx:38-57,73-83,154-180,190-203`; `STATE.md:162-166`.

The bar describes only the session currently under the center overlay. With two independent kind selectors, both side panels may show tasks/docs/projects and every other live work_session becomes invisible. The inherited right panel prevents this through a stable Sessions mode, lifecycle tabs, live count, and session tree. The draft removes that invariant while making a stronger visibility claim.

**Fix / ruling required:** retain a global live-session switcher/count independent of side-panel kind selection, or reserve one panel/rail mode for sessions. The slim bar must say “1 of N live” and open the live roster, not only return to the current terminal. Prove reload/reconnect reachability for every live session.

### 12. [MAJOR] The workspace overlay silently drops the inherited Z3 panel stack, pin-splits, and URL-addressable graph browsing

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:46-51,65-72`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:98-105,125-137,170-184`; `packages/ui/src/collab-v2/stores/nav.ts:7-21,29-85,112-147,158-217`; `packages/ui/src/collab-v2/shell/ShellLayout.tsx:111-130`.

Inherited behavior is not “show one detail”: chips stack panels with breadcrumbs, pins create 2–3 persistent splits, stack/pin/tab state is encoded in the URL, and expand promotes Z3→Z4. The current full-bleed workspace omits `PanelStack` completely. Pushing the existing nav-store stack while on the workspace route changes state but renders nothing. The draft's one center overlay does not say whether a second entity replaces, stacks, pins, or opens the global right panel; close/Esc “returns to terminal” discards the breadcrumb/split model.

**Fix / ruling required:** either render the existing nav-store PanelStack grammar inside the workspace center stack (with exact push/replace/pin/promote/dismiss semantics and URL serialization), or explicitly declare Workspace View an exception and amend the Z1–Z4/shell acceptance contract. Do not claim Z1–Z4 internals are inherited unchanged while dropping their navigation state machine.

### 13. [MAJOR] `MaestroPanel + SessionsSection → one EntityListPanel` is wishful reuse under the pixel law

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:44-51,90-93`; `STATE.md:126-134`; `packages/ui/src/real/workspace/TaskPanel.tsx:1-24,158-179,195-260`; `packages/ui/src/real/workspace/ResourcePanel.tsx:15-44,73-203`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:47-53,125-137`.

The left and right transplanted surfaces are not the same list with different data. The task panel has current/completed state, hierarchy expansion, inline status/edit/complete, Run/Coordinate, task filtering/sorting, and task-specific disabled affordances. The right panel has Sessions/Resources modes, quick launch, terminal/agent/doc/drawing filters, open/done/live lifecycle, live count, history, and distinct tile trees. A generic “kind selector + Create + sort + task-shaped tiles” either deletes those behaviors or becomes a slot/variant framework whose markup is no longer one component. Giving every kind task Run affordances also violates registry-driven capabilities.

**Fix / ruling required:** preserve the verbatim TaskPanel and ResourcePanel shells for the pixel-locked Workspace View. Extract only genuinely shared data/query, selection, and tile primitives behind adapters/registry entries. If the user instead wants identical generic panels, retire the verbatim-panel acceptance claim and capture a new reference; do not call that change “mostly reuse.”

### 14. [MAJOR] The route statement is not a route design and cannot satisfy reload/share/back semantics

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:40,69-72`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:170-184`; `packages/ui/src/collab-v2/stores/nav.ts:7-21,43-55,143-147,158-217`; `packages/ui/src/real/workspace/WorkspaceScreen.tsx:32-41`.

“URL encodes server/space/entity/view” omits the grammar and the state needed to reproduce the claimed layout. The current Z4 route `#/s/{space}/e/{entity}` does not encode a server/hubspace, previous view, collection query, kind, layout, filters, or collapsed-left state. `promotePanel` sets `view:'entity'` and loses the origin except as a browser-history entry. A reload or shared link therefore cannot know which “previous view slides left.” The current workspace also deliberately keeps selected task/session only in component state and reloads with neither, contradicting addressable-everything if the draft now treats center overlays/terminal selection as navigation.

**Fix / ruling required:** publish the exact grammar and canonical reload behavior. Either encode the origin collection/view/query (for example an origin route/query parameter) or rule that expanded detail always gets a canonical left companion derived from the entity kind rather than “the previous view.” Include server/connection and hubspace only after Finding 1 is resolved. Define whether workspace overlay/session selection uses existing `p=` stack state, a workspace-specific route segment, or intentionally stays ephemeral. Provide compatibility/redirect behavior for current `#/s/{space}/workspace`, `/tasks`, `/sessions/{id}`, `/channel/{id}`, and `/e/{id}` links.

### 15. [MAJOR] The layout spec omits the durable flex/grid floor law that already broke this exact UI three times

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:58-67,90-93`; `STATE.md:147-149`; `packages/ui/src/real/workspace/WorkspaceScreen.tsx:107-150,347-377`.

The draft supplies a diagram but no track minima, shrink order, overlay minimum, resizer bounds, or breakpoint derivation. The durable rule is explicit: every shrinkable flex/grid track states a floor; the breakpoint is derived from track minima plus rails; browser measurement is mandatory. Adding a second rail, arbitrary entity content, and a session bar makes the already-proven starvation failure more likely. Vitest cannot validate any of this.

**Fix / ruling required:** make the layout contract include named grid tracks with `minmax(...)` floors, rail widths, side-panel/center minima, shrink priority, resizer bounds, overlay overflow behavior, and a mathematically derived stacking/collapse breakpoint. Add reference-browser acceptance at wide and minimum supported widths with worst-case UUID/title/action content, not only the 1600×1000 golden screenshot.

### 16. [MAJOR] The draft regresses the universal collection system from six layouts to a kind-special-cased subset

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:48-51,69-72`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:188-208`; frozen `packages/contract/src/contract.ts:187-217`; `docs/tm8-architecture/01-LAWS.md:19-33`.

The inherited CollectionView supports List, Board, Tree, Feed, Gallery, and Graph for the same query. The draft offers list/tree/graph for all kinds, board only for tasks, and demotes feed/gallery into later per-kind extensions. Feed and Gallery are already generic layouts in the contract; board grouping is driven by axes/grouping rather than a hard-coded `kind === task` outside the registry. This is a contract/architecture regression disguised as simplification.

**Fix / ruling required:** retain all six generic layout modes. The KindRegistry/capabilities may choose defaults or hide modes that are semantically useless for a kind, but the component and contract stay universal. Treat a doc reader or channel hub as a Z4/per-kind layout variant, not as the generic Gallery/Feed implementation.

### 17. [MAJOR] Omitted inherited screens, drag grammar, and golden workflows have no disposition; omission is not a clean deferral

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:42,53-77,90-94`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:212-250,267-280`; `docs/tm8-architecture/06-SEQUENCING-AND-REVIEW.md:5-7,13-16`; `STATE.md:77-91,201-218`; frozen `packages/contract/src/contract.ts:551-557`.

The new nav silently drops Inbox and Space Settings, gives no home to saved views/pin-splits, and does not disposition the seven-row drag/drop/undo grammar. It also says nothing about the five golden workflows, which AM-5 parked after Phase 1 but did not repeal. “Dashboard” is underspecified against the frozen `spaces.home` shape: Ready-to-pull, In-flight, Needs-me, plus compact activity. Several proposed later items are not cleanly severable: project creation requires Settings now; a server rail depends on Phase 2 connection/gateway work; session visibility depends on a global roster; Entity View interactions depend on panel-stack/drag routing.

**Fix / ruling required:** add an inherited-surface disposition table with one of **preserved / adapted / explicitly deferred / superseded by user ruling** for every Layer 3–8 item and each golden workflow. For each deferral, name the remaining entry point and verify no current flow depends on it. Preserve the exact `spaces.home` My Work contract unless a separate contract amendment changes it.

### 18. [MAJOR] “Feed = the default channel” is not durably addressable after space creation

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:21,55-57`; `db/migrations/007_rpc_catalog.sql:424-478`; frozen `packages/contract/src/contract.ts:531-557`; `packages/contract/src/schemas.ts:959-987`.

Space creation atomically creates `general` and returns `defaultChannelId`, but that ID is not stored on the space and is absent from later `SpaceSummary`, `SpaceNavigation`, and `HomeSnapshot` reads. A client reopening the space cannot reliably distinguish the feed from any other root channel. Choosing the first channel or the name `general` breaks after reorder, rename, deletion, import, or legacy migration. Calling this “convention, not mechanism” does not produce a stable nav target.

**Fix / ruling required:** persist a default-channel relation/ID and expose it through navigation/settings, with deletion/replacement/import rules, or define and enforce an immutable deterministic convention with a fallback. This is another contract/migration touch if Feed is a guaranteed Home target.

### 19. [MAJOR] “Hierarchy comes free but will go unused” fails the entity test and leaves dangerous capabilities enabled

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:84-86`; `docs/tm8-architecture/01-LAWS.md:23-33`; frozen `packages/contract/src/contract.ts:162-176`.

The architecture's entity test asks whether all four universal capabilities pay rent. The draft concedes project hierarchy is expected to go unused, yet says hierarchy/capabilities come free. A generic EntityDetailPanel will expose `canAddChild`, `canEdit`, `canDelete`, reactions, points, and hierarchy according to capabilities. If these stay true, users can parent/move/delete or independently edit a materialized project shadow; if they are false, the proposal must explain why project still passes the entity test and how the generic UI renders the restriction.

**Fix / ruling required:** publish the project capability matrix and command routing. Rule parent semantics (disabled versus supported), content edit/delete behavior, reactions/points, and whether discussion/activity justify the entity. If only edge targeting pays rent, reconsider a dedicated graph-reference entity/projection with deliberately restricted capabilities rather than claiming all envelope behavior “comes free.”

### 20. [MINOR] Route labels, user labels, and entity-kind identifiers are mixed together

**Contradicted source:** draft `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:28-42`; `packages/ui/src/collab-v2/stores/nav.ts:43-55`; `packages/ui/src/real/workspace/WorkspaceScreen.tsx:11-16`.

The menu shows developer identifiers (`work_sessions`, `pull_requests`) while the shipped user route is `sessions` and existing screens use user labels such as Tasks, Tracking, Team, and Sessions. It is unclear whether sub-items are labels, route segments, or raw entity kinds. A literal `/work_sessions` route would create needless compatibility churn with `/sessions`.

**Fix / ruling required:** specify three columns—user-visible label, entity kind/query, stable route slug—and preserve aliases/redirects. Prefer “Sessions” → kind `work_session` → route `sessions`, and “Pull requests” → kind `pull_request` → a ruled route slug.

## Required re-review packet

Do not adopt the terminology or begin implementation from this draft. A re-reviewable revision needs, at minimum:

1. the resolved connection/server-instance/hubspace topology and phase boundary;
2. a semantic rename/compatibility matrix;
3. a per-space project-shadow identity and lifecycle state machine;
4. exact project contract, edge, migration, RLS, event, and conformance deltas;
5. one exact shell wireframe plus a ruled screenshot oracle;
6. center overlay + terminal visibility/suspend/focus behavior and browser tests;
7. exact URL grammar and legacy-link handling; and
8. an inherited UI surface/workflow disposition table.

Until those exist, the draft permits multiple mutually incompatible implementations and would force the implementers—not the design—to decide frozen-contract and topology questions. **NO-GO.**

# Round 2

**Review date:** 2026-07-26  
**Reviewed revision:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2  
**Round-1 disposition:** **14 RESOLVED · 6 PARTIAL · 0 UNRESOLVED**  
**New findings:** **2 BLOCKER · 8 MAJOR · 2 MINOR**  
**Verdict:** **NO-GO — 2 blockers.**

The three user rulings in v2 §0 are accepted as binding premises. This review does not relitigate the new Workspace oracle, Phase-1 local-only scope, or the definition of project as a configured execution root.

## A. Verification of F1–F20

1. **F1 — RESOLVED.** RULING B plus §4 fixes Phase 1 at one implicit local server and makes the gateway/hosted-hubspace connection model an explicitly separate Phase-2 amendment (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:12,19-20,88-90`).
2. **F2 — RESOLVED.** §1.1 replaces the unsafe sweep with a per-meaning matrix, freezes protocol/DB identifiers, retains Workspace View names, and requires per-hit inventory plus aliases (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:26-35`); the erroneous event-scope note is isolated as new Finding R2-11 below.
3. **F3 — RESOLVED.** §7 now specifies one projection entity per `(space, project)` link and a bidirectional resource/projection mapping, so it no longer attempts one global entity in multiple space-scoped graphs (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:126-130`).
4. **F4 — PARTIAL.** §7 supplies a lifecycle table and names `in_project`, but the claimed PR/commit derivation is not computable, the derived-edge mutation boundary is not enforced, and unlink/relink edge semantics remain inaccurate (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:131-140`; R2-1, R2-3, R2-4).
5. **F5 — RESOLVED.** Binding RULING A explicitly retires the old whole-window oracle for Workspace View, requires a new approved reference, and preserves the terminal-chrome crop invariants (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:11,123-124`).
6. **F6 — RESOLVED.** §8 stops calling the promotion a small amendment and gates implementation on a Vega-approved dossier covering contract, schemas, migration, RLS, events, conformance, repair, and rollback (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:144-148`). Defects in the proposed semantics still have to be corrected before that dossier can be approved.
7. **F7 — RESOLVED.** §7 explicitly defines a new “node resource + per-space projection” pattern rather than claiming equivalence with `work_session` (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:126-130`).
8. **F8 — RESOLVED.** RULING C and §§1/7 consistently define project as a configured execution root with required `workingDir` and optional vendor-neutral repository metadata (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:13,23,140`). The impossible legacy `githubRepo` backfill is a separate migration defect (R2-6).
9. **F9 — RESOLVED.** Navigation now exposes Space Settings and the node-admin Project Registry, while §7 separates node-admin create/update from space-admin link/unlink and covers the hosted-hub degradation (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:48,51,142`).
10. **F10 — PARTIAL.** §5.2 now names visibility, active, accessibility, reconciliation, focus/fit, and browser-test requirements, but “warm by definition” is false for a terminal first mounted behind a deep-linked overlay, and pinned-only state falls outside the rule (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:106`; R2-2, R2-8).
11. **F11 — RESOLVED.** The bar now has a space-global live count, roster, switch target, and reload/reconnect acceptance independent of either side-panel filter (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:107`).
12. **F12 — PARTIAL.** §5.2 restores the named PanelStack actions, but `p=` is not the inherited complete codec and pinning creates a state the layered terminal protocol and center sizing do not define (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:105`; R2-2, R2-7).
13. **F13 — RESOLVED.** RULING A permits a new component target and §3 makes the distinct task/session behaviors an explicit binding survival list with registry-gated actions (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:11,81-84`).
14. **F14 — PARTIAL.** §2.2 adds routes, origin, canonical reload, session addressability, and redirect intent, but it misstates the inherited panel codec, abbreviates legacy paths ambiguously, and leaves `q`/`origin` codecs unspecified (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:65-79`; R2-7).
15. **F15 — PARTIAL.** §5.6 adds the requested floors, shrink order, and browser measurement, but the menu track still has a zero floor and the stated 900/680 breakpoints are not derived from the displayed equations or pin-split widths (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:114-121`; R2-2, R2-9).
16. **F16 — RESOLVED.** §3 preserves all six generic layouts and makes kind-specific hiding/defaults registry-driven rather than task conditionals (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:86`).
17. **F17 — PARTIAL.** §9 now dispositions several major inherited surfaces, but it omits multiple Layer 2/5/6/7 contracts, falsely equates route query state with saved views, and schedules executable workflow acceptance at design adoption while §10 says no build occurs (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:150-173`; R2-10).
18. **F18 — RESOLVED.** §8.2 specifies a persisted default-channel ID, read-shape exposure, deletion/successor/no-feed behavior, and explicit import/migration handling (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` §8.2).
19. **F19 — RESOLVED.** §7 supplies a concrete capability matrix, disabled reasons, settings routing, and the claimed rent paid by project projections (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:141`).
20. **F20 — RESOLVED.** §2.1 separates user label, entity kind/query, and stable route slug for every proposed menu item (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:53-63`).

## B. New v2 findings

### R2-1. [BLOCKER] PR/commit repository strings cannot authoritatively identify a configured execution root

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:13,140`; frozen `packages/contract/src/contract.ts:95-97,489-496,651-660`; `packages/contract/src/schemas.ts:152-167,751-759`; `docs/tm8-architecture/05-DECISIONS.md:16`.

RULING C permits a non-git project and treats two working directories/clones of one repository as different projects. A PR or commit, however, stores only a repository string, while `linkPr`/`linkCommit` accept only a URL. That string cannot choose between two configured roots for the same remote and cannot identify a non-git root at all. The materializer therefore cannot derive one authoritative `pull_request|commit → in_project → project` edge “in the same transaction.” Inferring through the task also fails unless tasks are ruled to have exactly one project, which v2 does not do.

**Concrete fix / ruling needed:** choose one: (a) add an explicit `projectId` to PR/commit write inputs and typed detail/state, and define project-scoped uniqueness; or (b) rule that repository artifacts are repository-scoped and may assert zero/multiple user-managed `in_project` edges. Do not call repository-string matching authoritative. Record the chosen contract/schema/migration diff in §8.

### R2-2. [BLOCKER] Pinning produces a terminal/overlay state that §5.2 cannot render or suspend coherently

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:99-106,118-121`; `packages/ui/src/collab-v2/stores/nav.ts:129-139`; `packages/ui/src/collab-v2/shell/PanelStack.tsx:220-278`; `packages/ui/src/collab-v2/shell/ShellLayout.tsx:125-131`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:170-184`.

The inherited `pinPanel` moves the panel from `stack` to `pinned`. Section 5.2 hides/inerts the terminal only “when the stack is non-empty” and says an empty stack reveals it. After pinning the sole stacked panel, the stack is empty but the pinned panel still exists: the terminal becomes visible/active/focusable while a pinned detail remains. The spec does not rule whether that is a terminal-plus-pin split or an overlay, so focus, `active`, visibility reconciliation, Esc, and dismissal have two incompatible implementations.

There is also no verbatim drop-in component: inherited `PanelStack` returns a fragment so pinned frames become siblings of the global center in the shell flex row. Nesting that fragment inside a 320px-minimum workspace-center layer changes its containing layout. Up to three pinned panels at 320px each cannot fit the stated center floor or the 848px wide-layout equation.

**Concrete fix / ruling needed:** define the complete center state machine over `{stack, pinned}`. If any panel covers the terminal, use `stack.length || pinned.length` for visibility/inert/focus and give pinned panels an internal layout with derived floors. If pins split alongside a live terminal, specify terminal activation, split widths, overflow/stacking behavior, and breakpoint equations. Either way, acknowledge and specify the workspace composition adapter; “nothing workspace-specific” is not implementable.

### R2-3. [MAJOR] “Single writer of envelope” contradicts allowed discussion/reaction behavior and leaves derived edges writable

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:138-141`; `db/migrations/001_core_graph.sql:849-867,1034-1049`; frozen `packages/contract/src/catalog.ts:55-61`.

The transition table says the materializer is the single writer of the project envelope and detail, then permits normal messages and reactions. Posting a message updates the anchor's `activity_at`; reactions are edges and edge triggers update endpoint `activity_at` and counters. The materializer therefore cannot be the envelope's sole writer. Separately, generic `edges.create/patch/delete` has no v2 rule refusing client mutation of derived `in_project` edges from sessions/PRs/commits while allowing the task exception.

**Concrete fix / ruling needed:** narrow ownership to named configuration/lifecycle fields (for example title, projection detail, deleted state, and resource-derived content), explicitly leave activity/counters trigger-owned, and define server/RPC guards: task-source `in_project` is user-writable; session/PR/commit-source `in_project` is materializer-only; clients cannot patch/delete those derived rows.

### R2-4. [MAJOR] `project_links` persistence and “edges follow soft-delete” are not a complete unlink/relink model

**Contradicted/insufficient source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:130-138,146`; `db/migrations/001_core_graph.sql:264-271,762-773`; `db/migrations/007_rpc_catalog.sql:833-854,1417-1505`.

Today unlink physically deletes `space_projects`; the proposed mapping must survive that deletion to remember the projection ID for relink. V2 does not state its foreign keys, uniqueness, cascade policy, or whether active linkage is still determined solely by `space_projects`. The edge wording is also inaccurate: generic entity soft-delete changes only `entities.deleted_at`; edges have no `deleted_at` and remain physical rows. They do not “follow soft-delete” or get restored by `restore_entity`; only endpoint visibility may make them disappear from some projections. That difference matters to RLS, `edges.list`, relink repair, and historical task edges.

**Concrete fix / ruling needed:** specify the mapping DDL invariants (unique `(space_id,project_id)`, unique `project_entity_id`, FKs and non-cascade survival across unlink), active/inactive source of truth, and exact edge read behavior while the target projection is deleted. Say whether edges remain intact-and-hidden or are separately tombstoned; add relink repair/idempotency and negative RLS tests accordingly.

### R2-5. [MAJOR] “Bounded by link count” is not a bound for an all-space update transaction

**Contradicted/insufficient source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:128,135,146`; frozen `packages/contract/src/catalog.ts:100-103`; current `db/migrations/001_core_graph.sql:264-271`.

Projects are many-to-many and v2 gives no maximum link count. Updating every projection and allocating one per-space event sequence in one transaction can lock an arbitrary number of entity/event-counter rows. Concurrent updates to projects with overlapping spaces also need deterministic lock order to avoid deadlocks. “Bounded by link count” merely restates the input cardinality; it does not constrain it or define failure/retry semantics.

**Concrete fix / ruling needed:** either impose and validate a link cap plus deterministic space lock order and all-or-nothing retry behavior, or use a durable asynchronous projection/outbox model with observable convergence and repair. The dossier must name what a failed projection does to the resource update and per-space events.

### R2-6. [MAJOR] `spaces.githubRepo` cannot be auto-migrated into a valid configured execution root

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:13,140`; frozen `packages/contract/src/contract.ts:532-540,651-671`; `packages/contract/src/schemas.ts:807-825`; `db/migrations/001_core_graph.sql:222-233,246-259`.

The legacy field contains only repository text. A project requires a unique absolute `workingDir`; RULING C expressly says the repository is not the project. A database migration cannot infer which checkout/root on the node should own that repository, and fabricating or cloning a path is an external filesystem action outside an additive graph migration.

**Concrete fix / ruling needed:** deprecate `githubRepo` without automatic project creation, or create an explicit node-admin reconciliation/import flow that selects or creates a working directory and then links the resulting project. Existing repository metadata may be copied only after a root is chosen.

### R2-7. [MAJOR] The route grammar says `p=` is reused “as-is,” but the inherited codec has three parameters

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:65-79`; `packages/ui/src/collab-v2/stores/nav.ts:7-21,92-97,158-217`; `packages/ui/src/collab-v2/shell/router.ts:1-12`.

The current codec is `p=` for the stack, `pin=` for pinned splits, and `t=` for per-panel tabs. V2 shows only `p={panelStack}` and says it includes stack/pin state “as-is”; a reload would lose pins and active tabs if implemented literally. The redirect list is also not exact: current tm8 routes are space-qualified, while `#/tasks → k/tasks` omits both `#/s/{space}` sides. Finally, `q={query}` and nested `origin={k-route}` have no encoding, validation, canonicalization, or size rules, so shared links can parse differently or carry an invalid origin.

**Concrete fix / ruling needed:** publish a round-trippable codec using the existing `p`, `pin`, and `t` parameters (or explicitly version a new packed codec); define percent-encoding, allowed origin routes, invalid-state fallback, and query payload limits; list every redirect as a complete old hash → complete new hash preserving space and panel state.

### R2-8. [MAJOR] A terminal first mounted behind a deep-linked overlay is not warm “by definition”

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:69,78,106`; `packages/ui/src/real/terminal/visibilityDriver.ts:40-49,57-65,76-112`; `packages/ui/src/real/workspace/CenterPane.tsx:185-209`; `STATE.md:128,134`.

The warm-socket LRU is touched only when computed visibility is not hidden. On a fresh `#/workspace?session=…&p=…` reload, the selected terminal can mount hidden from its first reconciliation and never enter the warm LRU. It becomes suspend-eligible after the grace interval, contradicting the explicit ruling that the covered terminal stays warm because it is “by definition” most recent. The mounted-xterm LRU and warm-socket LRU are separate mechanisms; selecting a session in React does not touch the latter.

**Concrete fix / ruling needed:** add an explicit visibility-driver operation that marks the selected covered session warm (bounded by the same LRU), call it during route hydration/overlay transitions, and test a cold deep-link past ten seconds. Alternatively retract the keep-warm ruling for initially covered sessions and specify the normal flush/suspend/replay path.

### R2-9. [MAJOR] The layout breakpoints are asserted, not derived, and one shrinkable rail still has a zero floor

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:114-121`; `STATE.md:147-149`.

`minmax(0,220px)` permits the menu rail to shrink toward zero before or instead of entering the claimed 48px collapsed state, violating the durable rule that every shrinkable track state a floor. The shown wide minimum sums to exactly 848px, but v2 changes that into an unexplained “below ~900px” breakpoint. Once the right panel stacks, the displayed remaining horizontal minima total 622px; once both sides stack, they total 416px, so “below ~680px” is not derived from the shown tracks either. The formula also includes a 48px server rail even though Phase 1 permits it to be hidden, and it excludes the multi-pin center requirement.

**Concrete fix / ruling needed:** specify discrete expanded/collapsed menu tracks (each with a nonzero floor), whether the Phase-1 server rail consumes width, and the exact state-specific equations including borders/scrollbars/resizers and pinned columns. Set breakpoints from those equations, then measure each transition in the browser with worst-case content.

### R2-10. [MAJOR] §9 is not a complete Layers 3–8 disposition and makes two false preservation claims

**Contradicted/insufficient source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:150-173`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:141-165,188-208,212-280`; `STATE.md:89`.

The table omits the Layer-2 Thread/ConnectionsRail/reactions subsystem contract; Tracking, Graph, Entity Z4, and Channel Hub's pinned shelf/auto-tabs; creation/promote flows; optimistic reconciliation; keyboard/focus; live/offline/tombstone states; performance; and accessibility. “Saved views … serialize the same state” is false: a saved view includes query, layout, grouping, sorting, name, persistence, and share scope, while the proposed `q` parameter is only an unspecified query payload. “Five golden workflows … re-run … at adoption” is temporally impossible under §10 step 5 and AM-5: design adoption occurs before any build capable of running them.

**Concrete fix / ruling needed:** expand the table to every Layer 3–8 surface/subsystem and each golden workflow, with a real surviving entry point for each deferral. Separate transient route state from persisted/shared saved views. Move golden-workflow execution to implementation acceptance; at design adoption, require only traceability showing how the structure can support each workflow.

### R2-11. [MINOR] The grandfathering note changes a space-scoped event stream into “hubspace-scoped” machinery

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:32-33`; frozen `packages/contract/src/contract.ts:257-280`; `packages/contract/src/schemas.ts:521-579`; `db/migrations/003_read_model.sql:282-318`.

`WorkspaceEvent` is a historical name, but every envelope carries `spaceId`, sequence allocation is per space, and the durable table is uniquely ordered by `(space_id, seq)`. Calling it “hubspace-scoped” would teach implementers the wrong isolation and cursor boundary.

**Concrete fix:** keep every symbol unchanged, but make the note say: “`Workspace*` is a historical product name; events remain space-scoped and are multiplexed by a server.”

### R2-12. [MINOR] New section references and headings do not resolve

**Contradicted source:** v2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:48,84,112,161`.

The spec cites §§7.3, 7.4, and 7.5, but §7 has no numbered subsections. It also combines `### 5.4 Leaderboard` and “§5.5 Channel View” into one heading, leaving no real §5.5 anchor. These are small defects, but the adoption/dossier references must be mechanically navigable.

**Concrete fix:** split §7 into numbered identity/lifecycle/relations/capabilities/authorization subsections (or correct the references) and give Leaderboard and Channel View separate headings.

## Round-2 ruling

V2 is a substantial correction: it genuinely closes fourteen of twenty original findings and turns the remaining six into narrower, testable defects. It is still **NO-GO** because two central statements cannot produce one coherent implementation: repository strings do not identify a configured execution root, and the inherited pin action escapes the terminal protocol's `stack non-empty` predicate while also exceeding the center's sizing model. Resolve R2-1 and R2-2, then close the eight major findings in the amendment/oracle packet before Vega adoption. No implementation or post-freeze amendment should begin from the current v2 text.

# Round 3

**Review date:** 2026-07-26  
**Reviewed revision:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.1  
**Round-2 disposition:** **7 RESOLVED · 5 PARTIAL · 0 UNRESOLVED**  
**New findings:** **2 BLOCKER · 7 MAJOR · 1 MINOR**  
**Verdict:** **NO-GO — 2 blockers.**

RULINGS A–E are accepted as binding premises. In particular, this review does not argue for restoring a base terminal layer or changing Workspace's caret/palette navigation. It tests whether v2.1 completely specifies the implementation implied by those rulings.

## A. Verification of R2-1–R2-12

1. **R2-1 — RESOLVED.** §7.3 adds an explicit optional `projectId`, forbids repository-string derivation, derives only when the ID is present, and permits zero/multiple user-managed edges when it is absent (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:170-175`). Validation of that new ID is a fresh omission (R3-6), not a return to repository matching.
2. **R2-2 — PARTIAL.** RULING D genuinely deletes the broken base-layer predicate, and §5.2 acknowledges WorkspaceCenter, state, and width-based pin admission (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:103-121`). The replacement still lacks a terminal lifetime owner and a unique/complete host-visibility model (R3-1, R3-2), so it has traded the old contradiction for two new implementation forks.
3. **R2-3 — RESOLVED.** §7.4 narrows materializer ownership to title/detail/`deleted_at`, leaves activity/counters to triggers, and §7.3 supplies per-origin edge RPC guards (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:175,179-180`). One inaccurate version sentence is isolated as R3-10.
4. **R2-4 — PARTIAL.** §7.1 now gives the mapping's uniqueness, persistence, and active-authority rules, and §7.2 correctly keeps edges physical across entity soft-delete (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:153-168`). It still does not specify actionable FK `ON DELETE` behavior, and the promised deleted-endpoint visibility rule is not defined beyond delegating it to the dossier (R3-7).
5. **R2-5 — PARTIAL.** §7.2 adds a cap of 16, sorted space locking, all-or-nothing failure, and client retry (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:166`). It does not make the cap race-safe against concurrent links/updates or disposition projects already above the cap at migration time (R3-5).
6. **R2-6 — RESOLVED.** §7.3 forbids automatic migration and requires a node-admin flow to choose/create a root before copying repository metadata and linking (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:177`).
7. **R2-7 — PARTIAL.** §2.2 restores `p`/`pin`/`t`, full space-qualified redirects, validation intent, and a length cap (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:67-85`). The cap algorithm omits `q`, and the closed slug vocabulary contradicts the routes promised for deferred kinds (R3-8).
8. **R2-8 — RESOLVED.** §5.2 retracts “warm by definition,” adds an explicit bounded `markWarm(sessionId)` operation at every named selection path, and requires the cold-deep-link test past the grace period (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:117-121`).
9. **R2-9 — RESOLVED.** §5.6 removes the zero-minimum rail, uses discrete rendered states, carries the optional server rail symbolically, defines pin-sensitive `C_min`, and requires measured transition constants (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:133-144`). The pin-state formula/history defects are new RULING-D composition issues (R3-4).
10. **R2-10 — PARTIAL.** §9 now covers Layers 2–8 and correctly separates design traceability from post-build workflow execution and route state from saved views (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:188-209`). It simultaneously claims the palette is an entry point to every deferral while admitting some deferred surfaces have no entry point, and advertises unregistered `k/{slug}` routes (R3-8, R3-9).
11. **R2-11 — RESOLVED.** §1.1 now says the grandfathered event names remain space-scoped, with `spaceId`, per-space sequence, and `(space_id,seq)` storage explicitly preserved (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:28-35`).
12. **R2-12 — RESOLVED.** Leaderboard and Channel View have separate §§5.4/5.5 headings, and project now has real §§7.1–7.5 anchors (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:127-143,153-183`).

## B. New v2.1 findings

### R3-1. [BLOCKER] The “existing registry” does not own persistent terminal lifetime; Content-tab unmount still disposes xterm

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:14,90,117-121`; `packages/ui/src/collab-v2/entity/EntityPanel.tsx:389-413`; `packages/ui/src/real/terminal/runtime.ts:32-37,110-141`; `packages/ui/src/real/SessionTerminal.tsx:138-163,198,381-408`; `STATE.md:128,134,151-158`.

V2.1 says persistent terminal instances already live outside React in the session-keyed registry and that a Content tab merely hosts/portals them. That is not the current machinery. The registry stores references to xterms created by the `SessionTerminal` React effect; it has no DOM host and does not own lifecycle. `EntityPanel` conditionally mounts only the active tab's Content renderer, and `SessionTerminal` cleanup unregisters the instance, closes its transport, clears offsets/sizing, and calls `term.dispose()`. A normal switch from Content to Discussion would therefore perform the exact disposal v2.1 forbids. A React portal alone does not solve this: if the portal-producing Content component unmounts, its child unmounts too; changing a portal target can also recreate its subtree.

**Concrete fix / ruling needed:** specify one app-lifetime `TerminalPool`/host manager that owns stable session-keyed `SessionTerminal` instances up to mounted-LRU `k`, including a hidden parking container. The work-session Content renderer must acquire/release a **host slot**, not own the terminal component. Tab/panel transitions rehome or park the same terminal DOM without firing its effect cleanup; only pool eviction performs the stamped full-dispose path. Name the StrictMode-safe lease API, ownership of sockets/resize observers, and the test proving component identity survives Content → Discussion → Content.

### R3-2. [BLOCKER] The terminal host/visibility predicate is neither unique nor complete

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:112-125`; `packages/ui/src/collab-v2/stores/nav.ts:112-147,182-216`; `packages/ui/src/collab-v2/shell/PanelStack.tsx:241-276`; `packages/ui/src/collab-v2/entity/EntityFullView.tsx:93-103,152-190`; `packages/ui/src/real/SessionTerminal.tsx:410-454`.

Three states break the predicate “visible iff top-of-stack or pinned, Content active”:

1. The inherited store de-duplicates only within `stack`, not across `stack` and `pinned`; a user can reopen an already pinned session, and a URL can place the same ID in both `p` and `pin`. Both frames render. One xterm DOM node cannot occupy two visible host slots, and two `SessionTerminal` instances would race in the session-keyed registry and on PTY resize.
2. §5.3 says a promoted work_session behaves identically, but Z4 `EntityFullView` is neither top-of-stack nor pinned. Under the stated predicate its Content terminal is hidden/inactive even though it is the foreground route.
3. Different work_sessions may legitimately be pinned side-by-side with Content active. All satisfy the predicate, so v2.1 implies all receive `active=true`; the current `active` flag owns cursor blink, focus, fit, and PTY resize. Visibility and keyboard-focus ownership cannot be the same boolean in a multi-terminal split.

**Concrete fix / ruling needed:** establish a single-host invariant per session across stack, pins, and Z4. Opening an already visible/pinned session must raise/focus its existing host; URL hydration must atomically de-duplicate cross-set IDs with ruled precedence. Define host visibility from actual rendered host leases, including Z4, and define a separate `activeSessionId`: multiple terminals may be visible and streaming, but only the last-interacted terminal blinks, focuses, and owns local fit/resize. Add duplicate-route, promote/collapse, and two-visible-session browser tests.

### R3-3. [MAJOR] The terminal Content renderer's product boundary and vertical layout are unspecified

**Contradicted/insufficient source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:90,117-122,133-147`; `packages/ui/src/real/workspace/CenterPane.tsx:88-228`; `packages/ui/src/real/SessionTerminal.tsx:92-116,200-251,373-379`; `STATE.md:128,134`.

The transplanted terminal experience is not only the xterm instance: `CenterPane` currently owns the terminal strip/chrome, status and session identity, terminal container, and prompt `Composer`. V2.1 removes CenterPane but never states which of those move into the work-session Content renderer. This conflicts with the retained terminal-chrome crop invariant and risks silently dropping the proven prompt-delivery surface. The layout contract defines horizontal panel floors only; an xterm inside `.cv2-panel__body` also needs a definite vertical flex chain/min-height and resize handoff, or `FitAddon` sees a zero rectangle and never becomes authoritative.

**Concrete fix / ruling needed:** publish the exact work-session Content composition: retained terminal chrome, xterm host slot, composer/input and exited/read-only fallback, with which existing component owns each. Define the panel body's height/overflow/min-height contract and require host-reparent, panel-resize, tab-reveal, and full-screen/Z4 fit measurements in the terminal browser acceptance.

### R3-4. [MAJOR] Width-driven pin demotion changes navigation state without a valid formula or history rule

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:113-115,133-144,193`; `packages/ui/src/collab-v2/stores/nav.ts:29,129-139`; `packages/ui/src/collab-v2/shell/router.ts:101-152`; inherited `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:175-184`.

`C_min=(n+1)·320+n·8` assumes a stack-top column always exists. After pinning a one-deep stack, the stack is empty and only `n` pinned columns are visible, so the extra 320px is a ghost base column that RULING D explicitly removed. V2.1 also omits the inherited absolute `MAX_PINNED=3`; at a wide center its equation admits four or more pins. Finally, viewport/resizer-driven “oldest pin → stack” mutates `p`/`pin`. The inherited router pushes history on every such store change, so resizing across a threshold can inject navigation entries and make Back walk layout measurements rather than user navigation. This is not a verbatim state machine, contrary to §9.

**Concrete fix / ruling needed:** derive `C_min` from actual visible column count (`pinned + hasStackTop`), retain or explicitly supersede the absolute three-pin cap, and define oldest/order/focus/undo behavior. Responsive normalization must use `history.replaceState` (and be debounced/idempotent), while explicit user pin/unpin remains push-history; say whether widening restores a demoted pin (recommended: no). Test resize and reload at each capacity.

### R3-5. [MAJOR] The project link cap is not concurrency-safe and has no migration rule for pre-existing over-cap projects

**Contradicted/insufficient source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:156-166,185-186`; current `db/migrations/007_rpc_catalog.sql:810-854`; `db/migrations/001_core_graph.sql:264-271`.

Validating `count < 16` before insert is raceable: two concurrent `projects.link` transactions can both observe 15 and commit 17 unless every link/update/unlink takes the same project-level lock before reading active links. Sorted space locks during `projects.update` do not serialize a concurrent link or unlink. The frozen contract previously had no cap, so an existing installation may already have more than 16 links; v2.1 does not say whether the additive migration fails, grandfathers it (destroying the bound), or requires remediation.

**Concrete fix / ruling needed:** lock the project resource row first in `link`, `unlink`, and `update`, count/snapshot active links under that lock, then acquire affected spaces in sorted UUID order. The migration must audit existing cardinality and either abort with an actionable list or require admin unlink remediation before enabling the new semantics; it may not silently grandfather an unbounded fan-out.

### R3-6. [MAJOR] The new explicit PR/commit `projectId` has no validity or repeat-link semantics

**Contradicted/insufficient source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:153-175,185-186`; frozen `packages/contract/src/contract.ts:489-496,682-685`; `docs/tm8-architecture/05-DECISIONS.md:16`.

The ID solves repository ambiguity, but v2.1 does not require it to be an **actively linked project in the artifact/task's space**. An unlinked or cross-space resource has no live target projection, so the promised same-transaction edge cannot be created. Re-linking the same repository artifact first with project A and later with project B is also unspecified: RULING C makes both roots legitimate, while the text alternates between “the edge” and zero-or-more managed edges.

**Concrete fix / ruling needed:** validate `projectId` against active `space_projects` plus the same-space projection mapping and reject otherwise with a named error. State that materialization is idempotent per `(artifact_entity_id, project_entity_id)` and rule whether multiple materialized project edges coexist (the model implies yes) or one replaces another. Define how an existing user-origin edge for the same pair is promoted/deduplicated without allowing origin spoofing.

### R3-7. [MAJOR] `project_links` deletion actions and deleted-endpoint read enforcement remain delegated, not specified

**Contradicted/insufficient source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:153-168,185-186`; current `db/migrations/001_core_graph.sql:264-271,329-350,762-773`; `db/migrations/008_rls_policies.sql:73-87`; `packages/server/src/facade/entity-read.ts:340-440`.

“FKs … with no cascade on unlink” is not an SQL referential action because unlink deletes `space_projects`, a table `project_links` is not said to reference. The actual parent deletions still need rules: deleting a space must not be blocked by its mapping row; hard deletion/cascade of its projection must not strand `project_entity_id`; deleting the project resource is currently out of API scope but still needs a database `RESTRICT`/cascade posture. Likewise, current edge RLS checks only space membership and relation reads do not filter deleted endpoints. Saying edges are hidden by “endpoint-visibility rules” without naming the facade/RLS predicate permits either tombstone-visible or omitted edges, the exact fork R2-4 asked to close.

**Concrete fix / ruling needed:** state every FK action explicitly (normally mapping rows cascade with space/projection destruction, project deletion restricted while mappings exist) and name the canonical live-endpoint predicate used by `edges.list`, `entities.connections`, collection edge filters, and counters. The dossier may contain SQL, but this spec must first rule tombstone-versus-omission consistently.

### R3-8. [MAJOR] The route cap is not total, and its closed slug vocabulary excludes routes §9 promises

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:55-85,207-209`; `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:188-205`.

The 2048-character policy drops `t`, then `pin`, then `p`, but never drops or rejects `q`—the parameter most likely to exceed the cap. A large versioned collection query can therefore leave the hash over 2048 with no ruled fallback. Separately, `origin` accepts only slugs in §2.1, yet §9 promises `k/{slug}` access for custom kinds, spells, skills, collections, files, and commits; none of those slugs is registered in §2.1. Route parsing, palette generation, and canonical companion derivation cannot agree on what those URLs mean.

**Concrete fix / ruling needed:** make overflow handling total: after dropping presentation state, either atomically drop `q` to the canonical query or reject navigation with a recoverable message; never emit an over-cap hash. Define a registry-backed slug namespace for all core/custom kinds, reserved-word and collision rules, and which deferred kinds have a real `k/` view now. Use that same registry for `origin`, palette rows, and canonical companions.

### R3-9. [MAJOR] “Palette is the interim entry point for every deferral” contradicts the honest no-entry-point dispositions

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:52-53,202,207-209`; binding RULING E at `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:15`.

RULING E requires the palette to be first-class; that is sound. The extra claim that it is an entry point for **every** §9 deferral is not. §9 correctly says saved views/axes UI has no v1 entry point, and a palette cannot open unbuilt Leaderboard, points, or Activity screens. Presenting those as navigable produces dead routes or dishonest placeholder behavior.

**Concrete fix / ruling needed:** keep the palette first-class, but scope it to implemented views and addressable entities. Deferred features may appear only as explicitly disabled “not available yet” discovery rows if desired; do not call those entry points. For every §9 row, distinguish entity reachability from feature/screen reachability.

### R3-10. [MINOR] The corrected ownership paragraph still attributes project version bumps to messages/reactions

**Contradicted source:** v2.1 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:179-180`; `db/migrations/001_core_graph.sql:849-867,1034-1049,1130-1188`.

Messages and reaction edges update project `activity_at` and counters, not the anchor project's content version. Project version changes would come from the materializer updating versioned detail/content and its snapshot trigger. The ownership narrowing is otherwise correct, but this sentence would give concurrency implementers the wrong expected-version behavior.

**Concrete fix:** say “trigger-owned: activity, counters, and version/snapshots when materialized detail changes; messages/reactions do not bump the anchor content version.”

## Round-3 ruling

V2.1 genuinely resolves seven Round-2 findings and narrows five, including the former repository-identity blocker. RULING D also removes the old base-layer contradiction, but the replacement is not yet implementable without inventing terminal ownership and host arbitration: the current registry does not preserve an xterm across Content-tab unmount, and the proposed predicate cannot handle duplicate stack/pin hosts, Z4, or multiple visible sessions with one focus owner. Those are silent-disposal, duplicate-socket, resize, and replay-corruption risks at the stamped terminal seam, so the verdict remains **NO-GO (2 blockers)**. Resolve R3-1/R3-2 and close the seven majors in the dossier/reference packet before Vega adoption.

# Round 4

**Review date:** 2026-07-26  
**Reviewed revision:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.2  
**Round-3 disposition:** **7 RESOLVED · 3 PARTIAL · 0 UNRESOLVED**  
**New findings:** **0 BLOCKER · 6 MAJOR · 1 MINOR**  
**Verdict:** **CONDITIONAL GO — 0 blockers.**

RULINGS A–E remain accepted as binding premises. This round does not reopen the retired Workspace pixel oracle, Phase-1 locality, configured-root project identity, terminal-as-Content, or Workspace's caret/palette status.

## A. Verification of R3-1–R3-10

1. **R3-1 — RESOLVED.** §5.2a specifies the previously missing app-lifetime `TerminalPool`, tokened host leases, DOM reparenting to a retained parking node, one full-dispose point, StrictMode stale-release protection, and the identity-survives-tab-switch test (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:125-134`); pool-capacity arbitration is a fresh boundary defect (R4-1), not a return to React-owned lifetime.
2. **R3-2 — RESOLVED.** §5.2c makes stack, pins, and Z4 one host-arbitration domain, deduplicates navigation/hydration, derives visibility from the rendered Content lease, and separates multi-visible streaming from the single `activeSessionId` focus/fit owner (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:140-146`).
3. **R3-3 — RESOLVED.** §5.2b explicitly retains terminal chrome, the leased host, Composer, and exited fallback, supplies a vertical flex/min-height/overflow contract, and names all four fit-measure legs as browser acceptance (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:136-138`).
4. **R3-4 — PARTIAL.** V now counts real columns, `MAX_PINNED=3` is restored, oldest/focus/no-auto-restore behavior is ruled, and responsive changes use debounced `replaceState` (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:121-122,84-91`), but the same equation produces `C_min=-8px` for the allowed empty state and one demotion need not reduce V (R4-2).
5. **R3-5 — PARTIAL.** §7.2 specifies project-row serialization for link/unlink/update, ordered Space locks, all-or-nothing behavior, and a non-destructive frozen disposition for over-cap data (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:180-190`), but `link_frozen` and its two “named errors” are not representable in the frozen resource/error schemas as written (R4-3).
6. **R3-6 — RESOLVED.** §7.3 validates both active linkage and a live same-space projection before artifact creation, rules per-pair idempotency and legitimate coexisting project edges, and defines server-only in-place origin promotion (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:192-197`); the absence of an inverse correction operation is a new lifecycle problem (R4-4).
7. **R3-7 — RESOLVED.** §7.1 states all three FK actions and makes `space_projects` the active authority, while §7.3 fixes one live-both-endpoints omission predicate across every named reader and counters (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:177-178,199`); delete-time counter maintenance is a fresh execution hole (R4-5).
8. **R3-8 — PARTIAL.** §2.2 makes overflow total by atomically dropping `q`, and §2.1 replaces the closed vocabulary with a registry plus custom/reserved-word rules (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:55-71,84-91`), but the purportedly total canonical-companion registry still has no row or strategy for the frozen core kinds `channel` and `message` (R4-6).
9. **R3-9 — RESOLVED.** The specification limits the palette to implemented views and addressable entities, and §9 distinguishes entity reachability from feature reachability instead of presenting deferred screens as working destinations (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:52-53,212-234`).
10. **R3-10 — RESOLVED.** §7.4 specifies that messages/reactions change activity and counters but do not bump the projection anchor's content version (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:203-204`).

## B. New v2.2 findings

### R4-1. [MAJOR] TerminalPool has no safe capacity rule when all mounted entries are leased

**Insufficient source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:121-145`; `STATE.md:134,151-155`.

The center can render four session terminals simultaneously (three pins plus a stack top), while mounted-LRU `k` remains dialable. The pool text never requires `k` to cover the maximum simultaneous leases, excludes leased entries from eviction, or says what `acquireHost` does when every mounted entry is leased. Even with the initial `k=4`, replacing a stack top can transiently acquire the fifth terminal before React releases the old lease. Evicting a visible lease would violate both single-host identity and “disposal only at LRU eviction”; refusing the acquire without a ruled UI path violates navigation. The separate `activeSessionId` also has no deterministic successor/null transition when its lease is released or its Content tab hides.

**Concrete fix / ruling needed:** make leased entries eviction-ineligible; require `k ≥` maximum simultaneous terminal leases or make pin/admission capacity respect `k`; define an atomic release/acquire handoff when a visible slot changes; and transfer activation to the most-recently-interacted remaining visible session (or `null`). Test four visible work sessions, a fifth open/replace, a lowered `k`, and hiding/releasing the active lease.

### R4-2. [MAJOR] The corrected column equation is invalid at V=0, and one-step pin demotion may not converge

**Contradicted source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:121-122,157-168`; durable flex/grid floor rule at `STATE.md:147-149`.

The state machine expressly permits `stack ∪ pinned = ∅`, so `V=0`; §5.6 then computes `C_min = 0·320 + (0−1)·8 = -8px`. A negative length makes the intended `minmax(C_min,1fr)` floor invalid rather than preserving a usable empty center. There is a second convergence bug: with three pins and an empty stack, demoting one pin produces two pins plus a non-empty stack, leaving `V=3`; a width that fits only two columns still violates the equation after the single prescribed demotion.

**Concrete fix / ruling needed:** define a clamped floor, for example `C_min = max(320, V·320 + max(0,V−1)·8)`, and run oldest-pin demotion repeatedly until both width and absolute-cap predicates hold. Add real-browser cases for empty center and pinned-only `3→2→1` normalization, including reload and one debounced canonical `replaceState`.

### R4-3. [MAJOR] `link_frozen` and the two named failures do not yet have a valid frozen-contract representation

**Contradicted/insufficient source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:190,195,209-210`; frozen `packages/contract/src/contract.ts:320-335,651-660`; `packages/contract/src/schemas.ts:807-816,1055-1071`.

The spec names `project_over_cap` and `project_not_linked` as errors, but neither is in the closed `CommandErrorCode`/Zod union or its HTTP/retry maps. It also says a project is marked `link_frozen`, while `ProjectResource` and its strict schema expose no such state. “The dossier carries exact diffs” does not rule whether these names are new wire codes (a frozen-catalog amendment) or stable `details.reason` values under existing codes. Nor does it say how Settings discovers the frozen state/actionable projects before a rejected write, or when the flag clears after unlinking to 16.

**Concrete fix / ruling needed:** choose one representation now. Either amend `CommandErrorCode`, schema, status, and retryability for both codes, or use existing codes such as `limit_exceeded`/`invariant_violation` with a typed, stable `details.reason`. Persist and expose `linkFrozen` plus active count/remediation data (or define an equally queryable admin diagnostic), specify automatic clearing under the project lock at `≤16`, and enumerate those exact contract/database/UI changes in §8.

### R4-4. [MAJOR] A mistaken materialized PR/commit project association has no correction path

**Insufficient source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:192-197,209-210`; `docs/tm8-architecture/05-DECISIONS.md:16`.

`linkPr`/`linkCommit` can now create zero-or-more durable project associations from a caller-supplied/CLI-filled `projectId`; promotion converts a matching user edge into a materialized edge, and client deletion of that row is then forbidden. No authoritative artifact field or inverse command is specified. A typo, stale CLI context, or later correction therefore leaves an undeletable association forever; unlinking the project from the space only hides the projection and is far broader than correcting one artifact.

**Concrete fix / ruling needed:** add an authorized, idempotent inverse/correction operation for artifact↔project association (or store an authoritative association record whose materializer may remove the edge). Rule its transaction, event, origin transition, undo/audit, and behavior when a promoted user edge is corrected. Do not make a command-created relationship immutable without a repair path.

### R4-5. [MAJOR] Live-endpoint omission cannot keep reaction counters correct on entity deletion

**Contradicted source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:199,209-210`; `db/migrations/001_core_graph.sql:849-893`; `db/migrations/007_rpc_catalog.sql:1417-1505`.

V2.2 requires counters to exclude edges whose source or destination is deleted, but only promises recomputation “on restore.” The current counter trigger runs on edge INSERT/UPDATE/DELETE; `delete_entity` and `restore_entity` change only `entities.deleted_at`, so deleting a member/source with live reaction edges leaves every live destination's cached counts overstated. A subtree delete multiplies the drift. Restoring later cannot repair the period in which the counter was already contractually wrong, and the spec does not define event/cache invalidation for edges that vanish or reappear without edge-row mutations.

**Concrete fix / ruling needed:** in the same transaction as both delete **and** restore, recompute affected live destinations (including the full subtree's incident reaction edges), with bounded/indexed SQL and named lock order. Define how edge/connection caches learn endpoint-visibility changes—derived invalidation from the entity event or explicit projection events—and add delete/restore counter and read conformance tests.

### R4-6. [MAJOR] The slug registry is still not total over the frozen core-kind set

**Contradicted source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:55-71,73-92`; frozen `packages/contract/src/contract.ts:28-37`; `packages/contract/src/schemas.ts:51-63`.

§2.1 says one registry drives routes, `origin`, palette, and canonical companions, but its initial rows omit the frozen core kinds `channel` and `message`. Reserving `channel` and giving channels a special route does not tell the registry how to build that route; a message is harder still because its canonical companion is normally its containing channel/thread, not an invented `k/messages` collection. Therefore `e/{messageId}` without `origin` has no total canonical-reload rule, and registry consumers can disagree despite the “one source” claim.

**Concrete fix / ruling needed:** register every core kind with a route-builder/companion strategy, not merely a slug. Give `channel` its special `channel/{id}` builder and define how a `message` resolves its channel/thread anchor (including deleted/missing parents); retain the generic `k/{slug}` strategy for eligible core/custom kinds. Add an exhaustiveness check against `CoreEntityKindSchema`.

### R4-7. [MINOR] URL overflow silently drops panels while only dropped filters get a notice

**Insufficient source:** v2.2 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:84-91`; inherited URL-addressability contract at `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:188-205`.

The total cap algorithm is now safe, but it gives a visible notice only when `q` is dropped. A long stack can lose `t`, pins, and finally panels through `pin`/`p` drops while navigation appears to have preserved the user's workspace; reload/Back then reveals the loss. Atomicity prevents a malformed URL, not silent state loss.

**Concrete fix:** emit one generalized “some panel/layout state was not carried” notice whenever `t`, `pin`, or `p` is dropped, identifying the discarded class without exposing raw IDs; cover each drop tier in codec/history tests.

## Round-4 ruling

V2.2 genuinely removes both Round-3 blockers. The TerminalPool/lease model is now a coherent way to preserve xterm identity across Content unmounts, and §5.2c correctly separates host visibility from single-owner activation across stack, pins, and Z4. The design can therefore advance as **CONDITIONAL GO (0 blockers)**, but it is not dossier-ready unchanged: close the pool-capacity and layout-normalization rules in the design, then make the amendment dossier explicitly settle the frozen error/state representation, association correction, delete-time counter maintenance, and total core-kind routing. The Round-3 result is **7 resolved, 3 partial, 0 unresolved**; this round adds **6 majors and 1 minor**.

# Round 5

**Review date:** 2026-07-26  
**Reviewed revision:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.3  
**Round-4 disposition:** **7 RESOLVED · 0 PARTIAL · 0 UNRESOLVED**  
**Carried Round-3 partials:** **3 RESOLVED · 0 PARTIAL · 0 UNRESOLVED**  
**New findings:** **0 BLOCKER · 7 MAJOR · 1 MINOR**  
**Verdict:** **CONDITIONAL GO — 0 blockers.**

RULINGS A–H are accepted as binding premises. This review does not contest sharing entities into live sessions, terminal-first keyboard ownership, or a per-space configurable menu; it tests whether §§5.7, 5.8, and 2.3 specify those rulings without creating new contract or state-machine forks.

## A. Verification of R4-1–R4-7

1. **R4-1 — RESOLVED.** §5.2a specifies leased entries as eviction-ineligible, clamps `k ≥ MAX_PINNED+2`, bounds pin admission, permits the replace transient, and names the four-visible/fifth-open/runtime-lowering tests; §5.2c specifies deterministic activation transfer to the most-recent visible session or `null` (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:132-149`).
2. **R4-2 — RESOLVED.** The clamped equation is valid at V=0, normalization explicitly loops until both predicates hold, and one debounced `replaceState` plus empty/pinned-only 3→2→1 browser cases are required (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:126-130,160-166`).
3. **R4-3 — RESOLVED.** §7.2 selects existing error codes with stable reason values, adds optional `linkFrozen`/`activeLinkCount` to the strict resource amendment, exposes remediation state before rejection, and auto-clears under the project lock at ≤16 (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:199-211,230-231`).
4. **R4-4 — RESOLVED.** §7.3 adds an idempotent inverse association command, fixes its authorization/transaction/activity/event behavior, deletes materialized-only edges, and demotes promoted user edges so the user's assertion survives (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:213-218`); the dossier must still name the binding and DTO, but the previously absent lifecycle is ruled.
5. **R4-5 — RESOLVED.** The specification requires both delete and restore to recompute all affected live counterparts in-transaction with indexed access and sorted locks, and requires existing entity events to invalidate neighbor caches; source and subtree conformance cases are named (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:220-220`).
6. **R4-6 — RESOLVED.** The specification makes the registry exhaustive over core kinds and defines collection/special/anchored strategies, including channel routing and the missing/deleted message-parent fallback (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:58-71,89`).
7. **R4-7 — RESOLVED.** Every overflow tier (`t`, `pin`, `p`, `q`) now emits one class-specific generalized notice and has a codec/history test (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:84-91`).

## B. Closure of the carried Round-3 partials

1. **R3-4 — RESOLVED.** R4-2 closes the last V=0 and non-converging-demotion defects; the real-column capacity, absolute cap, history rule, and normalization loop now form one total rule (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:126-130,160-166`).
2. **R3-5 — RESOLVED.** R4-3 closes the representation gap left after the race-safe lock/cap fix: over-cap state and both refusal reasons now have a chosen resource/error encoding and deterministic clearing rule (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:199-211`).
3. **R3-8 — RESOLVED.** R4-6 closes the final registry hole for `channel`/`message`; together with the already-total cap algorithm, route parsing and canonical companions are now total over the frozen core-kind set (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:58-93`).

## C. New v2.3 findings

### R5-1. [MAJOR] Share-into-session has no gesture-level idempotency or partial-failure state machine

**Contradicted/insufficient source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:168-176`; `docs/tm8-architecture/01-LAWS.md:82-84`; `packages/ui/src/real/workspace/Composer.tsx:82-102`; `packages/execution/src/spawn/SpawnService.ts:249-297`.

One drop is currently specified as three independent catalog calls: `execution.prompt`, `edges.create`, and `messages.post`. No stable handoff ID binds them, so a lost response or retry cannot distinguish “retry this gesture” from the intentionally supported “drop it again.” The current prompt seam makes this concrete: `SpawnService.prompt` asks the command ledger first, but even a ledger replay proceeds to `pty.deliverPrompt`, so replaying the same `clientMutationId` can inject the envelope twice. After delivery, edge success followed by message failure leaves a half-record; retry can then redeliver, overwrite the singleton edge, or append an extra message. This violates T-L12's universal-idempotency promise and gives no truthful UI outcome beyond the simpler composer's two-write model.

**Concrete fix / ruling needed:** define one server-owned handoff saga/command with a stable `handoffId` and persisted states such as `prepared → delivered → recorded`. A retry after `delivered` must resume graph recording without re-injecting PTY bytes; the edge and anchored message must commit in one graph transaction. Specify the returned outcomes (`undelivered`, `delivered_unrecorded`, `delivered_recorded`), recovery after crash/timeout, per-intentional-repeat IDs, event reconciliation, and conformance for a lost response at every boundary. This is more than “one edge-registry row” in §5.7/§8.

### R5-2. [MAJOR] “Any entity” has no total, versioned, security-aware projection contract

**Insufficient source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:168-176,230-231`; `docs/tm8-architecture/01-LAWS.md:41-48`; frozen kinds at `packages/contract/src/contract.ts:28-37`; threat posture at `docs/tm8-architecture/10-SECURITY-MODEL.md:9-16,36-42`.

The feature promises any core/custom entity but defines examples only for doc/task/PR. “Same shape as the bridge pull projection” is not a DTO: bridge pull is a version-pinned build artifact of a neighborhood, whereas this feature needs a bounded inline string for messages, files, channels, sessions, members, projects, collections, and arbitrary `c:*` fields. `~32KB` does not say bytes versus characters, whether the wrapper counts, how UTF-8/truncation works, which version was serialized, how file/blob content is represented, or what generic fallback guarantees. Calling a flat prompt prefix “context, not command” also does not create an instruction boundary; shared entity text is explicitly a prompt-injection input to an arbitrary-code agent, and the ID-fetch claim is false unless the session identity can read the remainder.

**Concrete fix / ruling needed:** add a server-owned share-projection registry with an exhaustive core-kind test and a generic custom-kind fallback. Return a typed envelope carrying `entityId`, kind, content version, source space, projection body, exact UTF-8 byte length, truncation/omission metadata, and an authorization-checked fetch affordance. Freeze an exact byte cap including wrapper overhead; truncate only at valid field/UTF-8 boundaries. Define file/blob behavior, reauthorization of source and live target, and explicit untrusted-content delimiters/agent-facing provenance while retaining S13's server-side permission enforcement. Prototype measurement may choose the number, but the dossier cannot freeze an undefined serializer.

### R5-3. [MAJOR] Reusing ordinary `edges.create` makes the handoff record mutable and gives repeat shares a destructive undo

**Contradicted source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:170-176,242`; inherited one-command/undo rule at `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:233-250`; current `db/migrations/007_rpc_catalog.sql:1290-1373`; `packages/ui/src/collab-v2/interactions/execute.ts:1-15,62-115`.

The existing grammar guarantees one `placements.apply` command and an undo token per drop. RULING F's delivery is irreversible, yet §9 says the grammar is “preserved + extended” without ruling row 8's undo semantics. Direct `edges.create` is also the wrong authority for an audit-like record: `write_edge` upserts the singleton pair and always issues an `edges.delete` undo token; any ordinary space member may patch/delete it. On a repeat share, undoing the newest drop can delete the edge that also records all earlier shares, while the agent has already received every projection and the messages remain. The graph then states the opposite of reality.

**Concrete fix / ruling needed:** make `shared_into` server-created with an origin/authority guard and create it inside the R5-1 handoff recorder, not through public raw `edges.create`. Repeats should leave the existence edge untouched and append one message correlated to each `handoffId`. Explicitly supersede the inherited undo guarantee for irreversible PTY delivery, or define a clearly labelled **graph-record-only** compensation that cannot claim to retract agent context and cannot erase earlier handoffs.

### R5-4. [MAJOR] The keyboard table has no ordered scope precedence and is unsafe in text inputs/modals

**Insufficient/contradicted source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:178-187,245-246`; current `packages/ui/src/collab-v2/shell/keyboard.ts:21-44,78-145`; `packages/ui/src/real/workspace/Composer.tsx:174-208`.

The hard terminal rule is clear, but every other overlap is open. The table does not say that plain `c`, `g`, `j/k`, Enter, arrows, Esc, or panel shortcuts are suppressed in inputs, textareas, contenteditable fields, inline editors, and the Composer; nor does it establish modal/palette/drop-menu precedence, so one Esc can close a modal and pop the underlying stack depending on propagation order. The new `g s = Sessions` also conflicts with the inherited `g s = Settings`, while inherited jumps for Home, Team, Tracking, Graph, Inbox, and Settings disappear without an explicit retirement. A “specified contract” cannot leave those choices to listener order.

**Concrete fix / ruling needed:** publish one priority chain, for example browser/OS → active modal/menu → focused terminal → text-entry control → focused list/panel → global chrome. For every row, state `preventDefault`/propagation behavior and the allowed exceptions (for example whether ⌘K works in Composer). Enumerate the complete `g …` map, explicitly retire displaced inherited chords, and define shortcuts against stable registry/view refs so menu configuration cannot change their meaning. Test overlapping modal, Composer, inline-edit, list, panel, and terminal scopes.

### R5-5. [MAJOR] The single terminal blur chord is not yet an escape contract

**Insufficient source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:185-187`; terminal interception seam at `packages/ui/src/real/SessionTerminal.tsx:294-311`; inherited full-keyboard-path acceptance at `docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md:254-265`.

“Ctrl+backtick exits to chrome” does not name the focus destination, interception layer, physical/semantic key match, or discoverability. The current xterm custom-key handler forwards this chord to the PTY. A layout/IME where backtick is a dead or shifted key can therefore leave a keyboard-only user trapped, and an implementation that merely listens on `window` may both blur and inject the control sequence before bubbling. After TerminalPool reparenting, a stale focus target is another possible failure.

**Concrete fix / ruling needed:** intercept the chord inside xterm's `attachCustomKeyEventHandler` before `onData`, consume both default and propagation, and focus one named live chrome element (for example the owning panel's Content tab or header) supplied by the current host lease. Specify whether matching uses `event.code === 'Backquote'` plus Ctrl and how non-US/dead-key layouts are handled without changing the binding. Make the chord visibly discoverable and exposed via `aria-describedby`; test zero PTY bytes, exact focus landing, read-only/live terminals, IME/layout variants, and reparent/park transitions.

### R5-6. [MAJOR] Menu-as-config has no wire schema, concurrency rule, bootstrap/backfill, or invalidation event

**Contradicted/insufficient source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:95-100,230-231`; T-L12 at `docs/tm8-architecture/01-LAWS.md:82-84`; frozen `SpaceNavigation`/`SpaceSettings` at `packages/contract/src/contract.ts:531-590`; frozen event union at `packages/contract/src/contract.ts:265-280`; current hardcoded rail at `packages/ui/src/collab-v2/shell/LeftRail.tsx:19-48,84-97`.

Deferring “space detail field vs settings op” defers more than storage. No strict `MenuConfig` DTO defines stable group/item IDs, labels/icons, duplicate/required-item rules, bounds, schema version, or validation against the space's registry. No read response carries it; no admin command has revision/expected-version semantics; and the event union has no space/menu update capable of making every member converge after an edit. “Shipped default config” also does not state whether space creation materializes it, how existing spaces are backfilled, or what the UI renders during missing/corrupt/unsupported-version states without falling back to another hardcoded menu.

**Concrete fix / ruling needed:** freeze the `MenuConfig` schema and limits in this design, then make §8 choose and enumerate the read DTO, admin write command, authorization, revision/conflict behavior, and full-payload `WorkspaceEvent` (or another canonical event-union amendment) used for live invalidation. Materialize a versioned default on new-space creation, backfill every existing space, and define fail-closed normalization that preserves a registry-marked required Settings ref. Add two-client convergence, concurrent reorder, corrupt-row, unknown-ref, and upgrade/backfill tests.

### R5-7. [MAJOR] Menu kind refs contradict the route strategies they are supposed to consume

**Contradicted source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:58-71,95-100`.

§2.3 defines a kind ref as any §2.1 registry row rendered as a pre-filtered Entity View and says an omitted kind remains reachable through palette + `k/{slug}`. But §2.1 correctly rules that `channel` is special and `message` has no slug or `k/` view at all. An admin can therefore configure a registry-valid kind ref that the promised renderer cannot open; the reachability sentence is false for the two strategies R4-6 just fixed.

**Concrete fix / ruling needed:** make menu resolution strategy-aware. Either allow kind refs only for `collection` rows and model “Channels” as a separate registered view ref while disallowing `message`, or define rendering for each strategy. Replace “palette + `k/{slug}`” with “palette + its registry route strategy,” and validate/save normalized refs server-side so no client can persist a dead item.

### R5-8. [MINOR] Menu configuration is misclassified as an operational side table

**Contradicted source:** v2.3 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:98`; `docs/tm8-architecture/01-LAWS.md:23-27`.

T-L3 distinguishes **config** side tables (axes and registries) from **operational** tables (outbox, event buffer, invites, manifests). A durable admin-edited menu definition is config. Calling it operational invites the wrong retention/export/backup lifecycle even though both are legitimate side tables.

**Concrete fix:** call it a config side table and include it in space export/import, backup, default/backfill, and settings-authorization acceptance.

## Round-5 ruling

V2.3 closes every Round-4 finding and all three carried Round-3 partials; the project/link, route, layout, counter, and terminal-capacity repairs are now coherent enough to leave the adversarial ledger. The three new user rulings are also product-coherent, so none must be overturned. Their specifications are not yet dossier-ready, however: share-into-session needs a retry-safe server saga and protected record authority; the keyboard law needs complete focus-scope and escape mechanics; and menu-as-config needs an actual versioned contract plus strategy-aware validation and live convergence. The verdict remains **CONDITIONAL GO (0 blockers)** with **7 new majors and 1 minor**. Adoption is safe after those mechanics are ruled in the spec/dossier; implementation should not infer them from the existing three-call composer, window-listener order, or hardcoded rail.

# Round 6

**Review date:** 2026-07-26  
**Reviewed revision:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.4  
**Round-5 disposition:** **5 RESOLVED · 3 PARTIAL · 0 UNRESOLVED**  
**New findings:** **1 BLOCKER · 3 MAJOR · 1 MINOR**  
**Verdict:** **NO-GO — 1 blocker.**

RULINGS A–H remain binding and are not relitigated. V2.4 successfully closes most of the F/G/H specification gaps. The remaining blocker is narrower: the text promises exactly-once delivery across crash recovery without specifying a receiver-side deduplication mechanism capable of making an irreversible PTY write and a database state transition one logical effect.

## A. Verification of R5-1–R5-8

1. **R5-1 — PARTIAL.** §5.7 genuinely replaces the three client calls with one server command, binds intentional repeats to new `handoffId`s, makes edge+message one transaction, names recovery outcomes, and requires boundary tests (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:182-188,194`); the claimed exactly-once `prepared→delivered` transition still has an unclosed crash window (R6-1), and the handoff key is not bound to immutable request arguments (same finding).
2. **R5-2 — RESOLVED.** §5.7 specifies Server-owned projection rendering, a generic custom/core fallback plus exhaustiveness test, a typed/versioned envelope and exact wrapper-inclusive UTF-8 cap, safe truncation and blob references, labelled untrusted provenance, and an authorization-gated remainder-fetch affordance (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:184,190,194`).
3. **R5-3 — PARTIAL.** Recorder-only origin guards, repeat semantics, and explicit supersession of row-8 undo are all real (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:192,194,260-272`), but the promised per-handoff “withdrawal annotation” has no storage/event/read representation and cannot safely live on the singleton edge (R6-3).
4. **R5-4 — RESOLVED.** §5.8 specifies an ordered six-layer dispatcher, consumption of handled events, suppression of plain keys in every named text-entry control, one topmost Esc owner, the complete `g` map and explicit retirements, and stable-ref rather than menu-position shortcut bindings (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:196-213`).
5. **R5-5 — RESOLVED.** The specification requires the blur chord to be intercepted inside xterm before `onData`, matched physically, fully consumed, guaranteed to emit zero PTY bytes, paired with a visible/ARIA affordance, and focused through the current host lease onto one named header; live/exited/layout/reparent tests are explicit (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:215-217`).
6. **R5-6 — PARTIAL.** §2.3 now supplies bounded config structure, revisioned admin writes, full-payload convergence, default materialization/backfill, fail-closed fallback, and the requested tests (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:95-110,260-261`), but the allegedly frozen DTO still contains an open ellipsis/undefined view registry and the revision conflict/event wire shapes remain unnamed (R6-4).
7. **R5-7 — RESOLVED.** Kind refs are limited to collection strategies, Channels is a registered view ref, message is excluded, reachability delegates to each registry strategy, and server normalization prevents clients from persisting dead refs (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:103-110`).
8. **R5-8 — RESOLVED.** Menu storage is correctly classified as config and explicitly enters export/import, backup, backfill, and settings-authorization acceptance (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:95-109,260-261`).

## B. New v2.4 findings

### R6-1. [BLOCKER] A three-state database saga cannot by itself make raw PTY delivery exactly once

**Contradicted/insufficient source:** v2.4 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:182-188,194,260-261`; T-L12 at `docs/tm8-architecture/01-LAWS.md:82-84`; current delivery seam at `packages/execution/src/pty/PtyHostService.ts:71-91,440-503,515-570`; `packages/execution/src/spawn/SpawnService.ts:249-297`.

There is no atomic commit spanning Postgres and `entry.proc.write()`. If the server marks the saga `delivered` **before** writing the PTY and crashes between them, same-ID recovery skips bytes the agent never received. If it writes first and marks `delivered` afterward, a crash between those actions leaves `prepared`; recovery re-injects bytes the agent may already be acting on. The current PTY queue cannot close this gap: its delivery entries contain only content/mode/byte count, live in memory, are removed before the write, and have no `handoffId` receipt or dedup journal. Lost HTTP-response tests do not prove process-crash safety. The phrase “persisted saga” therefore does not establish the exactly-once property v2.4 makes load-bearing.

The idempotency key is also underspecified: the operation already inherits `clientMutationId`, while §5.7 introduces `handoffId` as “the idempotency key” without saying whether they are identical or how a reused ID with different source/session/version/payload is rejected. A collision must never replay one handoff's outcome for another request.

**Concrete fix / ruling needed:** choose an implementable delivery guarantee. For true exactly-once, make the PTY ingress accept `(sessionEpoch, handoffId, bytes)`, persist/deduplicate the receipt at the receiver boundary, and acknowledge the same receipt on replay before the saga advances; bind the ID to an immutable hash of caller, source ID/version, target session/epoch, and rendered-envelope hash, with mismatch → conflict. If the raw PTY cannot participate, use an honest at-most-once protocol: persist `dispatching`, never auto-reinject after an ambiguous crash, return `delivery_unknown`, and require an explicit new handoff to try again. Add kill/restart tests immediately before/after PTY write and immediately before/after the delivered-state commit—not only lost responses. Until one of those protocols is ruled, the central R5-1 promise is not implementable.

### R6-2. [MAJOR] Prepare does not guarantee that a delivered handoff remains graph-recordable

**Insufficient source:** v2.4 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:180-190`; same-space/live-edge enforcement at `db/migrations/007_rpc_catalog.sql:1290-1315`; edge schema at `db/migrations/001_core_graph.sql:762-773`.

Prepare checks that the caller can read the source and prompt the live target, but it never explicitly requires source and session to inhabit the same space. A caller can be authorized in two spaces; delivery can then succeed while the promised `shared_into` edge is structurally illegal. Even for a same-space request, source deletion or an authorization change between prepare and record creates a fork: ordinary graph RPCs require live/readable endpoints, but the agent already received the prepared snapshot. Retrying the handoff cannot repair a permanent authorization or tombstone failure, so `delivered_unrecorded` may never converge to `recorded` despite the stated recovery rule.

**Concrete fix / ruling needed:** require and persist `source.spaceId === session.spaceId` at prepare before any PTY effect. Rule that the recorded audit is authorized by the immutable prepared snapshot: later permission changes do not cancel it, and the recorder may reference a physically present soft-deleted source (the normal live-endpoint read predicate can hide/show the edge). If hard deletion can occur, persist enough source identity/title/version in the handoff audit/message to finish without the source row. Add races for cross-space input, delete/restore, permission loss, and session exit at every saga boundary, with a terminal state for any genuinely non-recoverable record failure.

### R6-3. [MAJOR] “Graph-record-only withdrawal” has no per-handoff data model

**Insufficient source:** v2.4 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:186,188,192,260-272`; singleton edge identity at `db/migrations/001_core_graph.sql:762-773`; frozen message shape at `packages/contract/src/contract.ts:223-226,459-466` and `packages/contract/src/schemas.ts:475-487,699-712`.

One `shared_into` edge represents the entity/session pair while each repeat has its own saga row and message. A withdrawal by one sharing author therefore cannot be represented on the edge without affecting earlier/later handoffs. The existing message DTO has only body/mentions/attachments and no withdrawal metadata, and the declared saga states end at `recorded`. “Removal that annotates the record” is internally ambiguous: removing the edge erases pair-level history; deleting/editing the message is not an immutable annotation; changing only an unseen saga row does not tell Connections or Discussion what happened.

**Concrete fix / ruling needed:** define withdrawal as a per-`handoffId` state transition, for example `recorded → withdrawn`, with `withdrawnAt`, `withdrawnBy`, optional reason, authorization, idempotency, and a full typed event. Keep the existence edge immutable because delivery historically occurred; render withdrawn state on the correlated Discussion record and Connections history without deleting the original envelope/provenance. Enumerate the read DTO/storage and tests in §8, including two authors sharing the same entity/session and withdrawing only one handoff.

### R6-4. [MAJOR] The “frozen” MenuConfig still leaves its namespace and wire conflicts open

**Contradicted/insufficient source:** v2.4 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:98-110,260-261`; current error/event seams at `packages/contract/src/contract.ts:257-280,339-365`; `packages/contract/src/schemas.ts:1055-1071`.

`ViewRef ∈ … settings · …` is not a frozen union: no view-registry table lists the complete initial refs, route builders, menu eligibility, required flag, labels/icons, namespace/collision rules, or behavior for registered-but-unimplemented views. `stable-slug` has no syntax/length definition, and “no duplicate refs” is not scoped per group versus the whole config. The write's “conflict error” is likewise not a wire rule: existing `version_conflict` is modeled around an `EntityDetail current`, while MenuConfig is not an entity. The “menu-updated WorkspaceEvent” lacks an exact discriminant and payload member, and corrupt-row fallback does not say which revision a subsequent repair write must submit.

**Concrete fix / ruling needed:** freeze a view registry and exact `ViewRef` union/extension namespace, group-ID grammar, global/per-group uniqueness, and menu-eligibility validation. Name the read field, update binding/DTO, conflict code plus typed current-menu details, exact event variant (for example `{type:'menu.updated', menu: MenuConfig, clientMutationId}`), and fallback repair revision. If `version_conflict` is reused, amend its non-entity current-resource shape explicitly; otherwise choose an existing code with a stable reason. Conformance must round-trip the strict schemas, not only the prose pseudocode.

### R6-5. [MINOR] The modifier notation conflicts with the browser-first priority rule on non-Mac/platform-reserved chords

**Insufficient source:** v2.4 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:198-215`; tm8's web-only posture at `docs/tm8-architecture/04-EXECUTION-TRANSPLANT.md:3`.

The table uses `⌘` for palette, Settings, rail toggle, pin, and primary actions but never defines the Windows/Linux equivalent, while layer 1 says browser/OS shortcuts are never intercepted. In a web app, a platform/browser-reserved chord may never reach layer 6, so “Settings = ⌘, only” is not a portable contract even though Settings remains pointer/palette reachable.

**Concrete fix:** define a platform `Mod` abstraction (`Meta` on macOS, `Ctrl` elsewhere), enumerate browser-reserved collisions for the supported browser matrix, and give every advertised shortcut a tested app-receivable binding or explicitly label it platform-specific. Keep the terminal blur chord as the separately ruled physical Ctrl+Backquote exception.

## Round-6 ruling

V2.4 resolves five R5 findings and materially narrows the other three. The projection registry, keyboard priority/escape model, strategy-aware menu refs, and config-table lifecycle are now concrete. The review cannot close with GO, however, because the handoff saga asserts an exactly-once side effect that no stated mechanism can provide across the PTY-write/database-commit crash window. This is not a request to undo RULING F; it is a requirement to choose a truthful delivery protocol beneath it. The final verdict is **NO-GO (1 blocker)**, with **3 additional majors and 1 minor**. Close R6-1, then specify same-space/post-prepare recordability, per-handoff withdrawal state, and the exact menu namespace/wire shapes before Vega adoption.

# Round 7

**Review date:** 2026-07-26  
**Reviewed revision:** v2.5  
**Round-6 disposition result:** **0 RESOLVED · 5 PARTIAL · 0 UNRESOLVED**  
**New finding count:** **0 BLOCKER · 7 MAJOR · 1 MINOR**  
**Verdict:** **CONDITIONAL GO (0 blockers)**

The v2.5 retraction closes the round-6 blocker: an at-most-once PTY protocol with an explicit ambiguous outcome is implementable and complies with the honest-mechanics law. It does not yet close the surrounding state, queue, persistence, and menu contracts well enough for unconditional adoption.

## A. Round-6 disposition audit

1. **R6-1 — PARTIAL.** V2.5 truthfully retracts exactly-once, adds `dispatching`/`delivery_unknown`, forbids automatic reinjection, unifies the ID, and names crash-window tests; however, the transition graph is not total, the current PTY seam cannot acknowledge the actual write, and the server-derived request hash has no defined same-ID retry evaluation order (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:186-196`; R7-1–R7-3).
2. **R6-2 — PARTIAL.** Same-space prepare, source snapshotting, snapshot authorization, soft-delete tolerance, terminal failure, and races are specified, but the assertion that hard deletion cannot block recording contradicts the mandatory source FK of the promised edge (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:190,193-196`; R7-4).
3. **R6-3 — PARTIAL.** The per-handoff withdrawal representation, authority, event, read DTO, immutable history, correlation, and two-author test are now real, but withdrawal is defined only from `recorded` while v2.5 separately creates `delivery_unknown_recorded` handoffs (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:192,195,202`; R7-1).
4. **R6-4 — PARTIAL.** The union, extension namespace, group grammar, global uniqueness, conflict details, event discriminant, and corrupt-row revision are substantially fixed; the claimed shipped default is not representable, Channels still lacks a canonical view route, and write/future-version revision semantics remain contradictory (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:42-53,73-82,97-113`; R7-5–R7-7).
5. **R6-5 — PARTIAL.** `Mod`, its physical terminal exception, fallback reachability, and browser receipt testing are added, but the exclusion list is literally left as an ellipsis for later reference capture, contrary to the section's “specified” status (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:206,225,231`; R7-8).

## B. New v2.5 findings

### R7-1. [MAJOR] Delivery and recording are two state axes, but the spec flattens them into a contradictory state machine

**Contradicted/insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:189-195,200-202`; honest derived truth at `docs/tm8-architecture/01-LAWS.md:82-84`.

`delivery_unknown` is called terminal, yet recording proceeds after it and the result set invents `delivery_unknown_recorded` without an allowed transition. `record_failed` then discards whether delivery was confirmed or unknown—the exact fact the UI needs before suggesting a new share. Withdrawal accepts only `recorded`, so an unknown-but-recorded handoff cannot enter the new withdrawal machine. More seriously, the recorder creates the same `shared_into` existence edge for an unknown delivery, while §5.7 later justifies that immutable edge with “delivery historically occurred.” In the unknown branch that statement may be false; the graph would turn an honest transport ambiguity into false derived truth.

**Concrete fix / ruling needed:** model orthogonal `deliveryStatus = prepared|dispatching|delivered|unknown` and `recordStatus = pending|recorded|failed` (or enumerate every equivalent composite state), with total transitions and response DTOs. Permit withdrawal from every recorded composite. Either create `shared_into` only after confirmed delivery, or redefine/name the edge as an attempted handoff and make its unknown status visible in every Connections read; the immutable message/handoff audit may still record an unknown attempt.

### R7-2. [MAJOR] “After the PTY write returns” is not observable through the current delivery queue

**Insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:191-196,204,272-273`; current queue at `packages/execution/src/pty/PtyHostService.ts:71-82,453-550,553-572`; current caller at `packages/execution/src/spawn/SpawnService.ts:249-297`.

`deliverPrompt()` resolves `true` immediately after putting an anonymous entry in memory; its fire-and-forget drain later removes the entry before `writePromptToEntry()`, and a write failure is only logged. The entry carries no handoff ID or completion promise. Therefore the saga cannot use this return value to distinguish queue admission from the actual write required by §5.7, nor can it durably enter `dispatching` immediately before the consumer writes. A retry while the first entry is merely queued also needs a single-claim rule or it can enqueue the same handoff twice. The §8 dossier names saga storage but never names this required execution-seam amendment.

**Concrete fix / ruling needed:** add a handoff-aware queue API whose entry carries `handoffId`, is unique while pending, and exposes an awaited outcome tied to the actual `proc.write` attempt. Specify the durable claim/consumer handshake that commits `dispatching` before that attempt and resolves delivered/refused/unknown afterward; explicitly bypass/replace the current pre-delivery `execution.prompt` command-ledger path for this command. Add queue-wait, spawn/resume handoff, rejection, write-failure, and concurrent same-ID tests in addition to the four crash windows.

### R7-3. [MAJOR] The immutable request hash cannot be safely recomputed on an ordinary retry

**Insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:188,195-196,272-273`; the frozen command envelope at `packages/contract/src/contract.ts:385-386`; the current ledger's replay-first rule at `db/migrations/004_ledgers.sql:101-121`.

The hash contains server-resolved mutable values—source `contentVersion`, session epoch, and rendered-envelope hash—but the new command DTO is not frozen with expected values for any of them. If a lost-response retry arrives after the source changes or the session restarts, recomputing the hash from current state falsely reports a reuse conflict instead of replaying the persisted outcome. If the server looks up and returns the old saga first, it has no client-carried data with which to decide that the caller intentionally reused the ID for the new version/epoch, so the promised full-hash mismatch check is not actually defined.

**Concrete fix / ruling needed:** freeze the command input and lookup order. Either carry `expectedContentVersion` and `expectedSessionEpoch` (the envelope remains server-derived) and hash the canonical client request before mutable lookups, or replay an existing ID by matching only stable caller/source/target input against its stored snapshot and require a new ID for every fresh resolution. State exactly which fields are client input, which are first-attempt facts, and which are compared on retry.

### R7-4. [MAJOR] A source snapshot cannot satisfy the mandatory source FK of `shared_into`

**Contradicted source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:193-194`; edge DDL at `db/migrations/001_core_graph.sql:762-773`; normal deletion is soft at `db/migrations/007_rpc_catalog.sql:1417-1454`.

The promised record transaction always inserts or retains an edge whose `src_id` references `entities(id)`. A JSON snapshot preserves display/audit data but cannot make that FK valid after physical deletion. V2.5 simultaneously says hard deletion cannot block recording and allows structural failures to end at `record_failed`; those are incompatible outcomes for this exact race. Normal `delete_entity` is soft, so the cleanest contract may be to forbid physical deletion while a handoff/same-space lifetime exists—but the current hard-delete-survival claim cannot stand as written.

**Concrete fix / ruling needed:** choose one representation: retain a permanent entity tombstone row; forbid physical source deletion while handoff history can exist; or let the snapshot-backed handoff/message record without a `shared_into` edge and expose that explicitly. If hard deletion is outside supported lifecycle, delete the claim and test rather than asserting impossible FK behavior.

### R7-5. [MAJOR] The shipped default menu cannot be encoded by the frozen MenuConfig

**Contradicted source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:42-56,97-108,112`.

The §2 diagram is declared to be the shipped default config and includes `Activity(deferred)` and `Leaderboard(deferred)`. Neither is in the closed `ViewRef` union, and registered-but-unimplemented views are explicitly invalid for menu save. `MenuItem` has no disabled/discovery variant. Consequently space creation/backfill cannot materialize the document's stated default through its own frozen DTO.

**Concrete fix / ruling needed:** remove the deferred rows from the shipped MenuConfig and expose them only through the separately allowed disabled palette discovery, or add and fully specify a non-navigable discovery item variant. Do not special-case them outside the config; that would violate RULING H.

### R7-6. [MAJOR] The closed `channels` ViewRef has no canonical route builder

**Contradicted/insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:51,67,73-82,104-111`.

The route grammar has `channel/{channelId}` only. A menu or `g c` navigation to the channel list has no entity ID, and the `channel` entity strategy is not a route builder for the `channels` view. §2.3 says the six-row view registry contains route builders but never enumerates their mappings, repeating the exact route-builder omission from R6-4 in prose.

**Concrete fix / ruling needed:** freeze a six-row view-registry table with exact route templates, menu eligibility, required flag, and implementation status. Add a canonical channel-list route such as `#/s/{spaceId}/channels` (plus legacy/canonical behavior), or define a deterministic existing target; do not overload `channel/{id}` without an ID.

### R7-7. [MAJOR] Menu revision is duplicated in the write DTO, and unsupported-version fallback can destroy newer data

**Contradicted/insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:98-113`.

`MenuConfig` contains `revision`, the write carries both `{menu: MenuConfig, expectedRevision}`, and the database revision is said to be separate from the payload. No rule says what happens when `menu.revision !== expectedRevision`, or which revision is stored/incremented. Separately, an unsupported future schema renders the current shipped default; if that fallback may submit the stored revision like a corrupt-row repair, an older client can validly overwrite a newer payload it cannot understand. Unsupported is not corrupt.

**Concrete fix / ruling needed:** define a revision-free `MenuConfigPayload` for writes plus one `expectedRevision`; server increments the separate revision and returns a `MenuConfig` read DTO. Preserve raw unsupported-version payloads and reject edits with a typed upgrade-required/invariant reason. Limit default-with-stored-revision repair writes to malformed payloads of a schema version the server understands.

### R7-8. [MINOR] The keyboard contract still delegates its collision set to reference capture

**Contradicted/insufficient source:** v2.5 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:206,225,231`.

The section says the keyboard map is specified and jsdom-testable, yet the non-interceptable set ends in `…enumerated fully at reference capture per supported browser`; the supported browser matrix itself is not frozen here. That leaves the accepted bindings and possible platform-specific rebindings unknown until a later design event.

**Concrete fix:** enumerate the supported browser/OS matrix and its excluded chords now, then freeze any per-platform fallback chord in the same table. Reference capture should verify the contract, not finish authoring it.

## Round-7 ruling

V2.5 makes the decisive correction: **R6-1 is no longer a blocker** because the PTY effect is described as at-most-once and an ambiguous crash never auto-reinjects bytes. The remaining work is specification closure rather than a challenge to RULINGS F/G/H. Before unconditional adoption, make delivery and graph recording independent state axes, expose a handoff-aware write receipt at the real queue boundary, define retry-hash evaluation, reconcile hard deletion with edge FKs, and make the menu's default/routes/revision behavior valid under its own DTO. Final verdict: **CONDITIONAL GO (0 blockers)** with **7 majors and 1 minor**; round-6 audit: **0 RESOLVED / 5 PARTIAL / 0 UNRESOLVED**.

# Round 8

**Review date:** 2026-07-26  
**Reviewed revision:** v2.6  
**R7 disposition result:** **5 RESOLVED · 3 PARTIAL · 0 UNRESOLVED**  
**Carried R6 re-audit:** **2 RESOLVED · 3 PARTIAL**  
**New finding count:** **0 BLOCKER · 3 MAJOR · 2 MINOR**  
**Verdict:** **CONDITIONAL GO (0 blockers)**

V2.6 closes the false-edge, PTY-queue, hard-delete, default-menu-row, Channels-route, and menu-revision defects at the design level. The remaining exact SQL, strict DTO schemas, RLS, and conformance fixtures properly belong to the separately reviewed §8 dossier. Three contradictions still change product behavior or the shape of a frozen design contract, however, so they cannot be handed to the dossier as mere implementation detail.

## A. R7-1–R7-8 verification

1. **R7-1 — PARTIAL.** The two axes, retained delivery outcome, confirmed-delivery-only edge, edge-less unknown/refused audit, and withdrawal-from-recorded rule are real; the declared Cartesian state space still admits recording before a delivery outcome and omits `withdrawn` from the `recordStatus` axis (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:201-210,220`; R8-1).
2. **R7-2 — RESOLVED.** §5.7 explicitly names the current queue defect and the required handoff-aware replacement: pending uniqueness, same-ID join, actual-write outcome, durable pre-write dispatch claim, ledger bypass, and all requested queue/crash tests; §8 carries the execution-seam amendment (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:208-214,290-291`). Exact method signatures and transaction code are dossier items.
3. **R7-3 — PARTIAL.** The frozen input, ID-first lookup, stable-input-only comparison, verbatim replay, first-attempt server facts, and new-ID fresh resolution are coherent (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:213-214`), but the older full request-hash rule remains normative and says mutable server facts participate in retry conflict detection (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:200`; R8-4); `refused` retry wording also conflicts with verbatim replay (R8-5).
4. **R7-4 — RESOLVED.** The impossible hard-delete guarantee is retracted: an absent source prevents the FK-backed edge while the snapshot-backed message/audit records with `sourceMissing:true`; soft deletion remains the normal lifecycle (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:207,210-211,214`).
5. **R7-5 — RESOLVED.** The specification removes Activity and Leaderboard from the shipped menu and confines them to disabled palette discovery; it defines every visible default row as a legal view/kind ref (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:42-57,99-110`). The separate caret-hierarchy defect is new (R8-2), not a failure to remove those deferred rows.
6. **R7-6 — RESOLVED.** The canonical `#/s/{spaceId}/channels` route exists and the complete six-row view table now freezes routes, menu eligibility, required status, and implementation status (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:74-84,112-123`).
7. **R7-7 — RESOLVED.** Writes have a revision-free payload and one expected revision; the server owns increments; future-version payloads are preserved and non-editable; understood-but-malformed repair is separate and tested (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:122-125`). Strict Zod/SQL shapes belong to the dossier.
8. **R7-8 — PARTIAL.** The matrix and finite exclusion list are finally frozen, and reference capture is verification-only, but the list is factually incomplete for browsers the same paragraph calls primary/supported (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:224-247`; R8-3).

## B. Re-audit of the five carried R6 partials

1. **R6-1 — PARTIAL.** Honest at-most-once delivery and the real queue boundary are now design-sound, but the stale full-hash statement and ambiguous refused-retry rule still conflict with the frozen replay policy (R8-4–R8-5).
2. **R6-2 — RESOLVED.** Same-space prepare, snapshot authorization, soft-delete tolerance, permission drift, hard-delete fallback without an illegal edge, terminal record failure, UI surfacing, and races now form one coherent recordability rule (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:207-214`).
3. **R6-3 — PARTIAL.** Per-handoff withdrawal authority/storage/rendering is specified, but the supposedly total response-state axis does not include its `withdrawn` value and overstates the legal composites (R8-1).
4. **R6-4 — RESOLVED.** The original namespace, route, conflict, event, revision, corrupt/future-version, and shipped-default-row gaps are closed (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:97-126`). The newly exposed inability to encode RULING E's nesting is tracked separately as R8-2.
5. **R6-5 — PARTIAL.** `Mod` and the browser matrix are explicit, but the collision inventory incorrectly advertises browser-owned chords as app-receivable on primary/supported targets (R8-3).

## C. Remaining design-level findings

### R8-1. [MAJOR] The “total” two-axis model permits impossible composites and leaves withdrawal outside its own axis

**Contradicted source:** v2.6 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:201-210,220`.

The text says every composite is legal once delivery leaves `prepared`. That includes `(dispatching, recorded)` and `(dispatching, failed)`, but recording is explicitly defined only after a `delivered|refused|unknown` outcome because its transaction depends on that outcome. The diagram also freezes `recordStatus` as `pending→{recorded|failed}`, then §5.7 mutates the same field to `withdrawn`. Thus the response DTO's advertised union and the “total transitions” claim cannot both represent the withdrawal command.

**Concrete design fix:** freeze the allowed-state invariant, not merely two independent enums: `prepared|dispatching` require `recordStatus=pending`; terminal delivery permits `pending|recorded|failed`; `recorded→withdrawn` adds `withdrawn` to the record-status union, with no transition from `failed`. The dossier should later encode that ruled matrix as SQL/Zod constraints and transition tests.

### R8-2. [MAJOR] The flat MenuConfig cannot encode the binding Workspace caret hierarchy

**Contradicted source:** RULINGS E/H at v2.6 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:15,18`; required rendering at `:47-48,56`; frozen DTO at `:99-110,126`.

Workspace must be a clickable view row whose caret owns Tasks, Sessions, Docs, and Teammates, and it must be visually distinct from label-only group headers. Yet `MenuGroup` contains a flat `MenuItem[]`, and `MenuItem` contains only a ref—no parent, children, expansion node, or group-header target. Rendering the first item as an implicit parent would hardcode a positional convention and violate RULING H. Calling the revised default “self-encodable” therefore remains false even though every individual ref is now legal.

**Concrete design fix / ruling needed:** add a bounded generic menu-node shape (for example a ref item with optional one-level `children: MenuLeaf[]`) or an explicit referenced parent field on a group; freeze depth, child bounds, global uniqueness across parent/children, and validation. Encode Workspace and its four children through that data. Exact default IDs, labels/icons, JSON/Zod grammar, and migration values can then be completed in the dossier.

### R8-3. [MAJOR] The frozen browser collision list contradicts the advertised chords on primary and supported browsers

**Contradicted source:** v2.6 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:224-243`. **External verification:** [Google Chrome's official shortcut table](https://support.google.com/chrome/answer/157179?co=GENIE.Platform%3DDesktop&hl=en) assigns `Ctrl+K` to browser search on Windows/Linux and `Command+,` to Chrome Settings on macOS; [Mozilla's official shortcut table](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly) assigns `Ctrl/Command+K` to browser search and `Command+.` to Stop on macOS.

V2.6 calls Chromium on every desktop OS primary and Firefox supported, advertises `Mod+K` for tm8's first-class palette, `Mod+,` for Settings, and `Mod+.` for pinning, then states none is browser-owned. The official browser tables directly disprove that statement: the palette chord collides on Chrome Windows/Linux and Firefox across the supported matrix; Chrome/macOS also has the Settings collision that the spec incorrectly labels Safari-only; Firefox/macOS collides with panel pinning. This is known design input, not something reference capture may merely discover after adoption.

**Concrete design fix / ruling needed:** expand the exclusion matrix per browser/OS and freeze app-receivable platform bindings now. At minimum, give the palette a tested fallback on Chrome Windows/Linux and Firefox, extend the Settings exception to Chrome/macOS (and verify Firefox/macOS), and resolve Firefox/macOS `Mod+.`. Pointer reachability may remain the fallback for secondary actions, but an advertised keyboard contract cannot claim receipt of browser-owned chords.

### R8-4. [MINOR] The old request-hash paragraph contradicts the new stable-input retry identity

**Contradicted source:** v2.6 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:200` versus `:213-214`.

Line 200 still says the conflict hash includes resolved content version, session epoch, and rendered-envelope hash. Line 213 correctly says those server-derived facts are never recomputed for retry comparison and only stable submitted inputs determine reuse. Both are normative, so an implementer cannot know which hash the mismatch error means.

**Concrete fix:** rename/factor the concepts: an idempotency identity hash over stable submitted inputs is compared on retry; a first-attempt fingerprint may include resolved version/epoch/envelope for audit only and is never a retry comparator.

### R8-5. [MINOR] `refused` is terminal and replay-only but is called safe for a same-ID delivery retry

**Contradicted source:** v2.6 `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:203,209,213`.

`refused` is terminal on the delivery axis, and an existing matching ID replays its outcome verbatim. Therefore a same-ID retry cannot attempt the PTY write again. “Safe same-id retry” is ambiguous between safe HTTP replay and a fresh delivery attempt.

**Concrete fix:** say “safe same-ID replay returns `refused`; a delivery re-attempt uses a new `handoffId`,” or deliberately add and specify `refused→dispatching` plus its already-recorded audit/edge behavior. The former matches the rest of v2.6.

## D. §8 dossier items — explicitly not design findings

After R8-1/R8-2/R8-3 are ruled, the following belong in the separately reviewed amendment dossier and should not prolong this design document:

- exact saga/menu SQL tables, CHECK constraints, indexes, lock/claim queries, RLS, retention, and migrations;
- strict command/read/event Zod and TypeScript schemas, field lengths/ID grammars, typed error-detail schemas, and facade/catalog registration;
- the concrete queue callback/API signature, process-write failure classification, shutdown recovery worker, and ledger migration/compatibility seam;
- the exact default MenuConfig IDs/presentation metadata and backfill payload after the nesting shape is chosen;
- browser automation and database conformance fixtures for every transition, race, corrupt/future-version, and platform chord ruled here.

## Round-8 ruling

V2.6 is materially close: five R7 findings resolve outright, the graph no longer lies about ambiguous delivery, and the dossier boundary is now mostly honest. It is not a final GO because three remaining defects are design choices, not SQL/DTO polish: the legal handoff-state matrix, the data shape for Workspace's caret children, and app-receivable keyboard bindings on the declared browser matrix. Fix those in the spec; apply the two wording corrections; then close design and move all listed mechanics to §8. Final verdict: **CONDITIONAL GO (0 blockers)** with **3 majors and 2 minors**. R7 audit: **5 RESOLVED / 3 PARTIAL / 0 UNRESOLVED**. Carried R6 audit: **2 RESOLVED / 3 PARTIAL**.

# Round 9 (final for the original design ledger)

**Review date:** 2026-07-26  
**Reviewed revision:** v2.7  
**Targeted R8 disposition:** **5 RESOLVED · 0 PARTIAL · 0 UNRESOLVED**  
**New design-level findings introduced by these edits:** **none**  
**Final verdict:** **GO — original design ledger closed**

## Targeted verification

1. **R8-1 — RESOLVED.** The legal-state matrix now requires `recordStatus=pending` while delivery is `prepared|dispatching`; terminal delivery admits the declared record states; `withdrawn` is a first-class union member reachable only from `recorded`; `failed` has no outgoing transition; and the response DTO is explicitly the same matrix (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:205-214`). SQL/Zod encoding and transition fixtures remain dossier work, as ruled.
2. **R8-2 — RESOLVED.** `MenuItem.children` is bounded to view parents, `MenuLeaf` forbids further nesting, uniqueness spans parents and children, and caret rendering is driven by the presence of children. The shipped default explicitly represents Workspace with task/session/doc/teammate leaves, with no positional or hardcoded inference (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:101-115`). Exact IDs, presentation metadata, and backfill JSON correctly remain in the dossier.
3. **R8-3 — RESOLVED.** The guaranteed keyboard paths are now browser-receivable plain sequences: `/` for palette, `g ,` for Settings, and panel-focused `p` for pinning. `Mod+.` is withdrawn; `Mod+K`/`Mod+,` are non-guaranteed conveniences gated and advertised per receive-test result; and the documented Chrome/Firefox/Safari collisions are incorporated as design input rather than deferred discovery (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:232-253`).
4. **R8-4 — RESOLVED.** The stale full-request comparator is replaced by one retry identity over stable request facts, while resolved version/epoch/envelope form a separately named audit-only first-attempt fingerprint that is never recomputed or compared (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:204,217-218`).
5. **R8-5 — RESOLVED.** `refused` is terminal; same-ID retry is explicitly HTTP-level verbatim replay with no PTY effect; and every delivery re-attempt after `refused|unknown` uses a new handoff ID (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:207-218`).

## Closing statement

Across nine adversarial rounds, the design moved from ambiguous terminology, understated frozen-contract amendments, transplant/layout conflicts, and incomplete inherited-surface accounting through concrete project projection, terminal hosting, navigation, menu, keyboard, and share-into-session contracts. Rounds 5–8 exposed and closed the irreversible-delivery, graph-truth, retry, config-convergence, hierarchy, and browser-collision edge cases. V2.7 specifies the final five design rulings without identifying a new design contradiction. **The original workspace layout and terminology design ledger is approved: GO.**

The boundary remains standing: implementation is still gated by a separately reviewed §8 amendment dossier. Per the adopted Round 8 §D baseline, that dossier owns exact SQL tables/checks/indexes/locks/RLS/retention/migrations; strict TypeScript/Zod command/read/event/error schemas and field grammars; the concrete PTY queue API, failure classification, recovery worker, and ledger compatibility; exact default MenuConfig IDs/presentation/backfill payload; and browser/database conformance fixtures. Those are not reopened design findings.

# Round 10 (post-GO delta: RULING J)

**Review date:** 2026-07-26  
**Reviewed revision:** v2.9  
**Scope:** RULING J only; RULING I and the Round-9 GO are not reopened  
**Delta verdict:** **CONDITIONAL GO — 0 blockers, 5 majors, 1 minor**

RULING J's central choice is coherent: a session's current project set can be M:N edge state while `launchProjectId` remains nullable provenance. G2 specifies removal of work-session rows from the materialized-edge repair design model, and §7.3's placement and wording keep R4-4's inverse command on PR/commit artifact links. Share-into-session remains same-Space and project-independent, so it neither derives from nor mutates this association set. The delta is not ready to adopt unchanged, however: its concurrency, unlink meaning, legacy backfill, projection lifecycle, and scratch security rules are incomplete at design level.

## Findings

### R10-1. [MAJOR] Association creation and project unlink do not share a serialization rule

**Contradicted source:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:264,276,282,298`; current seam demonstrated by `db/migrations/007_rpc_catalog.sql:833-853,1290-1323,2027-2112`.

The new invariant validates an `in_project` write against an active `space_projects` row, while G5 makes unlink consult committed live-session edges. Section 7.2 freezes project-first locking only for `projects.link|unlink|update`; it does not place ordinary association creation or G1's spawn-created edge in that lock order. Under ordinary read-committed behavior, an association transaction can observe the link, an unlink transaction can observe no committed live edge and delete the link, and then the association can commit. The result is a live session authoritatively associated to a project that is no longer active—precisely the state the write-time validation claims to prevent.

**Concrete design fix:** extend the project-resource lock invariant to every `in_project` creation/promotion and to the G1 spawn transaction: resolve projection→resource, lock that project row first, re-check the active link/live projection under the lock, then insert. `projects.unlink` must acquire the same lock before its G5 check. Freeze a create-vs-unlink race acceptance case here; exact SQL and retry mechanics remain dossier work.

### R10-2. [MAJOR] A removable association can bypass the live execution-root protection without proving that the session pivoted

**Contradicted source:** RULING J and G1/G5 at `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:21,282`; the pre-delta safety intent is explicit in `db/migrations/007_rpc_catalog.sql:841-849`.

G1 says the launch association is removable “if the session pivots,” but deleting a graph edge neither changes nor observes a PTY's cwd. G5 then tests only the writable association set. A live session can therefore remove its initial edge and permit project unlink while it is still executing from the immutable `launchProjectId` root. `launchProjectId` preserves historical attribution but does not make the G5 predicate truthful about the current runtime. This is not a share-into-session problem; it is an unresolved meaning for the unlink refusal.

**Ruling needed:** choose and state one of these semantics. If unlink is runtime safety, conservatively block on a live matching `launchProjectId` as well, or introduce a server-owned current-execution-root signal changed only by an operation that actually pivots the process. If unlink is merely graph/reachability hygiene and is not a filesystem-safety or revocation boundary, say so explicitly and remove the “if the session pivots” implication. Tests must cover removing the initial edge while the PTY remains live.

### R10-3. [MAJOR] The unconditional one-edge-per-session backfill is invalid for legal legacy rows

**Contradicted source:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:264,282,298`; extant storage/lifecycle at `db/migrations/001_core_graph.sql:694-721` and `db/migrations/007_rpc_catalog.sql:841-853`.

Section 8 orders one spawner-authored association edge for every existing non-null `work_sessions.project_id`. Today an exited session does not block unlink, and unlink removes `space_projects` without clearing that provenance column. Thus valid legacy data can contain a non-null project ID with no active Space link—and, in the new projection migration, possibly no live target projection. Backfilling the edge either violates RULING J's active-link invariant or secretly creates a hidden edge that becomes a current association if the project is later relinked. Neither behavior is ruled.

**Concrete design fix:** backfill an association only when the matching `space_projects` row and live per-Space projection exist. Preserve all other values solely as `launchProjectId`; emit an actionable migration audit for skipped historical references and never relink a project implicitly. Freeze cases for active, previously unlinked, soft-deleted projection, and missing-resource rows; exact migration queries belong to the dossier.

### R10-4. [MAJOR] Project materializer unlink/relink bypasses the counter and invalidation lifecycle promised for hidden association edges

**Contradicted source:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:269-276,282,287,292`.

G5 deliberately leaves exited-session edges physically intact and relies on endpoint omission when the project projection is soft-deleted. R4-5, however, names only `delete_entity` and `restore_entity` as the paths that recompute incident live-counterpart edge/reaction counters and drive derived cache invalidation. Project projections cannot use those entity commands; their `deleted_at` lifecycle belongs to the materializer. Without an equivalent materializer rule, unlink can hide an association while the session's cached connection count remains high, and relink can reveal it while the count remains low.

**Concrete design fix:** require `projects.unlink` and projection restore during `projects.link` to invoke the same incident-counter recompute and neighbor-cache invalidation semantics in their transaction, with the materializer event carrying the existing deleted/restored effect. Add exited-session edge hide/reveal counter tests. The helper SQL and event wiring remain dossier details.

### R10-5. [MAJOR] Scratch execution is not yet inside the adopted spawn-path/trust contract

**Contradicted source:** G4 and the dossier delta at `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:282,298`; `docs/tm8-architecture/10-SECURITY-MODEL.md:38-40,63-70`; `docs/tm8-architecture/05-DECISIONS.md:26` (T-D22); frozen types at `packages/contract/src/contract.ts:693-696,717-738` and `packages/contract/src/schemas.ts:873-890`.

G4 correctly forbids client paths and asks for the same informed-consent gate as an untrusted project, but adopted S11 permits computed paths only inside a project root or the node worktree area. It defines no scratch containment domain. S12 requires a submitted `confirmUntrusted: true`, while the strict frozen `ExecutionSpawnInput` still has no such field. Conversely, `projectId` is already nullable/optional, so §8 misidentifies that as the principal amendment; the missing public-contract changes are the scratch workdir variant and the consent carrier.

**Concrete design fix:** amend S11/T-D22 in the design to name a dedicated server-owned scratch root under the node data directory, with generated per-session paths, post-resolution containment and private permissions; state its retention/cleanup ownership. Enumerate `confirmUntrusted` and the scratch workdir variant/valid input combinations in §8, and extend doc 10's acceptance to scratch-without-confirmation and path/symlink escape. Exact field bounds, path construction, and cleanup implementation remain dossier work.

### R10-6. [MINOR] Section 8's blanket “server-set origin guards” wording can reintroduce the repair model G2 just retired

**Contradicted source:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:282-285,298`; compare the defined guard meaning at `:223`.

The operative §7.3 rule is sound: G1 produces a normal spawner-authored, user-writable association; task/work-session rows remain writable; only materialized PR/commit rows receive mutation refusal and the R4-4 correction path. Section 8 later calls both registry rows (`in_project` and `shared_into`) subject to “server-set origin guards.” Elsewhere that phrase includes refusal of public create/patch/delete, so a dossier author could accidentally restore immutability to all work-session associations. There is no inherent spoofing hole if origin metadata is server-owned; the ambiguity is which rows the mutation guard protects.

**Concrete wording fix:** distinguish origin-field ownership from edge mutability: clients never set `props.origin`; G1/backfill session edges receive the normal writable origin and use public patch/delete; only PR/commit `origin=materialized` rows are mutation-refused and use R4-4; `shared_into` remains recorder-only. Add the corresponding negative/positive matrix to the dossier.

## Targeted seams that pass

- **G1 versus R4-4:** the RULING-J/G2 design specifies no correction-command hole: it specifies session associations as ordinary writable edges using normal edge deletion and reserves the special inverse command for server-materialized PR/commit associations (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:282-285`). R10-6 is a dossier wording ambiguity, not a need to extend the correction command to sessions.
- **G3:** the design specifies deterministic exact-one association auto-fill, rejection of zero/ambiguous sets, and a prohibition on repository-string inference. It specifies that hidden edges are excluded by the canonical live-endpoint predicate (`:283,287`).
- **Share-into-session:** §5.7 authorizes and records a same-Space entity delivery independently of project membership. `shared_into` means historical confirmed delivery, not project association, so no coupling to `launchProjectId` or the M:N set is required (`:201-227,281`).
- **Base edge physics:** same-Space endpoint validation, unique `(src,dst,type)`, and hidden-not-deleted behavior support M:N associations. The defects above concern lifecycle coordination, not the representation itself (`db/migrations/001_core_graph.sql:762-776`; spec `:282,287`).

## Round-10 ruling

RULING J's M:N authority decision is viable and does not disturb the Round-9 GO outside this delta. Adoption is conditional on five design fixes: serialize association creation with unlink, rule what the live unlink guard actually protects, constrain legacy backfill, extend counter/invalidation behavior to materializer-driven projection lifecycle, and bring scratch execution under doc 10/T-D22. Clarify the origin-guard sentence at the same time. Once those are frozen, their SQL, strict DTOs, migration mechanics, and race fixtures fall back inside the standing §8 dossier boundary. **Delta verdict: CONDITIONAL GO (0 blockers, 5 majors, 1 minor).**

# Round 11 (delta-final: RULING J)

**Review date:** 2026-07-26  
**Reviewed revision:** v2.10  
**Scope:** R10-1 through R10-6 only  
**Disposition:** **6 RESOLVED · 0 PARTIAL · 0 UNRESOLVED**  
**Delta-final verdict:** **GO — RULING J delta ledger closed**

1. **R10-1 — RESOLVED.** §7.3 requires every `in_project` creation/promotion, explicitly including G1's spawn-created edge, to take the same project-resource lock as unlink and revalidate the active link plus live projection under that lock before insertion; the create-vs-unlink race is frozen for acceptance (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:276,282,303,353-354`). This closes the design-level check/commit window without prescribing dossier-level SQL.
2. **R10-2 — RESOLVED.** G5 is explicitly runtime safety and tests the union of live association edges and live matching `launchProjectId` under the project lock. G1 edge removal is correctly described as graph curation with no PTY-cwd effect, and the remove-edge-while-live case must still fail unlink through the launch leg (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:283,285,303,353-354`).
3. **R10-3 — RESOLVED.** Backfill now requires both an active `space_projects` row and a live per-Space projection; every other non-null legacy value remains provenance-only, produces an actionable audit, and never causes implicit relink. The four relevant legacy states are enumerated (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:287,303,353-354`).
4. **R10-4 — RESOLVED.** §7.3 requires materializer-driven projection soft-delete and restore to inherit R4-5's in-transaction incident-counter recompute and neighbor-cache invalidation semantics, with the deleted/restored event effect and an exited-session unlink→relink integrity case (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:286,292,303,353-354`).
5. **R10-5 — RESOLVED.** §7.3 specifies scratch execution with a named Server-owned containment domain, generated session path, post-resolution containment, private permissions, and execution-owned cleanup/retention. The specification identifies the frozen-contract deltas as the scratch workdir variant and `confirmUntrusted` carrier—`projectId` is already optional—and assigns the S11/T-D22/doc-10 amendments and negative cases (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:284,303,353-354`). Exact retention duration, field bounds, and filesystem implementation remain proper dossier items.
6. **R10-6 — RESOLVED.** Section 8 now separates server ownership of `props.origin` from edge mutability: G1/backfill session edges are publicly patchable/deletable with normal writable origin; only materialized PR/commit rows are mutation-refused and repaired through R4-4; `shared_into` remains recorder-only. The required positive/negative matrix is explicit (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:288-290,303,353-354`).

## Closing note

V2.10 closes every Round-10 defect without changing RULING J's viable M:N authority model or introducing a new design-level contradiction. The RULING J delta is approved: **GO**. The Round-9 design GO remains intact, and the standing boundary is unchanged: exact locks/SQL, strict schemas, migration implementation/audit shape, scratch retention constants, and conformance fixtures belong to the separately reviewed §8 amendment dossier.

---

# Round 12 (delta-final: RULINGS K/L/M + C6/C7 repairs)

**Review date:** 2026-07-26  
**Reviewed revision:** v2.11  
**Reviewer:** CLI+API review owner (`sess_1785022908381_vt4eu9250`)  
**Scope:** §0 RULINGS K/L/M · §2.2 `contentSurface` · §5.2b/§5.2c · §5.8 · §8.1 · §9/§10 deltas only  
**Initial verdict:** **CONDITIONAL GO — 0 blockers · 1 major (M12-1) · 3 minors (m12-1..3)**  
**Disposition after repair cut:** **4 RESOLVED · 0 PARTIAL · 0 UNRESOLVED**  
**Delta-final verdict:** **GO — no residuals; K/L/M + C6/C7 delta ledger closed**

## Initial pass

All eleven product invariants were verified as consistently specified at first read: Terminal remains a complete native interactive PTY that no profile may remove, demote or gate (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:173,175`); Chat is a peer surface never shown as a split (`:173`); one message store, Chat and Discussion being projections of the same graph store (`:176`, `:322`); explicit-only capture with raw ANSI/PTY never promoted into canonical messages by parsing (`:322`); static templates as registry assets, not entities and not CLI-authorable (`:320`); `session_chat_v1.replies` as the exact immutable transitive descendant closure with `root_message_id` permitted only as a prefilter and never as a substitute for parent-chain verification (`:317`); bounded `around` focus with cursors in both directions and no page-until-found (`:317,319`); profile authority requiring a human Member/admin principal even when `--as` selects a Teammate (`:321`); no frozen-81 count drift until adoption (`:314`); the T-D20/R17 reversal correctly gated to a Vega-logged master-corpus amendment at adoption (`:22,316`); and RULING D standing unchanged under an additive K (`:22,173`).

The earlier quota-interrupted write was confirmed fully repaired — no truncated or orphaned seam in any reviewed section.

## Dispositions

1. **M12-1 — RESOLVED.** RULING L classified Interaction Profiles as a "config-class profile registry", contradicting `§8.1`'s "restricted `interaction_profile` core kind", the subordinate briefing `§11.5` ("a second restricted core entity, **not** a config resource"), and its own subsequent citation of "restricted-kind family admission" — a clause that only parses if the profile is an entity. Diagnosed as a **swap rather than a misclassification**: the config-side label belongs to the static template registry and had bound to the nearer noun. Rated major because `config-class` is load-bearing (T-L3 defines the class; MenuConfig is assigned to it), §0 is the binding section, and v2.11 governs the subordinate docs — so the governing text assigned the profile a category its own §8.1 and its subordinate both reject, and an implementer reading RULING L alone would build a config side table without an entity envelope, losing versions, `entities.versions` history, messages, edges and Space export. Now reads "restricted `interaction_profile` core entity kind selecting static UI Templates (config-side, typed, versioned Server/UI registry assets — not entities)" (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:22`). Both halves of the agreed split now carry the correct classifier.
2. **m12-1 — RESOLVED.** RULINGS K/L/M preceded RULING J in §0, breaking both chronology and alphabetical order in a section whose entries are cited by letter across five documents. RULING J now precedes them (`:21,22`).
3. **m12-2 — RESOLVED.** §4's EntityDetailPanel row carried stale v2.10 wording, "`work_session` Content = the live terminal", while §9's disposition row had already been updated for the two-mode region. Now reads "`work_session` Content is the two-mode Terminal/Chat region; Terminal remains the RULING-D renderer and default surface (RULING K, §5.2b)" (`:137`), consistent with `:332`.
4. **m12-3 — RESOLVED.** RULING D carried no forward pointer to K. D remained true as written — K is additive and D's terminal identity is explicitly unchanged — but D is the most widely cited ruling in the corpus and a reader landing on it alone learned nothing about the peer surface. Now closes with "**See RULING K:** the Content region gains an additive peer Chat surface; D's terminal identity remains unchanged" (`:15`).

## Noted as correct (recorded so they are not re-litigated)

- **Handoff scope guard (`:179`).** The Composer supersession is explicitly bounded so it does not invert the frozen §5.7 saga: "a handoff record audits a delivery act; a message is a durable graph object that is subsequently offered for delivery." Both laws coexist because they describe different objects.
- **Keyboard mode scope (`:241`).** "Merely retaining a hidden TerminalPool lease while Chat is selected gives the terminal no keyboard authority" — lease persistence and keyboard ownership pull in opposite directions, and naming the trap is stronger than restating the predicate.
- **Lease persistence and its test (`:177,186,187`).** The specification requires the lease to survive mode switches, requires `markWarm` on Terminal re-selection after Chat, and requires the acceptance leg to preserve exact PTY/decoder/scroll state and re-fit across Terminal→Chat→Terminal. This is the specified mechanism behind the first-class-Terminal invariant.

## Closing note

V2.11 closes every Round-12 defect without weakening any product invariant or introducing a new design-level contradiction. The K/L/M and C6/C7 delta is approved: **GO, no residuals**. The Round-9 design GO and the Round-11 RULING J closure both remain intact. Standing boundary unchanged: exact DTOs, SQL, permission matrices, retry/result unions, limits, retention constants and conformance fixtures belong to the §8 amendment dossier and to the closed proposal companions cited in RULINGS K/L/M, which the dossier must mirror rather than paraphrase into a competing contract. Remaining sequencing item is the single Vega adoption, including the T-D20/R17 reversal logged in the master decision corpus.
