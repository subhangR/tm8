# tm8 Session Communication Model

**Status:** W0-adopted design revision 5, 2026-07-26 — Round-4 model plus final-set B1/B2 closure  
**Scope:** durable messages, live work-session delivery, replies, teammate inbox fallback, and entity handoffs  
**Implementation authority:** none; AM-5 continues to hold  

> **Normative subordination:** the FINAL architecture corpus, `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11, `WORKSPACE-LAYOUT-REVIEW.md`, and the W0 amendment dossier govern. RULING M stamps this message-first public direction; W0 Vega adoption logs the T-D20/R17 public-route reversal as T-D23. It does not rewrite the frozen v2.10 handoff state machine.

## 1. Binding direction to review

1. Messages are the principal communication medium.
2. A session sends another session a message; users and agents do not invoke a public `prompt` command.
3. Every communication is durable graph state before it is considered available for collaboration.
4. A message addressed to a live work session is delivered directly into that running session.
5. The injected session responds to the message through an ordinary durable reply.
6. If direct delivery is unavailable, refused, or ambiguous, the message remains durable and a fallback notification reaches the responsible Teammate inboxes.
7. Chat and Discussion are two UI projections of the same anchored graph-message store. Chat must not create a second message table, shadow conversation, provider transcript store, or parallel read-state authority.
8. Inbox ownership supports both human Members and agent Teammate personas.
9. Entity sharing is a handoff, not an oversized or magical message attachment.

The public grammar is therefore:

```text
tm8 message send --to <anchor-id> [--to <anchor-id>...] <body>
tm8 message reply <message-id> <body>
tm8 handoff send <work-session-id> --entity <entity-id>
```

There is no public `tm8 session prompt`.

## 2. Domain separation

| Concern | Authoritative model |
|---|---|
| Text communication | Message entity anchored to one entity |
| Multi-anchor send | Atomic correlated batch producing one message per anchor |
| Thread reply | New message under the original message's same anchor |
| Runtime notification | At-most-once execution delivery attempt for a work-session-anchored message |
| Human/persona fallback | Existing notification/inbox family extended to Member or Teammate recipients |
| Entity projection | Frozen v2.10 handoff saga plus conditional `shared_into` |
| Interactive terminal control | Session stream `drive`, separately permissioned; never treated as messaging |

No second message table, session inbox, or reporting channel is introduced.

## 3. Multi-anchor messages

### 3.1 Command

```text
tm8 message send
    --to <anchor-entity-id>
    [--to <anchor-entity-id>...]
    [<body>|-]
    [--body <text-source>]
    [--mention <member-or-team-member-id>...]
    [--attach <file-entity-id>...]
    [--wait stored|settled]
    [--mutation-id <id>]
```

### 3.2 Storage model

Messages retain a singular `anchorId`. A multi-anchor send does not create one illegally multi-anchored row. Instead it creates:

`message_batch` is a logical correlation, not a graph entity and not a separate storage node/table. Each ordinary message row carries the nullable `message_batch_id`; one batch command creates:

```text
message A (anchor A, message_batch_id = clientMutationId)
message B (anchor B, message_batch_id = clientMutationId)
message C (anchor C, message_batch_id = clientMutationId)
```

Each copy has its own message ID and the same `messageBatchId`. The batch ID is the command's `clientMutationId`: the CLI generates it when omitted, and the Server echoes it rather than creating a second identity. Replies and read marks remain local to the copy's anchor.

### 3.3 Atomic validation

Before inserting any row, the Server:

1. normalizes and de-duplicates anchors;
2. requires at least one anchor;
3. verifies every anchor exists, is not soft-deleted, is in one Space, and is messageable by the author;
4. resolves mentions by ID and derives display/kind Server-side;
5. validates all file attachments and relationship endpoints;
6. validates body and aggregate payload limits;
7. freezes the batch idempotency identity.

The identity is the hash of the stable submitted inputs only:

```text
hash(authorId,
     spaceId,
     sorted(unique(anchorIds)),
     exactBodyBytes,
     sorted(unique(mentionIds)),
     sorted(unique(attachmentIds)))
