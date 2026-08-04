# tm8 — API Catalog, Grouped and Explained

**Status:** documentation-only companion, 2026-07-26  
**Scope:** every operation in the current frozen `packages/contract` catalog, followed by the v2.11 post-freeze dossier family and Phase-2 additions  
**Catalog baseline:** 81 operations: 79 v1 and 2 reserved; 80 HTTP bindings and 1 WebSocket binding  
**Implementation note:** `v1` below means required by the target v1 contract, not necessarily implemented today. The source baseline is 81 catalog rows, 80 mounted HTTP routes plus one WebSocket binding, and a 78 registerable HTTP-handler ceiling (81 minus the WebSocket row and two reserved rows). With a configured database the current Server wires 28 semantic HTTP handlers; catalogued routes without a handler return honest `501 not_implemented`. Workspace-layout spec §8 defines the dossier that closes the amended portion of that implementation gap.  

> **Normative subordination:** `packages/contract/src/catalog.ts`, its DTO/Zod schemas, the FINAL architecture corpus, and approved amendment dossiers govern. This guide explains those contracts but does not create new operation names or authorize implementation.

---

## 1. How the API architecture works

tm8 has one transport-independent operation catalog. The web UI, CLI, agents, future MCP tools, direct remote clients, and gateway-mediated clients are different projections of that same catalog.

```text
UI / CLI / agent / future MCP
            │
            ▼
operation name + shared DTO
            │
            ▼
HTTP or WebSocket facade
            │
            ▼
semantic handler
            │
            ▼
RLS read or SECURITY DEFINER command
            │
            ▼
Postgres state + WorkspaceEvent
```

The important API laws are:

- Responses use the shared contract shapes; HTTP success uses `{data, requestId}`.
- Reads and commands execute as the authenticated Server account under Space membership and RLS.
- Every mutation carries `clientMutationId` and must be safely replayable.
- Entity content updates use `expectedVersion` to prevent lost updates.
- Lists use keyset cursors; durable event replay uses the Space sequence.
- The Server owns derived values such as counters, capabilities, badges, titles, blocked state, and pull staleness.
- A catalogued but unavailable operation returns `501 not_implemented`; an unknown route returns `404 not_found`.
- The closed error taxonomy and stable `details.reason` values carry machine-readable failures.

### Operation kinds

| Kind | Meaning |
|---|---|
| `read` | Observes authoritative state without mutating it. A read may use `POST` when its structured query is too rich for URL parameters. |
| `command` | Performs an authorized, idempotent domain transition. |
| `stream` | Opens a long-lived transport for live events. |
| `reserved` status | The operation name and route are intentionally occupied, but v1 returns `501` until the feature is built. |

---

## 2. Group summary

| Group | Count | Responsibility |
|---|---:|---|
| Identity and Spaces | 19 | Current identity, Space lifecycle, membership, settings, invites, task axes, scores |
| Universal entities | 13 | One CRUD/read grammar shared by graph entity kinds |
| Domain commands and tracking | 6 | Atomic transitions that cannot be expressed as a generic patch |
| Edges and edge types | 5 | Typed graph relationships |
| Messages | 4 | Discussion anchored to any readable entity |
| Collections, graph, placements and undo | 4 | Structured querying, graph projections, drag intent, compensation |
| Search | 1 | Reserved ranked discovery |
| ProjectResources | 6 | Server-local execution-root registry and Space links |
| Files and bridge blobs | 5 | Authorized blob upload/download lifecycle |
| Personal state | 3 | Inbox and per-member read position |
| Saved views | 4 | Persisted query/layout definitions |
| Action discovery | 1 | Contextual command-palette capabilities |
| Events and presence | 3 | Durable replay, live updates, ephemeral presence |
| Execution | 4 | Work-session spawn, prompt, termination and stream grants |
| Custom entity kinds | 3 | Space-scoped custom-kind registry |
| **Total** | **81** | **79 v1 + 2 reserved** |

---

## 3. Identity and Spaces — 19 operations

