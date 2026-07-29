# tm8 W0 Amendment Dossier

**Status:** Vega-adopted W0 design freeze, narrowly amended by W0-E for G0.1 on 2026-07-26  
**Authority:** sole W1–W5 amendment authority, subordinate only to the binding user rulings and the current shipped source where implementation status is concerned  
**Implementation status:** documentation only; none of the additions in this dossier is claimed shipped  
**Non-goals:** production code, migration execution, UI implementation, Remote Phase 2, provider-output parsing, and git activity

## 1. Baseline and interpretation law

The delivered source is the implementation truth at W0:

- 81 catalog rows: 79 v1 and 2 reserved;
- 80 mounted HTTP routes and one WebSocket binding;
- 78 registerable HTTP-handler slots: 81 minus one WS row and two reserved rows;
- 28 semantic HTTP handlers when the database-backed facade is configured; zero semantic handlers in the no-database composition;
- 36 bound input schemas and 13 explicitly unbound command rows;
- 43 migration-declared product tables, plus the migration runner's physical `applied_migrations` bookkeeping table;
- 13 shipped core entity kinds; neither `project` nor `interaction_profile` is shipped;
- the current CLI exposes only the small legacy worker/identity/task/session-report surface.

The adopted target is not the delivered source. W1 may change the contract only through the exact amendments below. After all twenty additive operations are admitted, the target catalog is 101 rows; until the contract change lands, every generated baseline proof continues to report 81. No document may report 101 as implemented before that source change exists.

## 2. Closure ledger

| Review id | Frozen closure | Owning text |
|---|---|---|
| B1 | `execution.prompt` stays v1 but only the audited Server-internal delivery principal may invoke a pre-reserved stored-message attempt. Every Member/Teammate gets `forbidden/use_message_send` before queue admission and writes zero PTY bytes. | §5.1, §8.2; SCM §8.2–§8.3; T-D23 |
| B2 | Every Teammate-authored live top-level send/reply reserves under one durable locked unordered session pair. No thread-root key. Four consecutive reservations; Member reset; retry consumes; fallback and cleanup frozen. | §5.2, §8.3; SCM §10 |
| M1 | `interaction_profile` has a total route/projection/capability/menu/migration disposition. | §6.4; consistency matrix §2 |
| M2 | DOMAIN owns K/L kinds, relations, additive storage, operations, and current-versus-target distinctions. | DOMAIN §§5–8 |
| M3 | `FeedPolicy.scope` is the named `direct_v1|session_chat_v1` union, never a predicate list. | §6.3; harness §4 |
| M4 | Harness adversarial closure is classified, with B1/B2 propagation and cases M10/M11/M12/S6. | harness §22; gate report §4 |
| M5 | Review ledger uses documentary design voice and states that it asserts no implementation. | workspace review masthead and targeted verb sweep |
| M6 | Twenty historical PARTIAL findings have explicit successor and closing-round traceability. | workspace review PARTIAL table |
| M7 | The two total cross-layer matrices and this indexed-set review are mandatory W0 evidence. | consistency matrices; gate report |
| m1 | Real §8.2 default-channel heading and exact behavior. | workspace §8.2; §6.2 here |
| m2 | Agent bearer environment name is `TM8_AGENT_TOKEN`. | harness §5.1; §6.5 here |
| m3 | Message grammar is repeatable `--to`; replies use `message reply`. | harness §7.3; §7 here |
| m4 | Request-only `scope=default` resolves to a concrete versioned scope and is never pinnable. | §6.3; API/UI/workspace/briefing |
| m5 | `project_links`, `in_project`, `launchProjectId`, profiles and delivery storage are explicitly proposed. `project_id` gets an immutability trigger. | DOMAIN §§4, 6.2; §8 here |
| m6 | Round maps are ordered 16, 17, 18, 19. | workspace tail |
| m7 | Maximum 16 live session Project associations; owner/admin may delete ordinary agent edges as repair. | §5.4, §8.5 |
| m8 | `canMessage`, `canContactSession`, and `canHandoffEntity` are independent. | §5.3 |
| m9 | Former SCM questions are classified as decisions, prototype constants, or later gates. | SCM §15 |
| m10 | `message_batch_id` is a nullable correlation column, not an entity/table. | §6.1, §8.2 |
| m11 | Feed message reads derive from the canonical anchor, including `authored`, descendants, and `around`. | §6.3, §8.4 |
| m12 | Ledger has a current status/disclaimer and explicit Round 1 heading. | workspace review masthead |
| m13 | Round 9 is final only for the original ledger; Round 11 is delta-final; the Round-6 regression remains visible. | workspace spec/review mastheads |

## 3. Exact additive operation freeze