```

Resolved entity versions, delivery capability, runtime epoch, generated message IDs, and output envelopes are audit facts, not retry comparators. Reusing one `clientMutationId` with a different identity is `invariant_violation` with `details.reason='message_batch_identity_mismatch'`; it never returns a stale success for a different anchor set.

All message rows, provenance edges, file-attachment edges, and `message.created` durable events commit atomically. The transaction de-duplicates first, then locks anchor entity rows in ascending UUID order and file entity rows in ascending UUID order. It takes no work-session or ProjectResource lock, and never acquires a ProjectResource lock, so its order is disjoint from spawn/project association writes. Live-delivery capability and liveness are re-read only after commit; attempts then settle independently per work-session anchor.

The dossier freezes provisional aggregate bounds for prototype validation: at most 16 anchors, at most 16 attachments, `anchorCount × attachmentCount <= 64`, and 256 KiB of canonical request JSON. Lower body/per-file limits still apply. No implementation ships until measured limits replace or approve these figures.

The current singular `messages.post` contract cannot provide this batch atomicity. The dossier must choose either an amended `messages.post` with `anchorIds` plus `MessageBatchResult`, or a new `messages.postMany` operation. A client loop is rejected because partial persistence would be ordinary behavior rather than an exceptional recovery case.

## 4. Attachment and relationship grammar

The same words must not mean three different things:

| CLI syntax | Meaning |
|---|---|
| `message send --attach <file-id>` | Attach finalized files to every produced message copy |
| `entity create --attach-to <entity-id>` | Create initial `attached_to` edges from the new entity |
| `entity create --relate-to <entity-id>` | Create initial `relates_to` edges from the new entity |
| `entity create --connect <type>=<target-id>` | General initial registered edge |
| `file upload --attach-to <entity-id>` | After finalization, create `file -> attached_to -> entity` |
| `edge create <src> <type> <dst>` | Standalone relationship mutation |

### 4.1 Message files

`--attach` takes file entity IDs only. The Server validates:

- file row exists, is live, and upload is finalized;
- author can read the file;
- target anchors and file belong to the same Space;
- every target anchor's effective audience is a subset of the file's audience; otherwise the Server returns `forbidden` with `details.reason='attachment_audience_widening'` (under the current inert visibility model this reduces to same-Space validation);
- duplicates, count, per-file bytes, aggregate bytes, MIME policy, and checksum metadata;
- `file -> attached_to -> message` is permitted by the edge registry.

For each produced message, the Server creates the `attached_to` edges in the message batch transaction. `MessageView.attachments` becomes a derived projection of those edges; the client supplies only `attachmentIds`, never filename/MIME/display metadata. A `file -> attached_to -> message` edge is message-owned: public `edges.create`, `edges.patch`, and `edges.delete` refuse that endpoint pattern. Attachment changes use versioned message commands, update the derived edges and message version atomically, and set `editedAt`:

```text
tm8 message attachment add <message-id> <file-id>... --expect-version <n>
tm8 message attachment remove <message-id> <file-id>... --expect-version <n>
```

### 4.2 Initial entity connections

Repeatable initial connections are atomic tuples. `--attach-to` and `--relate-to` are typed shorthands over `--connect`. They are not universal by source kind: the edge registry validates both endpoints, and the current `attached_to` source set excludes `channel` and `message`. `relates_to` is the registry's universal `* -> *` relationship when no narrower semantic edge applies. The Server validates every endpoint, Space, deletion state, registry pair, props schema, permissions, materializer guard, and duplicate before inserting the entity. A failure aborts entity plus all initial edges.

The current singular `CreateEntityInput.attachTo` requires an additive initial-connections amendment.

### 4.3 File upload attachment

External byte transfer cannot share a database transaction with the initial upload. However upload finalization can atomically create the file entity plus all requested `attached_to` edges after validating every anchor. A killed CLI must retain explicit upload resume/abort recovery commands.

## 5. Homogeneous hierarchy and relationship queries

Hierarchy remains homogeneous: parent and children are the same kind in the same Space. Different-kind context is an edge.

```text
tm8 entity children <entity-id> [--limit <n>] [--cursor <cursor>]
```

therefore needs no `--kind` filter.

The entity-centered connection query is:

```text
tm8 entity connections <entity-id>
    [--type <edge-type>...]
    [--direction incoming|outgoing|both]
    [--peer <entity-id>...]
    [--peer-kind <kind>...]
    [--created-by <actor-id>...]
    [--created-after <iso-time>]
    [--created-before <iso-time>]
    [--sort createdAt|updatedAt|type]
    [--order asc|desc]
    [--limit <n>] [--cursor <cursor>]