These operations establish who is calling and which Space-scoped collaboration surfaces they can access. Authentication/session establishment is a Server boundary concern; `identity.get` is the catalogued read of the resolved identity.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `identity.get` | `GET /v2/identity` | read | Returns the authenticated account/actor context and Server-visible identity information. |
| `spaces.list` | `GET /v2/spaces` | read | Lists Spaces visible to the caller with compact navigation information. |
| `spaces.create` | `POST /v2/spaces` | command | Creates a Space and its required default configuration under the authenticated Server. |
| `spaces.get` | `GET /v2/spaces/:spaceId` | read | Returns one Space's basic metadata. |
| `spaces.update` | `PATCH /v2/spaces/:spaceId` | command | Updates authorized Space metadata. Dedicated settings commands own configuration that has stronger revision rules. |
| `spaces.navigation` | `GET /v2/spaces/:spaceId/navigation` | read | Returns the caller, unread totals, channel tree, and data needed to construct Space navigation. |
| `spaces.home` | `GET /v2/spaces/:spaceId/home` | read | Returns Server-defined Home/My Work presets such as ready-to-pull, in-flight, needs-me, and compact activity. |
| `spaces.settings` | `GET /v2/spaces/:spaceId/settings` | read | Returns the authorized Space settings projection: metadata, members, invites, axes, and amendment-added settings such as menu/default feed. |
| `spaces.members.list` | `GET /v2/spaces/:spaceId/members` | read | Lists human Space memberships and their Space-local roles. |
| `spaces.invites.list` | `GET /v2/spaces/:spaceId/invites` | read | Lists invitations visible to Space administrators. |
| `spaces.invites.create` | `POST /v2/spaces/:spaceId/invites` | command | Creates a bounded/revocable invitation to a Space. |
| `spaces.invites.revoke` | `POST /v2/spaces/:spaceId/invites/:inviteId/revoke` | command | Revokes an unused or still-active Space invitation. |
| `spaces.invites.redeem` | `POST /v2/invites/redeem` | command | Redeems an invitation code and creates/returns the caller's Space membership. |
| `spaces.taskAxes.list` | `GET /v2/spaces/:spaceId/task-axes` | read | Lists the Space's configurable task classification axes and values. |
| `spaces.taskAxes.create` | `POST /v2/spaces/:spaceId/task-axes` | command | Creates a task axis and its allowed values. |
| `spaces.taskAxes.update` | `PATCH /v2/spaces/:spaceId/task-axes/:axisId` | command | Renames, reorders, or changes an existing task axis under validation. |
| `spaces.taskAxes.delete` | `DELETE /v2/spaces/:spaceId/task-axes/:axisId` | command | Removes a task axis according to the defined cleanup/invariant policy. |
| `spaces.leaderboard` | `GET /v2/spaces/:spaceId/leaderboard` | read | Returns ranked Space actors from the append-only points ledger. |
| `spaces.awards` | `GET /v2/spaces/:spaceId/awards` | read | Returns award/point history with the actor, recipient, reason, and related entity. |

---

## 4. Universal entity grammar — 13 operations

These operations work across core and custom entity kinds. Kind-specific detail is carried in a discriminated content shape rather than separate `/tasks`, `/docs`, or `/sessions` CRUD families. Restricted materialized kinds such as `work_session`, `message`, and the proposed `project` projection refuse generic creation or mutation where their owning command/materializer must be the writer.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `entities.get` | `GET /v2/entities/:id` | read | Returns one normalized `EntityDetail`: envelope, typed content, hierarchy, grouped connections, counters, capabilities, and derived state. |
| `entities.create` | `POST /v2/entities` | command | Creates an allowed entity kind with typed content, optional parent/position, and initial relationships. |
| `entities.patch` | `PATCH /v2/entities/:id` | command | Applies a kind-validated content patch guarded by `expectedVersion`. |
| `entities.move` | `POST /v2/entities/:id/move` | command | Reparents or reorders an entity while enforcing hierarchy and cycle rules. |
| `entities.delete` | `DELETE /v2/entities/:id` | command | Soft-deletes the entity or ruled subtree and updates derived relationship visibility/counters. |
| `entities.restore` | `POST /v2/entities/:id/restore` | command | Restores a soft-deleted entity/subtree and recomputes affected derived state. |
| `entities.children` | `GET /v2/entities/:id/children` | read | Returns a keyset-paged list of direct children. |
| `entities.hierarchy` | `GET /v2/entities/:id/hierarchy` | read | Returns parent, path, and bounded tree context for navigation. |
| `entities.connections` | `GET /v2/entities/:id/connections` | read | Returns live incoming and outgoing relationships grouped by registered edge type. |
| `entities.versions` | `GET /v2/entities/:id/versions` | read | Lists immutable content-version history for versioned entity kinds. |
| `entities.activity` | `GET /v2/entities/:id/activity` | read | Returns the entity's activity feed, including relevant graph and discussion events. |
| `entities.react` | `PUT /v2/entities/:id/reaction` | command | Enables/disables the caller's like, dislike, or star under mutual-exclusion and counter rules. |
| `entities.points.add` | `POST /v2/entities/:id/points` | command | Appends an authorized point grant to the immutable ledger; it never edits a total directly. |

