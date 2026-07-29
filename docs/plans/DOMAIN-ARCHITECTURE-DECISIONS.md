# tm8 — Local Domain Architecture Decisions

**Status:** design consolidation, documentation-only, 2026-07-26  
**Scope:** local tm8 domain and the decisions that must remain true when the reviewed workspace-layout design is adopted  
**Implementation status:** this document does not authorize or describe completed implementation; AM-5 remains in force  
**Related design:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 FINAL GO and its closed adversarial review ledger  
**Remote design:** intentionally separated into `PHASE-2-REMOTE-SERVER-INTEGRATION.md`

> **Normative subordination:** this is a readable consolidation, not a second specification. On any conflict, `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11, `WORKSPACE-LAYOUT-REVIEW.md`, and the FINAL `docs/tm8-architecture/00-10` corpus govern. RULINGS I–M record the user's post-GO terminology, multi-project work-session, Terminal/Chat, Interaction Profile, and message-first decisions. The separately reviewed §8 amendment dossier will govern exact contract and storage diffs.

---

## 1. Executive decision

tm8 has one user-facing top-level domain: the **Server**.

A Server is analogous to a Discord server at the product and navigation level: it is a durable place the user selects, and it contains the collaboration and work surfaces available on that deployment. The executable and process that hosts the domain is called **`tm8-server`**.

There is no `hubspace` concept. The word is retired and must not appear as a second root-container noun.

The canonical local hierarchy is:

```text
tm8 client
  └─ Server
      ├─ Accounts and Server administration
      ├─ ProjectResource registry
      ├─ Execution capability
      └─ Spaces
          ├─ Membership and roles
          ├─ Entity graph
          ├─ Channels and messages
          ├─ Tasks, docs, sessions, teammates, projects, and other entities
          └─ Workspace View
```

In the current local architecture, one `tm8-server` process hosts exactly one Server. A future gateway may route to several Servers, but it is infrastructure outside the Server domain and is deferred to Phase 2.

---

## 2. Binding decisions

### D1. Server is the root domain noun

- **Server** is the user-facing product/domain object.
- **`tm8-server`** or **server process** is the technical runtime.
- Capitalized `Server` in architecture prose means the domain; lowercase runtime wording means the process.
- The old root-container meaning of `workspace` must become `Server` through a classified documentation pass, never a blind textual replacement.
- `hubspace` is removed completely.

### D2. The Discord analogy is product-level, not an ACL clone

The analogy is exact for the top-level object and navigation rail. tm8 deliberately differs in authorization:

- An account authenticates to a Server.
- Server owner/admin is an infrastructure and administration role.
- Collaboration membership and roles belong to individual Spaces.
- tm8 does not introduce a general `server_members` collaboration table merely to imitate Discord guild membership.

This split lets one authenticated account see zero or more Spaces while keeping each Space an independent sharing boundary.

### D3. A Space is single-homed

- Every Space belongs to exactly one Server.
- A Space owns one space-scoped entity graph, membership set, event sequence, menu configuration, and default feed channel.
- Entities and edges never cross Space boundaries.
- A Space does not span Servers.

### D4. Workspace means a view

**Workspace** is the user-facing composed three-panel work view inside a selected Space. It is not a persistence boundary, tenancy object, remote topology object, or server root.

Frozen historical symbols remain unchanged:

- `WorkspaceEvent`
- `WorkspaceEventEnvelope`
- `workspace_events`
- `WorkspaceScreen` and Workspace routes where they refer to the three-panel view

The event symbols are historical names; events remain Space-scoped.

### D5. A Project is a configured execution root

A Project is not synonymous with a repository:

- `workingDir` is required.
- `repoUrl` is optional and vendor-neutral.
- Non-git directories are valid Projects.
- Two clones of the same repository are two different Projects.

### D6. Project uses a resource-plus-projection model

The shipped baseline's node-level `ProjectResource` remains the sole current configuration truth and project-settings write surface. It is stored in the Server-level project registry and linked to Spaces through `space_projects`. The resource-plus-projection mechanics below are adopted target design, not a claim that the additive projection storage or handlers are shipped.

Each active `(space, project)` link has one restricted `project` projection entity inside that Space's graph:

```text
ProjectResource
  ├─ canonical settings: workingDir, repoUrl, trust, defaults
  ├─ space_projects: whether a link is active
  └─ project_links: stable resource ↔ projection identity
       └─ project projection entity in the Space graph