```

This returns a flat `Page<EdgeView>` with a stable final ID tie-breaker and a cursor bound to the filter/sort fingerprint. It does not expose an `origin` filter until the Server-owned origin vocabulary is frozen, and does not keyset-sort by mutable/non-unique peer titles. It cannot truthfully reuse the current grouped `Connections` DTO with independent cursors. The API must amend that operation or add a catalogued connection-query read. `EntityDetail.connections` may retain a bounded grouped summary.

## 6. Message authorship and session provenance

The authenticated Member or Teammate authors a message. When the caller executes inside a work session, a relation matters and is therefore an edge:

```text
message -> authored_from -> work_session
```

This edge is Server-created and immutable. Clients cannot provide `--from` or forge session provenance. Every message copy in a multi-anchor batch receives the same source-session provenance when applicable.

The proposed receiver envelope contains only stable identifiers and facts:

```text
messageId
messageBatchId?
sourceActorId
sourceWorkSessionId?   # derived from authored_from for transport rendering
targetWorkSessionId
anchorId
createdAt
```

No new `sessionEpoch` or session-specific inbox cursor is introduced.

## 7. Session participants

The current spawn DTO takes one `teamMemberId`. To support a work session associated with multiple responsible Teammates without pretending they all control the same agent identity, introduce a graph relationship:

```text
team_member -> participates_in -> work_session
```

Rules:

- spawn creates the initial participant edge for its launch Teammate;
- additional participant edges are ordinary authorized graph relationships;
- at least one participant remains while the session is live; removal is a guarded RPC that locks the work-session row before recounting, so concurrent removals cannot both remove the last participants;
- participants are fallback-notification recipients and may inspect the session subject to capability;
- adding a participant does not change the agent persona, manifest, command permissions, launch provenance, terminal ownership, or cwd;
- participant removal does not revoke already-delivered messages or rewrite authorship;
- existing sessions receive a conditional, audited backfill only when the launch Teammate or another reliable creator fact resolves to a live, authorized Teammate; unresolved rows are audited and never guessed;
- the exact edge name/direction remains registry-review work.

This separates “the persona executing the process” from “the Teammates responsible for receiving fallback communication.”

## 8. Direct live delivery

> ### ➕ WHICH SESSIONS A MESSAGE REACHES — amended 2026-08-14 by migration `121`
>
> §8 was written for the case its first line names: a message **anchored on a work session**. `public.w2_record_session_message_routes` has since grown the full list, and it is now four classes, not one:
>
> | class | target | source recorded on the route |
> |---|---|---|
> | **anchor** (072) | the anchor itself, when it is a `work_session` | the conversation anchor |
> | **reply** (076) | `authored_from(parent)` — the session being answered | the reply's anchor |
> | **mention** (099) | work sessions the caller names (`pokeSessionIds`) | the conversation anchor |
> | **task** (121) | live work sessions with a `working_on` edge to the message's **task** anchor | the task, and the message on it |
>
> The task class is what makes `tm8 message send --to <task-id>` reach anybody. Before `121` a message on a task produced **zero** routes: durable, counted, and silent — the one address everyone working a task shares was the one address that did not route.
>
> Its narrowings, each deliberate:
>
> * **`working_on`, not `assigned_to`.** A wake has to reach a *process*; `working_on` hangs off a work session and names one, `assigned_to` hangs off a Teammate and names a person. An assignee with no live session gets the ordinary inbox notification it already got.
> * **Live sessions only** (`spawning`/`running`/`idle`). A task accumulates every session that ever touched it; unfiltered, each message would reserve a delivery per dead session, each settling `session_not_live` with its own fallback.
> * **Never the authoring session** — §5 item 5, which already anticipated task anchors, applied at the routing layer because here the self-hit is the common case rather than the corner.
> * **Yields to the other three classes**, so one batch never wakes one session twice.
>
> Delivery itself is unchanged: task routes are dispatched by the same loop, over the same reserve/claim/settle RPCs, with the same fallback union, as every other session copy. `addressingKind` is `anchored_message`, which is an existing value.

### 8.1 Public semantics

After a work-session-anchored message commits:

- live and delivery-capable target: reserve a durable direct-delivery attempt after the contact capability passes;
- non-live target: do not attempt; create fallback notifications;
- delivered: no delivery-failure fallback;
- refused: create fallback notifications;
- unknown: create fallback notifications explicitly marked delivery-ambiguous.

The message always remains in Discussion.

### 8.2 Delivery attempt state

Plain messages need only a delivery-attempt axis because graph recording already happened atomically:

```text
pending -> dispatching -> delivered
                       -> failed_retryable
                       -> failed_permanent
                       -> unknown
