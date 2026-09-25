# Entities

The `entities.*` family is the universal, cross-kind door onto every row in the graph: get,
create, patch, move, delete/restore, and the read pagers (children, hierarchy, connections,
versions, activity), plus the header cache, reactions, points, the universal feed and the
bounded "focus" context read. It sits beside, not instead of, the kind-specific families
(`containers.*`, `execution.*`, `forms.*`, …) — several entity kinds are **carved out** of the
generic doors on purpose because another door owns their lifecycle: `work_session` (owned by
`execution.spawn`/`execution.transition`), `container` (`containers.create`/lifecycle),
`project`, `interaction_profile`, `member`, `message`, and `artifact` all refuse
`entities.patch`/`.move`/`.delete`/`.restore` with `forbidden`, and `entities.create` excludes
those plus `chat` and `form`. Every one of the 24 operations below is **served** — all 24
catalog rows are `status: v1`, none `reserved`, confirmed against the registration seam that
binds every op name to a live handler (`packages/server/src/facade/handlers/w2/entities-commands-tracking.ts:19-49`,
`packages/server/src/facade/handlers/w2/feed-context.ts:27-30`) — so there is no 501 story to
tell in this group, unlike `containers.*`.

Nearly every command in this group returns the same envelope, `CommandResult`, assembled by
one of two functions that both wrap the same per-kind read assemblers reads use — "a client
that just created a task and a client that just fetched one are looking at identical objects."
Shared types are defined once below and referenced by name in each operation's tables.

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `entities.get` | GET | `/v2/entities/:id` | read | yes |
| `entities.create` | POST | `/v2/entities` | command | yes |
| `entities.patch` | PATCH | `/v2/entities/:id` | command | yes |
| `entities.header.set` | PUT | `/v2/entities/:id/header` | command | yes |
| `entities.header.clear` | DELETE | `/v2/entities/:id/header` | command | yes |
| `entities.move` | POST | `/v2/entities/:id/move` | command | yes |
| `entities.delete` | DELETE | `/v2/entities/:id` | command | yes |
| `entities.restore` | POST | `/v2/entities/:id/restore` | command | yes |
| `entities.children` | GET | `/v2/entities/:id/children` | read | yes |
| `entities.hierarchy` | GET | `/v2/entities/:id/hierarchy` | read | yes |
| `entities.connections` | GET | `/v2/entities/:id/connections` | read | yes |
| `entities.versions` | GET | `/v2/entities/:id/versions` | read | yes |
| `entities.activity` | GET | `/v2/entities/:id/activity` | read | yes |
| `entities.react` | PUT | `/v2/entities/:id/reaction` | command | yes |
| `entities.points.add` | POST | `/v2/entities/:id/points` | command | yes |
| `entities.commands.complete` | POST | `/v2/entities/:id/commands/complete` | command | yes |
| `entities.commands.work` | POST | `/v2/entities/:id/commands/work` | command | yes |
| `entities.commands.pull` | POST | `/v2/entities/:id/commands/pull` | command | yes |
| `entities.commands.linkPr` | POST | `/v2/entities/:id/commands/link-pr` | command | yes |
| `entities.commands.linkCommit` | POST | `/v2/entities/:id/commands/link-commit` | command | yes |
| `entities.commands.gate` | POST | `/v2/entities/:id/commands/gate` | command | yes |
| `entities.commands.tick` | POST | `/v2/entities/:id/commands/tick` | command | yes |
| `entities.feed` | GET | `/v2/entities/:id/feed` | read | yes |
| `entities.context` | GET | `/v2/entities/:id/context` | read | yes |

All 24 rows: `status: v1`. Source: `packages/contract/src/catalog.ts:110-143` (first 15),
`:331-332` (`feed`/`context`, registered as a separate wave — see catalog comment at that
range). Handlers: `entities.get/create/patch/header.set/header.clear/move/delete/restore/
children/hierarchy/connections/versions/activity/react/commands.tick` are
`W2EntitiesCommandsTrackingService` methods; `entities.points.add/commands.complete/
commands.work/commands.gate` are factory functions in `handlers/commands.ts`; `entities.feed`
and `entities.context` are `W2FeedContextService` methods (a separate registration seam,
`handlers/w2/feed-context.ts`).

Examples below are marked **(illustrative, from schema)** throughout. A live server and space
were reachable from this worktree, but every read in this space belongs to a real
customer/dogfooding space with real task titles and member names — capturing one would put
real business content in a committed reference doc for no documentation benefit the schema
doesn't already provide, so this worker chose not to. No command (mutating) operation was run
against it either way, per the rules for this task.

## Shared types

All defined in `packages/contract/src/contract.ts` unless noted; referenced by name in every
operation section below rather than repeated.

### Envelope and errors (DEV-6 / DEV-8)

Every success body is `{"data": ..., "requestId": "..."}`; every error body is
`{"error": {"code", "message", "details?", "requestId", "retryable"}}`, `status =
ERROR_STATUS[code]`. Source: `http/types.ts` (envelope), `contract.ts:1604-1673`.

```ts
interface ErrorDetails { reason: string; currentVersion?: number; currentRevision?: number;
  currentMenu?: MenuConfig; activeLinks?: number; deliveryId?: string }
// A specific handler may add its own keys onto `details` beyond this base shape
// (e.g. entities.commands.tick's `unknown`/`known`, entities.commands.complete's
// `gate_no_tracked_pr`/`gate_pr_unmerged_or_ci_red` as `details.reason` values).

type CommandErrorCode =
  | 'invalid_input' | 'invalid_cursor'
  | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'version_conflict' | 'conflict' | 'invariant_violation'
  | 'payload_too_large' | 'rate_limited' | 'limit_exceeded'
  | 'not_implemented' | 'upstream_unavailable'
  | 'context_budget_too_small'
  | 'form_answers_invalid' | 'form_not_open' | 'form_structure_frozen'
  | 'form_response_limit' | 'form_respondent_not_allowed';

const ERROR_STATUS = {
  invalid_input: 400, invalid_cursor: 400,
  unauthenticated: 401, forbidden: 403, not_found: 404,
  version_conflict: 409, conflict: 409, invariant_violation: 409,
  payload_too_large: 413, rate_limited: 429, limit_exceeded: 429,
  not_implemented: 501, upstream_unavailable: 503,
  context_budget_too_small: 422,
  form_answers_invalid: 422, form_not_open: 409, form_structure_frozen: 409,
  form_response_limit: 409, form_respondent_not_allowed: 403,
};
```

None of this group's operations raise the `form_*` codes; only `entities.context`'s v2
byte-budget path raises `context_budget_too_small`, via `budgetTooSmall()`
(`services/w2/feed-context-v2.ts:1359-1382`) when the view's never-drop core cannot fit inside
`totalBytes` even after every droppable section is cut. `details: {requestedBytes,
minimumBytes, core: EntityContextV2Section[], next?: string}` — `minimumBytes` is the smallest
`totalBytes` the core actually fits in (computed via a settle-to-fixed-point loop,
`minimumBytes()` in the same file); `next` is a ready-to-run `tm8 entity context ...
--total-bytes <minimumBytes rounded up to the next KB>` retry string repeating the caller's own
section/offset selection, omitted only when the minimum itself exceeds `V2_MAX_TOTAL_BYTES`
(no retry can succeed).

