# tm8 Current Backend Briefing for Chat and Agent Templates

**Status:** implementation audit plus design recommendations, 2026-07-26  
**Purpose:** authoritative input to the chat-agent-template design review  
**Rule:** every statement below is labelled **implemented**, **contracted**, **proposed**, or **recommended**. A design document is not evidence that code exists.

> **Authority order:** shipped migrations and package source govern implemented behavior; `packages/contract/src/catalog.ts` plus shared DTO/Zod schemas govern the frozen API; the FINAL architecture corpus and `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 govern adopted-but-not-yet-built design. The reviewed CLI, communication, harness, and UI companions remain subordinate, and their exact implementation changes remain dossier-gated.

## 1. Current blocks and packages

The conceptual tm8-server is one Server domain made from six composable blocks: graph/contract, Postgres, HTTP/WS server and identity, execution/PTY, bridge, and gateway (`docs/architecture/01-LAWS.md:7`). Phase 1 has real packages for:

- `packages/contract`: operation catalog, DTOs, schemas, events, errors;
- `packages/server`: generated HTTP facade, identity/RLS claims, graph reads/writes, event poll/WS skeleton, PTY WS bridge;
- `packages/execution`: spawn orchestration, manifest, cwd/trust resolution, PTY host;
- `packages/pty-protocol`: provider-neutral terminal transport control frames;
- `packages/prompt`: manifest-to-agent prompt composition;
- `packages/cli`: the currently tiny agent-facing client;
- `packages/ui`: real facade plus the Workspace UI.

Bridge/gateway remain Phase-2 architecture, not shipping packages. Older “node/workspace/hubspace” prose must not override the current product nouns: **Server** is the root tm8 domain, **tm8-server** is its runtime, **Space** is the collaboration/event boundary, and **Workspace** is the three-panel UI composition.

## 2. Implemented spawn-to-UI path

```text
execution.spawn HTTP
  -> generated facade handler
  -> SpawnService loads Teammate/Project/task context
  -> resolves launch config and Server-computed cwd
  -> one DB RPC creates work_session + working_on edges
  -> writes and records manifest
  -> PtyHostService spawns provider command under node-pty
  -> status becomes running

agent process
  -> receives TM8_* environment and composed prompt
  -> invokes current tm8 CLI
  -> HTTP operation with bearer token when available
  -> facade validates catalog schema and binds identity/actor claims
  -> SECURITY DEFINER graph RPC + command ledger
  -> DB triggers append per-Space workspace_events
  -> event mapper projects canonical WorkspaceEvent
  -> current UI polls by Space seq and dispatches into stores

PTY output
  -> raw bytes buffered/coalesced by PtyHostService
  -> PTY WebSocket binary frames
  -> xterm renderer inside the work_session Content tab