---

## 5. Domain commands and tracking — 6 operations

Commands exist where a generic entity patch would be too weak or unsafe. Each command owns its complete transaction, activity, points, relationships, and event emission.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `entities.commands.complete` | `POST /v2/entities/:id/commands/complete` | command | Completes a task after criteria/authorization checks and atomically records completers and award effects. |
| `entities.commands.work` | `POST /v2/entities/:id/commands/work` | command | Moves a task through ordinary work statuses and maintains `working_on`. **Proposed safety amendment:** refuse `done` with `invariant_violation/details.reason='use_complete_command'`; only `entities.commands.complete` may cross the criteria/completer/award gate into `done`. |
| `entities.commands.pull` | `POST /v2/entities/:id/commands/pull` | command | Builds a deterministic version-pinned projection for another context and records pull provenance/staleness metadata. |
| `entities.commands.linkPr` | `POST /v2/entities/:id/commands/link-pr` | command | Upserts/links a pull-request entity to the target work item; the pending amendment adds an optional explicit Project association. |
| `entities.commands.linkCommit` | `POST /v2/entities/:id/commands/link-commit` | command | Upserts/links a commit entity to the target work item; the pending amendment adds an optional explicit Project association. |
| `tracking.refresh` | `POST /v2/tracking/refresh` | command | Queues an asynchronous refresh of provider-backed PR/commit metadata and returns an accepted result. |

---

## 6. Edges and edge types — 5 operations

Edges are tm8's one graph-relationship grammar. Assignment, dependencies, tracking, attachment, equipping, project association, and other relationships use registered types rather than bespoke route families.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `edges.list` | `GET /v2/edges` | read | Lists edges filtered by source, destination, type, direction, and cursor. |
| `edges.create` | `POST /v2/edges` | command | Creates an allowed typed relationship after endpoint, Space, props-schema, and authorization validation. |
| `edges.patch` | `PATCH /v2/edges/:edgeId` | command | Changes mutable edge properties; server/materializer-owned origins are refused. |
| `edges.delete` | `DELETE /v2/edges/:edgeId` | command | Removes a mutable edge; immutable/materialized history requires its owning correction command. |
| `edgeTypes.list` | `GET /v2/edge-types` | read | Returns the edge registry: names, allowed endpoint kinds, direction and property schemas. |

---

## 7. Messages — 4 operations

Messages are entities, but their access pattern is anchor-first. The same Discussion component can therefore attach to channels, tasks, docs, sessions, project projections, and other readable entities.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `messages.list` | `GET /v2/entities/:anchorId/messages` | read | Lists an anchor's discussion, optionally narrowed to a thread/root and paged by cursor. |
| `messages.post` | `POST /v2/messages` | command | Creates a message with `anchorId`, body, optional reply parent, mentions, and attachments. |
| `messages.edit` | `PATCH /v2/messages/:id` | command | Replaces the body/mentions of an authorized message and records its edited state and resulting activity/event. |
| `messages.delete` | `DELETE /v2/messages/:id` | command | Redacts/tombstones a message without destroying the surrounding thread structure. |

---

## 8. Collections, graph, placements and undo — 4 operations

These APIs power lists, boards, trees, feeds, galleries, graph canvases, drag/drop, and reversible UI commands without creating one endpoint per screen.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `collections.query` | `POST /v2/collections/query` | read | Runs a typed entity query with Space, kind, filters, grouping, sorting, hierarchy and keyset pagination. |
| `graph.query` | `POST /v2/graph/query` | read | Returns a bounded node/edge projection for neighborhood, dependency, hierarchy, or graph-canvas views. |
| `placements.apply` | `POST /v2/placements` | command | Resolves a drag/drop intent into its authorized atomic effect, such as a move, edge, or message promotion. |
| `commands.undo` | `POST /v2/undo` | command | Redeems a short-lived undo token and executes the registered inverse of a reversible command. |