A `version_conflict` on `entities.patch`/`.move`/`.commands.tick` carries `current:
EntityDetail` both as `error.current` (thrown `CollabError`) and `error.details.current` (wire
`details`), re-fetched in a fresh statement inside the same transaction so the caller sees
exactly what it lost to. Two call sites do this identically: `enrichVersionConflict`
(`handlers/entities.ts`, used by `commands.ts`'s factories) and the service's own `withCurrent`
(`services/w2/entities-commands-tracking.ts:1700-1718`, used by `patchEntity`/`tickCriteria`);
`moveEntity` inlines the same re-fetch rather than calling either
(`entities-commands-tracking.ts:1916-1926`).

### `CommandContext` — embedded in every command body

```ts
interface CommandContext {
  actorId?: EntityId;
  clientMutationId?: string;
  workSessionId?: EntityId;   // the session that originated this write, if any
}
```
Source: `contract.ts:1698-1706`; Zod shape `commandContextShape`, `schemas.ts:1662-1666`.

`commandAcceptsClientMutationId(opName)` is `true` for every operation in this group (it is
`false` only for `auth.*`). The command ledger that makes `clientMutationId` a real
idempotency key is **off by default**; while off, `normalizeCommandInputForIdempotencyMode`
(`http/idempotency.ts:20-43`) injects a fresh random UUID into any command body whose schema
needs one, before Zod validation runs, so a client that omits an optional
`clientMutationId` never fails validation — but on a ledger-off server two otherwise-identical
requests are NOT deduplicated against each other; only a ledger-on server makes retried writes
truly idempotent.

### `CommandResult` — the generic command response

```ts
interface UndoToken { token: string; label: string; expiresAt?: string }
interface ResultWarning { code: string; message: string }

interface CommandResult {
  entity?: EntityDetail;
  edge?: EdgeView;
  activity?: ActivityItem;
  patches: EntitySummary[];
  undo?: UndoToken;
  warnings?: ResultWarning[];
}
```
Source: `contract.ts:1679-1695`.

**Two different assemblers build it, and only one populates `activity`.** `toCommandResult`
(`packages/server/src/facade/handlers/entities.ts:346-403`, used by
`commandsWork`/`commandsComplete`/`commandsGate`/`entitiesPointsAdd` in `handlers/commands.ts`)
never sets `activity`. The service's own `commandResult()`
(`services/w2/entities-commands-tracking.ts:976-1024`, used by
`react`/`pull`/`linkPr`/`linkCommit`/`tickCriteria`) does. `entities.create`/`.patch`/`.move`/
`.delete`/`.restore`/header ops build their `CommandResult` through the same local helpers as
`patchEntity` et al. This is a per-operation fact, called out again in each operation's
Response section rather than assumed uniform.

### `ServerReceipt` — the `?return=receipt` opt-in

A caller may add `?return=receipt` to any of `entities.create`, `entities.patch`,
`entities.commands.work`, `entities.commands.complete`, `entities.commands.tick`,
`entities.commands.linkPr`, `entities.commands.linkCommit` to get a compact receipt instead of
a full `CommandResult` — skipping the post-write `buildDetail` (hierarchy, every connection
with both endpoints' summaries, content, capabilities), which is where most of a command
response's bytes come from. Default behavior (no query param) is unchanged.

```ts
const RECEIPT_SCHEMA = 'tm8.receipt.v1';
type ServerReceiptOp = 'task.complete' | 'task.tick' | 'task.transition'
  | 'task.link-pr' | 'task.link-commit' | 'entity.create' | 'entity.update';
type ServerReceipt = { schemaVersion: 'tm8.receipt.v1'; ok: true; op: ServerReceiptOp } & Record<string, unknown>;
```
Fields present depend on `op`: always `id`, `kind`, `version: {from?, to}` (from present only
when a genuine before/after diff was observed — a `clientMutationId` replay that wrote nothing
carries a `no_write_observed` warning instead), `status: {from?, to}` when the kind has a
status; `title` (clamped to 80 code points); `changed: string[]` naming the stored fields/edge
types that moved (`[]` with a `no_change` warning means the RPC rewrote the row but every value
came out equal); `refs: []` of new edges/linked artifacts the write touched; `undo` when the
write produced one; `warnings: []`. `task.complete` adds `gate: {kind, result: 'passed'}`;
`task.tick` adds `acceptance: {done, total}` and `open: string[]` (capped at 16, with
`truncated`/`openCount` past the cap); `task.link-pr`/`task.link-commit` add the linked
artifact's `{kind, id, url?}` into `refs`. Only `task`/`doc` kinds get a receipt at all — any
other kind falls back to the full `CommandResult`, and a client can tell which it got by the
presence/absence of `schemaVersion`.
Source: `packages/server/src/facade/receipt.ts` (whole file; `wantsReceipt` at line 65,
`buildReceipt` at 218-307, `ServerReceiptOp`/`ServerReceipt` at 52-62).

### `EntitySummary` / `EntityDetail` — the universal entity shapes

```ts
interface EntityCounters { likes: number; dislikes: number; stars: number; points: number;
  messages: number; humanMessages?: number; agentMessages?: number; docs?: number;
  memories?: number; viewerReaction: 'like' | 'dislike' | 'star' | null }

interface EntitySummary {
  id: EntityId; spaceId: SpaceId; kind: EntityKind; title: string; excerpt?: string;
  parentId: EntityId | null; position: number; visibility: Visibility; version: number;
  activityAt: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  createdBy: ActorSummary; counters: EntityCounters;
  state: EntityState;              // kind-discriminated union — see note below
  badges: EntityBadges;
  capabilities?: EntityCapabilities;  // absent on an older node; never assume true
  category?: StatusCategory;          // absent when the kind has no workflow status
}

interface EntityDetail extends EntitySummary {
  content: EntityContent;          // kind-discriminated union, the full editable body
  hierarchy: Hierarchy;
  connections: Connections;
  capabilities: EntityCapabilities;   // required here, unlike on the summary
  header?: EntityHeaderView;          // absent when none is authored
  warnings?: ResultWarning[];         // present only if `header=` was normalised
}
```
Source: `EntityCounters` `contract.ts:132-152`; `EntitySummary` `:154-235`; `EntityDetail`
`:691-709`.

`EntityState` and `EntityContent` are large kind-discriminated unions (one arm per entity
kind — `task`, `channel`, `doc`, `message`, `member`, `team_member`, `pull_request`, `commit`,
`file`, `spell`, `skill`, `work_session`, and more), each carrying that kind's own fields (e.g.
the `task` arm of `EntityState`: `status`, `priority`, `axes`, `dueDate`, `startDate`,
`assignees`, `assignments?`, `acceptance: {total, completed}`, `completionGate?`). This
document is about the cross-kind operations, not each kind's own field list, so kind detail is
pointed at rather than reproduced: `EntityState` starts at `contract.ts:244`, `EntityContent`
at a later range in the same file (grep `export type EntityContent =`).

```ts
interface EntityBadges {
  humanMessageAuthors?: { actors: ActorSummary[]; total: number };
  attention?: EntityAttentionSummary;
  blocked?: { unresolvedHardDependencyCount: number; waitingOn: EntitySummary[] };
  pulls?: PullState[];
  workingActors?: LiveWork[];
  pullRequests?: LinkedPullRequestBadge[];
  pullRequestsTruncated?: boolean;
  completedBy?: { actor: ActorSummary; at: string };
  restricted?: boolean;
  staleness?: EntityStaleness;
}

interface EntityCapabilities {
  canEdit: boolean; canDelete: boolean; canAddChild: boolean; canLink: boolean;
  canPull: boolean; canReact: boolean; canGrantPoints: boolean; canComplete: boolean;
  allowedTransitions?: string[];   // absent = no matrix, fall back to the registry vocabulary
  // container-only verbs; absent on every non-container kind, and ABSENT MEANS DENY here
  // (opposite of allowedTransitions' absent-means-no-narrowing rule):
  canStart?: boolean; canStop?: boolean; canDestroy?: boolean;
  canAttach?: boolean; canControl?: boolean; canExec?: boolean;
}
```
Source: `EntityBadges` `contract.ts:535-571`; `EntityCapabilities` `:940-987`.

### `Hierarchy` / `Connections` / `EdgeView` / `Page<T>`

```ts
interface Page<T> { items: T[]; nextCursor: Cursor | null; total?: number }

interface Hierarchy { parent: EntitySummary | null; children: Page<EntitySummary>; path: EntitySummary[] }

// EMBEDDED on EntityDetail.connections — grouped by type+direction, NOT the same
// shape entities.connections (the standalone endpoint) returns:
interface Connections { outgoing: EdgeGroup[]; incoming: EdgeGroup[]; unresolvedHardDependencyCount: number }
interface EdgeGroup { type: string; direction: 'outgoing'|'incoming'; label: string; edges: EdgeView[]; nextCursor?: Cursor }

interface EdgeView { id: string; type: string; source: EntitySummary; target: EntitySummary;
  props: Record<string, unknown>; createdBy: ActorSummary; createdAt: string; updatedAt: string;
  resolved?: boolean; hard?: boolean }

// entities.connections (the standalone read) returns Page<EdgeView> — a FLAT page,
// not grouped into outgoing/incoming like EntityDetail.connections above.
interface EntityConnectionsQuery { types?: string[]; direction?: 'incoming'|'outgoing'|'both';
  peerIds?: EntityId[]; peerKinds?: EntityKind[]; createdByIds?: EntityId[];
  createdAfter?: string; createdBefore?: string; sort?: 'createdAt'|'updatedAt'|'type';
  order?: 'asc'|'desc'; cursor?: Cursor; limit?: number }
type EntityConnectionsPage = Page<EdgeView>;
```
Source: `contract.ts:889-901` (`Hierarchy`/`Connections`/`EdgeGroup`/`EdgeView`), `:924-938`
(`EntityConnectionsQuery`/`EntityConnectionsPage`), `:989` (`Page<T>`).

### `ActivityItem`

```ts
interface ActivityItem { id: string; entityId?: EntityId | null; actor?: ActorSummary | null;
  verb: string; summary: Record<string, unknown>; createdAt: string; refId?: string | null;
  workSessionId?: EntityId | null }
```
Source: `contract.ts:1314-1316`.

### `EntityHeaderView` / header command inputs

```ts
type SelectionHeaderSource = 'authored' | 'native' | 'derived';
type SelectionHeaderKind = 'skill'|'memory'|'team_member'|'doc'|'artifact'|'drawing'|'file'|'task'|'collection';
// SELECTION_HEADER_KINDS above is the ONLY set that actually stores an authored header;
// entities.create/.header.set on any other kind (chat, message, work_session, c:*, ...)
// is a no-op with warning `header_not_stored`.

interface SelectionHeader {
  entityId: EntityId; kind: SelectionHeaderKind; name: string;
  whenToUse: string | null; summary: string | null; keywords: string[];
  source: SelectionHeaderSource; stale: boolean; bytes: number | null; loadPointer: string | null;
  clipped?: ('whenToUse'|'summary'|'keywords')[];
}
interface EntityHeaderView extends SelectionHeader {
  version: number;          // the HEADER's own version, 0 = none authored — NOT entities.version
  pinnedVersion: number | null;
}
const AUTHORED_HEADER_LIMITS = { whenToUse: 400, summary: 600, keywords: 12, keyword: 40 };
// GUIDANCE, not a refusal (lenient ruling, migration 223): text over these is TRIMMED and
// declared via `clipped`, never rejected. A field that trims to nothing is dropped.

interface HeaderTextInput { whenToUse?: string | null; summary?: string | null; keywords?: string[] }
interface SetEntityHeaderInput extends CommandContext, HeaderTextInput { expectedVersion?: number }
interface ClearEntityHeaderInput extends CommandContext { expectedVersion?: number }
interface EntityHeaderResult extends CommandResult { header?: EntityHeaderView }
```
Source: `packages/contract/src/selection-header.ts` (whole file, 165 lines).

### Feed and context — shared vocabulary

```ts
type FeedVia = 'subject'|'anchored'|'authored'|'replies'|'caused'|'thread'|'derived_thread'|'derived_task'|'derived_session';
type FeedScope = 'direct_v1'|'session_chat_v1'|'channel_threads_v1'|'thread_v1'|'task_discussion_v1';

interface EntityFeedQuery { scope?: 'default'|FeedScope; order?: 'newest'|'oldest';
  around?: `message:${string}`|`activity:${string}`; cursor?: Cursor; limit?: number }

interface DeliverySummary { deliveryId: string; targetWorkSessionId: EntityId;
  targetWorkSession?: EntitySummary|null; status: MessageDeliveryStatus; attemptNo: number;
  failureReason: string|null; updatedAt: string }

interface FeedItemBase { itemId: string; createdAt: string; sortId: string; via: FeedVia[];
  actor: ActorSummary|null; sourceWorkSessionId: EntityId|null; anchor: EntitySummary|null;
  logicalOperationId: string|null }
type FeedItem =
  | (FeedItemBase & { itemKind: 'message'; message: MessageView; delivery: DeliverySummary[]; linkedWorkSessions?: EntitySummary[] })
  | (FeedItemBase & { itemKind: 'activity'; activity: ActivityItem });

interface EntityFeedPage { resolvedScope: FeedScope; predicates: FeedVia[]; items: FeedItem[];
  nextCursor: Cursor|null; previousCursor?: Cursor|null }
```
Source: `contract.ts:6253-6295` (types); `EntityFeedQuerySchema` `schemas.ts:3826-3836`.

**`FEED_SCOPE_PREDICATES`** — the ONLY place a scope becomes predicates ("a feed is selected
by a versioned named scope, never by a raw predicate array"):

| scope | predicates | valid anchor kinds | `default` resolves here for |
|---|---|---|---|
| `direct_v1` | anchored, replies, subject | any | anything not listed below |
| `session_chat_v1` | anchored, authored, caused, replies | `work_session` | `work_session` |
| `channel_threads_v1` | anchored, subject | `channel` | `channel` |
| `thread_v1` | derived_session, derived_task, subject, thread | `message` | `message` |
| `task_discussion_v1` | anchored, derived_thread, replies, subject | `task` | `task` |

Requesting a scope not applicable to the anchor's kind is `invalid_input`,
`details.reason: 'feed_scope_not_applicable'` — never an empty 200. Source:
`packages/server/src/facade/services/w2/feed-context.ts:108-186` (`FEED_SCOPE_PREDICATES`,
`FEED_SCOPE_ANCHOR_KINDS`, `defaultScopeFor`), mirrored in SQL by
`internal.w2_feed_scope_predicates()` (`db/migrations/030_w2_feed_context.sql`).

```ts
type EntityContextSection = 'summary'|'hierarchy'|'connections'|'messages'|'activity'|'actions';        // v1
type EntityContextV2Section = 'assignment'|'summary'|'hierarchy'|'blockers'|'connections'|'messages'|'actions'; // v2 — no `activity`

interface EntityContextQuery {
  schema?: 'v1'|'v2';                       // absent = v1 (rollout not yet flipped)
  sections?: Array<EntityContextSection|EntityContextV2Section>;
  totalBytes?: number;                      // v1: 512-16384(default)-...; v2: 1024-32768
  sectionBytes?: number;                    // v1 ONLY, 512-8192; refused on v2 (`section_bytes_not_in_v2`)
  offset?: number;                          // v2 only, pages the `assignment` body
  actionsSchema?: 'v1'|'v2';
  cursor?: string;                          // v2 only, continues exactly ONE paged section
  edgeType?: string;                        // v2 only, with sections=connections alone
  header?: string;                          // v2 only: 'resolved' | 'authored'(default) | anything else -> warning
}
```
Source: `contract.ts:6297-6343`; `EntityContextQuerySchema` `schemas.ts:3914-3926`.

v1 response `EntityContextView` (`schemaVersion: 'tm8.entity-context.v1'`): `{root:
EntitySummary, content?: {excerpt, source, truncated}, parents: EntitySummary[], children:
EntitySummary[], edges: EdgeView[], messages: MessageView[], actions: PaletteAction[] |
ActionRows, provenance: {operation, fetchedAt, eventSeq}, cursors: Record<string, Cursor |
null>, byteSize: number, truncated: boolean}`. **Declared gap**: `sections` accepts
`'activity'` but this frozen `.strict()` view has no activity array; the `activity` section
instead contributes only a `cursors.activity` continuation token into `entities.feed` (legal
because `cursors` is an open record) — reported to the coordinator rather than silently
patched. Source: `contract.ts:6362-6380`; gap noted at
`services/w2/feed-context.ts:1109-1115`.

v2 response `EntityContextV2View` (`schemaVersion: 'tm8.entity-context.v2'`) is per-kind and
narrow rather than everything-at-once: always `{id, kind, title, version, status, asOfSeq,
parent?, omitted: [], notLoaded: [], errors: [], budget: {requested, used}}`, plus
kind-specific optional fields populated only for the relevant kind — task:
`priority, gate, assignees, assignment, acceptance, acceptanceWrite, header, blockers,
children`; doc: `outline, outlineTruncated, bodyFetch`; work_session: `teammate, agentTool,
model, checkoutBranch, startedAt, exitedAt, endedKind, endedReason, tasks`; chat: `runtimeState,
turnState, turnCount, lastTurnAt, mode`; project: `projectId`; message: `anchor,
parentMessage, attachments`; and on any kind, only when the section was requested and fit the
budget: `connections: EntityContextConnection[]`, `messages: EntityContextMessage[]`. A
reference the caller cannot read collapses to `{id, unreadable: true}` rather than being
omitted from its parent list; a section that did not fit the budget lands in `omitted:
[{section, kept, more, reason: 'budget'|'rowLimit'|'fetchLimit', expand?, expandOp?}]`, never
silently dropped. Source: `contract.ts:6387-6574` (whole v1/v2 cluster).

### Restricted-kind vocabularies (generic CRUD carve-outs)

```
RESTRICTED_LIFECYCLE_KINDS = { member, message, work_session, project, interaction_profile, artifact, container }
```
Blocks `entities.patch` / `.move` / `.delete` / `.restore` uniformly (`forbidden`,
`"entities.<op> is owned by the ${kind} lifecycle"`), **except** `entities.patch` carves out
`work_session` for a title-only rename. `entities.create`'s exclusion list is separately and
more broadly defined as `CreatableEntityKind` (`CoreEntityKind` minus the set above, minus also
`chat` and `form`), enforced at the Zod layer rather than in the handler, so a create for an
excluded kind never reaches the handler at all (400, not 403). Source:
`services/w2/entities-commands-tracking.ts:77-97` (constant + `assertGenericLifecycle`,
helper body at `:1041-1045`); `CreatableEntityKindSchema` `schemas.ts:2312-2321`.

```
HIERARCHY_DISABLED_KINDS = { message, project, interaction_profile, memory }
```
`entities.children` and `entities.hierarchy` both throw `forbidden` ("children/hierarchy are
disabled for ${kind}") for these parent kinds. Source:
`services/w2/entities-commands-tracking.ts:674-676` (hierarchy), `:1961-1963` (children).

---

## Operations

### `entities.get`
`GET /v2/entities/:id` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1317-1326`)
CLI: `tm8 entity get <entity-id>` (`packages/cli/src/commands/entity.ts:372-386`, registered
`:1124`) — no options besides globals; `--mutation-id` is refused (read-only).

Reads one entity's full detail: content, hierarchy, connections, capabilities, and (by default)
its authored selection header.

**Path params**

| name | type | description |
|---|---|---|
| `id` | `EntityId` | the entity to read |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `header` | string | no | `authored` (default); any value not in `authored\|resolved` also reads as `authored`, with a warning naming the valid modes | which selection header to embed — `authored` (only a human/agent-written one) or `resolved` (falls back to native/derived) |

Example request: `GET /v2/entities/01a0d337-.../get?header=resolved`

**Response** — 200, `data: EntityDetail` (shared type above).

| field | type | description |
|---|---|---|
| (all of `EntitySummary`) | | id, spaceId, kind, title, state, badges, capabilities, counters, ... |
| `content` | `EntityContent` | kind-discriminated full body |
| `hierarchy` | `Hierarchy` | parent + path + first page of children |
| `connections` | `Connections` | grouped outgoing/incoming edges |
| `header` | `EntityHeaderView` \| absent | present per `header=` mode, absent when none resolves |
| `warnings` | `ResultWarning[]` \| absent | present only if `header=` was normalised |

Example (illustrative, from schema):
```json
{
  "data": {
    "id": "01a0d337-f756-7999-a1c6-9e4699ddd4e9",
    "spaceId": "01a0bf2c-a293-7e14-9ce8-35b1d24451c2",
    "kind": "task",
    "title": "Example task",
    "version": 7,
    "state": { "kind": "task", "status": "in_review", "priority": "medium", "axes": {}, "assignees": [], "acceptance": { "total": 3, "completed": 1 } },
    "content": { "kind": "task", "description": "..." },
    "hierarchy": { "parent": null, "path": [], "children": { "items": [], "nextCursor": null } },
    "connections": { "outgoing": [], "incoming": [], "unresolvedHardDependencyCount": 0 },
    "capabilities": { "canEdit": true, "canDelete": false, "canAddChild": true, "canLink": true, "canPull": true, "canReact": true, "canGrantPoints": true, "canComplete": true }
  },
  "requestId": "req_000123"
}
```

**Errors** — `not_found` (404) when no live row exists for `id` (soft-deleted rows are also
"not found" here — use `entities.versions`/`entities.activity` on a deleted id, or
`entities.restore` first).
**Notes** — no idempotency concerns (read). No `expectedVersion`/cursor. Auth: requires an
authenticated owner whose claims RLS admits the row (`claimsFor(owner, ctx)`; role specifics
beyond "authenticated member of the space" not traced in this pass —
`unverified: exact per-kind read authorization beyond RLS was not traced into
packages/server/src/facade/context.ts`). No side effects.
Source: catalog `catalog.ts:110`; handler `services/w2/entities-commands-tracking.ts:1317-1326`;
`headerReadMode` `schemas.ts:3888-3906`.

---

### `entities.create`
`POST /v2/entities` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1328-1472`)
CLI: `tm8 entity create <kind> <title>` (`entity.ts:855-895`, registered `:1125`).

Creates one entity of a `CreatableEntityKind`, optionally attaching it to a parent, wiring
initial connections, and/or authoring a selection header — all in one transaction.

**Path params** — none (`spaceId` travels in the body).

**Request body** (`CreateEntityInput`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | **yes** | min 1 | required here even though the base `CommandContext` shape makes it optional |
| `workSessionId` | `EntityId` | no | | |
| `spaceId` | `SpaceId` | yes | | owning space |
| `kind` | `CreatableEntityKind` | yes | `CoreEntityKind` minus `{message, member, work_session, project, interaction_profile, worktree, artifact, chat, container, form}`, plus any `c:*` custom kind | an excluded kind fails Zod validation (400) before the handler runs |
| `title` | string | yes | min 1 | |
| `parentId` | `EntityId` \| null | no | | |
| `position` | number | no | | |
| `content` | `Record<string, unknown>` | no | kind-specific bag, dispatched in the handler's own `switch(kind)` — e.g. `task`: description/axes/priority/acceptanceCriteria/pointsEstimate/dueDate/startDate; `doc`: body/format; `channel`: topic; `team_member`: role/identity/model/agentTool/mode/permissionMode/capabilities/commandPermissions/avatar; `pull_request`: provider/url/repository/number/state/headSha; `commit`: provider/url/repository/sha/author/committedAt; `memory`: statement/mechanism/subjectScope/doesNotEstablish/measuredAt/workSessionId; `graph`/`drawing`: soft-validated via their own content schemas | not enforced per-kind by Zod beyond `graph`/`drawing`'s soft gates — `content` itself is `z.record(z.unknown())` |
| `attachTo` | `{entityId, edgeType: 'attached_to'\|'relates_to'}` | no | | writes one edge in the same transaction |
| `connections` | `{type, targetId, props?}[]` | no | deduped | writes N edges in the same transaction |
| `header` | `HeaderTextInput` | no | see shared types | only stored for kinds in `SELECTION_HEADER_KINDS`; other kinds get warning `header_not_stored` |

Example request (illustrative, from schema):
```json
{
  "clientMutationId": "cm_01",
  "spaceId": "01a0bf2c-a293-7e14-9ce8-35b1d24451c2",
  "kind": "task",
  "title": "Fix the invoice uploader",
  "parentId": null,
  "content": { "description": "...", "priority": "high" }
}
```

**Response** — 201, `data: CommandResult | ServerReceipt` (receipt on `?return=receipt`, op
`entity.create`). `entity` is the new row's `EntityDetail`. `warnings` carries header outcomes
when `header` was sent. Uses the service's local `commandResult()` — see shared-types note on
which assembler populates `activity` (this path does not typically populate one for a plain
create, since there is no prior activity feed row beyond the `created` event itself, which
`buildDetail` does not surface as `activity` on this response — `unverified: whether
`entities.create`'s CommandResult.activity is ever populated` was not independently confirmed
by tracing every kind's create RPC).

**Errors**
- `invalid_input` (400) — schema validation (excluded `kind`, missing `title`/`spaceId`, bad `content` shape for `graph`/`drawing`).
- `forbidden` (403) — `"entities.create is owned by the ${kind} lifecycle"`: defense-in-depth for a kind reaching the handler's `switch` default arm; effectively unreachable given the schema already excludes those kinds.

**Notes** — idempotent via required `clientMutationId` (ledger, when enabled). No
`expectedVersion` (nothing to conflict with on create). Side effects: attaches
`attachTo`/`connections` edges and writes the header, all in the same transaction as the row
(`"the entity and its header land together or not at all"`).
Source: catalog `catalog.ts:111`; schema `CreateEntityInputSchema` `schemas.ts:2323-2334`, type
`contract.ts:2600-2616`; handler `services/w2/entities-commands-tracking.ts:1328-1472`
(per-kind dispatch, `attachInitialConnections` at `:1461`, header at `:1462-1468`).

---

### `entities.patch`
`PATCH /v2/entities/:id` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1474-1663`)
CLI: `tm8 entity update <entity-id>` (note: **not** `entity patch`) (`entity.ts:897-933`,
registered `:1126`) — requires `--expect-version` and at least one of `--title`/`--content`.

Updates title and/or a kind-specific subset of `content`, version-guarded. Refuses the
`RESTRICTED_LIFECYCLE_KINDS` set except a narrow `work_session` title-only carve-out.

**Path params**

| name | type | description |
|---|---|---|
| `id` | `EntityId` | |

**Request body** (`PatchEntityInput`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | optional here (unlike create) |
| `workSessionId` | `EntityId` | no | | |
| `expectedVersion` | number | **yes** | finite | optimistic-concurrency guard |
| `title` | string | no | | |
| `content` | `Record<string, unknown>` | no | per-kind allow-listed member set (`PATCH_CONTENT_MEMBERS`) — e.g. task/doc/channel/collection/team_member/file/spell/skill/pull_request/commit/memory/loop each declare their own accepted fields; unknown members are refused by name with the accepted list | |

Behavior notes baked into validation:
- `work_session`: only `title` is accepted; any `content` key ⇒ `invalid_input` ("work_session
  patch accepts title only, not: ..."); missing title ⇒ `invalid_input` ("work_session patch
  requires title").
- `worktree`: only `content.status` (+ optional `content.preflightToken`) accepted; `title` is
  refused ("title is derived from the branch"); `path`/`branch`/`baseRef`/`baseCommitOid`/
  `projectId` are refused by name as immutable.
- Any other restricted kind (`member, message, project, interaction_profile, artifact,
  container`) ⇒ `forbidden`, `"entities.patch is owned by the ${kind} lifecycle"`, before any
  content check runs.
- A patch with neither `title` nor an accepted `content` member ⇒ `invalid_input` (no-op
  refused, not silently accepted).
- An unrecognized `kind` (not in the per-kind switch, not `c:*`) ⇒ `not_implemented`,
  `"entities.patch does not support ${kind}"`.

Example request: `PATCH /v2/entities/<id>` with
```json
{ "expectedVersion": 7, "title": "Renamed", "content": { "priority": "urgent" } }
```

**Response** — `data: CommandResult | ServerReceipt` (receipt on `?return=receipt`, op
`entity.update`).

**Errors**
- `invalid_input` (400) — unknown content member, kind/content mismatch, no-op patch, `work_session`/`worktree` special-case violations.
- `forbidden` (403) — restricted-lifecycle kind.
- `not_implemented` (501) — unrecognized kind.
- `version_conflict` (409) — `expectedVersion` stale; `current: EntityDetail` attached via `withCurrent`.
- `not_found` (404) — no live row for `id`.

**Notes** — `expectedVersion` required. `clientMutationId` optional but idempotency-ledger-keyed
when supplied. Side effects: per-kind RPC (`update_task_content`, etc.) writes an activity row
and, for `task`, may re-stamp `doneBy`/`doneAt` on acceptance criteria via the same normalizer
`entities.commands.tick` reuses.
Source: catalog `catalog.ts:112`; schema `PatchEntityInputSchema` `schemas.ts:2340-2344`, type
`contract.ts:2623-2627`; handler `services/w2/entities-commands-tracking.ts:1474-1663`
(`assertGenericLifecycle` `:1041-1045`, `assertPatchContentMembers` `:1086-1109`,
`PATCH_CONTENT_MEMBERS` `:1069-1084`).

---

### `entities.header.set`
`PUT /v2/entities/:id/header` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1671-1681`)
CLI: `tm8 entity header set <entity-id> [--when-to-use <t>] [--summary <t>] [--keyword <k>]...
[--expect-version <n>] [--mutation-id <id>]` (`entity.ts:942-960`, registered `:1127`).

Writes (creates or replaces) the entity's authored selection header, re-pinning it to the
entity's current version. Never moves `entities.version` — the header has its own version
counter.

**Path params** — `id: EntityId`.

**Request body** (`SetEntityHeaderInput extends CommandContext, HeaderTextInput`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `whenToUse` | string \| null | no | guidance cap 400 chars — trimmed/clipped, never refused | |
| `summary` | string \| null | no | guidance cap 600 chars | |
| `keywords` | string[] | no | guidance cap 12 keywords × 40 chars each | |
| `expectedVersion` | number | no | int, ≥0 | the **header's own** version (0 = none yet); omitted ⇒ unguarded write |

The WHOLE header is written each call: an absent/null field is removed (a set with only
`summary` leaves no `whenToUse`). Blank text/keywords are dropped, duplicates removed; a set
that ends up empty is a no-op with warning `header_empty`.

Example request:
```json
{ "summary": "Uploads a CSV of invoices into the ledger", "whenToUse": "Pick when the user asks to bulk-import invoices" }
```

**Response** — `data: EntityHeaderResult extends CommandResult { header?: EntityHeaderView }`.
`header` absent means the entity's kind is not in `SELECTION_HEADER_KINDS`, with warning
`header_not_stored`.

**Errors** — `version_conflict` (409) if `expectedVersion` given and stale (header's own
version, carries `current: EntityDetail`); `not_found` (404) if the entity doesn't exist.
**Notes** — idempotent via `clientMutationId` (ledger). `expectedVersion` here guards the
HEADER's version, not the entity's `entities.version`.
Source: catalog `catalog.ts:116`; schema `SetEntityHeaderInputSchema` `schemas.ts:2617-2621`,
type `selection-header.ts:142-144`; handler
`services/w2/entities-commands-tracking.ts:1671-1681`.

---

### `entities.header.clear`
`DELETE /v2/entities/:id/header` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1688-1698`)
CLI: `tm8 entity header clear <entity-id> [--expect-version <n>] [--mutation-id <id>]`
(`entity.ts:962-976`, registered `:1128`).

Removes the authored header; the entity falls back to its native/derived one.

**Path params** — `id: EntityId`.

**Request body** (`ClearEntityHeaderInput extends CommandContext`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `expectedVersion` | number | no | int, ≥0 | header's own version; omitted ⇒ unguarded |

Example request: `{}` (unguarded clear) or `{ "expectedVersion": 2 }`.

**Response** — `data: EntityHeaderResult`. Clearing an entity with no authored header is a
no-op, warning `header_absent`.

**Errors** — `version_conflict` (409) if guarded and stale; `not_found` (404).
**Notes** — idempotent via `clientMutationId`.
Source: catalog `catalog.ts:117`; schema `ClearEntityHeaderInputSchema` `schemas.ts:2623-2626`,
type `selection-header.ts:152-154`; handler
`services/w2/entities-commands-tracking.ts:1688-1698`.

---

### `entities.move`
`POST /v2/entities/:id/move` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1904-1927`)
CLI: `tm8 entity move <entity-id> --parent <id|none> --position <n> --expect-version <n>
[--mutation-id <id>]` (`entity.ts:999-1026`, registered `:1130`) — all three options required.

Reparents and/or repositions an entity, version-guarded.

**Path params** — `id: EntityId`.

**Request body** (`MoveEntityInput`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `parentId` | `EntityId` \| null | **yes** | new parent must be the same kind's valid container per RPC | `null` moves to root |
| `position` | number | **yes** | finite | |
| `expectedVersion` | number | **yes** | finite | |

Example request: `{ "clientMutationId": "cm_02", "parentId": "01a0...", "position": 2, "expectedVersion": 5 }`

**Response** — `data: CommandResult`.

**Errors** — `forbidden` (403) `"entities.move is owned by the ${kind} lifecycle"` for
`RESTRICTED_LIFECYCLE_KINDS`; `version_conflict` (409, `current: EntityDetail` attached
inline, not via the shared `withCurrent` helper); `not_found` (404).
**Notes** — idempotent via `clientMutationId`. RPC: `move_entity`.
Source: catalog `catalog.ts:122`; schema `MoveEntityInputSchema` `schemas.ts:2448-2453`, type
`contract.ts:2657-2661`; handler `services/w2/entities-commands-tracking.ts:1904-1927`.

---

### `entities.delete`
`DELETE /v2/entities/:id` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1929-1939`)
CLI: `tm8 entity delete <entity-id> --yes [--mutation-id <id>]` (`entity.ts:1028-1042`,
registered `:1131`) — refuses (usage error, with a hint pointing at `entity restore`) without
`--yes`.

Soft-deletes an entity (`deletedAt` set); no optimistic-concurrency guard exists on this op.

**Path params** — `id: EntityId`.

**Request body** (`RequiredCommandContextSchema`, defined locally in
`packages/server/src/facade/input-schemas.ts:154-157`, not in `@tm8/contract`, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | **yes** | min 1 | |

No `expectedVersion`, no `workSessionId` — this schema is narrower than the base
`CommandContext`.

Example request: `{ "clientMutationId": "cm_03" }`

**Response** — `data: CommandResult`.

**Errors** — `forbidden` (403) for `RESTRICTED_LIFECYCLE_KINDS`; `not_found` (404).
**Notes** — idempotent via required `clientMutationId`. No version guard at all on this op —
a delete cannot lose a race the way patch/move can, by design (a second delete of an
already-deleted row is a no-op). RPC: `delete_entity`.
Source: catalog `catalog.ts:123`; schema `input-schemas.ts:154-157`; handler
`services/w2/entities-commands-tracking.ts:1929-1939`.

---

### `entities.restore`
`POST /v2/entities/:id/restore` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1941-1953`)
CLI: `tm8 entity restore <entity-id> [--mutation-id <id>]` (`entity.ts:1044-1053`, registered
`:1132`).

Un-deletes a soft-deleted entity.

**Path params** — `id: EntityId`.

**Request body** — same `RequiredCommandContextSchema` as `entities.delete`: `{actorId?,
clientMutationId: string (required, min 1)}`.

Example request: `{ "clientMutationId": "cm_04" }`

**Response** — `data: CommandResult`.

**Errors** — `not_found` (404) `"no such entity: ${id}"` if the row is gone entirely (this
lookup, unlike most others, includes soft-deleted rows so it can tell "deleted" from "never
existed"); `forbidden` (403) for `RESTRICTED_LIFECYCLE_KINDS`.
**Notes** — idempotent via required `clientMutationId`. RPC: `restore_entity`.
Source: catalog `catalog.ts:124`; schema `input-schemas.ts:154-157`; handler
`services/w2/entities-commands-tracking.ts:1941-1953`.

---

### `entities.children`
`GET /v2/entities/:id/children` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1955-1992`)
CLI: `tm8 entity children <entity-id> [--limit n] [--cursor c]` — no `--depth` option: the CLI
docblock explicitly refuses one by name because nothing on the wire backs it (a flag with no
wire destination is refused, not silently dropped).

Lists an entity's direct (one level) live children, position-ordered.

**Path params** — `id: EntityId`.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | integer | no | server default/cap via `limitOf()` (shared clamp helper; exact bounds not independently re-derived in this pass beyond "1..100"-style clamps seen elsewhere in this file — `unverified: entities.children`'s exact limit bounds, only that `limitOf` clamps a caller value) | |
| `cursor` | string | no | must be a cursor this exact parent (`id`) fingerprinted | keyset on `(position, id)` |

**Response** — `data: Page<EntitySummary>`.

| field | type | description |
|---|---|---|
| `items` | `EntitySummary[]` | |
| `nextCursor` | string \| null | |

**Errors** — `forbidden` (403) `"children are disabled for ${kind}"` for
`HIERARCHY_DISABLED_KINDS` (`message, project, interaction_profile, memory`); `invalid_cursor`
(400) if the cursor doesn't fingerprint-match this parent; `not_found` (404) if `id` has no
live row.
**Notes** — no idempotency (read). Cursor is keyset-paginated, fingerprinted per parent so a
cursor from a different parent's page cannot be replayed here.
Source: catalog `catalog.ts:125`; handler
`services/w2/entities-commands-tracking.ts:1955-1992`.

---

### `entities.hierarchy`
`GET /v2/entities/:id/hierarchy` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1994-1999`, delegating to `hierarchyFor` at
`:668-708`)
CLI: `tm8 entity hierarchy <entity-id>` — no options; `--depth` is explicitly refused by name
(no wire schema backs it — the response always returns the full ancestor path plus one page of
direct children, never a caller-chosen depth).

Reads the entity's ancestor path (root → parent) plus a bounded first page of its direct
children.

**Path params** — `id: EntityId`. No query params at all — confirmed the handler never reads
`ctx.query`.

**Response** — `data: Hierarchy` (shared type: `{parent: EntitySummary | null, path:
EntitySummary[], children: Page<EntitySummary>}`). `children` is capped at 50 items
(`childLimit = 50`, hard-coded, not caller-configurable) with its own `nextCursor` (a normal
`entities.children` cursor, pageable through that operation for more). Deleted ancestors are
excluded (unlike `entities.get`'s own `path`, if any).

**Errors** — `forbidden` (403) `"hierarchy is disabled for ${kind}"` for
`HIERARCHY_DISABLED_KINDS`; `not_found` (404).
**Notes** — no cursor/idempotency on the top-level call; the embedded `children.nextCursor`
continues through `entities.children`, not a param of this operation.
Source: catalog `catalog.ts:126`; handler `services/w2/entities-commands-tracking.ts:1994-1999`
+ `hierarchyFor` `:668-708`.

---

### `entities.connections`
`GET /v2/entities/:id/connections` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2001-2006`, via `normalizedConnections`/
`queryConnections` at `:495-620`)
CLI: `tm8 entity connections <entity-id> [--type <t>]... [--peer <id>]... [--direction
incoming|outgoing|both] [--limit n] [--cursor c]` (`packages/cli/src/commands/edge.ts:180-196`,
registered `:365` — **lives in `edge.ts`, not `entity.ts`**, because its response type,
`Page<EdgeView>`, is an edge read that happens to be addressed by this endpoint). The CLI
**explicitly refuses `--sort`, `--order`, `--peer-kind`, `--created-by`, `--created-after`,
`--created-before` by name** even though the server implements every one of them — those flags
are documented in a grammar-redesign proposal the frozen CLI projection does not bind yet
(`edge.ts:44-56`, `refuseUnbound`).

Paginated, filterable list of an entity's graph edges in either or both directions.

**Path params** — `id: EntityId`.

**Query params** (`EntityConnectionsQuery`)

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `type` / `types` (repeatable) | string[] | no | | edge type filter |
| `direction` | `'incoming'\|'outgoing'\|'both'` | no | `both` | |
| `peerId` / `peerIds` (repeatable) | `EntityId[]` | no | must be UUIDs | other-endpoint filter |
| `peerKind` / `peerKinds` (repeatable) | `EntityKind[]` | no | | other-endpoint kind filter |
| `createdById` / `createdByIds` (repeatable) | `EntityId[]` | no | must be UUIDs | |
| `createdAfter` | ISO timestamp | no | must parse | |
| `createdBefore` | ISO timestamp | no | must parse | |
| `sort` | `'createdAt'\|'updatedAt'\|'type'` | no | `createdAt` | |
| `order` | `'asc'\|'desc'` | no | `desc` | |
| `cursor` | string | no | must fingerprint-match every other query param above | |
| `limit` | integer | no | clamped via `limitOf()` | |

**Response** — `data: Page<EdgeView>` — a **flat** page, not the grouped
`outgoing`/`incoming` shape `EntityDetail.connections` embeds (see shared-types note).

**Errors** — `invalid_input` (400) for a bad `direction`/`sort`/`order` value, a non-UUID
`peerId`/`createdById`, or an unparsable timestamp; `invalid_cursor` (400) if the cursor's
fingerprint doesn't match this exact filter set (including `sort`/`order` — a cursor taken
under one sort cannot be replayed under another); `not_found` (404) if `id` has no live row
(`assertLive`).
**Notes** — no idempotency (read). The query is deliberately performance-shaped: endpoint
entity lookups are per-edge primary-key reads rather than a join, specifically to avoid an N²
RLS-call plan on a freshly-created row with no table statistics yet (documented at length in
the handler as a fix for a measured 11.5s-per-call regression).
Source: catalog `catalog.ts:127`; type `EntityConnectionsQuery`/`EntityConnectionsPage`
`contract.ts:924-938`; handler `normalizedConnections`/`queryConnections`
`services/w2/entities-commands-tracking.ts:495-620`.

---

### `entities.versions`
`GET /v2/entities/:id/versions` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2008-2056`)
CLI: `tm8 entity versions <entity-id> [--limit n] [--cursor c]` (per `ENTITY_COMMANDS`
registration referenced in `entity.ts`; not independently re-read line-by-line in this pass —
`unverified: exact entity.ts line range for the `versions` CLI command body`, only that it is
registered and reachable).

Paginated, newest-first history of an entity's stored snapshots.

**Path params** — `id: EntityId`.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | integer | no | clamped via `limitOf()` | |
| `cursor` | string | no | fingerprinted on `{entityId, kind}`, keyset on `version desc` | |

**Response** — `data: Page<T>` where `T` is an **ad-hoc shape with no dedicated contract type**
(genuine finding, not a gap — confirmed directly from the handler rather than a missing
export): `{entityId: string, version: number, snapshot: unknown, changedBy: ActorSummary |
null, changedAt: string}`. For `kind === 'interaction_profile'` the snapshot is read from a
different table (`interaction_profile_versions`) and reshaped to
`{draft, validationStatus, validatedHash, validation}`; every other kind reads
`public.entity_versions` directly and returns its `snapshot` column verbatim.

Example (illustrative, from schema):
```json
{
  "data": {
    "items": [
      { "entityId": "01a0d337-...", "version": 7, "snapshot": { "title": "..." }, "changedBy": { "id": "...", "displayName": "..." }, "changedAt": "2026-09-24T11:54:03.020Z" }
    ],
    "nextCursor": null
  },
  "requestId": "req_000456"
}
```

**Errors** — `invalid_cursor` (400) mismatched fingerprint or non-integer version key;
`not_found` (404) if `id` has no live row.
**Notes** — no idempotency (read). No write path shares this shape; it exists purely as a
history read.
Source: catalog `catalog.ts:128`; handler `services/w2/entities-commands-tracking.ts:2008-2056`.

---

### `entities.activity`
`GET /v2/entities/:id/activity` · kind: read · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2058-2104`)
CLI: `tm8 entity activity <entity-id> [--limit n] [--cursor c]` (registered in `entity.ts`;
exact body range not re-read in this pass, same caveat as `entities.versions` above).

Paginated, newest-first activity log for one entity. Note: a same-named `entitiesActivity`
function exists in `packages/server/src/facade/handlers/commands.ts` but is **dead code** —
never imported or registered anywhere; the live handler is `service.listActivity` below.

**Path params** — `id: EntityId`.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | integer | no | clamped via `limitOf()` | |
| `cursor` | string | no | fingerprinted on `{entityId}`, keyset on `(created_at, id) desc` | |

**Response** — `data: Page<ActivityItem>` (shared type).

Example (illustrative, from schema):
```json
{
  "data": {
    "items": [
      { "id": "act_01", "entityId": "01a0d337-...", "actor": { "id": "...", "displayName": "..." }, "verb": "task.tick", "summary": {}, "createdAt": "2026-09-24T12:00:00.000Z", "refId": null, "workSessionId": null }
    ],
    "nextCursor": null
  },
  "requestId": "req_000789"
}
```

**Errors** — `invalid_cursor` (400); `not_found` (404).
**Notes** — no idempotency (read). No kind restriction — unlike children/hierarchy, every kind
supports activity.
Source: catalog `catalog.ts:129`; handler `services/w2/entities-commands-tracking.ts:2058-2104`
(dead-code note: `handlers/commands.ts:215`, confirmed unreferenced via repo-wide grep).

---

### `entities.react`
`PUT /v2/entities/:id/reaction` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2106-2116`)
CLI: `tm8 entity react <entity-id> <like|dislike|star> [--off] [--mutation-id <id>]`
(mapped from `entity react` per `entity.ts` registration; exact enabled/disabled flag spelling
not re-verified beyond the RPC's `enabled: boolean` argument — `unverified: exact CLI flag
name for disabling a reaction`, cross-checked only against the wire shape below).

Sets or clears the caller's own reaction edge on an entity.

**Path params** — `id: EntityId`.

**Request body** (`ReactionInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `reaction` | `'like'\|'dislike'\|'star'` | yes | | |
| `enabled` | boolean | yes | | `true` sets, `false` clears |

Example request: `{ "reaction": "star", "enabled": true }`

**Response** — `data: CommandResult`, built via the service's local `commandResult()` — this
path **does** populate `activity` when the RPC returns one (see shared-types note on the two
assemblers).

**Errors** — `not_found` (404) if `id` has no live row.
**Notes** — idempotent via `clientMutationId`. RPC: `react`. Reflected in
`EntityCounters.viewerReaction` on the next read of this entity.
Source: catalog `catalog.ts:130`; type `ReactionInput` `contract.ts` (grep
`interface ReactionInput`); handler `services/w2/entities-commands-tracking.ts:2106-2116`.

---

### `entities.points.add`
`POST /v2/entities/:id/points` · kind: command · status: v1 · served: yes
(`handlers/commands.ts:193-212`, factory `entitiesPointsAdd(deps)`)
CLI: `tm8 entity point grant <entity-id> <amount> --reason grant|award|seed [--reference <id>]
[--mutation-id <id>]` (`entity.ts:1071-1093`).

Grants (or debits, via a negative amount) points on a `member`/`team_member` entity.

**Path params** — `id: EntityId`.

**Request body** (`GrantPointsInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `amount` | number | yes | finite, non-zero | |
| `reason` | `'grant'\|'award'\|'seed'` | yes | | |
| `referenceId` | `EntityId` | no | | e.g. the task the points are for |

Example request: `{ "amount": 5, "reason": "award", "referenceId": "01a0d337-..." }`

**Response** — `data: CommandResult`, via `toCommandResult` (never populates `activity` — see
shared-types note). Idempotent on `client_event_id` in `point_events`, so a retried grant does
not pay twice, but the returned `pointEventId` is **not exposed** on the wire `CommandResult`
(`toCommandResult` builds a fresh object and does not copy that RPC field through —
`unverified: whether pointEventId reaches the client by any other path`).

**Errors** — `invalid_input` (400) `"point amount must be non-zero"`; `invalid_input` (400)
`"points are granted to a member or team_member"` when the target entity's kind is neither.
**Notes** — `EntityCounters.points` is a trigger-maintained cache of `point_events`, never
written directly by this or any other RPC.
Source: catalog `catalog.ts:131`; schema `GrantPointsInputSchema` `schemas.ts:2557-2562`, type
`contract.ts:2777-2781`; handler `handlers/commands.ts:193-212`; RPC `grant_points`
(`db/migrations/007_rpc_catalog.sql:1557-1595`).

---

### `entities.commands.complete`
`POST /v2/entities/:id/commands/complete` · kind: command · status: v1 · served: yes
(`handlers/commands.ts:71-149`, factory `commandsComplete(deps)`)
CLI: `tm8 task complete <task-id> --expect-version <n> --by <actor-id>... [--mutation-id <id>]`
(`task.ts:93-131`; `--by` repeatable, client-validated as UUIDs).

**Dual-kind dispatch in one transaction**: on a `work_session` row this atomically toggles
session-done state (RPC `set_session_done`, ignoring `completerIds`); on every other kind
(effectively `task`) it runs `complete_task`, which — unlike `entities.commands.work` — is
"not a transition": it checks acceptance criteria, writes `completed_by` edges, awards points,
and flips `work_status='done'` all in one statement.

**Path params** — `id: EntityId`.

**Request body** (`CompleteTaskInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `expectedVersion` | number | yes | finite | |
| `completerIds` | `EntityId[]` | yes | min 1, each a UUID (message: `"completerIds (--by) must be actor ids (uuids)"`) | ignored on the `work_session` dispatch path |

Example request: `{ "expectedVersion": 4, "completerIds": ["01a0bf2c-..."] }`

**Response** — `data: CommandResult | ServerReceipt` (receipt op `task.complete`), via
`toCommandResult` (no `activity`).

**Errors**
- `not_found` (404) `"task not found"` — missing/wrong-kind/deleted row.
- `version_conflict` (409) — via `enrichVersionConflict`, `current: EntityDetail` attached.
- `invariant_violation` (409) `"task is already complete"` — `work_status` already `done`.
- `invariant_violation` (409) `"all acceptance criteria must be complete first"` — any criterion `done: false`.
- `invariant_violation` (409, `details.reason: 'gate_no_tracked_pr'`) — `completion_gate='pr_merged'` and no tracked PR.
- `invariant_violation` (409, `details.reason: 'gate_pr_unmerged_or_ci_red'`) — tracked PR exists but unmerged, or `ci_status='failing'` (a `null` `ci_status` does not refuse).

**Notes** — idempotent via `clientMutationId`. Points/completer edges written atomically with
the status flip.
Source: catalog `catalog.ts:134`; schema `CompleteTaskInputSchema` `schemas.ts:2564-2570`, type
`contract.ts:2783-2786`; handler `handlers/commands.ts:71-149`; RPC `complete_task`
(`db/migrations/082_git_graph_events_provenance_gate.sql:344-410`).

---

### `entities.commands.work`
`POST /v2/entities/:id/commands/work` · kind: command · status: v1 · served: yes
(`handlers/commands.ts:26-69`, factory `commandsWork(deps)`)
CLI: `tm8 task transition <task-id> <open|pulled|working|in_review|blocked|cancelled>
[--mutation-id <id>]` (`task.ts:56-85`; the CLI's own `TRANSITIONABLE` set excludes `done`, but
the wire schema still admits any `WorkStatus` — a direct API caller sending `done` reaches the
server and is refused there, not locally).

Sets a task's work status and/or the caller's own `working_on` presence edge. Only legal on
kind `task`.

**Path params** — `id: EntityId`.

**Request body** (`WorkInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `status` | `WorkStatus` | yes | | |
| `startedAt` | ISO timestamp | no | | |
| `note` | string \| null | no | three-state: absent (leave stored note), explicit `null` (clear it), a string (set it) — distinguished server-side by a 7th positional `p_clear_note` argument, since absent and null are otherwise indistinguishable on the wire | |

Example request: `{ "status": "working", "note": "starting now" }`

**Response** — `data: CommandResult | ServerReceipt` (receipt op `task.transition`), via
`toCommandResult` (no `activity`). Behavior: on `open`/`cancelled` the actor's `working_on`
edge is deleted; otherwise one `working_on` edge per actor is upserted with
`props={status, startedAt, note}` (note falls back to the stored value unless explicitly
cleared).

**Errors** — `invariant_violation` (409, `details.reason: 'use_complete_command'`) —
`"completion goes through complete_task"` when `status='done'`; `invalid_input` (400)
`"invalid work status: %s"` for any value past what Zod's `WorkStatus` enum should already
exclude (should not occur past validation).
**Notes** — idempotent via `clientMutationId`. RPC: `set_work_state`.
Source: catalog `catalog.ts:135`; schema `WorkInputSchema` `schemas.ts:2578-2583`, type
`contract.ts:2789`; handler `handlers/commands.ts:26-69`; RPC `set_work_state`
(`db/migrations/060_work_refusal_reason_detail.sql:16-77`).

---

### `entities.commands.pull`
`POST /v2/entities/:id/commands/pull` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2118-2137`)
CLI: `tm8 entity pull <entity-id> --pinned-version <n> [--local-id <id>|--local-id '']
[--mutation-id <id>]` (`entity.ts:1095-1117`; refuses locally with a usage hint if
`--pinned-version` is missing).

Records that an actor has "pulled" (locally checked out / synced) a specific version of an
entity.

**Path params** — `id: EntityId`.

**Request body** (`PullInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `localId` | string \| null | no | three-state, same pattern as `work`'s `note` (absent = preserve, `null` = clear, string = set) | caller's local identifier for the pulled copy |
| `pinnedVersion` | number | yes | finite | the version being pulled |

Example request: `{ "pinnedVersion": 7, "localId": "wt-abc123" }`

**Response** — `data: CommandResult`, via the service's local `commandResult()` — **does**
populate `activity` when the RPC returns one. Reflected in `EntityState.task.pulls: PullState[]`
(`{actor, localId, pinnedVersion, contentStale, discussionMoved, status, pulledAt}`) on the
next read.

**Errors** — `invalid_input` (400) `"pinned version %s is not a version of this entity"`;
`not_found` (404) `"pinned version is no longer retained"` if the version projection was
pruned.
**Notes** — idempotent via `clientMutationId`. RPC: `set_pull_state`.
Source: catalog `catalog.ts:136`; schema `PullInputSchema` `schemas.ts:2572-2576`, type
`contract.ts:2788`; handler `services/w2/entities-commands-tracking.ts:2118-2137`; RPC
`set_pull_state` (`db/migrations/042_w2_set_pull_state_absent_means_merge.sql`).

---

### `entities.commands.linkPr`
`POST /v2/entities/:id/commands/link-pr` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2139-2157`)
CLI: `tm8 task link-pr <task-id> <url> [--project <id>] [--mutation-id <id>]`
(`task.ts:250-287`, shared `linker()` factory with `link-commit`). After a successful link the
CLI makes a **best-effort, non-fatal** follow-up `edges.create` call (`created_in` edge from
the artifact to the caller's session) so the forge watcher can resolve an owning session;
failures there are swallowed or surfaced only as a receipt warning
(`session_link_failed`, `task.ts:196-248`) — never as a failure of the link itself.

Links a task to a pull request by URL, creating-or-reusing the `pull_request` entity and a
`tracks` edge, atomically.

**Path params** — `id: EntityId` (the task).

**Request body** (`LinkPrInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | **yes** | min 1 — required here, unlike the optional base default | |
| `workSessionId` | `EntityId` | no | | |
| `url` | string | yes | valid URL, must contain a `/pull/` or `/merge_requests/` segment with a numeric PR number | |
| `projectId` | string | no | min 1 | associates the linked artifact with a project |

Client-side URL parsing (`parseProviderUrl(url, 'pull_request')`) raises `invalid_input` before
any RPC for: an unparsable URL ("tracking URL is invalid"), a URL missing the pull-request
segment ("URL is not a pull request URL"), or a non-numeric/`<1` PR number ("pull request URL
has an invalid number").

Example request: `{ "clientMutationId": "cm_05", "url": "https://github.com/org/repo/pull/42" }`

**Response** — `data: CommandResult | ServerReceipt` (receipt op `task.link-pr`), via the
service's local `commandResult()` — populates `activity` (verb `pr.linked`).

**Errors** — `invariant_violation` (409, `details.reason: 'project_not_linked'`) `"Project not
found"` if `projectId` given but doesn't exist; `not_found` (404) `"task not found"`;
`invalid_input` (400) `"invalid pull request reference"` / the client-side parse errors above.
**Notes** — idempotent via required `clientMutationId`. RPC: `link_pull_request`
(creates-or-upserts the `pull_request` entity, unique on provider+repo+number,
advisory-locked).
Source: catalog `catalog.ts:137`; schema `LinkPrInputSchema` `schemas.ts:2597-2602`, type
`contract.ts:2820`; handler `services/w2/entities-commands-tracking.ts:2139-2157`
(`parseProviderUrl` `:1284-1312`); RPC `link_pull_request`
(`db/migrations/017_w2_entities_commands_tracking.sql:534-579`).

---

### `entities.commands.linkCommit`
`POST /v2/entities/:id/commands/link-commit` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:2159-2177` approx., same structure as `linkPr`)
CLI: `tm8 task link-commit <task-id> <url> [--project <id>] [--mutation-id <id>]`
(`task.ts:584-585`, same `linker()` factory and post-link session-claim behavior as `link-pr`).

Same shape as `entities.commands.linkPr`, keyed on commits instead of pull requests.

**Path params** — `id: EntityId` (the task).

**Request body** (`LinkCommitInput extends CommandContext`) — identical field set to
`LinkPrInput` above (`clientMutationId` required, `url` required, `projectId` optional).
`parseProviderUrl(url, 'commit')` requires a `/commit/` or `/commits/` segment and a 7–64
hex-character sha; failures raise `invalid_input` ("URL is not a commit URL" / "commit URL has
an invalid sha").

Example request: `{ "clientMutationId": "cm_06", "url": "https://github.com/org/repo/commit/abc1234" }`

**Response** — `data: CommandResult | ServerReceipt` (receipt op `task.link-commit`), activity
verb `linked`.

**Errors** — same `project_not_linked` / `"task not found"` / `invalid_input` (22023, "invalid
commit reference") family as `linkPr`.
**Notes** — idempotent via required `clientMutationId`. RPC: `link_commit`, keyed on
provider+repo+sha.
Source: catalog `catalog.ts:138`; schema `LinkCommitInputSchema` `schemas.ts:2604-2609`, type
`contract.ts:2823`; RPC `link_commit`
(`db/migrations/017_w2_entities_commands_tracking.sql:581-626`).

---

### `entities.commands.gate`
`POST /v2/entities/:id/commands/gate` · kind: command · status: v1 · served: yes
(`handlers/commands.ts:156-183`, factory `commandsGate(deps)`)
CLI: `tm8 task gate <task-id> <none|pr_merged> --expect-version <n> [--mutation-id <id>]`
(`task.ts:289-325`).

Sets a task's completion gate flag. This command only stores the flag — the refusal it enables
lives entirely in `entities.commands.complete`'s `complete_task` RPC.

**Path params** — `id: EntityId`.

**Request body** (`GateTaskInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `expectedVersion` | number | yes | finite | |
| `gate` | `'none'\|'pr_merged'` | yes | | |

Example request: `{ "expectedVersion": 3, "gate": "pr_merged" }`

**Response** — `data: CommandResult`, via `toCommandResult` (no `activity`).

**Errors** — `version_conflict` (409, via `enrichVersionConflict`, `current: EntityDetail`
attached); `invalid_input` (400) `"invalid completion gate: %s"` (should not occur past Zod);
`not_found` (404) if the task doesn't resolve.
**Notes** — idempotent via `clientMutationId`. RPC: `set_task_gate` — version-guarded, ledgered,
writes activity verb `gate_set`, sets `tasks.completion_gate` (DB CHECK constrains to
`none`/`pr_merged`, default `none`).
Source: catalog `catalog.ts:139`; schema `GateTaskInputSchema` `schemas.ts:2611-2615`, type
`contract.ts:2859`; handler `handlers/commands.ts:156-183`; RPC `set_task_gate`
(`db/migrations/082_git_graph_events_provenance_gate.sql:292-329`).

---

### `entities.commands.tick`
`POST /v2/entities/:id/commands/tick` · kind: command · status: v1 · served: yes
(`services/w2/entities-commands-tracking.ts:1740-1786`)
CLI: `tm8 task tick <task-id> <criterion-id>... [--untick] --expect-version <n>
[--mutation-id <id>]` (registered in `task.ts:145-176`; ids come from `tm8 entity context
<task-id>`'s acceptance section).

Sets `done` on named acceptance criteria, **merged by id** into the stored list — never a
whole-array replace. Exists specifically so ticking one criterion does not require reading the
task, restating every other criterion, and re-sending the whole array (measured at 29.5 KB of
`entity get` per agent for that pattern). Writes through the exact same `update_task_content`
RPC and normalizer `entities.patch` uses, so version guard, `doneBy`/`doneAt` stamping and the
activity row are the patch door's own, not a second copy.

**Path params** — `id: EntityId` (must be kind `task`).

**Request body** (`TickCriteriaInput extends CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `actorId` | `EntityId` | no | | |
| `clientMutationId` | string | no | | |
| `workSessionId` | `EntityId` | no | | |
| `expectedVersion` | number | yes | finite | |
| `criterionIds` | string[] | yes | min 1 | ids that must already exist on the task |
| `done` | boolean | no | default `true` | `true` ticks, `false` unticks |

Example request: `{ "expectedVersion": 7, "criterionIds": ["c1", "c2"], "done": true }`

**Response** — `data: CommandResult | ServerReceipt` (receipt op `task.tick`), via the
service's local `commandResult()` — populates `activity`.

**Errors**
- `invalid_input` (400) `"only a task carries acceptance criteria; ${id} is a ${kind}"` — non-task target.
- `invalid_input` (400, `details.reason: 'unknown_criterion'`, `details.unknown: [...]`, `details.known: [...]`) — any `criterionIds` not present on the task; **refused by name, never silently dropped**.
- `version_conflict` (409, via the service's local `withCurrent`, `current: EntityDetail` attached).
- `not_found` (404) if the task doesn't resolve.

**Notes** — idempotent via `clientMutationId`. Ticking a criterion strips any stale
`doneBy`/`doneAt` stamp so the normalizer restamps the acting actor; criteria not named in
`criterionIds` are left untouched.
Source: catalog `catalog.ts:143`; schema `TickCriteriaInputSchema` `schemas.ts:2638-2643`, type
`contract.ts:2867-2871`; handler `services/w2/entities-commands-tracking.ts:1740-1786`.

---

### `entities.feed`
`GET /v2/entities/:id/feed` · kind: read · status: v1 · served: yes
(`services/w2/feed-context.ts:1008-1079`)
CLI: `tm8 entity feed <entity-id> [--scope direct_v1|session_chat_v1] [--order newest|oldest]
[--around <message:id|activity:id>] [--limit n] [--cursor c]` (`entity.ts:442-460`) — note the
CLI's local `enumOption(cmd, 'scope', ['direct_v1', 'session_chat_v1'])` only offers 2 of the 5
server-side scopes as an explicit flag value; `channel_threads_v1`, `thread_v1`, and
`task_discussion_v1` are reachable only via `default` resolution on the matching anchor kind,
not by naming them directly through this CLI surface (`unverified: whether entity.ts accepts
the other 3 scope names verbatim despite the narrower enumOption list — not traced further`).

Returns a versioned-named-scope feed for one anchor entity: messages and/or activity related to
it, per the scope's fixed predicate set. No caller-supplied predicate ever reaches SQL text —
only the closed `scope` enum does.

**Path params** — `id: EntityId` (the anchor).

**Query params** (`EntityFeedQuery`)

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `scope` | `'default'\|FeedScope` | no | `default` → resolved by anchor kind (see shared types table) | |
| `order` | `'newest'\|'oldest'` | no | `newest` | |
| `around` | `` `message:${string}` \| `activity:${string}` `` | no | mutually exclusive with `cursor` | centers the page on one item |
| `cursor` | string | no | fingerprinted on `{entityId, scope, order, predicates}` | |
| `limit` | integer | no | 1–100, default 50 | |

**Response** — `data: EntityFeedPage` (shared type).

| field | type | description |
|---|---|---|
| `resolvedScope` | `FeedScope` | the scope actually used (after `default` resolution) |
| `predicates` | `FeedVia[]` | canonical (deduped+sorted) predicate list this scope expanded to |
| `items` | `FeedItem[]` | discriminated on `itemKind: 'message'\|'activity'` |
| `nextCursor` | string \| null | |
| `previousCursor` | string \| null \| absent | present when `around` was used |

**Errors** — `invalid_input` (400, `details.reason: 'feed_scope_not_applicable'`) — a named
scope that does not apply to this anchor's kind (e.g. `session_chat_v1` on a task);
`invalid_cursor` (400) — cursor fingerprint mismatch, or `around`+`cursor` both given.
**Notes** — no idempotency (read). No RPC calls at all in this handler — pure reads inside
`db.tx`, RLS-scoped.
Source: catalog `catalog.ts:331`; type `EntityFeedQuery`/`EntityFeedPage` `contract.ts:6253-6295`;
schema `EntityFeedQuerySchema` `schemas.ts:3826-3836`; handler `services/w2/feed-context.ts:1008-1079`
(scope registry `:94-186`).

---

### `entities.context`
`GET /v2/entities/:id/context` · kind: read · status: v1 · served: yes
(`services/w2/feed-context.ts:1117-1157`)
CLI: `tm8 entity context <entity-id> [--schema v1|v2] [--sections a,b,c] [--total-bytes n]
[--section-bytes n] [--offset n] [--actions-schema v1|v2] [--cursor c] [--edge-type t]`
(`entity.ts:608-624`, with the schema-selection logic — `contextSchema`/`contextQuery` — at
`entity.ts:493-606`, shared with `tm8 chat show`). The CLI defaults human/agent JSON callers to
v2 (`defaultV2: true`) unless a v1-only flag/section is used (`--section-bytes`, `--sections
activity`) or an explicit `--schema v1` is passed, in which case it prints a note and falls
back to v1 rather than silently dropping the request.

A bounded, byte-budgeted "focus" read: everything a caller plausibly needs about one entity in
one call, capped so a caller can never exceed its own requested budget regardless of how much
exists.

**Path params** — `id: EntityId`.

**Query params** (`EntityContextQuery`, one shape for both DTOs — `schema` picks which section
names and budget knobs are legal)

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `schema` | `'v1'\|'v2'` | no | absent = v1 (rollout not yet flipped at the wire layer; CLI defaults its own callers to v2) | |
| `sections` | comma-joined enum list | no | v1: `summary,hierarchy,connections,messages,activity,actions`; v2: `assignment,summary,hierarchy,blockers,connections,messages,actions` (no `activity`) | |
| `totalBytes` | integer | no | v1: default 16384; v2: default (`V2_DEFAULT_TOTAL_BYTES`) — both bounded 1024–32768 | hard cap on the serialised view |
| `sectionBytes` | integer | no | v1 only, 512–8192, default 4096; **refused** (`invalid_input`, `details.reason: 'section_bytes_not_in_v2'`) if sent with `schema=v2` | |
| `offset` | integer | no | v2 only | UTF-8 byte offset into a paged `assignment` body, taken from a prior response's own `expand`, never computed by the caller |
| `actionsSchema` | `'v1'\|'v2'` | no | | shape of the `actions` section |
| `cursor` | string | no | v2 only | continues exactly one paged v2 section (hierarchy/blockers/connections/messages) |
| `edgeType` | string | no | v2 only, regex `^[a-z][a-z_]{0,63}$` | filters the v2 `connections` section to one edge type, with `sections=connections` alone |

Example request: `GET /v2/entities/<id>/context?schema=v2&sections=summary,blockers`

**Response** — `data: EntityContextResult = EntityContextView | EntityContextV2View`, selected
by `schema`.

`EntityContextView` (v1, `schemaVersion: 'tm8.entity-context.v1'`):

| field | type | description |
|---|---|---|
| `root` | `EntitySummary` | |
| `content` | `{excerpt, source, truncated}` \| absent | |
| `parents` / `children` | `EntitySummary[]` | |
| `edges` | `EdgeView[]` | |
| `messages` | `MessageView[]` | |
| `actions` | `PaletteAction[] \| ActionRows` | shape depends on `actionsSchema` |
| `provenance` | `{operation, fetchedAt, eventSeq}` | |
| `cursors` | `Record<string, Cursor\|null>` | includes `cursors.activity` as the ONLY surface of the `activity` section — see declared gap in shared types |
| `byteSize` | number | |
| `truncated` | boolean | |

`EntityContextV2View` (v2, `schemaVersion: 'tm8.entity-context.v2'`) — always `{id, kind,
title, version, status, asOfSeq, parent?, omitted: [], notLoaded: [], errors: [], budget:
{requested, used}}` plus per-kind optional fields (task: `priority, gate, assignees,
assignment, acceptance, acceptanceWrite, header, blockers, children`; doc: `outline,
outlineTruncated, bodyFetch`; work_session: `teammate, agentTool, model, checkoutBranch,
startedAt, exitedAt, endedKind, endedReason, tasks`; chat: `runtimeState, turnState, turnCount,
lastTurnAt, mode`; project: `projectId`; message: `anchor, parentMessage, attachments`) and, on
request, `connections`/`messages` — see the full field table in Shared Types above.

Example (illustrative, from schema, v2, task):
```json
{
  "data": {
    "schemaVersion": "tm8.entity-context.v2",
    "id": "01a0d337-f756-7999-a1c6-9e4699ddd4e9",
    "kind": "task",
    "title": "Example task",
    "version": 7,
    "status": "in_review",
    "asOfSeq": 12345,
    "acceptance": [ { "id": "c1", "done": true, "text": "..." } ],
    "omitted": [],
    "notLoaded": [ { "section": "messages" } ],
    "errors": [],
    "budget": { "requested": 4096, "used": 512 }
  },
  "requestId": "req_000999"
}
```

**Errors** — `invalid_input` (400, `details.reason: 'section_bytes_not_in_v2'`) —
`sectionBytes` sent with `schema=v2`; `invalid_cursor` (400) — v2 section-cursor mismatch (a
context cursor binds entity, section, edge-type filter and order, and is never an
`entities.children`/`entities.connections` cursor); `not_found` (404);
`context_budget_too_small` (422, `details: {requestedBytes, minimumBytes, core, next?}`) — v2
only, `totalBytes` is smaller than the never-drop core requires even with every droppable
section cut; `next` (when the minimum is still ≤ `V2_MAX_TOTAL_BYTES`) is a ready-to-run retry
command at the minimum viable `totalBytes`.
**Notes** — no idempotency (read). The `actions` section is served by a separate discoverer
(`saved-views-actions.ts`'s `discoverActions`, the same one `actions.list` uses) run in its own
tagged sub-transaction, specifically so the palette and this focus view can never disagree
about what a caller may do.
Source: catalog `catalog.ts:332`; type `EntityContextQuery`/`EntityContextView`/
`EntityContextV2View`/`EntityContextResult` `contract.ts:6297-6574`; schema
`EntityContextQuerySchema` `schemas.ts:3914-3926`; handler `services/w2/feed-context.ts:1117-1157`
(v1 load plan in the same file, v2 delegated to `services/w2/feed-context-v2.ts`).