```

Spawn ordering is explicit in `packages/execution/src/spawn/SpawnService.ts:96`; graph creation is at `:125`, scratch cwd resolution at `:142`, and PTY spawn follows manifest persistence. The runtime keeps spawner claims in the in-memory `sessionAuth` map (`:65`); this currently makes post-restart asynchronous graph attribution incomplete and is not a durable identity mechanism.

The graph/state and terminal streams are separate by law: durable session state lives in the graph; live terminal bytes stay out of Postgres (`docs/architecture/01-LAWS.md:66`).

## 3. API and CLI authority

### Frozen API

- Canonical operation inventory: `packages/contract/src/catalog.ts` — 81 rows: 79 v1 plus 2 reserved, 80 HTTP plus one WS binding.
- Shared DTOs: `packages/contract/src/contract.ts`.
- Input/event schemas: `packages/contract/src/schemas.ts`.
- Human grouped guide, mechanically reconciled to all 81 rows: `docs/api-and-cli/API-CATALOG-GROUPED-GUIDE.md`.

The catalog covers identity; Spaces; entities and commands; edges/types; messages; collections/graph/placements/undo; search; ProjectResources; files/blob grants; inbox/read marks; saved views; actions; events/presence; execution; and entity-kind registry. A catalog row can still answer `not_implemented`; catalogued is not synonymous with shipped.

### Implemented CLI

`packages/cli/src/run.ts:21` is the current truth. Only these command families ship: `worker init`, `whoami`, three `task report` forms, and three `session report` forms (`:23-30`, dispatch at `:57-60`). It has no general entity, edge, message, file, doc, event, project, or session-spawn grammar yet.

### Proposed CLI

- `docs/api-and-cli/CLI-GRAMMAR-REDESIGN.md` revision 4: graph/domain noun-first grammar and an exact 81-operation disposition table.
- `docs/chat-and-messaging/SESSION-COMMUNICATION-MODEL.md` revision 4: proposed durable message-first live-session delivery, teammate inboxes, provenance and guarded attachments.
- `docs/harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`: the agent journey, orchestration harness, progressive command discovery, native provider launch, and explicitly deferred structured-provider seam.

These are design-only and must not be represented to the chat-template review as implemented API.

## 4. Current graph schemas

### Entities and typed detail

**Implemented.** The common `entities` envelope is in `db/migrations/001_core_graph.sql:329`; typed details include `work_sessions` at `:694`. Contract work-session state is status/tool/model/share/timestamps (`packages/contract/src/contract.ts:101`), while content currently exposes `nodeId`, singular `projectId`, `workingOn`, and transcript document (`:148`).

`work_sessions.project_id` is the implemented singular launch/execution column. The v2.10 design reinterprets it in reads as immutable nullable `launchProjectId` and proposes writable M:N `work_session -> in_project -> project projection` associations. Project projections, `project_links`, and multi-project session associations are not implemented.

### Members and Teammates

**Implemented.** A Member is a human Space-membership entity. `team_members` is a typed persona table (`db/migrations/002_identity.sql:113`) owned by one Member; authorization resolves through that owner. Identity session types make agent bearer sessions explicitly Teammate-scoped (`packages/server/src/identity/types.ts:66`).

### Messages and anchors

**Implemented.** Each message is an entity plus a message detail row (`db/migrations/001_core_graph.sql:934`). It has one entity anchor, one same-anchor root/parent thread, an author, body, mentions and attachment metadata. Contract state/content are at `packages/contract/src/contract.ts:90` and `:142`; `MessageView` is at `:223`. Current messages do not have multiple anchors; clients post one anchor at a time.

**Proposed only.** Atomic multi-anchor send would create one message copy per singular anchor, correlated by a batch ID. `authored_from` message-to-source-session edges, `participates_in` Teammate-to-session edges, message-owned file attachment edges, session delivery records, and teammate-recipient inbox rows are all dossier work.

### Edges and provenance

**Implemented.** Edges are Space-scoped rows (`db/migrations/001_core_graph.sql:762`) validated against the registry at `:900`. `EdgeView` exposes type, both projected endpoints, props, createdBy and createdAt (`packages/contract/src/contract.ts:172`). Current provenance is `created_by` plus unconstrained Server-owned props where a writer supplies them; there is no universal typed provenance union. The registry already says `assigned_to` is task→Member|Teammate, `working_on` includes work_session→task, `attached_to` has a restricted source-kind set, and `relates_to` is universal (`001_core_graph.sql:901-909`).

## 5. Session identity and mutation provenance today

The spawn environment contains `TM8_SESSION_ID`, `TM8_MANIFEST_PATH`, `TM8_BASE_URL`, `TM8_SPACE_ID`, `TM8_TEAM_MEMBER_ID`, tasks and optional Project/model (`packages/execution/src/spawn/manifest.ts:305-331`). The CLI also reads optional `TM8_AGENT_TOKEN` (`packages/cli/src/env.ts:6-29`) and sends it as `Authorization: Bearer` (`packages/cli/src/client.ts:94`).

Important limits:

- `TM8_SESSION_ID` is process context, not currently attached to every HTTP mutation as a header, claim or body field.
- An agent bearer token, when issued/wired, is scoped to one Teammate; the identity service requires that scope (`packages/server/src/identity/service.ts:245-271`).
- The facade command body carries optional `actorId` and `clientMutationId`; `packages/server/src/facade/context.ts:31-64` binds identity always and an explicit actor only for authorized act-as.
- `clientMutationId` drives command replay and is copied into durable events. The ledger currently keys by mutation ID and operation, reserves before execution, and stores the result (`db/migrations/004_ledgers.sql:79`; concurrency fix `012_ledger_reserve_cmid.sql:66`). It does not generally compare an input hash.
- There is no implemented Server-owned `sourceWorkSessionId` claim or `authored_from` edge on every CLI mutation. Therefore “every mutation is session-provenanced” is false today.

Recommended seam: authenticate the process with a durable agent session whose claims include immutable `workSessionId` and Teammate ID; the Server derives provenance from verified claims and never trusts a client `--from`. Mutation audit may add `source_work_session_id`; graph relations that matter should be Server-owned edges on the produced entity/message.

For universal mutation provenance, the cleaner proposed shape is nullable `activity.work_session_id` plus `ActivityItem.workSessionId?` and an index. It covers entity and edge mutations and survives target hard-deletion. Keep `authored_from` narrowly messages-only because message writes do not produce an activity row; do not invent a generic provenance edge for every mutation.

## 6. Durable events and realtime state

The contracted envelope is:

```text
{ spaceId, seq, occurredAt, schemaVersion, type, typed payload, clientMutationId? }
```

`seq` is per-Space monotonic, gaps are allowed, and `(spaceId, seq)` is the order/dedupe/replay key (`packages/contract/src/contract.ts:246-280`). Mutation-derived events may echo `clientMutationId`. Presence/typing remain in the TypeScript union for compatibility but are excluded from the durable stream (`:282-291`).

**Implemented durable log.** One trigger captures graph changes into `workspace_events`; the DB assigns per-Space seq and retains seven days by default (`db/migrations/003_read_model.sql:294-314`, trigger `:319-399`, pruning `:401`). The server mapper reconstructs full typed projections and validates them before emission.

**Implemented replay/poll.** `events.poll` reads after a Space seq. The current UI uses a 1.5-second poller and synthesizes legacy UI `eventId` as `spaceId:seq` (`packages/ui/src/real/events.ts:1-20`, `:82-168`).

**Partial WS.** The catalog binds `events.subscribe` to one WS. The HTTP upgrade, framing, heartbeat and subscription registry exist, but `packages/server/src/events/ws-server.ts:11-13` says nothing publishes yet and `:46-54` says no contracted client subscribe/unsubscribe control frame exists. The real UI therefore does not use live durable WS. Presence subscription is currently a truthful no-op (`packages/ui/src/real/RealFacade.ts:518-525`).

## 7. PTY and harness reality

**Implemented transport.** `/pty`-style transport multiplexes binary raw PTY bytes with JSON text control frames. The only recognized Server→client controls are `exit`, `size`, and `attached` with byte offsets, replay/gap/snapshot and an equality-only stream epoch (`packages/pty-protocol/src/index.ts:8-65`). Unrecognized text is rendered verbatim (`:67-125`). `PtyHostService` buffers, coalesces, replays and fans raw bytes to terminal viewers; input ultimately calls `proc.write`, and prompt delivery writes text followed by carriage return (`packages/execution/src/pty/PtyHostService.ts:553-573`).

**Not implemented:** a structured provider event stream. The current agent launcher is command-based, selected primarily through `TM8_AGENT_CMD`; Claude receives `--dangerously-skip-permissions` (`packages/execution/src/spawn/manifest.ts:194-236`). Nothing in PTY frames distinguishes assistant prose, user echo, tool calls, tool results, status chrome or ANSI repaint operations.

Therefore a provider-neutral design cannot authoritatively capture Claude Code assistant messages from raw terminal output without a hook or structured mode. ANSI screen scraping can produce a best-effort transcript, but cannot reliably establish semantic boundaries, stable message IDs, tool-call causality, hidden/repainted text, or exactly which bytes constitute the assistant response.

**Binding Phase-1 product ruling:** tm8 keeps the complete normal Terminal flow and launches the full native interactive Claude or Codex CLI in a PTY. Spawn resolves/pins the Interaction Profile, compiles provider-specific launch prompt/tool-discovery policy, injects trusted tm8 session credential/context, and launches that interactive provider. Phase 1 has `providerCaptureMode='explicit-only'`: only explicit tm8 message operations create canonical Chat messages. Raw terminal output remains terminal output and may be replayed only as explicitly unstructured terminal data.

A per-provider adapter behind a provider-neutral `AgentEvent` contract remains a post-Phase-1 extension seam only. It would require an approved provider hook/JSONL/event API or tm8 control socket—not terminal scraping—and must never become a hidden dependency of native Terminal or the Phase-1 Chat UI.

## 8. Recommended projected chat feed

Phase 1 keeps two active layers separate:

1. **Terminal:** the full native interactive PTY stream and input path; never graph messages.
2. **Chat:** ordinary explicit graph messages plus activity, read through `entities.feed`; never synthesized from terminal prose.

A future third structured-agent-event layer may be added only through an approved provider adapter contract. Its event store, projection/deduplication, redaction, replay, and graph-projection rules in §11.2–§11.3 are deferred and are not Phase-1 dependencies.

The graph-side mixed history read should be a universal `entities.feed` operation: `GET /v2/entities/:id/feed -> Page<FeedItem>`. It performs a keyset-correct `UNION ALL` over existing messages and activity ordered by `(created_at,id)`; it creates no bespoke timeline table. `FeedItem` is a discriminated message-or-activity union. `ActivityItem.summary` must become a discriminated union over the closed activity-verb set before a generic client can render it. Add `EdgeView.updatedAt` and an activity write for `edges.patch` if connections may sort by update time.

For this phase, UI Templates are static, typed entries shipped in a Server/UI registry. There is no `ui_template` entity, agent authoring lifecycle, mutation API, or CLI noun. A registry entry contains presentation data only: layout regions, supported typed feed blocks, conditional visibility, declarative action requests, theme tokens and schema version. The resolved Interaction Profile pins an exact static template key/version. Dynamic or agent-authored templates are explicitly deferred.

Static templates still need an inverse prompt-injection rule: profile/feed data rendered into a human browser cannot turn untrusted values into operator-authorized mutations. Static bindings may only name allowlisted catalog operations, show consequential targets, honor current capabilities, and preserve normal destructive confirmation. A click never inherits authority from a template or profile.

Do not overload WorkspaceEvent with PTY bytes. Phase-1 Chat changes emit ordinary durable graph events; Terminal uses its existing PTY transport. Any future semantic token stream requires a separate approved session cursor/socket.

## 9. Contradictions not to carry forward

- Do not call the root domain a hubspace. Current noun is Server; runtime is tm8-server. `WorkspaceEvent` and `workspace_events` are grandfathered protocol/storage names, not root-domain vocabulary.
- Do not equate ProjectResource with repository or graph entity. Current code has ProjectResources; v2.10 proposes one restricted per-Space projection per active link.
- Do not claim work_session has implemented M:N Projects. That is approved design/dossier work; current storage still has singular `project_id`.
- Do not claim the noun-first CLI ships. The current CLI is the eight-command report/whoami prototype.
- Do not claim messages already support multiple anchors, teammate inbox recipients, `authored_from`, participants or edge-derived attachments. Those are revision-3 proposals.
- Do not claim event WS is the UI transport. The server socket is incomplete and the real UI polls.
- Do not send presence through the durable cursor or DB log.
- Do not infer semantic chat messages from ANSI PTY bytes or claim Claude/Codex tool-call separation exists.
- Do not use the existing `manifest.directive` as proof of runtime messaging. It is currently always null at spawn and is rendered as launch prompt content, not a structured live receiver.
- Do not bring Phase-2 bridge/gateway/remote-server transport into Phase-1 guarantees.

## 10. Design questions closed by the current §11 rulings

1. Which supported provider tools have a stable structured output/hook seam, and what degraded mode is honest for those that do not?
2. Is the semantic event log an execution-side table, append-only artifact, or both; what retention/export contract applies?
3. Which structured event kinds become durable graph messages, and when is an assistant message considered complete?
4. How are secrets/tool arguments redacted before event persistence and projection?
5. What cursor/reconnect contract governs the projected feed independently of Space `WorkspaceEvent.seq`?
6. Are declarative templates core entities or Server configuration resources, and do they deserve messages/edges/versioning under the entity test?
7. Which current CLI/session-communication proposals the chat UI may reference, versus which must remain feature-gated pending dossier approval?

## 11. Closed backend rulings for the chat-template plan

### 11.1 Universal `entities.feed`

Ruling: there is no hidden work-session-only operation. Every entity uses one universal named-scope grammar built from a closed predicate vocabulary:

```text
GET /v2/entities/:id/feed
  ?scope=default|direct_v1|session_chat_v1
  &order=newest|oldest
  &around=message:{id}|activity:{id}
  &limit=...
  &cursor=...