```

One Project linked to three Spaces therefore has one resource record and three Space-scoped projection entities.

The projection pays for its entity status by supporting:

- Entity navigation and Project Entity Views
- Discussion and reactions
- Activity
- Connections to tasks, sessions, pull requests, and commits

It is not an ordinary mutable entity:

- `entities.create/patch/delete/restore/move` on kind `project` are refused.
- Project content and lifecycle are materializer-owned.
- Settings edits go through `projects.*`.
- Hierarchy, entity deletion, and generic content editing are disabled with reasons.
- Messages, reactions, Connections, and activity are enabled.
- Points are disabled in v1.

### D7. Project links are Server-local

A `ProjectResource` may link only to Spaces on the same Server. Cross-Server collaboration must use an explicit pull, projection, or handoff. It must never create a live cross-database `space_projects` relationship.

### D8. Project projection lifecycle is deterministic

The following is the adopted, unimplemented target lifecycle:

- `projects.link` creates or restores the projection and mapping idempotently.
- `projects.update` updates every active projection atomically.
- `projects.unlink` soft-deletes the projection but retains its mapping and physical relationship history.
- `projects.unlink` is refused while any live session either has an `in_project` edge to the projection or has a matching `launchProjectId`; removing an edge does not change the PTY's runtime cwd.
- Relinking restores the same projection identity.
- Projection unlink/relink performs the same in-transaction incident-counter recomputation and neighbor-cache invalidation as entity delete/restore; the materializer event carries the corresponding deleted/restored effect.
- Generic project-entity mutation remains refused.
- Resource deletion is outside v1.

Concurrent project link, unlink, update, and every `in_project` creation/promotion lock the ProjectResource first and revalidate the active Space link plus live projection under that lock. Affected Spaces are then locked in sorted UUID order. Active links are capped at 16. Existing over-cap Projects are marked `linkFrozen`; failures reuse the existing error taxonomy with stable `details.reason` values.

While `linkFrozen` is set, both further links and `projects.update` are refused with `limit_exceeded` and `details.reason='project_over_cap'`. `projects.unlink` remains available for remediation and automatically clears the flag under the ProjectResource lock once active links reach 16 or fewer.

Legacy non-null `work_sessions.project_id` values are backfilled to association edges only when an active `space_projects` row and live projection already exist. Otherwise the value remains launch provenance and the migration emits an actionable audit; backfill never implicitly relinks a Project.

### D9. Project relationships use one graph grammar

The adopted target relationship is:

```text
in_project:
  task | work_session | pull_request | commit → project