---

## 9. Search — 1 reserved operation

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `search.query` | `GET /v2/search` | read, reserved | Reserves ranked cross-entity discovery. Until implemented, it returns `501`; the palette uses recent/known entities and action discovery. |

---

## 10. ProjectResources — 6 operations

These APIs manage Server-local configured execution roots. They do not use generic entity mutation. Space navigation uses the proposed project projection entity, while settings and execution configuration use the ProjectResource ID.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `projects.list` | `GET /v2/projects` | read | Lists ProjectResources visible to the caller at the Server/settings boundary. |
| `projects.create` | `POST /v2/projects` | command | Creates a configured execution root with required `workingDir`, optional `repoUrl`, trust, and defaults. |
| `projects.get` | `GET /v2/projects/:projectId` | read | Returns one ProjectResource and its authorized configuration details. |
| `projects.update` | `PATCH /v2/projects/:projectId` | command | Updates ProjectResource configuration and, after the amendment, fans materialized changes to active Space projections. |
| `projects.link` | `POST /v2/spaces/:spaceId/projects` | command | Activates a Server-local Space–ProjectResource link and creates/restores its stable project projection. |
| `projects.unlink` | `DELETE /v2/spaces/:spaceId/projects/:projectId` | command | Deactivates the link and soft-deletes the projection while preserving mapping and relationship history for relink. |

A Space can link many ProjectResources, and one ProjectResource can link to many Spaces on the same Server. A work session can associate with multiple project projections through normal `in_project` edges. Singular `work_sessions.project_id` remains only as immutable launch provenance, exposed as `launchProjectId`; it is not the association authority.

---

## 11. Files and bridge blobs — 5 operations

File entities store metadata in the graph; byte transfer uses brokered storage operations so RLS membership and blob authorization never disagree.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `files.uploadInit` | `POST /v2/files/uploads` | command | Authorizes an upload, validates metadata/limits, and creates a short-lived upload slot. |
| `files.uploadComplete` | `POST /v2/files/uploads/:uploadId/complete` | command | Verifies the uploaded bytes and atomically finalizes the file entity/storage record. |
| `files.uploadAbort` | `POST /v2/files/uploads/:uploadId/abort` | command | Cancels an unfinished upload and safely releases temporary storage. |
| `files.download` | `GET /v2/files/:fileEntityId/download` | read | Reauthorizes access and streams bytes with validated MIME, size, checksum, and disposition. |
| `bridge.fetchBlob` | `GET /v2/bridge/blobs/:fileEntityId` | read, reserved | Reserves membership-checked cross-Server blob retrieval for Phase 2; v1 returns `501`. |

---

## 12. Personal state — 3 operations

Personal state belongs to the authenticated member and does not become shared entity content.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `inbox.list` | `GET /v2/inbox` | read | Returns notifications/inbox items for the caller across visible Spaces on the selected Server. |
| `inbox.markRead` | `PUT /v2/inbox/:notificationId/read` | command | Marks one notification read idempotently. |
| `readMarks.upsert` | `PUT /v2/read-marks/:anchorId` | command | Advances the caller's read cursor for a channel, discussion anchor, or other feed. |

---

## 13. Saved views — 4 operations

A saved view persists a query and optional graph layout. It is distinct from the per-Space menu configuration and from transient URL state.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `savedViews.list` | `GET /v2/spaces/:spaceId/saved-views` | read | Lists private and Space-shared saved queries visible to the caller. |
| `savedViews.create` | `POST /v2/saved-views` | command | Persists a named query, sharing mode, and optional graph layout. |
| `savedViews.update` | `PATCH /v2/saved-views/:viewId` | command | Updates an authorized saved view. |
| `savedViews.delete` | `DELETE /v2/saved-views/:viewId` | command | Deletes an authorized saved view without changing the entities it selected. |

---

## 14. Action discovery — 1 operation

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `actions.list` | `GET /v2/actions` | read | Returns currently available actions for the caller and optional entity context; drives command palette and capability-aware clients. |

Clients do not infer authorization from visible buttons. The Server returns what the caller can actually do in the current context.

---

## 15. Events and presence — 3 operations