```

The closed include terms mean:

- `subject`: activity whose `entity_id` is the requested entity;
- `anchored`: messages whose immutable `anchor_id` is the requested entity;
- `authored`: messages whose author is the requested Member/Teammate, or whose immutable Server-owned `authored_from` source is the requested work_session;
- `replies`: the transitive descendant closure over immutable `parent_id`, seeded by messages selected through `anchored` or `authored` for this request;
- `caused`: activity whose immutable `work_session_id` is the requested work_session.

`direct_v1` resolves to `subject,anchored`. `session_chat_v1` resolves to `subject,anchored,authored,replies,caused`. `scope=default` is an API-request-only value: it resolves by kind—direct for ordinary entities and session-chat for work_session—and the response echoes both the resolved scope name and exact predicate set. `default` is never stored or pinnable. An inapplicable scope is `invalid_input` with `details.reason='feed_scope_not_applicable'`. Scope definitions are versioned; adding a predicate requires a new scope name. An Interaction Profile may pin only `direct_v1` or `session_chat_v1`, never an unversioned implicit list or `default`.

Feed qualification never grants read access. Every message admitted through `authored` or the reply-descendant closure is filtered again through the canonical anchor's ordinary read predicate; if the caller cannot read that anchor, the message, its body, and its existence are absent. The same non-leaking rule applies to `around`: a hidden anchor/item is indistinguishable from missing. Delivery facets and source-session provenance likewise do not widen anchor authorization.

Membership never depends on delivery target or outcome. A delivery record is a status facet on its message item, never an independent membership source or feed item. Therefore replies and replies-to-replies remain visible even when live wake delivery failed, expired, was refused, or became unknown. A future one-hop interpretation would require a separately versioned scope name; `session_chat_v1` is never silently narrowed.

The closure is computed Server-side. `messages.root_message_id` plus `(root_message_id,created_at,entity_id)` provide an index-backed prefilter for roots containing seed messages; the Server then verifies the exact immutable parent chain so siblings and messages preceding a seed are not admitted merely because they share a root. Parent writes must reference a pre-existing same-anchor message, preserving an acyclic chain. The client never recursively merges pages. A long-thread conformance fixture must prove the query remains within the dossier's bounded page-cost target.

The Server computes all candidates and de-duplicates **before** applying the keyset page. One physical message/activity row appears once even when several predicates match. `FeedItem.via` is the sorted unique subset of `subject|anchored|authored|replies|caused` explaining every qualification path.

The proposed DTO is a discriminated union, not an untyped presentation bag:

```text
FeedItemBase {
  itemKind: message|activity
  itemId
  createdAt
  sortId: uuidv7
  via: FeedVia[]
  actor: ActorSummary?
  sourceWorkSessionId?
  anchor: authorized EntitySummary?
  logicalOperationId: clientMutationId?
}
MessageFeedItem extends FeedItemBase {
  itemKind: message
  message: MessageView
  delivery: authorized DeliverySummary[]
}
ActivityFeedItem extends FeedItemBase {
  itemKind: activity
  activity: ActivityItem with closed discriminated ActivitySummary
}
```

The envelope is versioned and total over the closed variants. A client with an older safe renderer may show an unknown-variant card using only envelope metadata and a canonical open-details action; it must not silently drop the row or parse arbitrary properties into UI claims. Delivery summaries are facets of the message item and must be batch-projected or hydrated without an N+1 read.

The one ordering key is `(createdAt, uuidv7Id)` in the requested direction; there is no kind rank. The opaque cursor carries the last tuple and a fingerprint of entity ID, resolved scope name, exact predicate set, order and remaining filters. It is invalid under any different fingerprint. Feed membership fields are immutable: anchor, author, reply parent/root, `authored_from`, and `activity.work_session_id`; Server-owned relation guards refuse mutation. Required indexes align anchor/subject direction and add/retain message-parent/root, immutable `authored_from` lookup, and activity `(work_session_id,created_at,id)` coverage.

`around` is an optional initial-read seek, not a new feed membership source. The Server first applies authorization and scope membership, then returns one bounded window centered on the tagged item plus opaque older/newer cursors. A missing or hidden item yields the same non-leaking `not_found`; a visible item outside the resolved scope returns `invalid_input` with `details.reason='feed_item_not_in_scope'`. Clients never fetch pages until found. `around` and `cursor` are mutually exclusive, and subsequent pages use only the returned scope-fingerprinted cursors.

### 11.2 Deferred post-Phase-1 provider `AgentEvent` persistence and transport

Deferred ruling: if structured provider capture is later approved, events are not entities. Use both an operational append-only table and a sealed artifact:

- `session_agent_events(work_session_id, stream_epoch, agent_seq, event_kind, provider, provider_event_id, turn_id, causation_id, payload, occurred_at)` with primary key `(work_session_id,stream_epoch,agent_seq)` and provider-id idempotency constraints;
- retain hot rows while live and for seven days after terminal state;
- at exit, seal the complete normalized stream as a compressed JSONL `file` artifact attached to the work_session; retain it under the Space transcript policy, default 90 days;
- graph-projected messages retain normal graph lifetime independently of hot-event/artifact retention.

Add `execution.agentEvents.list` for HTTP replay with `afterAgentSeq` and bounded pages, plus a distinct `execution.agentEvents.subscribe` WS/subprotocol. Do not mix semantic JSON with the raw PTY socket where unrecognized text means terminal output. The socket cursor is `(workSessionId,streamEpoch,agentSeq)`; epoch is equality-only. Its attach acknowledgment includes retained `baseSeq`, authoritative `nextSeq`, and `gap`. A cursor below `baseSeq` yields the sealed artifact reference or an explicit retention gap. Provider ingestion is buffered and persistence is asynchronous so terminal/provider liveness does not block on a graph transaction.

### 11.3 Deferred post-Phase-1 provider-response projection

Deferred ruling: Phase 1 uses `explicit-only`, so an explicit tm8 message is the only canonical agent response bubble and no provider-prose deduplication is needed. If observed provider responses are added later, deduplication is correlation-based, never text-similarity-based. The Server creates an immutable `agentTurnId` and a scoped `responseSlotId` for each actionable session input. The receiver adapter binds them to the running session; the CLI automatically presents the scoped token on session-originated message writes, and clients cannot manufacture another session's slot.

The projection key is `(workSessionId,responseSlotId)`. An explicit graph message correlated to that slot is canonical and wins over provider assistant prose. The provider event remains in the audit stream with `projectionStatus='shadowed'` and `shadowedByMessageId`; it is not deleted. If no correlated explicit message exists when the turn closes, **no graph bubble is projected**; the provider event remains operational/audit data only. Implicit projection is post-Phase-1 work behind the structured-capture gate. Multiple intentional messages require distinct response slots. Uncorrelated messages are never collapsed merely because their text matches. `message reply` to the current inbound graph message receives the current response slot automatically; a generic message send is canonical only when the harness supplies the current scoped slot.

### 11.4 Work-session Terminal/Chat surfaces and exact template selection storage

Ruling: v2.11 preserves RULING D and adds RULING K. The work_session Content renderer hosts two peer surfaces: Terminal, with the complete normal native interactive PTY flow, and Chat. A **Terminal/Chat switch** selects one surface at a time; there is no split view. Terminal is always available and is never replaced, demoted, gated, or treated as a log/fallback view. A valid Interaction Profile may enable/configure Chat and set the default visible surface, but profile validation refuses any attempt to suppress Terminal. Absent or invalid profile resolution, the switch defaults to Terminal and any Chat configuration failure remains visible.

Store the whole resolved Interaction Profile pin in an operational/config side table, not arbitrary work-session entity content:

```text
work_session_interaction_pins
  work_session_id PK/FK
  interaction_profile_entity_id nullable FK
  interaction_profile_version nullable integer
  resolved_profile_hash
  resolved_profile_payload jsonb
  source core_default|space_default|teammate_default|spawn_override
  pin_revision integer
  selected_by_actor_id
  selected_at