These twenty names and bindings are the adopted additions. Renaming, merging, or splitting one requires a dossier amendment and a new generated reachability review.

| # | Operation | Binding | Kind | Input / output |
|---:|---|---|---|---|
| A01 | `spaces.menu.get` | `GET /v2/spaces/:spaceId/menu` | read | `— → MenuConfig` |
| A02 | `spaces.menu.update` | `PUT /v2/spaces/:spaceId/menu` | command | `UpdateMenuInput → MenuConfig` |
| A03 | `spaces.defaultChannel.set` | `PUT /v2/spaces/:spaceId/default-channel` | command | `SetDefaultChannelInput → SpaceSettingsView` |
| A04 | `projects.associations.correct` | `POST /v2/entities/:artifactId/commands/correct-project-association` | command | `CorrectProjectAssociationInput → EdgeCorrectionResult` |
| A05 | `handoffs.send` | `POST /v2/work-sessions/:workSessionId/handoffs` | command | `SendHandoffInput → HandoffView` |
| A06 | `handoffs.list` | `GET /v2/work-sessions/:workSessionId/handoffs` | read | `HandoffListQuery → Page<HandoffView>` |
| A07 | `handoffs.withdraw` | `POST /v2/handoffs/:handoffId/withdraw` | command | `WithdrawHandoffInput → HandoffView` |
| A08 | `messages.attachments.add` | `POST /v2/messages/:messageId/attachments` | command | `AddMessageAttachmentsInput → MessageView` |
| A09 | `messages.attachments.remove` | `DELETE /v2/messages/:messageId/attachments` | command | `RemoveMessageAttachmentsInput → MessageView` |
| A10 | `messages.delivery.get` | `GET /v2/messages/:messageId/delivery` | read | `MessageDeliveryQuery → MessageDeliveryView` |
| A11 | `entities.feed` | `GET /v2/entities/:id/feed` | read | `EntityFeedQuery → EntityFeedPage` |
| A12 | `entities.context` | `GET /v2/entities/:id/context` | read | `EntityContextQuery → EntityContextView` |
| A13 | `interactionProfiles.propose` | `POST /v2/spaces/:spaceId/interaction-profiles` | command | `ProposeInteractionProfileInput → InteractionProfileView` |
| A14 | `interactionProfiles.updateDraft` | `PATCH /v2/interaction-profiles/:profileId/draft` | command | `UpdateInteractionProfileDraftInput → InteractionProfileView` |
| A15 | `interactionProfiles.validate` | `POST /v2/interaction-profiles/:profileId/validate` | command | `ValidateInteractionProfileInput → ProfileValidationView` |
| A16 | `interactionProfiles.preview` | `POST /v2/interaction-profiles/:profileId/preview` | read | `PreviewInteractionProfileInput → InteractionProfilePreview` |
| A17 | `interactionProfiles.activate` | `POST /v2/interaction-profiles/:profileId/activate` | command | `ActivateInteractionProfileInput → InteractionProfileView` |
| A18 | `interactionProfiles.retire` | `POST /v2/interaction-profiles/:profileId/retire` | command | `RetireInteractionProfileInput → InteractionProfileView` |
| A19 | `teamMembers.interactionProfile.setDefault` | `PUT /v2/team-members/:teamMemberId/interaction-profile-default` | command | `SetTeammateProfileDefaultInput → TeammateProfileDefaultView` |
| A20 | `spaces.interactionProfile.setDefault` | `PUT /v2/spaces/:spaceId/interaction-profile-default` | command | `SetSpaceProfileDefaultInput → SpaceProfileDefaultView` |

The following are additive changes to frozen rows, not new names:

| Frozen operation | Exact amendment |
|---|---|
| `messages.post` | `anchorIds` atomic batch, optional `parentMessageId`, mention/file IDs, `MessageBatchResult`; singular `anchorId` is accepted as a deprecated input spelling only inside the versioned DTO migration and is normalized to one-element `anchorIds`. |
| `messages.edit`, `messages.delete` | required `expectedVersion`; attachment edges remain owned by A08/A09. |
| `entities.create` | repeatable initial `connections`, validated/locked and committed atomically with the entity. |
| `entities.connections` | flat `Page<EdgeView>` with typed filters/sort and a cursor fingerprint bound to them. |
| `files.uploadComplete` | atomic finalized `attached_to` targets; message targets delegate ownership to A08 semantics. |
| `execution.spawn` | `workdir`, `confirmUntrusted`, and optional active `interactionProfileId`; `projectId` was already optional. |
| `execution.prompt` | input shape remains frozen; exposure becomes internal-only under B1. |
| `entities.commands.linkPr`, `entities.commands.linkCommit` | optional explicit `projectId`; exact-one association CLI auto-fill only. |
| `inbox.list`, `inbox.markRead` | Member/Teammate discriminated recipient and explicit owner-inspection capability. |
| `actions.list` | operation name, target/version, capability epoch, authorization target, exposure and help reference. |
| `events.subscribe` | no claim beyond the current WS skeleton until durable replay/subscription conformance passes. |