```

All relationship and lifecycle rules below are adopted target requirements, not claims about shipped storage, locks, handlers, or runtime behavior:

- In the adopted target, `work_session ↔ project` is many-to-many within one Space. Normal `in_project` edges are the association authority and are user/agent writable.
- Association creation resolves projection to ProjectResource, takes the Project lock, and revalidates the active Space link and live projection; failure is `invariant_violation` with `details.reason='project_not_linked'`.
- `work_sessions.project_id` remains the storage column but is exposed as nullable `launchProjectId`: initial cwd/worktree provenance, never the session's complete Project set. It is immutable by current write-path construction; the W0 dossier requires a database trigger before the target is called enforced.
- A live session may have at most 16 live `in_project` edges. A Space owner/admin may delete an ordinary agent-created edge as the recovery path; a Teammate cannot indefinitely pin a link merely by creating associations.
- A spawn with a launch Project creates exactly one normal, spawner-authored association edge. Later Projects use ordinary `edges.create`/`edges.delete`; scratch spawns create no initial edge.
- Scratch sessions use a Server-generated, symlink-safe `<dataDir>/scratch/<sessionId>` root with private permissions and execution-owned cleanup on exit plus the ruled retention window. They require the `workdir` scratch variant and explicit `confirmUntrusted` consent.
- PR and commit commands accept an optional explicit `projectId`; CLI auto-fill is allowed only when the current session has exactly one live Project association. Repository-string inference is forbidden.
- `task → project` and `work_session → project` are normal writable relationships. The Server always owns `props.origin`, but only materialized PR/commit edges are refused ordinary mutation.
- A dedicated idempotent correction command removes a materialized association or demotes a promoted user relationship back to user origin.

### D10. The terminal is the work-session Content renderer

- Clicking any entity opens its detail.
- `work_session` Content is the terminal.
- There is no base terminal layer behind entity panels.
- Terminal identity and PTY transport lifetime are app-owned by one `TerminalPool`, not React Content-tab mount lifetime.
- Stack, pins, and full entity views share one host-arbitration domain.
- Multiple terminals may stream visibly; exactly one is active for keyboard focus, cursor blink, fit, and resize authority.
- The Content region has peer Terminal/Chat surfaces, never a split or replacement. Terminal is native, complete, and always available; a profile cannot remove, demote, or gate it. Chat is a projection of the one graph message/activity store and never parses PTY bytes or creates a second transcript authority.

### D11. Share into session is a first-class command

The adopted, unimplemented handoff design specifies that dropping an entity onto a live work session:

1. Builds a typed, size-bounded, security-labelled projection.
2. Delivers it to the agent's PTY as context.
3. Records the outcome through durable handoff state and Discussion; it creates `shared_into` only after confirmed delivery and only while the source row physically exists.

Delivery is honestly **at most once**, not exactly once, across the Postgres/PTY boundary. The saga uses two constrained axes:

```text
deliveryStatus: prepared → dispatching → delivered | refused | unknown
recordStatus:   pending → recorded | failed; recorded → withdrawn
```

`prepared` and `dispatching` permit only `recordStatus=pending`. A terminal delivery status permits `pending`, `recorded`, `failed`, or `withdrawn`; only `recorded` can become `withdrawn`, and `failed` has no outgoing transition. A crash anywhere between the durable `dispatching` commit and the delivery-outcome commit resolves to `unknown`, and bytes are never automatically reinjected. A same-ID retry is a verbatim replay; any delivery re-attempt uses a new ID.

Each `handoffId` is the command's `clientMutationId`. Its idempotency hash covers only stable submitted inputs; resolved content version, session epoch, and rendered-envelope hash are retained separately as first-attempt audit facts. The source and target session must be in the same Space. A prepared source snapshot authorizes later recording despite permission drift or soft deletion, but it does not fabricate an edge if the source row was physically removed. Refused, unknown, or missing-source outcomes record Discussion plus audit without `shared_into`; a missing source is exposed as `sourceMissing`, so the graph never claims delivery that was not confirmed. Withdrawal changes the per-handoff record from `recorded` to `withdrawn`; it never edits the correlated message or erases a historical existence edge.

### D12. The Space menu is data

- Every Space owns a revisioned `MenuConfig`.
- The shipped menu is a default config, not hardcoded chrome.
- A view item may own at most one bounded level of leaf children; leaves cannot nest again.
- The Workspace row and its Tasks, Sessions, Docs, and Teammates children are encoded in that data rather than inferred by position or hardcoded UI logic.
- References are unique across the complete config, including parent items and children.
- Only Space admins may update it.
- Writes carry a revision-free `MenuConfigPayload` plus `expectedRevision`; the revision exists only on stored/read `MenuConfig`.
- Members converge through a full-payload `menu.updated` event.
- Settings is required and cannot be removed.
- Missing or corrupt data falls back to the versioned shipped default without losing the stored revision needed for repair.
- An unsupported future `schemaVersion` is preserved raw, rendered through a default fallback, and refused on edit with `details.reason='menu_upgrade_required'`; an older client may never overwrite newer config.
- Future menu entries must be registered; no new UI surface may hardcode itself into the rail.

### D13. Feed has a durable identity

The adopted target identifies the Space default feed by a persisted `default_channel_id`. Heuristics such as "first channel" or a channel named `general` are forbidden. Its deletion rule requires selecting a successor or explicitly placing the Space in a no-feed state.

### D14. Navigation and keyboard behavior are contracts

- Workspace is a caret view item.
- Every group sub-item is a pre-filtered Entity View using the same registry-driven grammar.
- The command palette is first-class and targets addressable entities and implemented views.
- Routes preserve panel stack, pins, tabs, origin, and collection query state within a total length cap.
- Keyboard dispatch has an explicit priority chain.
- The browser-proof guaranteed paths are `/` for the command palette, `g ,` for Settings, and panel-focused `p` for pinning.
- `Mod` means Meta on macOS and Ctrl on Windows/Linux. `Mod` shortcuts are conveniences only where browser receive tests prove they are interceptable; browser/OS-reserved chords are never application shortcuts or advertised as such.
- A focused terminal owns the keyboard except for the physical `Ctrl+Backquote` blur chord, which must deliver zero bytes to the PTY.

### D15. Remote is deferred and never changes the local model

Phase 1 has one implicit local Server. Remote transport, gateway routing, multi-Server connections, remote authentication, and relays are Phase 2. They are documented separately and must reuse this domain rather than create `remote_workspace`, `hubspace`, or remote-only graph entities.

### D16. Message-first delivery has one public authoring path

The adopted target makes public communication stored-first through `messages.*`; `message_batch` is only the nullable correlation value carried by ordinary singularly anchored message rows, never an entity or table. The frozen `execution.prompt` v1 route is targeted to remain solely as an internal adapter: only the audited Server delivery principal may invoke it for a pre-reserved stored message. Every Member/Teammate caller is targeted to receive `forbidden` with `details.reason='use_message_send'` before queue admission and write zero PTY bytes.

The adopted target requires every Teammate-authored live delivery, whether a top-level send or reply, to reserve under one durable row-locked unordered work-session-pair budget. The key contains no thread root. The first four consecutive Teammate reservations are admitted; a Member-authored message resets the same locked row. The next Teammate attempt becomes `failed_permanent/automated_wake_limit`, falls back to inbox, and writes zero PTY bytes. `canMessage`, `canContactSession`, and `canHandoffEntity` are independent authorization decisions.

### D17. Interaction Profiles own policy; templates do not become entities

The adopted target defines `interaction_profile` as a restricted, versioned, discussable core entity with a named draft/validation/activation/retirement family. It selects a static Server/UI template key/version and owns prompt, tool-discovery, named feed scope, composer, and `explicit-only` capture policy. The proposed immutable `work_session_interaction_pins` row is the sole runtime authority; `selected_profile` is a recorder-owned projection. Static templates remain typed registry assets with no entity, messages, authorship lifecycle, API family, or CLI noun. Profiles can narrow capabilities but never grant them.

### Governing-source map

| Decision | Governing source |
|---|---|
| D1 Server terminology | Workspace-layout spec §0 RULING I, §1, §1.1, §4 |
| D2 identity versus collaboration roles | `01-LAWS.md` T-L7, T-L9; `02-NODE-AND-GATEWAY.md` §§2, 4 |
| D3 Space single-homing | `01-LAWS.md` T-L5, T-L9; workspace-layout spec §4 |
| D4 Workspace View and grandfathered symbols | Workspace-layout spec §§1, 1.1, 5 |
| D5–D9 ProjectResource/projection model | Workspace-layout spec §§7–8 |
| D10 terminal ownership/rendering | Workspace-layout spec §5.2a–c; `04-EXECUTION-TRANSPLANT.md` |
| D11 share into session | Workspace-layout spec §§5.7, 8 |
| D12 Space menu | Workspace-layout spec §§2.3, 8 |
| D13 default feed | Workspace-layout spec §8.2 |
| D14 navigation and keyboard | Workspace-layout spec §§2.1–2.3, 5.8 |
| D15 Phase boundary | Workspace-layout spec §0 RULING B and §4; remote companion document |

---

## 3. Ubiquitous language

| Term | Exact meaning | Must not mean |
|---|---|---|
| **Server** | Top-level user-facing tm8 domain containing Accounts, ProjectResources, execution capability, and Spaces | A Space, gateway, URL, or UI workspace |
| **`tm8-server`** | Process/executable hosting one Server | A second product-domain noun |
| **Gateway** | Optional Phase-2 router, authenticator, relay, and hosted-Server spawner | Owner of graph data or a Server itself |
| **Connection** | Client configuration used to reach a Server directly or through a gateway | A graph edge |
| **Space** | Single-homed collaboration, membership, permission, and graph boundary | Server root or generic screen |
| **Workspace** | Three-panel work view inside a Space | Root container, tenant, database, or remote node |
| **ProjectResource** | Server-scoped configured execution root and project-settings authority | Graph entity or repository identity |
| **Project projection** | Restricted Space entity representing a linked ProjectResource | Independent settings authority |
| **Member** | Human account's membership entity in one Space | Server account or agent persona |
| **Team member / teammate** | Agent persona owned by a human Space member | Human account |
| **Work session** | Space entity representing an agent process hosted by the Server execution runtime | Terminal byte stream itself |
| **Remote** | Relative adjective for another Server or its Space | Entity kind or container |

Language rules:

1. Say **Server contains Spaces**.
2. Say **a Space is homed on a Server**.
3. Say **open the Workspace in a Space**.
4. Say **link a ProjectResource to a Space** and **open its project projection**.
5. Say **connect to a remote Server**, not "open a remote workspace."
6. Never use `hubspace`.

---

## 4. Domain boundaries and cardinalities

| Relationship | Cardinality | Authority |
|---|---:|---|
| `tm8-server process → Server` | 1:1 in the current architecture | Process bootstrap and Server configuration |
| `Server → Space` | 1:many | Server database; Space is single-homed |
| `Server → Account` | 1:many | Identity block |
| `Account → Space membership` | 1:many | `members`; a role is Space-local |
| `Server → ProjectResource` | 1:many | `projects.*` |
| `Space ↔ ProjectResource` | many:many within one Server | `space_projects` |
| `(Space, ProjectResource) → project projection` | exactly 1 stable mapping | **Proposed:** `project_links` + materializer |
| `work_session ↔ project projection` | many:many within one Space | **Proposed:** writable `in_project` edges |
| `work_session → launch ProjectResource` | 0..1 provenance; target immutable | Implemented storage `work_sessions.project_id`, proposed read name `launchProjectId`; current write-path immutable, dossier adds trigger |
| `team_member → interaction_profile` | 0..1 future-spawn default | **Proposed:** guarded `defaults_to_profile` edge |
| `work_session → interaction_profile` | exactly 1 immutable selection | **Proposed:** `work_session_interaction_pins` authority + recorder-owned `selected_profile` projection |
| `team_member → work_session` | many:many participation | **Proposed:** guarded `participates_in` edges |
| `Space → entity` | 1:many | `entities.space_id` |
| `entity ↔ entity` | many:many within one Space | `edges` |
| `work_session → live PTY` | 1:0..1 on its home Server | execution runtime; bytes never enter Postgres |

No cross-Server foreign key or transaction is allowed.

---

## 5. Entity model

### 5.1 Envelope plus typed detail

Every graph entity uses the universal `entities` envelope for identity, Space ownership, hierarchy, ordering, author, visibility, version, activity, timestamps, and soft deletion. Kind-specific fields live in one typed detail table or the validated custom-entity store.

The current implemented core-kind registry contains:

```text
channel, task, message, member, team_member,
doc, file, spell, skill, pull_request, commit,
work_session, collection
```

The proposed post-freeze amendment adds `project` as a restricted materialized core kind and `interaction_profile` as a restricted lifecycle-owned core kind. Direct generic creation remains excluded at both the contract and server dispatch layers. `interaction_profile` uses universal reads, versions, Discussion, activity, reactions, and connections; its policy content is writable only through its named family. Its handoff projection is a sanitized summary and never includes prompt/tool/credential policy.

Custom kinds remain Space-scoped `c:*` kinds with scalar fields only. Relationships always use edges.

### 5.2 Graph relationships

Existing universal relationships remain intact, including `depends_on`, `assigned_to`, `working_on`, `attached_to`, `contains`, `completed_by`, `tracks`, `equips`, and reactions.

The amendment adds:

- `in_project`: task/session/PR/commit to project projection
- `shared_into`: source entity to work session, recorder-owned
- `participates_in`: Teammate to work session, with a locked last-participant guard
- `authored_from`: message to source work session, immutable and Server-owned
- `defaults_to_profile`: Teammate to Interaction Profile, guarded configuration
- `selected_profile`: work session to Interaction Profile, immutable recorder-owned projection

Both require origin guards for materialized records.

### 5.3 Messages and sessions

Messages are entities anchored to any readable entity. A work session is an entity whose graph state is durable while live terminal bytes remain an ephemeral socket stream. A transcript is a document attached after exit rather than a database recording of terminal bytes. Chat and Discussion are projections of this one message store. `message_batch_id` is nullable correlation on message rows; there is no batch entity/table. Feed `authored`/reply traversal rechecks the canonical anchor's read authorization before returning each item, preventing a visible session from leaking a restricted task/channel message.

---

## 6. Tables and storage model

### 6.1 Implemented table groups

The current migration sequence creates 43 tables. This count was verified from the 43 `CREATE TABLE` statements in `db/migrations/001_core_graph.sql` through `006_execution_side.sql`; migrations `007`–`014` add catalog functions, policies, grants, and fixes rather than tables.

| Group | Tables | Responsibility |
|---|---|---|
| Server/Space resources | `spaces`, `projects`, `space_projects`, `task_axes` | Space boundaries, configured execution roots, active links, task configuration |
| Graph foundation | `entity_kinds`, `entities`, `entity_counters`, `edge_types`, `edges`, `entity_versions` | Universal envelope, registries, relationships, derived counters, content history |
| Entity detail | `channels`, `tasks`, `documents`, `files`, `pull_requests`, `commits`, `spells`, `skills`, `collections`, `work_sessions`, `messages`, `custom_entities` | Typed content for core and custom entities |
| Identity | `user_profiles`, `accounts`, `members`, `team_members`, `auth_sessions`, `space_invites` | Server authentication and Space-local actors/roles |
| Read/event model | `activity`, `read_marks`, `notifications`, `notification_outbox`, `space_event_seq`, `workspace_events`, `saved_views` | Feeds, personal state, durable events, saved lenses |
| Ledgers | `point_events`, `command_ledger`, `undo_tokens` | Append-only points, idempotency/audit, reversible command metadata |
| Operational side tables | `session_manifests`, `session_modals`, `stream_grants`, `file_upload_slots`, `tracking_refresh_requests` | Execution, streams, uploads, and provider-work queues |

### 6.2 Decided additive storage changes

The post-freeze amendment dossier must define exact DDL for:

- `project_links(space_id, project_id, project_entity_id, ...)`
- Project projection detail/content storage
- Additive `ProjectResource.linkFrozen` and `activeLinkCount` fields
- `linkPr`/`linkCommit` optional `projectId`, their binding/DTO changes, and the idempotent inverse/correction command
- Revisioned per-Space `MenuConfig` storage
- Revision-free menu write payloads, the admin write command, and the `menu.updated` event-union variant
- Share-into-session command, two-axis saga, per-session handoffs read DTO, withdrawal command/event, and share-projection registry
- Handoff-aware PTY queue API with pending-unique `handoffId` entries, durable dispatch handshake, awaited write outcomes, and command-ledger replay bypass
- RULING J contract/storage delta: `launchProjectId` read mapping; `workdir` scratch variant and `confirmUntrusted`; Project-locked association validation; exact-one CLI auto-fill; live-edge-or-launch-root unlink guard; counter/invalidation parity; conditional audited backfill; origin-versus-mutability matrix
- Database immutability trigger for `work_sessions.project_id` plus a 16-live-association cap and owner/admin deletion repair
- Persisted `default_channel_id`
- `project` kind registry row
- `interaction_profile` kind registry row and restricted detail/lifecycle storage
- `interaction_profiles`, `work_session_interaction_pins`, and `work_session_view_preferences`
- guarded `participates_in` and immutable recorder-owned `authored_from` edge rows, plus nullable `messages.message_batch_id`
- `session_message_deliveries` plus unordered-pair `session_wake_budgets` with row-locked reservation/reset/cleanup
- nullable `notifications.recipient_team_member_id` plus recipient/read-state indexes
- `in_project` and `shared_into` edge registry rows with origin guards
- Project projection materializer functions
- Uniform live-endpoint edge predicates
- Delete/restore counter recomputation
- RLS, backfill, rollback, repair, and negative tests

This list summarizes the scope only. Workspace-layout spec §8 is authoritative and must be mirrored exactly in the amendment dossier, including contract/Zod changes, route/query registry changes, conformance, facade fixtures, backfill, RLS, rollback, and repair. The exact projection-detail and handoff table names belong there; implementations must not invent them before approval.

### 6.3 Database authority laws

- Reads use RLS under transaction-local identity claims.
- The application role has no direct table write privileges.
- Writes go through the enumerable SECURITY DEFINER RPC catalog.
- `clientMutationId` provides universal idempotency and event reconciliation.
- `expectedVersion` protects entity content from lost updates.
- Database triggers own structural invariants, counters, snapshots, and event capture.
- `workspace_events.seq` is monotonic per Space.
- Terminal bytes and secret values never enter Postgres.

---

## 7. API architecture

### 7.1 One contract

UI, CLI, future MCP tools, direct clients, and eventually remote clients project one operation catalog. There must not be separate local and remote graph APIs.

The implemented contract currently declares 81 operations: 79 v1 and two reserved. The generated router exposes 80 HTTP bindings plus the WebSocket operation. With a configured database, the current Phase-1 server wires 28 HTTP semantic handlers; absent handlers answer honest `501 not_implemented`.

This is implementation status, not a reduction of the target contract.

### 7.2 API groups

| Family | Purpose |
|---|---|
| `identity.*`, `spaces.*` | Server identity surface, Space discovery/configuration, membership, invites, axes, awards |
| `projects.*` | Server-scoped ProjectResource registry and Space linking |
| `entities.*` | Uniform graph reads, hierarchy, content mutation, activity, reactions, points |
| `entities.commands.*` | Atomic domain transitions such as complete, work, pull, and tracking links |
| `edges.*`, `edgeTypes.*` | Typed graph relationships |
| `messages.*` | Anchored discussion and replies |
| `interactionProfiles.*` | Restricted draft, validation, preview, activation, retirement, and default lifecycle |
| `collections.*`, `graph.*`, placements, search | Registry-driven list, graph, grouping, placement, and discovery surfaces |
| inbox, read marks, saved views, actions | Personal state and capability discovery |
| events and presence | Durable Space events, replay, and ephemeral presence |
| `execution.*` | Spawn, internal stored-message delivery adapter, termination, and stream authorization; `execution.prompt` is not a public authoring capability |
| files | Authorized blob lifecycle |
| `entityKinds.*` | Runtime custom-kind registry |

**Adopted amendment-family ownership (proposed, not shipped):** the W0 A01–A20 target additionally assigns `spaces.menu.*`, `spaces.defaultChannel.*`, and `spaces.interactionProfile.*`; `projects.associations.correct`; `handoffs.*`; `messages.attachments.*` and `messages.delivery.*`; `entities.feed` and `entities.context`; `interactionProfiles.*`; and `teamMembers.interactionProfile.*`. The dossier owns their exact bindings and DTOs; this list neither adds catalog rows nor asserts handlers in current source.

### 7.3 Project API boundary

- Settings and lifecycle use the ProjectResource ID through `projects.*`.
- Graph navigation and entity routes use the Space-local project projection entity ID.
- The server resolves the two through `project_links`.
- The UI must not require users to understand the dual IDs.
- Project projection DTOs must state the resource ID explicitly.
- Raw `workingDir` and node-wide administrative data should remain on the settings/resource surface, not be exposed automatically to ordinary Space members.

### 7.4 API laws

- Success envelope: `{data, requestId}`.
- Closed error taxonomy with stable `details.reason` for domain-specific refusal.
- Keyset cursors for lists; event `seq` for durable replay.
- Server-owned derived truth: clients render rather than recompute badges, capabilities, counters, and relationships.
- Unknown routes are `not_found`; catalogued but unavailable operations are `not_implemented`.
- Capability discovery must describe what this Server composition can actually do.

---

## 8. Current state versus target design

| Area | Implemented now | Decided target |
|---|---|---|
| Root noun | Older docs still mix root `workspace` and process `server` | Server is the sole root domain; `hubspace` removed |
| Project | Server resource + active Space links | Resource + stable per-Space projection entities |
| Project graph kind | Not present | Restricted materialized `project` kind |
| Workspace | Existing UI route/screen | Canonical three-panel Space work view |
| Menu | Existing/hardcoded surfaces | Revisioned per-Space data |
| Terminal | Execution and terminal transplant exists | TerminalPool-backed work-session Content renderer |
| Chat/feed | One message/activity baseline; no `entities.feed` | One-store Chat/Discussion projections with versioned named scopes; request-only `default` resolves to a concrete name and is never pinnable |
| Interaction Profile | Absent | Restricted entity + immutable resolved session pin; static templates remain registry assets |
| Message delivery | Public `execution.prompt` handler exists; no durable delivery/budget tables | Stored-first messages, internal-only prompt adapter, durable delivery attempts and universal unordered-pair budget |
| Share to agent | Prompt/composer mechanics only | At-most-once typed handoff command and durable record |
| Remote | Not built | Phase-2 separate design; local domain unchanged |

No document should describe a decided target as already implemented.

---

## 9. Architecture quality assessment

**Assessment basis (2026-07-26):** these qualitative scores evaluate the adopted local target design after the K/L/M delta. They do not rate current source or implementation completeness, and they do not certify that an adopted mechanism is shipped.

### 9.1 Domain — **9.2/10, excellent**

**Why it is strong**

- Server, Space, Workspace, ProjectResource, project projection, and work session have distinct responsibilities.
- Single-homing eliminates distributed ownership ambiguity.
- Project resource-plus-projection reconciles machine-local execution truth with graph participation.
- Server authentication and Space collaboration authorization remain separate.
- Remote expansion is prevented from contaminating the local model.

**Remaining documentation risk**

- The Server terminology must be applied across the canonical corpus.
- Phase-2 connection and gateway concepts must remain visibly deferred.
- The final Project projection DTO needs exact field-level disclosure rules.

### 9.2 Entities and tables — **8.8/10, very strong**

**Why it is strong**

- Envelope-plus-detail gives every kind universal behavior without flattening typed content.
- Edges are the single relationship mechanism.
- Config, operational state, ledgers, and graph entities are separated rather than forced into one abstraction.
- Project projection identity survives unlink/relink while active linkage remains independently authoritative.
- RLS reads plus RPC-only writes make the mutation surface auditable.

**Costs and risks**

- Project fan-out, materialized-edge origin, counter repair, and handoff sagas are sophisticated and require exact transactional tests.
- The additive DDL is not final until the amendment dossier names every table, constraint, trigger, and rollback.
- Complexity is justified, but it must not be duplicated in handlers and database functions.

### 9.3 Ubiquitous language — **target 9.3/10; current repository consistency 6.5/10**

**Why the target language is strong**

- Every important noun has one job.
- Server versus `tm8-server` cleanly separates product domain from runtime.
- Workspace becomes concrete and user-visible rather than an overloaded storage term.
- Remote is an adjective, preventing an unnecessary parallel domain.

**Why current consistency is lower**

- Existing architecture documents still use `workspace` for the old root container.
- RULINGS I–M are recorded and delta-verified through v2.11; the older canonical corpus still needs a classified terminology pass without renaming grandfathered `Workspace*` symbols, plus the Vega-logged T-D20/R17 reversal at adoption.
- Code symbols named `Workspace*` require grandfathering notes so engineers do not "correct" them incorrectly.

After the classified terminology pass and adoption, this becomes one of the design's strongest areas.

### 9.4 APIs — **8.7/10, very strong design; partial implementation**

**Why it is strong**

- One catalog drives HTTP, CLI, events, and future remote clients.
- Honest 501 behavior prevents simulated completeness.
- DTOs, Zod schemas, errors, idempotency, version checks, and event envelopes form a rigorous seam.
- The ProjectResource/projection ID boundary preserves clean configuration and graph APIs.
- Remote reuse of the same graph catalog prevents API divergence.

**Remaining gaps**

- The amendment dossier must freeze new operation names and DTOs for project correction, handoffs, menu writes, and handoff withdrawal.
- Event live-subscription control is not fully wired in the current server.
- Only 28 HTTP semantic handlers are currently implemented from the larger catalog.
- Phase-2 connection/gateway control-plane APIs are intentionally separate and unresolved.

### 9.5 Overall — **9.0/10 local architecture**

The architecture is unusually coherent for a system combining collaboration, graph data, machine-local execution, live terminal streams, and future multi-Server operation. Its strongest quality is explicit authority: each fact has a named owner and write path.

The main danger is not conceptual weakness; it is specification density. The amendment dossier, terminology migration, and transactional conformance matrix must be completed before implementation so that multiple correct-looking but incompatible interpretations cannot emerge.

---

## 10. Documentation finalization gates

1. **Completed:** close the workspace-layout review (Round 9: GO), record RULINGS I–M, close the RULING J delta review (Rounds 10–11: GO), and close the K/L/M+C6/C7 delta review (Round 12: GO) in v2.11.
2. Obtain Vega's adoption and terminology-equivalence verification.
3. Author, independently review, and approve the exact post-freeze §8 amendment dossier.
4. Perform a classified Server/Workspace terminology pass over architecture docs and `STATE.md`.
5. Freeze Project projection disclosure/IDs and all dossier operation names, DTOs, DDL, events, backfills, repairs, and conformance tests.
6. Capture the approved Workspace View reference, measured layout breakpoints, and browser-matrix keyboard receive evidence.
7. Prototype-validate the 32,768-byte share-projection cap.
8. Publish a current-versus-target traceability matrix.
9. Keep implementation stopped until explicit user direction.