```

`resolved_profile_payload` is the immutable validated launch snapshot needed even if a referenced profile/template is later edited or disabled. It contains the pinned template identity/version plus prompt/tool-discovery, feed, provider-capture, and composer/interaction policies. In Phase 1, provider-capture validates to `explicit-only`. It is never returned wholesale to the browser: the UI receives a safe projection containing only template, feed and composer policy.

Store viewer-local display preference separately, but do not let it replace the session's pinned Interaction Profile:

```text
work_session_view_preferences
  (member_id, work_session_id) PK
  content_surface terminal|chat
  local_display_preferences jsonb
  preference_revision
  updated_at
```

The existing outer per-panel tab codec remains the authority for `content|discussion|connections|activity`. `content_surface` is nested state used only while the outer Content tab is active; it never mixes Discussion into the Terminal/Chat switch.

Spawn resolution is explicit override → Teammate default → Space default → built-in core profile. Resolution locks the chosen profile version, resolves its static UI Template key/version from the shipped registry, validates every component, and stores the complete canonical snapshot/hash. Neither profile nor template floats for an existing session. Changing a pin requires expected `pinRevision`, emits a durable config-change event, and does not mutate viewer preferences. Unsafe or unsupported pins fall back visibly to the core profile without erasing the failed pin, so recovery/audit remains possible.

Conformance must prove that native Terminal remains attachable, interactive and state-preserving when Chat is enabled, selected, invalid, or unavailable; that switching surfaces does not restart or detach the provider; and that a profile attempting to hide Terminal is rejected.

### 11.5 Interaction Profile and static UI Template registry

Ruling: `interaction_profile` is a restricted core entity, while UI Templates are static, typed registry entries in this phase. A profile is reusable, Space-collaborative, versioned, discussable and linkable; it passes the entity test and travels with Space export/import. A template is shipped presentation code/data and has no messages, edges, authorship or runtime mutation lifecycle.

The separation is strict:

```text
static UI Template registry entry
  templateKey + version + schemaVersion
  regions, typed blocks, visual tokens, composer widgets,
  declarative action requests naming catalog operations