## 4. Shared DTO, Zod, and error freeze

All IDs use the repository UUID/opaque-ID conventions; all objects are strict. Unknown keys fail `invalid_input`. Command inputs include `clientMutationId`; versioned mutations include the stated expected revision/version. Reads do not accept a mutation ID.

```ts
type ErrorCode =
  | 'invalid_input' | 'forbidden' | 'not_found' | 'conflict'
  | 'invariant_violation' | 'limit_exceeded' | 'not_implemented';

type ErrorDetails = {
  reason: string;
  currentVersion?: number;
  currentRevision?: number;
  currentMenu?: MenuConfig;
  activeLinks?: number;
  deliveryId?: string;
};

type UpdateMenuInput = {
  clientMutationId: string;
  expectedRevision: number;
  payload: MenuConfigPayload; // schemaVersion=1; <=8 groups; <=12 items/group; children depth<=1
};

type SetDefaultChannelInput = {
  clientMutationId: string;
  expectedSettingsRevision: number;
  channelId: string | null; // null is the explicit no-feed state
};

type CorrectProjectAssociationInput = {
  clientMutationId: string;
  projectId: string;
  expectedArtifactVersion: number;
};

type SendHandoffInput = {
  clientMutationId: string; // handoffId exactly
  sourceEntityId: string;
};

type WithdrawHandoffInput = {
  clientMutationId: string;
  expectedRecordVersion: number;
  reason?: string; // 1..256 chars
};

type AddMessageAttachmentsInput = {
  clientMutationId: string;
  expectedVersion: number;
  fileEntityIds: string[]; // unique, 1..16
};
type RemoveMessageAttachmentsInput = AddMessageAttachmentsInput;

type EntityFeedQuery = {
  scope?: 'default' | 'direct_v1' | 'session_chat_v1';
  order?: 'newest' | 'oldest';
  around?: `message:${string}` | `activity:${string}`;
  cursor?: string;
  limit?: number; // 1..100, default 50
};

type EntityContextQuery = {
  sections?: Array<'summary'|'hierarchy'|'connections'|'messages'|'activity'|'actions'>;
  totalBytes?: number; // 1024..32768, default 16384
  sectionBytes?: number; // 512..8192, default 4096
};

type FeedPolicy = {
  scope: 'direct_v1' | 'session_chat_v1';
  pageSize: number; // 1..100
  bodyExcerptBytes: number; // 0..4096
};

type InteractionProfileDraft = {
  name: string; // 1..80
  templateKey: string; // registry key
  templateVersion: number;
  promptPolicy: ClosedPromptPolicy;
  toolDiscoveryPolicy: ToolDiscoveryPolicy;
  feedPolicy: FeedPolicy;
  providerCaptureMode: 'explicit-only';
  composerPolicy: ComposerInteractionPolicy;
};

type ProposeInteractionProfileInput = {
  clientMutationId: string;
  spaceId: string;
  draft: InteractionProfileDraft;
};
type UpdateInteractionProfileDraftInput = {
  clientMutationId: string;
  expectedVersion: number;
  draft: InteractionProfileDraft;
};
type ValidateInteractionProfileInput = { clientMutationId: string; expectedVersion: number };
type PreviewInteractionProfileInput = { profileVersion: number };
type ActivateInteractionProfileInput = {
  clientMutationId: string;
  validatedVersion: number;
  validatedHash: string;
  confirm: true;
};
type RetireInteractionProfileInput = {
  clientMutationId: string;
  expectedVersion: number;
  confirm: true;
};
type SetTeammateProfileDefaultInput = {
  clientMutationId: string;
  expectedVersion: number;
  profileId: string | null;
};
type SetSpaceProfileDefaultInput = {
  clientMutationId: string;
  expectedSettingsRevision: number;
  profileId: string | null;
  confirmAgentGenerated?: true;
};
type SpaceProfileDefaultView = {
  spaceId: string;
  defaultInteractionProfileId: string | null;
  settingsRevision: number;
};
```

Stable new `details.reason` values are closed:

| Reason | Code | Meaning |
|---|---|---|
| `use_message_send` | `forbidden` | Any Member/Teammate attempted `execution.prompt`. |
| `automated_wake_limit` | delivery failure reason, not a top-level message-storage error | Pair has four consecutive Teammate reservations; stored delivery settles `failed_permanent`. |
| `session_contact_forbidden` | `forbidden` | Durable message may store, but caller lacks live-contact authority. |
| `handoff_forbidden` | `forbidden` | Entity projection/handoff authority absent. |
| `message_batch_identity_mismatch` | `invariant_violation` | Same mutation ID reused with different stable batch input. |
| `feed_scope_not_applicable` | `invalid_input` | Named scope invalid for anchor kind. |
| `feed_item_not_in_scope` | `invalid_input` | Visible `around` item is outside resolved scope. |
| `project_not_linked` | `invariant_violation` | Association target is not an active live Space projection. |
| `project_association_cap` | `limit_exceeded` | Session already has 16 live Project associations. |
| `project_over_cap` | `limit_exceeded` | Resource active-link cap exceeded. |
| `menu_revision_conflict` | `conflict` | Menu optimistic revision mismatch; includes `currentMenu`. |
| `menu_upgrade_required` | `conflict` | Stored future schema version cannot be edited by this client. |
| `profile_not_validated` | `invariant_violation` | Activation version/hash lacks matching successful validation. |
| `profile_referenced_default` | `conflict` | Retirement still referenced by Teammate or Space default. |
| `profile_retired` | `invariant_violation` | Retired profile selected as default/spawn override. |
| `profile_principal_required` | `forbidden` | Activation/retire/default/spawn override attempted by agent/act-as. |
| `profile_capture_mode_reserved` | `invalid_input` | Phase-1 draft uses anything but `explicit-only`. |
| `attachment_edge_owned` | `forbidden` | Generic edge mutation targets a message-owned attachment. |

## 5. Authorization and delivery machines

### 5.1 B1 internal principal

The only `execution.prompt` caller is `principalType='system_delivery_adapter'`, minted by the Server for a single worker execution. It is not an account, Member, Teammate, agent token, session token, owner/admin role, or act-as identity. It cannot be supplied in HTTP JSON, CLI flags, headers, or `actorId`. Its claims contain only `deliveryId`, `messageId`, target session, reservation version, and expiry. It may execute exactly three closed database RPCs — `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery` — plus one separately governed non-database execution-adapter write. It has no graph write grant.

The HTTP handler order is mandatory:

1. authenticate the request;
2. reject any principal other than `system_delivery_adapter` with `forbidden` and `details.reason='use_message_send'`;
3. verify the delivery/message/target tuple and active reservation;
4. claim the delivery idempotently;
5. enqueue exactly one governed adapter entry;
6. settle from the awaited `proc.write` result.

Steps 2–3 occur before queue admission. Negative tests assert queue depth, `proc.write` call count, PTY byte count, and delivery row state are unchanged for Member, Teammate, owner/admin, session token, and act-as attempts. Exact help remains available, but returns internal exposure, reason, and the `messages.post` public composite without invocation syntax.

### 5.2 B2 universal unordered-pair budget

For every Teammate-authored message requesting live delivery, the Server derives `sourceWorkSessionId` from immutable authenticated provenance. It refuses self-contact. It canonicalizes `(low,high)` by UUID byte order and performs this transaction:

1. create the pair row at zero if absent;
2. `SELECT ... FOR UPDATE` the pair row;
3. if `consecutive_agent_wakes = 4`, create the delivery row directly as `failed_permanent`/`automated_wake_limit`, enqueue inbox fallback, emit settlement events, and commit;
4. otherwise increment the counter and version;
5. create one `pending` delivery reservation referencing that pair/version;
6. commit, then allow the internal adapter to claim it.

A Member-authored reply resets a pair only when immutable parent/delivery provenance identifies exactly one source/target work-session pair. The Server derives and locks that pair; no client reset-pair field exists. A top-level or ambiguous Member message resets none. A Teammate retry from proven `failed_retryable` creates a new delivery ID and consumes another unit. Unknown delivery is terminal and never auto-reinjected. Concurrent reset/reservation, concurrent top-level sends, and concurrent replies serialize on the pair row. Thread roots, message IDs, anchors, process restarts, and message deletion are not keys and cannot reset the row.

The pending-delivery TTL is exactly 15 minutes in Phase 1; expiry settles `expired` without adapter invocation. Cleanup eligibility for a pair begins only when both sessions are terminal and no `pending|dispatching` row references it. The execution-retention worker deletes eligible pair rows seven days later. Session-message delivery rows are retained 30 days after terminal settlement; message/audit/event references retain their IDs after operational row expiry.

### 5.3 Independent authorization functions

