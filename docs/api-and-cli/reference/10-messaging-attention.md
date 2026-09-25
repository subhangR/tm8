# Messages, chat, inbox, read marks, attention requests, handoffs, presence

This family covers how one entity talks to another and how a member or agent keeps
track of what changed. `messages.*` is the anchor-first discussion primitive shared by
every entity kind (a task's comments and a channel's chat are the same rows);
`chat.start` is the single door a chat thread is born through, after which every later
turn — human or agent — travels through `messages.post`. `attentionRequests.*` is the
generic "somebody needs to look at this" queue any entity can carry. `inbox.*` /
`readMarks.*` are per-member read state (notifications and last-read cursors).
`handoffs.*` hands a work session's context to another live session. `presence.get`
reports who is currently viewing/typing on an entity, when this node tracks it.

All operations live on the closed v1 catalog (`packages/contract/src/catalog.ts`) and
all 19 have a registered handler on this commit — none answer a bare 501, though
`presence.get` is registered only when the node has a presence store configured
(otherwise the router's honest 501 applies; see its Notes).

## Summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `attentionRequests.list` | GET | `/v2/attention-requests` | read | yes |
| `attentionRequests.create` | POST | `/v2/entities/:entityId/attention-requests` | command | yes |
| `attentionRequests.update` | PATCH | `/v2/attention-requests/:requestId` | command | yes |
| `attentionRequests.resolveEntity` | POST | `/v2/entities/:entityId/attention-requests/resolve` | command | yes |
| `messages.list` | GET | `/v2/entities/:anchorId/messages` | read | yes |
| `messages.post` | POST | `/v2/messages` | command | yes |
| `messages.edit` | PATCH | `/v2/messages/:id` | command | yes |
| `messages.delete` | DELETE | `/v2/messages/:id` | command | yes |
| `chat.start` | POST | `/v2/chats` | command | yes |
| `inbox.list` | GET | `/v2/inbox` | read | yes |
| `inbox.markRead` | PUT | `/v2/inbox/:notificationId/read` | command | yes |
| `readMarks.upsert` | PUT | `/v2/read-marks/:anchorId` | command | yes |
| `presence.get` | GET | `/v2/entities/:id/presence` | read | yes, conditional (see Notes) |
| `handoffs.send` | POST | `/v2/work-sessions/:workSessionId/handoffs` | command | yes |
| `handoffs.list` | GET | `/v2/work-sessions/:workSessionId/handoffs` | read | yes |
| `handoffs.withdraw` | POST | `/v2/handoffs/:handoffId/withdraw` | command | yes |
| `messages.attachments.add` | POST | `/v2/messages/:messageId/attachments` | command | yes |
| `messages.attachments.remove` | DELETE | `/v2/messages/:messageId/attachments` | command | yes |
| `messages.delivery.get` | GET | `/v2/messages/:messageId/delivery` | read | yes |

Source: `packages/contract/src/catalog.ts:118-121` (attention requests),
`:157-165` (messages, chat), `:231-233` (inbox, read marks), `:250` (presence),
`:325-330` (handoffs, attachments, delivery).

## Shared types

**`CommandContext`** (`packages/contract/src/contract.ts:1698`) — embedded in every
command input below: `actorId?: EntityId` (impersonated actor; server resolves the
caller's identity when absent), `clientMutationId?: string` (idempotency key — the
server's command ledger dedupes a retried request that carries the same id; several
operations below make it required rather than optional), `workSessionId?: EntityId`
(the session that originated the command, authorized against the resolved actor).

**`ActorSummary`** (`contract.ts:107`) — `{ id, kind: 'member'|'team_member'|'work_session',
displayName, avatar?, role?, ownerMemberId?, isAgent, via?: { sessionId } }`. `via` is
present when the actor resolved through a work session (a run acting as a persona).

**`Page<T>`** (`contract.ts:989`) — `{ items: T[], nextCursor: Cursor | null, total?: number }`.
Every list op below returns this shape; `nextCursor` is an opaque keyset string, `null`
on the last page.

**`EntitySummary`** / **`MessageView`** (`contract.ts:154`, `:1137`) — the generic entity
row and its message specialization (`state`/`content` narrowed to `kind: 'message'`,
plus `replyCount`, `lastReplyAt`, `replyParticipants`, optional `parts` and
`turnInFlight`). Defined in full in the entities reference; referenced by name here.
A message's `content` is `{ kind: 'message', body, mentions: Mention[], attachments:
FileAttachment[] }` (`contract.ts:780`); `Mention` is `{ entityId, kind:
'member'|'team_member', display }` (`contract.ts:886`); `FileAttachment` is
`{ fileEntityId, name, mime }` (`contract.ts:887`).

**Error envelope** — every non-2xx response is
`{ error: { code, message, details?, requestId, retryable } }` with HTTP status from
`ERROR_STATUS[code]` (`contract.ts:1628`, `packages/server/src/http/errors.ts:1-14`).
Relevant codes for this family: `invalid_input`/`invalid_cursor` (400),
`unauthenticated` (401), `forbidden` (403), `not_found` (404), `version_conflict`/
`conflict`/`invariant_violation` (409), `upstream_unavailable` (503),
`not_implemented` (501).

---

### `attentionRequests.list`
`GET /v2/attention-requests` · kind: read · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entities-commands-tracking.ts:1788`,
registered at `packages/server/src/facade/handlers/w2/entities-commands-tracking.ts:25`)
CLI: `tm8 attention list`