interaction_profile entity
  static templateKey + templateVersion
  prompt policy
  tool-discovery policy
  feed policy
  provider-capture mode
  composer/interaction policy
```

The canonical graph relations are:

```text
team_member --defaults_to_profile--> interaction_profile
work_session --selected_profile {pinnedVersion,origin:'materialized'}--> interaction_profile
```

- `defaults_to_profile` is the guarded 0..1 Teammate default and configuration authority for future spawns. It is distinct from `equips`: equipped content is rendered into the agent manifest, while profile resolution must project prompt/tool policy toward the harness and presentation policy toward the browser without cross-leaking the two.
- A Space default lives in typed Space config because Space is not an entity. An explicit spawn override is the highest resolution input.
- `work_session_interaction_pins` is the sole immutable runtime authority after spawn. It holds the profile version, static template key/version, complete resolved policy payload, capabilities/bindings projection, projector version and canonical hash. The manifest is a hash-matching serialization, not independent authority.
- `selected_profile` is Server-created, immutable, refused to public edge create/patch/delete, and rebuildable from the pin. If it differs or is missing, the pin wins. It exists only for graph queries and provenance, never runtime resolution.
- A re-selection creates a new pin revision through the guarded pin command and then rematerializes `selected_profile`; editing or repairing the edge can never reconfigure a running session.
- A static registry version may not be removed while any live session pin references it. Registry cleanup requires an explicit audited pin migration. An unresolved historical key/version falls back visibly to the core profile without erasing the failed pin.

`pulled` is not used: it means Member/Teammate projection/adoption and exposes `PullState.actor`. `equips` is not used for the default because its existing manifest renderer consumes equipped content as spell/skill input. Static templates need no `renders_with` relation because they are not entities.

Profile resolution produces two typed projections from the same pinned snapshot. The agent manifest receives only prompt/tool-discovery policy, the Phase-1 `explicit-only` capture ruling, and agent-relevant feed instructions; it never receives template layout, browser composer configuration or browser bindings. The browser receives only static template, feed and composer presentation policy; it never receives agent prompt/tool policy. A static template action binding is not authorization: at invocation the Server re-resolves identity, membership, act-as, capabilities, operation validation, version/idempotency and confirmation. Profiles/templates may reduce actions, never grant them.

The inverse browser prompt-injection rule is deferred, not discarded: it is a mandatory design/security gate before any template content, binding or template variable becomes agent-influenced.

### 11.6 Restricted authoring lifecycle and catalog surface

“Restricted core kind with a Server-owned writer” means a named handler/RPC family is the sole detail/default-edge writer, not an unaudited magic actor. Generic `entities.create`, `entities.patch`, `entities.delete`, and generic mutation of `defaults_to_profile` refuse the restricted kind/relation; dedicated commands retain authenticated authorship, command-ledger identity, activity and generator work-session provenance. Static UI Templates have no writer.

The operation-family admission rule is closed: a core entity kind may receive a top-level operation family if and only if (1) it is restricted from universal create/patch and (2) its lifecycle or access pattern cannot be expressed by universal CRUD plus the closed `entities.commands.*` namespace. The family may add invariant-preserving writers or anchor-first reads, but it may not duplicate universal `entities.get/query/versions`. Existing examples are anchor-first `messages.*` and lifecycle-owned `execution.*` for work_session. `interaction_profile` qualifies because it is restricted and its draft/validation/hash-bound activation lifecycle is not a uniform patch. An ordinary creatable kind such as task does not qualify; `tasks.*` remains forbidden.

Profile version state uses orthogonal fields rather than one misleading status:

```text
currentDraftVersion
validatedVersion?
validationHash?
activeVersion?
retiredAt?
```

Lifecycle law:

1. `propose` creates version 1 with no active version.
2. `update` advances the draft/entity version; an older active version remains active. It never clears a recorded `validatedVersion`/`validationHash` for an earlier immutable version.
3. `validate` parses the complete profile schema, verifies the static template key/version, limits and cross-references, resolves only catalogued operation requests, rejects authority/credential declarations, checks inverse-injection rules, and records `validatedVersion + validationHash`. It executes no binding.
4. `preview` returns a non-interactive sanitized projection; action invocation is disabled.
5. `activate --validated-version --validation-hash --yes` is human-only and sets `activeVersion` to that exact recorded validated version. `--validated-version` is a selector, not an optimistic guard on the latest draft; a later draft cannot make an earlier validated artifact unactivatable.
6. `retire --yes` is human-only and prevents new defaults/spawn pins; existing session pins remain readable and executable under their recorded policy. Retirement refuses while a `defaults_to_profile` edge or Space-default row still references the profile, returning `invariant_violation` with `details.reason='profile_default_in_use'` and authorized `referencingTeammateIds[]`/`referencingSpaceIds[]`. Operators explicitly clear or replace those defaults before retirement; the Server never silently clears them.

Agent-authored profile drafts are first-class proposals, not active configuration. In Phase 1 a Teammate may update only a draft it proposed; a human Space owner/admin may update any accessible draft. `actions.list` exposes this decision, and there is no separate profile-collaborator ACL or implied delegation mechanism. This permits selection of an already shipped static template key/version; it does not author or mutate a template. Only an authenticated human Member satisfying the Space owner/admin policy may activate/retire a profile and set persistent Teammate/Space defaults. These handlers check the authenticated principal as well as the selected actor, so `--as <teammate>` and agent tokens cannot cross the human-only boundary. The Server derives `generatorWorkSessionId` from verified claims; clients cannot submit it.

Activation is not a blind “approve draft” action. Preview/activation shows the exact validated version/hash, generator provenance, static template key/version, and a structured diff of prompt, discovery, feed, composer, bindings and capture policy against the active version. On first activation it renders the complete policy explicitly labelled `initial activation — no prior baseline`; it never shows an empty diff. `activate` succeeds only for that exact validation hash. Phase-1 provider capture must equal `explicit-only`; any other value is reserved and rejected until the structured-capture gate closes.

Profile prompt/tool policy is a closed structured vocabulary of Server-known template IDs, enums, numeric budgets, catalog operation IDs and boolean constraints. It cannot contain free-form prose for the trusted system-prompt kernel. If a future profile field carries agent-authored explanatory text, the manifest must render it with generator provenance inside the same escaped untrusted-content delimiters used by §5.7; it may never be interpolated into trusted control. An agent-generated profile can become a Space default only through a **separate** human `spaces.interactionProfile.setDefault` command, mutation ID and confirmation after activation. Activation cannot atomically set a default or satisfy that second approval.

The following new catalog operations are required beyond the frozen 81:

| Operation | Kind | Mutation identity |
|---|---|---|
| `interactionProfiles.propose` | command | required |
| `interactionProfiles.updateDraft` | command | required |
| `interactionProfiles.validate` | command | required |
| `interactionProfiles.preview` | read (POST read) | none |
| `interactionProfiles.activate` | command, human-only | required |
| `interactionProfiles.retire` | command, human-only | required |
| `teamMembers.interactionProfile.setDefault` | command, human-only | required |
| `spaces.interactionProfile.setDefault` | command, human-only | required |

`interactionProfiles.updateDraft` is the sole profile-content writer; the Server validates its static template key/version. The two default operations are the sole `defaults_to_profile`/Space-default writers. Reads remain universal `entities.get/query/versions`; no duplicate lifecycle-specific get/list operations are added. `execution.spawn` remains one existing operation with additive optional `interactionProfileId`. There are no `uiTemplates.*` operations.

Spawn resolves only an active profile. In Phase 1 only an authenticated human Member with the Member/admin capability `canOverrideInteractionProfileAtSpawn` may request an explicit override. Teammate/agent-initiated spawns follow guarded Teammate default → Space default → core and cannot submit an override; a later Teammate grant/revoke model is deferred rather than implied. Override never permits a draft, retired profile, inaccessible Space profile, or authority expansion. Both default-setting operations refuse a retired target with `invariant_violation` and `details.reason='profile_retired'`.

Required CLI nouns and commands:

```text
tm8 interaction-profile propose --data <json-source>
tm8 interaction-profile update <id> --expect-version <n> --data <json-source>
tm8 interaction-profile validate <id> --expect-version <n>
tm8 interaction-profile preview <id> --version <n>
tm8 interaction-profile activate <id> --validated-version <n> --validation-hash <hash> --yes
tm8 interaction-profile retire <id> --yes

tm8 teammate interaction-profile set-default <teammate-id> <profile-id|none> --yes
tm8 space interaction-profile set-default <profile-id|none> --yes
tm8 session spawn ... [--interaction-profile <active-profile-id>]
```

There is no `tm8 ui-template` noun. Every profile mutation takes `clientMutationId`; `preview` is a read, records nothing, and is excluded. Updates and activation take expected versions; activation/default/retirement require non-TTY-safe human confirmation and a human principal. Static template bindings name operation requests and input mappings only. Invocation always goes through the ordinary catalog, current capabilities and confirmations, so profile activation grants no operational authority.