| Function | Grants | Explicitly does not grant |
|---|---|---|
| `canMessage(actor, anchor)` | Author a durable message after anchor visibility/write checks. | Live contact, handoff, terminal drive, hidden-anchor reads. |
| `canContactSession(actor, sourceSession, targetSession)` | Request one live delivery after storage; requires same Space, visible/live target, participant/contact policy, no self-contact. | Durable authoring, handoff projection, terminal drive, budget bypass. |
| `canHandoffEntity(actor, entity, targetSession)` | Render and attempt the governed entity projection after source-read and target-contact checks. | Message authoring, public prompt, terminal drive, mutation of source/target. |

Owner/admin roles do not bypass B1 or the pair budget. An owner/admin may repair graph associations and inspect an owned Teammate inbox only through named capabilities; that inspection never shares read marks.

### 5.4 Project association and launch authority

All `in_project` creation/promotion paths, including spawn's initial edge, lock the ProjectResource row, then affected Space rows in ascending UUID order. Under the lock they recheck the active `space_projects` row, live projection, same Space, and the source session's live-edge count. The 17th live association fails `limit_exceeded/project_association_cap`. Ordinary task/session edges remain writable; an owner/admin may delete an ordinary agent-created session edge. Project unlink locks the same resource and refuses while any live session has either a matching live edge or matching `launchProjectId`.

`work_sessions.project_id` is exposed as nullable `launchProjectId` and is never an association list. Spawn alone writes it. A `BEFORE UPDATE OF project_id` trigger raises an invariant violation when `OLD.project_id IS DISTINCT FROM NEW.project_id`. Deleting an association never changes cwd or provenance.

## 6. Projection, profile, feed, and messaging laws

### 6.1 Message batch and attachments

`messages.post` accepts 1–16 unique anchors, 0–16 unique finalized file IDs, at most 64 anchor×file pairs, and at most 256 KiB canonical request JSON. The stable idempotency identity hashes author, Space, sorted anchors, exact body bytes, sorted mention IDs, and sorted attachment IDs. The command de-duplicates, locks anchor rows then file rows in ascending UUID order, and commits all message rows, provenance, attachments, and `message.created` events atomically.

Each row keeps one immutable `anchor_id` and nullable `message_batch_id = clientMutationId`. No `message_batches` table, batch entity, batch route, or batch menu item exists. Replies derive the parent and same anchor Server-side. Files use protected `file -> attached_to -> message` edges; generic edge create/patch/delete refuses those edges.

### 6.2 Default channel

`spaces.default_channel_id` is nullable and references a live same-Space channel. Space creation selects the created default channel. Deleting the current default must atomically set a live successor or explicitly confirm `channelId=null`; heuristic selection is forbidden. Import maps an exported stable reference explicitly and otherwise enters the declared no-feed state with an audit. Navigation/settings expose the field and revision.

### 6.3 Feed policy and read authorization

The request union is `default|direct_v1|session_chat_v1`. `default` is an API request convenience only: ordinary entities resolve to `direct_v1`; `work_session` resolves to `session_chat_v1`; the response and cursor always carry the resolved concrete name and exact predicates. Profiles and persistent preferences may store only concrete names. The CLI exposes and accepts only `direct_v1|session_chat_v1`, so scripts never persist kind-dependent semantics.

`direct_v1 = subject,anchored`. `session_chat_v1 = subject,anchored,authored,replies,caused`, where replies are the exact transitive descendant closure of immutable seed messages. `root_message_id` is an index prefilter only; every parent chain is verified. Before returning any message admitted through `authored`, `replies`, or `around`, the query re-applies read authorization to its canonical anchor. Hidden anchors/items return the same non-leaking absence as missing. Candidates are logically de-duplicated before paging; cursors bind entity, resolved scope, exact predicates, order, and filters.

### 6.4 Interaction Profile and template split

`interaction_profile` is a restricted core kind, route slug `interaction-profiles`, collection strategy, registered but absent from the default menu. Universal reads/versions/messages/activity/reactions/connections are allowed. Generic create, patch, move, hierarchy, delete/restore, and points are disabled. The named lifecycle is the sole policy writer; retire is the deletion analogue. Share projection is a sanitized summary only: identity, status, template key/version, resolved hash, and provenance. Prompt/tool/credential policy never enters the browser or a handoff.

Static UI Templates are versioned registry assets, not entities. They have no messages, edges, authorship, migration row, CRUD operations, or CLI noun. Template operation bindings request actions but never grant authority. A profile pins a shipped key/version; missing versions fail validation or use a visibly recorded core fallback. `providerCaptureMode` is exactly `explicit-only` in Phase 1.

Resolution order is authorized human spawn override → Teammate default → Space default → built-in core. Spawn writes an immutable snapshot/hash to `work_session_interaction_pins` and materializes `selected_profile` for query/provenance. Running sessions read only the pin. Repin creates a new revision under `expectedPinRevision`; public edge repair cannot change runtime truth. Activation, retirement, defaults, and spawn override require a human Member owner/admin principal even when act-as is present.