Durable graph changes use canonical `WorkspaceEvent` envelopes ordered per Space. Presence is ephemeral and never advances the durable event cursor.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `events.subscribe` | `WS /v2/ws` | stream | Opens the single live event socket for authorized Space subscriptions, graph changes, and ephemeral signals. |
| `events.poll` | `GET /v2/spaces/:spaceId/events` | read | Replays durable events after a Space sequence cursor for startup, reconnect, and polling fallback. |
| `presence.get` | `GET /v2/entities/:id/presence` | read | Returns current ephemeral viewers/actors for an entity without treating presence as stored graph history. |

---

## 16. Execution and work sessions — 4 operations

The Server-hosted PTY is the only execution path. Work-session graph state is durable; terminal bytes remain a live stream and never enter Postgres or `WorkspaceEvent` storage.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `execution.spawn` | `POST /v2/execution/spawn` | command | Creates a `work_session`, composes its launch manifest, chooses an authorized execution root/cwd, and starts the Server PTY under limits. The amendment adds the `workdir` scratch variant and `confirmUntrusted`; additional Project associations are edges, not spawn inputs. |
| `execution.prompt` | `POST /v2/entities/:id/commands/prompt` | command | Frozen v1 internal delivery adapter only. The Server-internal delivery principal may invoke it after message storage and delivery reservation; every Member or Teammate caller is forbidden with `details.reason='use_message_send'` before queue admission and writes zero PTY bytes. |
| `execution.terminate` | `POST /v2/entities/:id/commands/terminate` | command | Requests the single authoritative cancellation/termination path and records the resulting session transition. |
| `execution.streams.attach` | `POST /v2/entities/:id/commands/streams-attach` | command | Authorizes terminal attachment and returns a narrowed, expiring view/drive stream grant; it does not persist terminal bytes. |

The multi-project correction separates two facts:

- `work_session ↔ project projection` is a many-to-many graph relationship.
- One optional singular launch Project may select initial `cwd`/worktree and remains immutable execution provenance. Spawn accepts it through the already-optional `projectId`; the read DTO exposes it as `launchProjectId`. It is not the session's complete Project set.

Spawn with a launch Project creates exactly one normal writable, spawner-authored `in_project` edge. Later associations use ordinary `edges.create`/`edges.delete`; creation takes the ProjectResource lock and revalidates the active Space link plus live projection, returning `project_not_linked` on failure. A live work session may hold at most 16 live `in_project` edges. A Space owner/admin may delete an ordinary agent-created association as the repair path. Unlink is refused while a live session has either a matching association edge or matching `launchProjectId`. Scratch sessions run under `<dataDir>/scratch/<sessionId>` with containment/private-permission rules and explicit untrusted confirmation. Exact schemas, SQL, limits, retention constants, and audit shapes are frozen by the W0 dossier; none is implemented by this document.

---

## 17. Custom entity kinds — 3 operations

Custom kinds are Space-scoped schema registry entries using validated scalar fields. They inherit the universal entity envelope and edge grammar.

| Operation | Binding | Kind | What it does |
|---|---|---|---|
| `entityKinds.list` | `GET /v2/spaces/:spaceId/entity-kinds` | read | Lists core-visible and custom kind definitions available in a Space. |
| `entityKinds.create` | `POST /v2/spaces/:spaceId/entity-kinds` | command | Registers a namespaced custom kind with validated scalar fields and presentation metadata. |
| `entityKinds.update` | `PATCH /v2/spaces/:spaceId/entity-kinds/:kind` | command | Evolves an existing custom-kind schema under compatibility and data-validation rules. |

There is deliberately no generic custom-kind delete operation in the frozen catalog; schema evolution must not orphan existing entities.

---

## 18. Proposed post-freeze API amendments

These are Vega-adopted W0 design scope. At the 2026-07-26 W1 resume boundary, delivered source contained 81 catalog rows; `W0-AMENDMENT-DOSSIER.md` froze the following twenty additive names, bindings, kinds, and DTOs. The adopted target becomes 101 only after those source rows land. This dated resume-boundary statement is not a current-source claim while W1 is in progress; current implementation status must be derived from the catalog and generated metadata.