pending -> expired | cancelled
```

- `failed_retryable` means the execution seam proved that no byte was written; it is the only retryable outcome;
- `failed_permanent` means the live receiver rejected before acceptance;
- `unknown` means the irreversible write crossed an ambiguous crash window and is terminal;
- `pending` may expire while a session is spawning or be explicitly cancelled before dispatch;
- every outcome except `failed_retryable` is terminal;
- the same mutation/delivery ID returns stored state and never attempts bytes again;
- no automatic reoffer or reinjection exists; an authorized retry from `failed_retryable` requires a new delivery ID;
- delivered means the execution seam completed its governed write attempt, not that the model complied;
- structured runtime acknowledgment is future work and, if adopted, becomes a separate consumption axis rather than rewriting delivery or the handoff matrix.

There is no public cancel command in this phase. The Server produces `cancelled` only before dispatch when the target work session reaches `exited|failed` or the source message is deleted. The pending-window TTL produces `expired`. Every state therefore has a named producer.

The single public status facade is:

```text
tm8 message delivery <message-id>
```

It returns the message plus its work-session delivery record. Human and JSON output always name any non-delivered state. `--wait stored` prints `delivery: pending` for a live/spawning work-session target rather than implying receipt and returns exit 0 after graph commit. Only `--wait settled` makes delivery part of the command outcome: mixed, non-delivered, or wait-incomplete delivery returns exit 11 (`delivery_incomplete`) while still printing the stored batch and every outcome.

Delivery state belongs to an execution-side append/audit table such as `session_message_deliveries`, not to graph truth. A narrowly scoped, audited Server execution principal may only reserve and settle these records and create the associated fallback notifications. It survives process restart and cannot mutate arbitrary entities or edges. Restart recovery resolves stranded `dispatching` rows to `unknown`; it never reinjects bytes.

The principal above is the only **delivery-adapter principal**. It is minted by the Server for the delivery worker, is not a Member or Teammate bearer identity, cannot be selected through `actorId`/`--as`, and is scoped to delivery reservation/settlement, the one governed PTY write, and fallback notification creation. Every reservation records the source message, authenticated source actor, derived source work session when present, target session, budget row/version, and request/delivery IDs. No ambient spawner claims or ordinary user bearer may substitute for it.

### 8.3 Phase-1 adapter

The user-facing action is still a message. Until structured receiver integration exists, the execution block may invoke the already-shipped governed PTY queue internally. It renders a control envelope containing message ID, author, provenance, and explicit untrusted-content delimiters, then performs one at-most-once write.

This is not a shell-execution API and the body is never interpreted as a command. Nevertheless, it remains PTY transport with an ambiguous crash window; the state must say `unknown` when proof is impossible.

The frozen `execution.prompt` operation remains v1 and retains its HTTP binding, so the 79/2 catalog split does not change. Invocation is authorized **only** for the audited Server-internal delivery-adapter principal defined in §8.2, after a stored message already owns the communication and a delivery reservation already owns the one write attempt. Every Member or Teammate caller—including a session-scoped agent bearer, an owning Member, a Space admin, and a caller using authorized act-as—receives `forbidden` with `details.reason='use_message_send'`; the handler must return before queue admission and write **zero PTY bytes**. The operation has no CLI command, no template binding, and no public action-discovery result. T-D20/R17 is reversed only as to the public authoring route: message-first storage plus the internal adapter now owns delivery. Removing the frozen operation entirely remains a later catalog-version decision.

### 8.4 Future receiver adapters

Before removing the PTY adapter, produce a feasibility and acceptance matrix for every supported tool:

| Tool | Structured inbound seam | Stable message-ID acknowledgment | Current status |
|---|---|---|---|
| Claude tool | To verify through hooks/MCP/control interface | To prototype | unproven |
| Codex | To verify | To prototype | unproven |
| Gemini | To verify | To prototype | unproven |
| Hermes | To verify | To prototype | unproven |

Unsupported tools remain functional through the governed Phase-1 PTY adapter; the system does not delete communication and call it unavailable.

### 8.5 Authorization boundaries

Three authorities are separate and must be evaluated Server-side:

- **`canMessage(anchor)`** permits creating an ordinary durable message at a readable/messageable anchor. It never implies live contact.
- **`canContactSession(sourceActor, sourceSession?, targetSession)`** permits reserving a live delivery to that session after same-Space, participant/ownership policy, self-delivery suppression, target state/capability, and the universal pair budget are checked. It never permits terminal drive or a direct prompt call.
- **`canHandoffEntity(sourceEntity, targetSession)`** permits the distinct entity-projection saga after source-read, target-contact, same-Space, content-version, and handoff-policy checks. It never follows merely from `canMessage` and does not use a message body as the projection.

The dossier freezes the positive/negative matrix for Member, Teammate, participant, owner/admin, unrelated Space member, session-scoped bearer, and internal delivery principal. Profiles/templates may hide or narrow these actions; they cannot grant any of them.

## 9. One inbox for Members and Teammates

The existing notification family is extended additively. The delivered table's `recipient_member_id NOT NULL` remains the human owner/routing principal. A nullable `recipient_team_member_id` FK is added:

```text
Member item:   recipient_member_id = member, recipient_team_member_id = null
Teammate item: recipient_member_id = teammate.owner, recipient_team_member_id = teammate
```

This avoids repointing the existing FK or rebuilding the table. Reads treat the nullable teammate column as the recipient discriminator: the Member's personal feed excludes teammate-addressed rows unless an explicit ownership-capability query is used. `NotificationItem` gains `recipient: ActorSummary`, derived as Teammate when the nullable column is present and Member otherwise. New recipient indexes are additive. It remains one inbox model and one notification event family.

### 9.1 Ownership

- a Member reads and marks their personal inbox;
- a Teammate persona has an independent inbox;
- sessions acting as a Teammate consume that persona inbox;
- a Teammate's owning Member may inspect it only through an explicit ownership capability;
- reading one recipient's item never marks another recipient's copy read.

### 9.2 Failed-delivery fan-out

For a direct message to a work session that expires, is cancelled, is non-live, fails, or becomes unknown:

1. resolve the union of the session's participant Teammates, their owning Members, the message author, and the spawning/owning Member when resolvable;
2. create one deduplicated notification per recipient;
3. reference the original message ID, anchor, delivery disposition, and source actor;
4. never copy the message body into the notification store;
5. emit ordinary `notification.created` events;
6. suppress fallback when delivery is confirmed, except independent mentions/subscriptions.

If no participant exists because of corrupt or legacy data, the author and spawning owner paths still receive the failure. The Server also creates an actionable audit; it never silently drops the fallback.

The notification kinds are frozen as `session_delivery_failed` for a non-delivered terminal attempt and `message_reply` for durable reply notification. Later kinds require the ordinary closed-namespace admission process. Add Member-personal cursor/unread partial indexes where `recipient_team_member_id IS NULL`, and Teammate cursor/unread indexes keyed by `recipient_team_member_id` where it is non-null. The personal Member query must never rely on the broad owner column alone.

### 9.3 CLI

```text
tm8 inbox list
    [--for <team-member-id>]
    [--space <space-id>]
    [--unread]
    [--limit <n>] [--cursor <cursor>]