### 6.5 Harness and CLI bootstrap

The agent manifest uses `TM8_AGENT_TOKEN`. Root bootstrap stays below 4 KiB, trusted kernel below 6 KiB, combined initial injection below 32 KiB. Exact operation lookup is total; root help never injects the 81/101-row table. Public grammar contains `message send --to ...` and `message reply <id>`, no `--anchor`, `--reply-to`, `report`, `progress`, `whoami`, alias layer, or public prompt. Native interactive Terminal is always available and complete; Chat is an optional peer and no profile may gate Terminal. PTY bytes/logs never author messages.

## 7. CLI freeze

| Capability | Exact CLI |
|---|---|
| Menu | `tm8 space menu get`; `tm8 space menu update --file <json> --expect-revision <n> --mutation-id <id>` |
| Default channel | `tm8 space default-channel set <channel-id|none> --expect-revision <n> --mutation-id <id>` |
| Message batch | `tm8 message send --to <entity-id> [--to ...] [body|-] [--attach <file-id>...] [--wait stored|settled] --mutation-id <id>` |
| Reply | `tm8 message reply <message-id> [body|-] [--notify-source inbox|live] --mutation-id <id>` |
| Delivery read | `tm8 message delivery <message-id>` |
| Attachments | `tm8 message attachment add|remove <message-id> <file-id>... --expect-version <n> --mutation-id <id>` |
| Feed | `tm8 entity feed <id> --scope direct_v1|session_chat_v1 --order newest|oldest [--around message:<id>|activity:<id>]` |
| Context | `tm8 entity context <id> [--section ...] [--budget-bytes <n>]` |
| Handoff | `tm8 handoff send <work-session-id> --entity <entity-id> --mutation-id <id>`; `handoff list`; `handoff withdraw` |
| Profile | `tm8 interaction-profile propose|update|validate|preview|activate|retire`; Teammate/Space default subcommands |
| Spawn | `tm8 session spawn [--project <id>|--workdir scratch] [--confirm-untrusted] [--interaction-profile <id>]` |
| Project repair | `tm8 project association correct <artifact-id> --project <id> --expect-version <n> --mutation-id <id>` |

All commands use standard JSON envelopes, closed errors, exit 0 success, ordinary taxonomy exits, and exit 11 only for stored-but-unsettled/mixed `--wait settled` delivery. `execution.prompt` has no CLI form.

## 8. Database and migration freeze

### 8.1 One additive migration boundary

W1 authors one forward migration after the shipped sequence. Exact table/column names are:

- `entity_kinds`: add `project` and `interaction_profile` rows;
- `edge_types`: add `in_project`, `shared_into`, `participates_in`, `authored_from`, `defaults_to_profile`, `selected_profile` with closed endpoint/origin/mutability guards;
- `project_links(space_id,project_id,project_entity_id,created_at,updated_at)`;
- `project_projection_details(entity_id,project_id,materialized_version,created_at,updated_at)`;
- `space_menu_configs(space_id,schema_version,revision,payload,created_at,updated_at)`;
- `spaces.default_channel_id`; `spaces.settings_revision integer NOT NULL DEFAULT 1 CHECK (settings_revision >= 1)`; and `spaces.default_interaction_profile_id uuid NULL REFERENCES interaction_profiles(entity_id) ON DELETE RESTRICT`;
- `interaction_profiles(entity_id,status,current_draft_version,active_version,active_hash,generated_by_team_member_id,retired_at,created_at,updated_at)`;
- `interaction_profile_versions(profile_id,version,draft_json,validation_status,validated_hash,validation_json,created_at)`;
- `work_session_interaction_pins(work_session_id,pin_revision,profile_id,profile_version,template_key,template_version,resolved_hash,resolved_snapshot,created_at)`;
- `work_session_view_preferences(member_id,work_session_id,content_surface,revision,updated_at)`;
- `session_message_deliveries(delivery_id,message_id,source_work_session_id,target_work_session_id,pair_low_session_id,pair_high_session_id,pair_budget_version,status,attempt_no,failure_reason,reserved_at,claimed_at,settled_at,updated_at)`;
- `session_wake_budgets(low_work_session_id,high_work_session_id,consecutive_agent_wakes,version,updated_at,eligible_for_cleanup_at)`;
- `session_handoffs(handoff_id,source_entity_id,target_work_session_id,delivery_status,record_status,request_hash,source_snapshot,envelope_hash,source_missing,record_version,withdrawn_by,withdrawn_at,withdraw_reason,created_at,updated_at)`;
- no participant/provenance side table: `participates_in` and `authored_from` use guarded rows in the universal `edges` table;
- `messages.message_batch_id`; reply parent remains the message entity's existing immutable `entities.parent_id`, and the shipped `messages.root_message_id` remains the root prefilter;
- `notifications.recipient_team_member_id` while retaining `recipient_member_id NOT NULL`;
- `activity.work_session_id`; `edges.updated_at`.