Lists attention requests across a space, newest-first by points then age, optionally
scoped to one entity or status.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `spaceId` | uuid | yes | — | space to list within |
| `entityId` | uuid | no | — | scope to one entity's requests |
| `status` | enum | no | `open`\|`acknowledged`\|`resolved`\|`dismissed` | filter by status |
| `minPoints` | int | no | 1–100 | minimum points |
| `limit` | int | no | default 50, max 200 (`limitOf`, `packages/server/src/facade/context.ts:144-154`) | page size |
| `cursor` | string | no | — | opaque keyset from a prior page |

Example: `GET /v2/attention-requests?spaceId=<uuid>&status=open&limit=20`

**Response** — 200; `data: Page<AttentionRequest>`

| field | type | description |
|---|---|---|
| `items[].id` | string | attention request id |
| `items[].spaceId` | uuid | |
| `items[].entityId` | uuid | entity the request targets |
| `items[].reason` | string | |
| `items[].points` | int | severity/urgency weight |
| `items[].status` | enum | `open`\|`acknowledged`\|`resolved`\|`dismissed` |
| `items[].version` | int | optimistic-concurrency version |
| `items[].requestedBy` / `acknowledgedBy` / `resolvedBy` | `ActorSummary` \| null | |
| `items[].resolutionNote` | string \| null | |
| `items[].createdAt` / `updatedAt` / `acknowledgedAt` / `resolvedAt` | ISO timestamp \| null | |
| `nextCursor` | string \| null | |

```json
{"data": {"items": [{"id": "<uuid>", "spaceId": "<uuid>", "entityId": "<uuid>",
  "reason": "needs review", "points": 5, "status": "open", "version": 1,
  "requestedBy": {"id": "<uuid>", "kind": "member", "displayName": "<redacted>", "isAgent": false},
  "acknowledgedBy": null, "resolvedBy": null, "resolutionNote": null,
  "createdAt": "2026-09-20T00:00:00.000Z", "updatedAt": "2026-09-20T00:00:00.000Z",
  "acknowledgedAt": null, "resolvedAt": null}], "nextCursor": null}, "requestId": "<redacted>"}
```
(illustrative, from schema)

**Errors** — `invalid_input` (400): missing/malformed `spaceId`, bad `entityId`, bad
`status`, `minPoints` out of 1–100. `invalid_cursor` (400): cursor does not match this
query's fingerprint (spaceId/entityId/status/minPoints).
**Notes**: no idempotency (read). RLS scopes results to what the caller can see.
Source: `packages/server/src/facade/services/w2/entities-commands-tracking.ts:1788-1849`;
contract type `AttentionRequestPage`/`AttentionRequest` at `packages/contract/src/contract.ts:644,671`.

---

### `attentionRequests.create`
`POST /v2/entities/:entityId/attention-requests` · kind: command · status: v1 · served: yes
(`entities-commands-tracking.ts:1851`)
CLI: `tm8 entity attention <entity-id>` (`packages/cli/src/commands/entity.ts:987`)

Opens a new attention request against an entity.

**Path params** — `entityId` (uuid): the entity the request targets.