tm8 inbox mark-read <notification-id>
    [--mutation-id <id>]
```

Omitting `--for` means the authenticated Member's personal inbox. The current API is personal-member-oriented and requires the additive recipient, DTO, ownership, authorization, and query amendments above.

## 10. Replies and routing back to the sender

```text
tm8 message reply <message-id> <body>
    [--notify-source inbox|live]
```

The Server fetches the parent, derives its singular anchor, and posts the reply under that same anchor. Cross-anchor thread parents remain forbidden.

When a work session responds:

1. the reply is stored in the original session Discussion;
2. the original message author always receives an ordinary `message_reply` notification;
3. the default `--notify-source inbox` performs no runtime wake;
4. `--notify-source live` may additionally attempt delivery to the parent's Server-derived `authored_from` session when live; the replying client never supplies a hidden destination;
5. a message is never delivered into the same work session that authored it, regardless of whether its anchor is that session, a task, or any other entity;
6. non-live or non-delivered live-wake attempts use the normal fallback union.

> ### ⚠ THE BUDGET DESCRIBED BELOW WAS REMOVED — by migrations `120` and `135`
>
> Everything from here to the end of §10 describes the retired **agent wake budget**. `120_remove_agent_wake_budget.sql` first deleted the cap; `135_remove_wake_budget_machinery.sql` then removed the table, counter, reset/cleanup functions, delivery pair columns, and copied version claim. **A session may wake another session as many times as the work needs.** The adopted text is kept verbatim below because it is the record of what was adopted; read it as history, not as behaviour.
>
> What is still true, and is load-bearing after `135`:
>
> * `session_message_deliveries` remains the durable per-attempt ledger. Its unique `(message_id,target_work_session_id,attempt_no)` key prevents two reservation identities for one logical attempt.
> * Claim and settle lock the delivery row `FOR UPDATE` and enforce legal status transitions. The removed pair version never changed after reserve and was never checked against the pair row, so it was not delivery-row optimistic concurrency.
> * The delivery principal remains bound to the exact `(deliveryId,messageId,targetWorkSessionId)` tuple, an expiry, the authenticated worker role, and no actor claims.
> * `automated_wake_limit` remains a valid `failure_reason` in the contract and the UI reason map: rows written before `120` still carry it and must still render. Nothing writes it any more.
> * The self-delivery rule (item 5 above) is **not** part of the cap and did not go with it. A session is still never handed its own message.
>
> §14.2 acceptance case 26 and §13 amendment 13 are historical for the same reason.

This produces a durable conversation thread without making an agent ping-pong loop the default. Every Teammate-authored live delivery is bounded—including a new top-level `message send`, an ordinary reply, and an explicit source-session wake. The budget is universal per unordered source/target work-session pair; a new message or thread root cannot obtain a fresh allowance. At most four consecutive Teammate-authored live reservations are allowed. A Member-authored reply resets a pair only when immutable parent/delivery provenance identifies exactly one source/target work-session pair; the Server derives that pair and locks its row in the same transaction. A top-level or ambiguous Member message has no pair-reset effect and cannot name a reset pair in client input.

The counter is durable execution state:

```text
session_wake_budgets(
  low_work_session_id,
  high_work_session_id,
  consecutive_agent_wakes,
  version,
  updated_at,
  primary key(low_work_session_id,high_work_session_id),
  check(low_work_session_id < high_work_session_id),
  check(consecutive_agent_wakes between 0 and 4)
)
```

The Server derives the source work session from authenticated provenance, canonicalizes the unordered pair, creates-or-locks this durable row, rechecks the cap, and increments it in the **same transaction that reserves every Teammate-authored live delivery attempt**. Reservation order is pair-budget row then delivery row; neither lock is held across `proc.write`. Concurrent top-level sends and replies cannot both pass from the same prior count. An agent-authored attempt counts when reserved regardless of outcome. An authorized retry from `failed_retryable` uses a new delivery ID and consumes a new unit; retry never creates a free loop. A provenance-derived Member reset serializes under the same lock. Exceeding the cap records `failed_permanent` with `details.reason='automated_wake_limit'`, creates the normal inbox fallback, and returns before queue admission with zero PTY bytes.

Wake-budget rows are operational and bounded, not permanent graph history. A row becomes eligible for cleanup only when both sessions are terminal and no pending/dispatching delivery references the pair; the execution retention sweep removes eligible rows seven days after eligibility. A missing row is recreated at zero. A session restart does not reset the pair, and thread/message deletion never changes it.

## 11. Entity handoffs remain separate

```text
tm8 handoff send <work-session-id> --entity <entity-id>
tm8 handoff list <work-session-id>
tm8 handoff withdraw <handoff-id> --yes
```

This command projects entity context under the complete v2.10 §5.7 contract. It retains:

- `handoffId == clientMutationId`;
- stable idempotency identity versus first-attempt audit fingerprint;
- the frozen deliveryStatus × recordStatus matrix;
- same-Space validation;
- source snapshot;
- per-kind renderer and custom-kind fallback;
- 32,768-byte UTF-8 envelope cap;
- untrusted-data delimiters;
- conditional recorder-only `shared_into`;
- no same-ID reinjection;
- correlated bounded Discussion reference;
- per-handoff withdrawal.

The full 32 KiB envelope is not placed in `PostMessageInput.body`, whose current cap is 10,000 characters.

## 12. Terminal drive is not communication

`session attach --mode drive` is interactive terminal ownership. Phase 1:

- grants drive only to the spawning owner;
- uses short-lived non-transferable credentials;
- refuses drive to a spawned session attempting to contact another session;
- never claims drive bytes are messages, idempotent, or graph-audited;
- keeps view and drive capabilities separate.

## 13. Required amendments

1. Record the public message-first ruling and the W0-adopted T-D23 disposition of T-D20/R17.
2. Add atomic multi-anchor message input and `MessageBatchResult`.
3. Add `messageBatchId` correlation without violating singular message anchors.
4. Change message inputs from client-authored Mention/FileAttachment objects to IDs resolved by the Server.
5. Materialize message file attachments as `attached_to` edges and derive the DTO projection.
6. Add repeatable atomic initial connections to entity creation.
7. Add flat filtered/sorted/paged entity-connection query semantics.
8. Add Server-owned immutable `authored_from` message→work_session provenance.
9. Add and validate the session-participant relationship.
10. Add nullable `recipient_team_member_id`, the `NotificationItem.recipient: ActorSummary` projection, recipient indexes, and ownership-filtered reads while retaining `recipient_member_id NOT NULL`.
11. Add the execution-side `session_message_deliveries` record, the constrained recovery principal, and typed events without creating a second inbox.
12. Add the frozen `session_delivery_failed` and `message_reply` targeted notification triggers.
13. Historical: add the unordered-pair wake budget. Migrations `120` and `135` later removed its cap and then all remaining machinery; self-wake refusal, per-attempt delivery rows, retry identity, and fallback survive.
14. Keep entity handoffs subordinate to the v2.10 dossier rather than redefining them.
15. Keep `execution.prompt` v1 but authorize it only to the audited Server-internal delivery-adapter principal; every Member/Teammate caller receives `forbidden/use_message_send` before queue admission and writes zero PTY bytes. Removal remains a later catalog-version decision.
16. Apply spawning-owner-only drive authorization.
17. Add file upload resume/abort and atomic final attachment relationships.
18. Freeze all attachment count/size/MIME/checksum and message batch limits.
19. Guard message-owned attachment edges and add versioned attachment add/remove commands.
20. Add the batch stable-input identity hash and mismatch taxonomy reason.
21. Add `message delivery`, the complete delivery machine, rendering law, timeout behavior, and exit 11.
22. Add the locked last-participant guard plus conditional audited legacy backfill.
23. Freeze the batch lock order and the automated source-wake breaker.

## 14. Acceptance cases

1. One message to one task; no runtime delivery.
2. One atomic message batch to task, doc, and two work sessions.
3. Invalid final anchor causes zero message rows and zero edges.
4. Duplicate anchors and duplicate files collapse deterministically.
5. One inaccessible file aborts the complete batch.
6. Every attachment produces an authorized `attached_to` edge and derived DTO entry.
7. Live session receives at most one governed write attempt per delivery ID through the Phase-1 adapter; an ambiguous crash resolves `unknown`, never an exactly-once claim.
8. Permanent failure produces deduplicated notifications for participant Teammates, their owners, the author, and the spawning owner.
9. Unknown delivery produces ambiguity-labelled fallback without reinjection.
10. Successful delivery suppresses failure fallback.
11. Multi-participant inbox read state remains independent.
12. Session reply remains on the original anchor, creates an author notification, and does not wake the source session by default.
13. Explicit `--notify-source live` wakes a live source session; unavailable delivery uses the fallback union.
14. Same-ID retry returns stored state and never attempts delivery again.
15. Entity handoff keeps its two-axis matrix and conditional `shared_into`.
16. Drive authorization cannot be used by one spawned agent to inject another.
17. Same-kind hierarchy refuses different-kind parent/child.
18. Connection cursor refuses reuse under a different sort/filter fingerprint.
19. Reusing one mutation ID with different anchors returns `message_batch_identity_mismatch` and creates no rows.
20. `message delivery` distinguishes retryable proof-of-no-write, permanent failure, unknown, expired, and cancelled.
21. `--wait stored` returns exit 0 plus explicit pending state after graph commit; only `--wait settled` returns exit 11 for a mixed/incomplete batch, with the complete stored result.
22. Public edge deletion cannot remove a message attachment; versioned attachment removal can.
23. Two concurrent participant removals cannot leave a live session participant-less.
24. Legacy participant backfill never invents or relinks a Teammate.
25. A Teammate-addressed inbox row is absent from its owner's personal feed unless owner-inspection is explicit.
26. Historical acceptance case: the former unordered-pair breaker engaged after four Teammate reservations. Migrations `120`/`135` retired that behavior and its backing state; current concurrency coverage instead pins unique logical attempts and row-locked claim/settle transitions.
27. Process restart settles stranded dispatches without ambient spawner credentials and never reinjects.
28. A session replying with `--notify-source live` to its own task-anchored message never writes back into itself; the durable reply and author notification still commit.
29. Historical acceptance case: a Member-authored reply reset the former locked pair row. After `135` no reset RPC or pair state exists; concurrent delivery transitions serialize on their delivery rows instead.
30. A bare Member bearer, a Teammate bearer, an owning Member, a Space admin, and an authorized act-as principal each call the frozen `execution.prompt` HTTP binding and receive `forbidden` with `details.reason='use_message_send'`; queue depth and PTY bytes are unchanged. The internal delivery principal succeeds only for a pre-reserved stored message.
31. `canMessage`, `canContactSession`, and `canHandoffEntity` are independently denied/granted across the dossier principal matrix; no permission implies another.

## 15. W0 decisions and prototype gates

The former review questions are classified rather than hidden beneath a GO label:

| Former question | W0 classification |
|---|---|
| Q1 | **Decided:** `team_member -> participates_in -> work_session`; registry name/direction frozen. |
| Q2 | **Decided:** Members are not participant endpoints; human routing uses Teammate ownership plus spawning/owning Member facts. |
| Q3 | **Decided:** named `canInspectOwnedTeammateInbox`, human-only, owner-scoped, and read-state preserving. |
| Q4 | **Prototype-gated constant:** pending-delivery TTL is measured before W1 contract freeze; dossier provisional value is 15 minutes and is not silently changed. |
| Q5 | **Decided:** a dedicated unprivileged database role invokes a closed SECURITY DEFINER RPC allowlist; it is not an application/member role. |
| Q6 | **Decided:** the queue implementation may be shared, but message delivery and handoff retain distinct rows, state vocabularies, authorization, and idempotency identities. |
| Q7 | **Prototype-gated constants:** the provisional batch/attachment limits remain hard ceilings until measurement approves a lower/equal shipped value. |
| Q8 | **Decided:** amend `messages.post` additively with `anchorIds` and `MessageBatchResult`; no `messages.postMany` operation is added. |
| Q9 | **Decided:** four consecutive Teammate reservations per unordered pair is the Phase-1 hard Server constant; it is not Space-configurable. |
| Q10 | **Implementation gate:** provider receiver seams remain governed Phase-1 PTY adapters; structured receivers are deferred and cannot weaken B1. |