### 8.2 Checks, uniques, indexes, and triggers

Mandatory constraints/indexes:

```text
project_links: UNIQUE(space_id,project_id), UNIQUE(project_entity_id)
space_menu_configs: PK(space_id), CHECK(schema_version >= 1), CHECK(revision >= 1)
interaction_profiles: PK(entity_id)
spaces: partial index spaces_default_interaction_profile_idx(default_interaction_profile_id) WHERE default_interaction_profile_id IS NOT NULL
interaction_profile_versions: PK(profile_id,version), UNIQUE(profile_id,validated_hash) WHERE validated_hash IS NOT NULL
work_session_interaction_pins: PK(work_session_id,pin_revision), UNIQUE(work_session_id,resolved_hash,pin_revision)
session_wake_budgets: PK(low_work_session_id,high_work_session_id), CHECK(low < high), CHECK(counter BETWEEN 0 AND 4)
session_message_deliveries: UNIQUE(message_id,target_work_session_id,attempt_no), status closed CHECK
session_handoffs: PK(handoff_id), legal deliveryStatus×recordStatus CHECK, immutable request_hash
edges: unique guarded `participates_in` and `authored_from` pairs plus type/destination/source indexes used by participant and provenance lookup
messages: retain (anchor_id,created_at,id) and (root_message_id,created_at,id); add (message_batch_id,id); reply traversal joins immutable `entities.parent_id`
activity: index(work_session_id,created_at,id)
notifications: Member-personal and Teammate-recipient partial cursor/unread indexes
```

`spaces.default_interaction_profile_id=NULL` means that the Space contributes no default and resolution continues to built-in core after the Teammate-default step. The typed FK proves that a non-null value names an `interaction_profile`; it is never a generic entity FK or a `defaults_to_profile` edge. `set_space_profile_default` is its sole application writer. It derives an authenticated human Member owner/admin for the target Space and rejects agent tokens, system principals, and act-as selection with `profile_principal_required`. For a non-null target it locks the profile entity and selected active version before the Space row; requires a same-Space, readable, live entity, `retired_at IS NULL`, a non-null `active_version`/`active_hash`, and the matching successful immutable validation/hash; and requires `confirmAgentGenerated=true` when generator provenance is present. Wrong-Space, deleted, or unreadable targets use the ordinary non-leaking absence response; retired targets use `profile_retired`; inactive or unmatched-validation targets use `profile_not_validated`.

After locking the Space row, the RPC compares `expectedSettingsRevision` to `settings_revision`. A mismatch returns `conflict` with `details.currentRevision` and writes nothing. A genuine null/non-null/replacement change updates the column, increments the revision exactly once, records the command ledger result, and emits `interaction_profile.default_updated` in the same transaction. An exact ledger replay never increments or emits twice. A new mutation that requests the already-stored value still checks the revision and records its result, but performs no row change, revision increment, or event. Reads expose `defaultInteractionProfileId` and `settingsRevision` through the member-authorized Space-settings/profile-default projection; public Space summaries/discovery never project the profile ID. The application role has no direct write grant.

Triggers/RPC guards enforce immutable launch project, message anchor/author/entity-parent/root, the recorder-owned `authored_from` edge, pin snapshots, delivery identity, handoff request identity, recorder-owned `shared_into|selected_profile`, message-owned attachment edges, last-participant preservation for a live session, Project association cap/link validation, and Space-local endpoints. Each command uses the command ledger and emits event rows in the same transaction as durable state.

### 8.3 Locks and transaction order

1. Project association/link lifecycle: ProjectResource → affected Spaces sorted → projection/entity/edge rows sorted.
2. Message batch: anchors sorted → files sorted; it takes no Project or work-session locks.
3. Delivery: unordered pair budget → delivery row; no DB lock is held across `proc.write`.
4. Participant removal: work-session row → `participates_in` edge rows sorted; refuse removal of the last live participant.
5. Menu/default-channel settings: Space row → config/default-channel row.
6. Profile lifecycle: profile entity → profile version; non-null defaults then lock the target Teammate/Space. A20 replacement follows profile entity → selected active profile version → Space; A20 clear locks only the Space. Spawn locks the chosen profile version then writes the pin.
7. Entity delete/restore/materializer: affected entity rows sorted → counterpart rows sorted for counter recompute.