| ID | Adopted additive operation | Binding | Kind |
|---:|---|---|---|
| A01 | `spaces.menu.get` | `GET /v2/spaces/:spaceId/menu` | read |
| A02 | `spaces.menu.update` | `PUT /v2/spaces/:spaceId/menu` | command |
| A03 | `spaces.defaultChannel.set` | `PUT /v2/spaces/:spaceId/default-channel` | command |
| A04 | `projects.associations.correct` | `POST /v2/entities/:artifactId/commands/correct-project-association` | command |
| A05 | `handoffs.send` | `POST /v2/work-sessions/:workSessionId/handoffs` | command |
| A06 | `handoffs.list` | `GET /v2/work-sessions/:workSessionId/handoffs` | read |
| A07 | `handoffs.withdraw` | `POST /v2/handoffs/:handoffId/withdraw` | command |
| A08 | `messages.attachments.add` | `POST /v2/messages/:messageId/attachments` | command |
| A09 | `messages.attachments.remove` | `DELETE /v2/messages/:messageId/attachments` | command |
| A10 | `messages.delivery.get` | `GET /v2/messages/:messageId/delivery` | read |
| A11 | `entities.feed` | `GET /v2/entities/:id/feed` | read |
| A12 | `entities.context` | `GET /v2/entities/:id/context` | read |
| A13 | `interactionProfiles.propose` | `POST /v2/spaces/:spaceId/interaction-profiles` | command |
| A14 | `interactionProfiles.updateDraft` | `PATCH /v2/interaction-profiles/:profileId/draft` | command |
| A15 | `interactionProfiles.validate` | `POST /v2/interaction-profiles/:profileId/validate` | command |
| A16 | `interactionProfiles.preview` | `POST /v2/interaction-profiles/:profileId/preview` | read |
| A17 | `interactionProfiles.activate` | `POST /v2/interaction-profiles/:profileId/activate` | command |
| A18 | `interactionProfiles.retire` | `POST /v2/interaction-profiles/:profileId/retire` | command |
| A19 | `teamMembers.interactionProfile.setDefault` | `PUT /v2/team-members/:teamMemberId/interaction-profile-default` | command |
| A20 | `spaces.interactionProfile.setDefault` | `PUT /v2/spaces/:spaceId/interaction-profile-default` | command |

### Workspace-layout v2.11 dossier family

- Project projection reads and restricted capabilities through the existing entity grammar.
- Optional explicit `projectId` on `linkPr` and `linkCommit`.
- Idempotent Project-association correction command, including demotion of promoted user edges.
- Share-into-session handoff command with two-axis delivery/record state.
- Per-session handoff history read.
- Per-handoff withdrawal command and event.
- Per-Space MenuConfig read/write with `expectedRevision` and `menu.updated` event.
- Persisted default-channel settings behavior.
- Exact `project_not_linked`, `project_over_cap`, menu conflict, and handoff failure details.

### Multi-project work-session correction

V2.10 and RULING J freeze the model; the dossier encodes it:

- Spawn retains one singular optional launch Project: the frozen input already accepts optional `projectId`, and the read DTO exposes the immutable provenance as nullable `launchProjectId`. Optionality is not a new amendment.
- Spawn with a launch Project creates exactly one normal writable, spawner-authored `in_project` association. Scratch spawn creates none.
- Later Project associations use ordinary `edges.create`/`edges.delete`, not a multi-project spawn input or special session-association command.
- Every association creation/promotion, including spawn's initial edge, shares the ProjectResource lock with unlink and revalidates the active Space link plus live projection under that lock; failure uses `invariant_violation`/`project_not_linked`.
- The Server owns `props.origin`, but origin ownership and edge mutability are separate: task/session associations are normally writable; only materialized PR/commit edges require the correction command.
- CLI PR/commit Project auto-fill occurs only when the session has exactly one live association; zero or multiple requires explicit `projectId`.
- Project unlink is runtime safety: under the same Project lock, it refuses if any live session has either an association edge to the projection or a matching `launchProjectId`. Exited sessions do not block.
- Unlink/relink performs entity-delete/restore-equivalent incident-counter recomputation and neighbor-cache invalidation.
- Legacy backfill creates an association only when the active `space_projects` row and live projection both exist. Otherwise it preserves launch provenance, records an actionable audit, and never implicitly relinks.
- Scratch uses the `workdir` scratch variant plus `confirmUntrusted`, with a Server-generated, symlink-safe `<dataDir>/scratch/<sessionId>` root, private permissions, and execution-owned cleanup/retention.

### Message-first communication and feed

The closed Round-4 message/delivery proposal extends the existing graph families rather than creating a session-chat API or second message store:

- extend `messages.post` with atomic multi-anchor batching, stable-input idempotency identity, Server-resolved mention/file IDs, and one ordinary singularly anchored message per target;
- add same-anchor message reply semantics through the messages family;
- add versioned message-owned attachment add/remove commands while refusing generic mutation of `file -> attached_to -> message` edges;
- add one execution-side message-delivery read/status facade and the bounded delivery machine; live PTY injection remains an internal adapter, never a second authored message;
- extend notifications/inbox for separate Member and Teammate recipients/read state without creating a second inbox;
- add universal `entities.feed`, returning a single keyset page over messages plus activity with versioned `direct_v1|session_chat_v1` concrete scopes, newest/oldest order, optional bounded `around=<itemKind>:<itemId>` seek, Server-side de-duplication, `FeedItem.via`, transitive reply-descendant membership for session Chat, and no feed table. Request-only `scope=default` resolves by anchor kind and the response echoes the concrete resolved scope name plus predicates; `default` is never stored or pinnable by a profile;
- add typed activity summaries, nullable `activity.work_session_id`, `ActivityItem.workSessionId?`, and `EdgeView.updatedAt` plus edge-patch activity;
- keep Chat and Discussion as two projections of the same anchored graph messages.

The public CLI has no `session prompt`. The frozen `execution.prompt` operation remains v1 and exact-lookup discoverable, but only with `exposure='internal'` and `reason='use_message_send'`. Only the audited Server-internal delivery-adapter principal may invoke it, and only for a stored message with an existing delivery reservation. That principal is not a Member or Teammate bearer, cannot be selected by `actorId` or act-as, and is scoped to reservation/settlement plus one governed PTY write. Every Member or Teammate—including an owner/admin, session-scoped agent bearer, or authorized act-as caller—receives `forbidden` with `details.reason='use_message_send'` before queue admission and writes zero PTY bytes. The W0 adoption record reverses T-D20/R17 only as to the public authoring route; later removal remains a catalog-version decision.

### Interaction Profiles and static Chat templates

Phase 1 adds no `ui_template` entity, template CRUD API, or template CLI noun. Templates are typed, versioned Server/UI registry assets; their operation bindings request existing catalog operations and never confer authority.

`interaction_profile` is a restricted core entity with a named lifecycle family because universal entity mutation is refused and its draft/validation/hash-bound activation lifecycle does not fit the closed generic command namespace. Ordinary reads still use `entities.get/query/versions`. Its proposed lifecycle operations are the single §18 A13–A20 rows, not a second operation table: A13 proposes an inactive draft; A14 advances draft content/version through the sole profile-content writer; A15 validates static template selection, policy, bindings, budgets, and Phase-1 `explicit-only` capture; A16 is the POST read returning a sanitized non-interactive projection with no mutation ID or ledger row; A17 activates the exact validated version/hash after provenance and structured diff; A18 prevents future resolution only after Teammate/Space defaults are removed; A19 writes the guarded 0..1 `defaults_to_profile` relation; and A20 writes the typed Space default because Space is not an entity.

`execution.spawn` gains an additive active-profile override for authorized human spawners. Spawn resolves override → Teammate default → Space default → core, pins the complete immutable snapshot in `work_session_interaction_pins`, and materializes `selected_profile` for query/provenance only. Phase 1 launches the full native interactive Claude/Codex CLI in Terminal and fixes `providerCaptureMode='explicit-only'`; provider event/list/subscribe operations are deferred, not Phase-1 catalog additions.

### Phase-2 remote control plane

The future remote specification must add Server/Connection/gateway operations for discovery, login/token exchange, Server resolution, capability negotiation, socket control, relay, hosted-Server lifecycle, and cross-relay observability. After a Server is resolved, clients use the same 81-operation graph catalog plus approved amendments; remote does not gain a parallel graph API.

---

## 19. Surfaces outside the semantic catalog

Not every network path is a domain operation:

- `/health` is an operational readiness endpoint.
- The terminal byte socket is a transport activated by `execution.streams.attach`, not graph CRUD.
- Internal Postgres RPC functions implement handlers but are not client APIs.
- Server bootstrap and local-owner authentication are infrastructure seams.
- Gateway discovery, token exchange, routing and relay are deferred Phase-2 control-plane APIs.
- UI routes such as Workspace, Entity View and Settings are client navigation, not backend operation names.

This separation keeps the semantic catalog stable while allowing deployment and transport machinery to evolve.