**Request body** — `CreateAttentionRequestInput` (`contract.ts:2635`, schema
`CreateAttentionRequestInputSchema` at `packages/contract/src/schemas.ts:2416`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | uuid | no | | impersonated actor |
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `workSessionId` | uuid | no | | originating session |
| `reason` | string | yes | trimmed, 1–500 chars | |
| `points` | int | yes | 1–100 | |

```json
{"reason": "blocked on design review", "points": 10, "clientMutationId": "<uuid>"}
```

**Response** — 201; `data: AttentionRequestMutationResult` (`contract.ts:673`)

| field | type | description |
|---|---|---|
| `request` | `AttentionRequest` \| null | the created request |
| `entity` | `EntitySummary` | the targeted entity, refreshed |
| `affectedCount` | int | rows the RPC touched |

```json
{"data": {"request": {"id": "<uuid>", "status": "open", "points": 10, "...": "..."},
  "entity": {"id": "<uuid>", "...": "..."}, "affectedCount": 1}, "requestId": "<redacted>"}
```
(illustrative, from schema)

**Errors** — `invalid_input` (400): schema violation. `not_found` (404): no such
entity. Handler wraps the result at 201 explicitly
(`packages/server/src/facade/handlers/w2/entities-commands-tracking.ts:26`).
**Notes**: `clientMutationId` required (idempotent retry). Mutates through RPC
`create_attention_request`.
Source: `entities-commands-tracking.ts:1851-1866`.

---

### `attentionRequests.update`
`PATCH /v2/attention-requests/:requestId` · kind: command · status: v1 · served: yes
(`entities-commands-tracking.ts:1868`)
CLI: `tm8 attention update <attention-request-id> --expect-version <n> [--reason] [--points] [--status] [--note]`

Updates one or more fields of an existing attention request (partial patch — at least
one of `reason`/`points`/`status`/`resolutionNote` required).

**Path params** — `requestId` (uuid).

**Request body** — `UpdateAttentionRequestInput` (`contract.ts:2642`, schema at
`schemas.ts:2423`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | int | yes | positive | optimistic-concurrency guard |
| `reason` | string | no | trimmed, 1–500 | |
| `points` | int | no | 1–100 | |
| `status` | enum | no | `open`\|`acknowledged`\|`resolved`\|`dismissed` | |
| `resolutionNote` | string | no | trimmed, max 1000 | |

**Response** — 200; `data: AttentionRequestMutationResult` (same shape as `create`).

**Errors** — `invalid_input` (400): no field to update supplied, or schema violation.
`version_conflict` (409): `expectedVersion` stale. `not_found` (404): no such request.
**Notes**: idempotent via `clientMutationId`. RPC `update_attention_request`.
Source: `entities-commands-tracking.ts:1868-1886`.

---

### `attentionRequests.resolveEntity`
`POST /v2/entities/:entityId/attention-requests/resolve` · kind: command · status: v1 · served: yes
(`entities-commands-tracking.ts:1888`)
CLI: `tm8 attention resolve-entity <entity-id> [--note]`

Resolves every open attention request on one entity in one call (bulk resolve, not
scoped to a single request id).

**Path params** — `entityId` (uuid).

**Request body** — `ResolveEntityAttentionInput` (`contract.ts:2652`, schema at
`schemas.ts:2436`): `clientMutationId` (string, required), `resolutionNote?` (string,
trimmed, max 1000).

**Response** — 200; `data: AttentionRequestMutationResult`. `request` is the most
recently resolved request (or `null` if none were open); `affectedCount` is how many
requests the resolve touched.

**Errors** — `invalid_input` (400): schema violation. `not_found` (404): no such
entity.
**Notes**: idempotent via `clientMutationId`. RPC `resolve_entity_attention`.
Source: `entities-commands-tracking.ts:1888-1902`.

---

### `messages.list`
`GET /v2/entities/:anchorId/messages` · kind: read · status: v1 · served: yes
(`packages/server/src/facade/handlers/messages.ts:290`, registered at
`packages/server/src/facade/handlers/w2/messages-handoffs.ts:17`)
CLI: `tm8 message list <anchor-entity-id> [--limit] [--cursor] [--order] [--root]`

Lists a thread's ROOT messages (or, with `rootMessageId`, the replies under one root),
addressed by anchor (the entity the discussion is about — a task, a channel, a chat).
Roots whose complete reply branch fits under 20 messages get that branch embedded
inline (`replies`); larger branches keep only their `replyCount` and are paged
separately via `rootMessageId`.

**Path params** — `anchorId` (uuid): the entity the thread hangs off.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | int | no | default 50, max 200 | page size |
| `cursor` | string | no | — | opaque keyset |
| `order` | enum | no | `oldest`\|`newest`, default `oldest` | thread scan direction |
| `rootMessageId` | uuid-like string | no | — | switch to "replies under this root" |

**Response** — 200; `data: Page<MessageView>`. `MessageView` extends `EntitySummary`
with `state`/`content` narrowed to `kind: 'message'`, plus `replyCount: number`,
`lastReplyAt: string | null`, `replyParticipants?: ActorSummary[]`,
`parts?: MessagePart[]` (structured chat-turn output), `replies?: Page<MessageView>`
(embedded branch), `turnInFlight?: boolean` (true while an in-progress chat turn owns
this message's body).

```json
{"data": {"items": [{"id": "<uuid>", "kind": "message", "title": "...",
  "state": {"kind": "message", "anchorId": "<uuid>", "rootMessageId": null,
    "author": {"id": "<uuid>", "kind": "member", "displayName": "<redacted>", "isAgent": false},
    "messageBatchId": "<uuid>"},
  "content": {"kind": "message", "body": "hello", "mentions": [], "attachments": []},
  "replyCount": 0, "lastReplyAt": null, "replyParticipants": []}], "nextCursor": null},
  "requestId": "<redacted>"}
```
(illustrative, from schema)

**Errors** — `unauthenticated` (401): anonymous caller or unresolved bearer identity.
`invalid_input` (400): `order` not `oldest`/`newest`. `not_found` (404): malformed
`rootMessageId`. `invalid_cursor` (400): cursor fingerprint mismatch (anchor/root/order).
**Notes**: no idempotency (read). RLS: `messages_select` requires the anchor AND the
message both be `entity_readable`.
Source: `handlers/messages.ts:290-417`.

---

### `messages.post`
`POST /v2/messages` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/messages-handoffs.ts:428`)
CLI: `tm8 message send <anchor-id...> --body <text>` / `tm8 message reply <message-id> --body <text>`

Posts one message, optionally to several anchors at once (a batch), or as a threaded
reply. Also the sole write path a chat's later turns use (after `chat.start` opens the
thread). Can wake live work sessions: as an anchor that IS a work session, as the
session being replied to, via explicit `pokeSessionIds`, or via any live session
`working_on` a task the batch is anchored on.

**Request body** — `PostMessageInput` (`contract.ts:2688`, wire schema
`PostMessageInputSchema` at `packages/contract/src/schemas.ts:2482-2535`; accepts a
deprecated single `anchorId` normalized into `anchorIds`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `anchorIds` | uuid[] | one of `anchorIds`/`anchorId`/`replyToMessageId` | 1–16 unique | targets to post to |
| `anchorId` | uuid | (deprecated alias) | | single-anchor legacy form |
| `conversationAnchorId` | uuid \| null | no | must be one of the anchors | canonical reply-origin anchor for a multi-anchor post |
| `replyToMessageId` | uuid | no | mutually exclusive with anchors/`parentMessageId`/`conversationAnchorId` | routed session reply — anchor/parent derived server-side |
| `body` | string | yes | 1–10,000 chars | |
| `parentMessageId` | uuid \| null | no | requires exactly 1 anchor | explicit thread parent |
| `mentionIds` | uuid[] | no | 0–16 unique | |
| `attachmentIds` | uuid[] | no | 0–16 unique; anchors × attachments ≤ 64 | |
| `pokeSessionIds` | uuid[] | no | 0–16 unique | sessions to wake without anchoring |
| `mode` | enum | no | `ask`\|`explain`\|`plan`\|`build`\|`orchestrate`\|`craft` | per-turn chat mode (chat anchors only) |

Whole-request canonical JSON is capped at 256 KiB.

```json
{"anchorIds": ["<task-id>"], "body": "status update", "clientMutationId": "<uuid>"}
```

**Response** — 200; `data: MessageBatchResult` (`contract.ts:2747`)

| field | type | description |
|---|---|---|
| `messageBatchId` | string | |
| `messages` | `MessageView[]` | one per anchor |
| `delivery?` | `MessageDeliveryDisposition[]` | present iff the batch named ≥1 session; per-target `{targetMessageId, targetWorkSessionId, status: 'accepted'\|'skipped'\|'undelivered', reason?, deliveryId?}` |

**Errors** — `invalid_input` (400): empty `anchorIds`, both/neither of
`anchorIds`/`anchorId`, `replyToMessageId` combined with anchors, anchor×attachment
product > 64. `forbidden` (403): a reply requires a work-session-bound credential
(`details.reason` may carry `message_batch_identity_mismatch` when the RPC's identity
check fails). `upstream_unavailable` (503): stored batch could not be reloaded.
**Notes**: `clientMutationId` required — idempotent replay returns the original batch.
Delivery dispatch runs AFTER the write transaction commits and is best-effort/observed,
not part of the HTTP response's success/failure. `senderAttribution` on a delivered
copy is `verified` only when a session-bound credential authored the message.
Source: `messages-handoffs.ts:428-583`.

---

### `messages.edit`
`PATCH /v2/messages/:id` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:585`)
CLI: `tm8 message update <message-id> --expect-version <n> --body <text>`

Edits a message's body and/or mentions.

**Path params** — `id` (uuid).

**Request body** — `PatchMessageInput` (`contract.ts:2760`, schema `schemas.ts:2537`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | int | yes | positive | |
| `body` | string | yes | 1–10,000 chars | |
| `mentions` | `Mention[]` | no | | **absent ≠ empty**: omitted leaves stored mentions untouched; `[]` clears them |

**Response** — 200; `data: MessageView` (the edited message, reloaded).

**Errors** — `version_conflict` (409): `expectedVersion` stale. `not_found` (404): no
readable message at that id.
**Notes**: `clientMutationId` required. RPC `w2_edit_message`.
Source: `messages-handoffs.ts:585-608`.

---

### `messages.delete`
`DELETE /v2/messages/:id` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:610`)
CLI: `tm8 message delete <message-id> --expect-version <n>`

Tombstones (soft-deletes) a message.

**Path params** — `id` (uuid).
**Request body** — `DeleteMessageInput` (`contract.ts:2767`, schema `schemas.ts:2545`):
`clientMutationId` (required), `expectedVersion` (int, positive).

**Response** — 200; `data: MessageView` (the message post-tombstone, e.g. with
`redactedAt` set in `state`).

**Errors** — `version_conflict` (409), `not_found` (404).
**Notes**: `clientMutationId` required. RPC `w2_tombstone_message`.
Source: `messages-handoffs.ts:610-620`.

---

### `chat.start`
`POST /v2/chats` · kind: command · status: v1 · served: yes
(`packages/server/src/chat/handlers.ts:30`, registered at `:154-162`)
CLI: `tm8 chat start`

Creates a chat entity and posts its opening turn in one transaction — the only door a
chat is born through. Human-callers only (`humanOnly` wrapper refuses a
chat-runtime/agent bearer both here and again inside the `start_chat` RPC).

**Request body** — `StartChatInput` (`contract.ts:1269`, schema
`StartChatInputSchema` at `schemas.ts:1317`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `spaceId` | uuid | yes | | |
| `teammateId` | uuid | yes | | the agent teammate the chat runs as |
| `model` | string | yes | min 1; must resolve via `launchModel` to `agentTool: 'claude-code'` | |
| `mode` | enum | yes | `ask`\|`explain`\|`plan`\|`build`\|`orchestrate`\|`craft` | |
| `workdirMode` | enum | yes | `project`\|`scratch` | |
| `projectId` | uuid \| null | required iff `workdirMode: 'project'` | | |
| `title` | string \| null | no | max 240 | defaults to body, trimmed to 240 chars |
| `body` | string | yes | 1–10,000 | the opening turn |
| `attachmentIds` | uuid[] | no | max 16 | |
| `aboutId` | uuid \| null | no | | written as an `about` edge |
| `clientMutationId` | string | yes | min 1 | |

**Response** — 200; `data: StartChatResult` (`contract.ts:1291`):
`{ chat: EntitySummary, messageId: EntityId }` (the opening message, already queued as
turn one).

**Errors** — `invalid_input` (400): unsupported/non-claude-code `model`.
`unauthenticated` (401). `upstream_unavailable` (503): chat runtime not configured on
this node, or the created chat could not be read back. `forbidden` (403): non-human
(chat-runtime) bearer credential.
**Notes**: `clientMutationId` required. A `scratch` workdir gets a server-created
directory under the node's data dir; a `project` workdir's path is resolved
server-side from `projects.working_dir` and any client-supplied path is ignored. On
success the orchestrator is woken asynchronously (`queueMicrotask`) to run the opening
turn — the HTTP response does not wait for it.
Source: `packages/server/src/chat/handlers.ts:30-162`.

---

### `inbox.list`
`GET /v2/inbox` · kind: read · status: v1 · served: yes
(`packages/server/src/facade/services/w2/inbox-read-marks.ts:394`, registered at
`packages/server/src/facade/handlers/w2/inbox-read-marks.ts:15`)
CLI: `tm8 inbox list [--recipient] [--space] [--unread] [--limit] [--cursor]`

Lists notification rows (mentions, assignments, awards, unblocks, review requests,
stale flags) for the caller or a named recipient.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `recipient` | JSON-encoded `InboxRecipient` | no | `{type:'member',memberId}` \| `{type:'team_member',teamMemberId}` | defaults to the caller's own member inbox |
| `spaceId` | uuid | no | | |
| `unread` | `'true'`\|`'false'` | no | | |
| `cursor` | string | no | | |
| `limit` | int | no | default 50, max 100 | |

**Response** — 200; `data: Page<NotificationItem>` (`contract.ts:1563`)

| field | type | description |
|---|---|---|
| `id` | string | |
| `spaceId` | uuid | |
| `kind` | string | `mention`\|`assignment`\|`award`\|`unblock`\|`review_request`\|`stale`\|... |
| `actor?` | `ActorSummary` \| null | absent when the notification has no actor |
| `target?` | `EntitySummary` \| null | absent field, or `null` if unreadable |
| `message?` | string | the referenced message's excerpt, when readable |
| `recipient` | `ActorSummary` | |
| `readAt` | ISO timestamp \| null | |
| `createdAt` | ISO timestamp | |

**Errors** — `invalid_input` (400): unknown query key, malformed `recipient` JSON, bad
`unread`. `not_found` (404): a `team_member` recipient the caller is not authorized to
act as, or (for an agent bearer / `ctx.identity.actorId` set) any recipient other than
that session's own actor.
**Notes**: no idempotency (read). A `team_member` recipient is read through
`inspect_owned_teammate_inbox`; every other recipient reads `public.notifications`
directly, gated by `recipientAuthorized`.
Source: `inbox-read-marks.ts:394-427`.

---

### `inbox.markRead`
`PUT /v2/inbox/:notificationId/read` · kind: command · status: v1 · served: yes
(`inbox-read-marks.ts:429`)
CLI: `tm8 inbox mark-read <notification-id>`

Marks one notification read.

**Path params** — `notificationId` (uuid).
**Request body** — `InboxMarkReadInput` (`contract.ts:6756`, schema `schemas.ts:4364`):
`clientMutationId` (string, required), `recipient?` (`InboxRecipient`).

**Response** — 200; `data: NotificationItem` (see `inbox.list`).

**Errors** — `not_found` (404): recipient mismatch/unauthorized, or the RPC returns no
row.
**Notes**: `clientMutationId` required. RPC `mark_notification_read`.
Source: `inbox-read-marks.ts:429-457`.

---

### `readMarks.upsert`
`PUT /v2/read-marks/:anchorId` · kind: command · status: v1 · served: yes
(`inbox-read-marks.ts:459`)
CLI: `tm8 message mark-read <anchor-entity-id>`

Advances the caller's last-read cursor on an anchor to now. There is no
"mark read through message X" input in v1 — only "as of now" (see Notes).

**Path params** — `anchorId` (uuid): the thread/entity being marked read.
**Request body** — bound at the router to `RequiredCommandContextSchema`
(`packages/server/src/facade/input-schemas.ts:154-157`: `actorId?`, `clientMutationId`
required), then re-validated inside the service against the looser
`CommandContextSchema` with an explicit non-empty check
(`inbox-read-marks.ts:462-463`).

**Response** — 200; `data`: `{ anchorId: string, lastReadAt: string, patches: unknown[] }`.

**Errors** — `invalid_input` (400): missing `clientMutationId`, malformed `actorId`.
**Notes**: `clientMutationId` required. RPC `mark_read(anchor_id, client_mutation_id)`
— it takes no message id, so a caller cannot position the cursor at a specific message;
the CLI's `--through <message-id>` flag is refused locally with
`invalid_input`/usage error pending a grammar amendment (§9.2 item 26,
`packages/cli/src/commands/inbox.ts:95-135`).
Source: `inbox-read-marks.ts:459-468`.

---

### `presence.get`
`GET /v2/entities/:id/presence` · kind: read · status: v1 · served: yes, only when this
node has a presence source configured (`deps.presence`); otherwise the router's honest
`501 not_implemented` applies — never an empty snapshot
(`packages/server/src/events/handlers.ts:142-157`)
CLI: `tm8 presence get <entity-id>`

Reads who is currently viewing/typing on one entity (ephemeral, not persisted
history).

**Path params** — `id` (uuid): the entity to read presence for.

**Response** — 200; `data: PresenceSnapshot` (`contract.ts:1318`)

| field | type | description |
|---|---|---|
| `viewers` | `ActorSummary[]` | members currently viewing |
| `typingActorIds` | `EntityId[]` | member entity ids currently typing |
| `updatedAt` | ISO timestamp | |

**Errors** — `invalid_input` (400): missing entity id. `not_found` (404): non-uuid id,
or an entity the caller cannot read (RLS-shadowed — indistinguishable from
nonexistent).
**Notes**: no idempotency (read). Order of operations is deliberate: the entity is
read under the caller's own claims BEFORE the presence store is consulted, so a caller
who cannot see the entity never learns who is viewing it; the store is keyed by the
entity's real `space_id` from that row, not by anything a writer claimed.
Source: `packages/server/src/events/handlers.ts:142-226`; type at `contract.ts:1318`.

---

### `handoffs.send`
`POST /v2/work-sessions/:workSessionId/handoffs` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:705`)
CLI: `tm8 handoff send <work-session-id> --source <entity-id>`

Hands one entity's content snapshot to a live work session, dispatching it over the
session's PTY when a delivery adapter is configured.

**Path params** — `workSessionId` (uuid): the target session.
**Request body** — `SendHandoffInput` (`contract.ts:6201`, schema `schemas.ts:3782`):
`clientMutationId` (required), `sourceEntityId` (uuid).

**Response** — 200; `data: HandoffView` (`contract.ts:6219`)

| field | type | description |
|---|---|---|
| `handoffId` | string | |
| `sourceEntityId` | uuid | |
| `targetWorkSessionId` | uuid | |
| `deliveryStatus` | enum | `prepared`\|`dispatching`\|`delivered`\|`refused`\|`unknown` |
| `recordStatus` | enum | `pending`\|`recorded`\|`failed`\|`withdrawn` |
| `sourceSnapshot` | `ShareProjectionEnvelope` | `{entityId, kind, title, contentVersion, sourceSpaceId, body, bodyBytes, truncated, omittedFields}` |
| `envelopeHash` | string | |
| `sourceMissing` | bool | |
| `recordVersion` | int | |
| `withdrawnBy` | `ActorSummary` \| null | |
| `withdrawnAt` / `withdrawReason` | string \| null | |
| `createdAt` / `updatedAt` | ISO timestamp | |

**Errors** — `forbidden` (403): `details.reason: 'handoff_forbidden'` when the RPC
refuses. `invalid_input` (400): concurrent dispatch of the same handoff with a
mismatched fingerprint (`'handoff dispatch identity mismatch'`).
**Notes**: `clientMutationId` required. If no dispatch is needed (or no delivery
adapter configured) the RPC-prepared `HandoffView` is returned as-is; otherwise the
handler claims and dispatches the write, de-duplicating concurrent dispatches for the
same `handoffId` in-process (`pendingHandoffs`).
Source: `messages-handoffs.ts:705-770`.

---

### `handoffs.list`
`GET /v2/work-sessions/:workSessionId/handoffs` · kind: read · status: v1 · served: yes
(`messages-handoffs.ts:772`)
CLI: `tm8 handoff list <work-session-id> [--delivery-status] [--record-status] [--limit] [--cursor]`

Lists handoffs sent to one work session, oldest-first.

**Path params** — `workSessionId` (uuid).

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `deliveryStatus` | enum[] (repeatable/comma-separated) | no | `prepared`\|`dispatching`\|`delivered`\|`refused`\|`unknown` | |
| `recordStatus` | enum[] (repeatable/comma-separated) | no | `pending`\|`recorded`\|`failed`\|`withdrawn` | |
| `limit` | int | no | default 50, max 100 | |
| `cursor` | string | no | | |

**Response** — 200; `data: Page<HandoffView>` (see `handoffs.send` for `HandoffView`).

**Errors** — `invalid_input` (400): unsupported status value. `invalid_cursor` (400):
cursor does not match this filter set.
**Notes**: no idempotency (read).
Source: `messages-handoffs.ts:772-815`.

---

### `handoffs.withdraw`
`POST /v2/handoffs/:handoffId/withdraw` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:817`)
CLI: `tm8 handoff withdraw <handoff-id> --expect-version <n> [--reason]`

Withdraws a pending/undelivered handoff.

**Path params** — `handoffId` (string, non-uuid — see `requireParam` vs.
`requireUuidParam` used elsewhere).
**Request body** — `WithdrawHandoffInput` (`contract.ts:6213`, schema
`schemas.ts:3794`): `clientMutationId` (required), `expectedRecordVersion` (int,
positive), `reason?` (string, 1–256 chars).

**Response** — 200; `data: HandoffView`.

**Errors** — `version_conflict` (409): stale `expectedRecordVersion`. `forbidden`
(403): `details.reason: 'handoff_forbidden'`.
**Notes**: `clientMutationId` required. RPC `w2_withdraw_handoff`.
Source: `messages-handoffs.ts:817-828`.

---

### `messages.attachments.add`
`POST /v2/messages/:messageId/attachments` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:622`, shared implementation `updateAttachments` at `:630`)
CLI: `tm8 message attachment add <message-id> --expect-version <n> --file <file-entity-id>...`

Adds file attachments to an already-posted message.

**Path params** — `messageId` (uuid).
**Request body** — `AddMessageAttachmentsInput` (`contract.ts:6130`, schema
`schemas.ts:3717`): `clientMutationId` (required), `expectedVersion` (int, positive),
`fileEntityIds` (uuid[], 1–16 unique, non-empty).

**Response** — 200; `data: MessageView` (the message, reloaded with the new
attachments in `content.attachments`).

**Errors** — `invalid_input` (400): empty `fileEntityIds`. `version_conflict` (409).
**Notes**: `clientMutationId` required. RPC `w2_add_message_attachments`.
Source: `messages-handoffs.ts:622-645`.

---

### `messages.attachments.remove`
`DELETE /v2/messages/:messageId/attachments` · kind: command · status: v1 · served: yes
(`messages-handoffs.ts:626`, shared `updateAttachments`)
CLI: `tm8 message attachment remove <message-id> --expect-version <n> --file <file-entity-id>...`

Removes file attachments from a message. Same request/response/error shape as
`messages.attachments.add` (`RemoveMessageAttachmentsInput` is a type alias of
`AddMessageAttachmentsInput`, `contract.ts:6135`); RPC is `w2_remove_message_attachments`.
Source: `messages-handoffs.ts:626-645`.

---

### `messages.delivery.get`
`GET /v2/messages/:messageId/delivery` · kind: read · status: v1 · served: yes
(`messages-handoffs.ts:647`)
CLI: `tm8 message delivery <message-id> [--limit] [--cursor]`

Reads a message's delivery ledger: per-target session-write attempts, plus any chat
turns the message queued.

**Path params** — `messageId` (uuid).
**Query params** — `limit` (int, default 50, max 100), `cursor` (string).

**Response** — 200; `data: MessageDeliveryView` (`contract.ts:6175`)

| field | type | description |
|---|---|---|
| `message` | `MessageView` | |
| `deliveries` | `MessageDeliveryRecord[]` | `{deliveryId, messageId, sourceWorkSessionId, targetWorkSessionId, status, attemptNo, failureReason, reservedAt, claimedAt, settledAt, updatedAt}`; `status` one of `pending`\|`dispatching`\|`delivered`\|`failed_retryable`\|`failed_permanent`\|`unknown`\|`expired`\|`cancelled` |
| `chatTurns?` | `MessageChatTurnRecord[]` | `{chatId, turnId, state}`; present only when the message queued ≥1 chat turn — a chat's ledger is `chat_turns`, not `session_message_deliveries` |

**Errors** — `invalid_cursor` (400). `upstream_unavailable` (503): a stored delivery
row has an out-of-enum status.
**Notes**: no idempotency (read). `chatTurns` is additive/optional — an older node
that omits it means "cannot tell you", never "this message woke no chat".
Source: `messages-handoffs.ts:647-703`.