### 8.4 RLS and SECURITY DEFINER boundary

All reads run with transaction-local authenticated claims and Space RLS. Feed RLS joins back to canonical message anchors before projection. The application role has no direct writes. Enumerable SECURITY DEFINER RPCs own commands. The delivery worker uses a dedicated unprivileged DB role that may execute only these three delivery database RPCs: `reserve_session_message_delivery`, `claim_session_message_delivery`, and `settle_session_message_delivery`. Their defining migration explicitly revokes default/PUBLIC and application-role execution before granting the dedicated role; the functions validate the internal principal tuple and never accept caller-selected actor claims. The separately authorized execution-adapter write is the single governed PTY `proc.write` effect; it is not a database RPC and confers no DB grant or graph-write authority. No expiry, recovery, retention, cleanup, or notification RPC is authorized or implied by this allowlist. Owner inspection of Teammate inboxes is a separate RPC/read policy and excludes read-mark writes.

### 8.5 Backfill, repair, retention, and rollback

- Project projection/backfill runs only for active `space_projects` with live projections. Legacy unmatched `work_sessions.project_id` remains provenance and produces an actionable audit; it never relinks.
- Pre-existing over-cap ProjectResources become `linkFrozen`; unlink remains the repair and clears at 16.
- Session association backfill creates at most one launch-derived edge and never exceeds 16.
- Profiles have no legacy rows. Add `spaces.default_interaction_profile_id` as nullable with every existing Space backfilled to `NULL`, and backfill `spaces.settings_revision=1`; infer no profile default. Create one built-in core registry definition and resolve existing live/future sessions to a recorded core pin without inventing user profiles.
- Participant backfill uses only unambiguous existing Teammate/session facts. Ambiguous sessions receive an audit and no invented/relinked Teammate.
- Existing messages receive null batch/source/parent values; no inferred provenance.
- Existing Member notification rows keep `recipient_team_member_id=NULL`.
- Default channel backfill uses an explicitly recorded current product default if uniquely known; otherwise records no-feed plus audit, never “first” or `general` heuristics.
- Menu backfill materializes the versioned default payload at revision 1.

Repair commands are idempotent and audit every mutation. Rollback is forward-only: quiesce new bindings, drain delivery/handoff rows, clear Space profile defaults under the same Space locks while advancing `settings_revision`, append core pin revisions rather than mutating immutable historical pins, remove materialized edges/projections through RPCs, and then apply an explicit compensating migration that removes `spaces_default_interaction_profile_idx`, its FK, and the column only after references are gone. Never rewrite or drop the shipped migration history. Operational delivery rows retain 30 days after settlement; pair budgets retain seven days after eligibility; handoff audit/message/event history follows normal Space retention.

## 9. Durable events

The event union adds `menu.updated`, `space.default_channel.updated`, `project.association.corrected`, `handoff.prepared|delivery_settled|recorded|withdrawn`, `message.delivery_reserved|settled`, `message.attachments.updated`, `interaction_profile.proposed|updated|validated|activated|retired`, `interaction_profile.default_updated`, `work_session.profile_pinned|repinned`, and ordinary entity/edge/message variants for their rows. Every durable event carries `spaceId`, per-Space `seq`, `occurredAt`, `schemaVersion`, and `clientMutationId?`. Live publication must originate from/reconcile with `workspace_events`; the current in-memory sequence publisher is a skeleton and may not be described as production-durable.

## 10. Required conformance gate

W1–W5 must implement and pass:

- the harness D1–D7, B1–B7, P1–P10, C1–C5, M1–M12, R1–R8, and S1–S6 cases;
- B1 Member/Teammate/owner/admin/act-as negative calls with unchanged queue and zero bytes;
- B2 top-level/reply concurrency, fifth-attempt breaker, Member reset race, retry consumption, restart persistence, and terminal cleanup;
- 81-baseline and 101-target generated catalog/route/DTO/help/CLI reachability proofs at their respective migration stages;
- total kind registry/projection/capability/menu/migration exhaustiveness;
- feed anchor non-leak, transitive closure, de-dup-before-page, cursor fingerprint, and `around` non-leak;
- profile principal, validation hash, retirement/default reference, template projection, pin immutability, and Terminal-never-gated cases;
- Project link/create/unlink race, association cap/admin repair, launch-root union guard, and DB immutability trigger;
- handoff kill-window and legal two-axis matrix cases;
- migration backfill/repair/compensating rollback on a copy of the 43-table baseline;
- durable event replay from stored per-Space sequence, including restart/reconnect.

No W1–W5 implementation is complete merely because a route is mounted. Reserved and unavailable operations remain honest `501 not_implemented`; WS skeleton status remains explicit until semantic subscription delivery passes.
