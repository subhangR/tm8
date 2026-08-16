# tm8 CLI Grammar Redesign

**Status:** design-only revision 4, 2026-07-26 — Round-4 message/delivery GO and dedicated Interaction Profile authority GO; no review residuals  
**Implementation authority:** none; AM-5 continues to hold  
**API baseline:** 81 catalog operations: 79 v1 and 2 reserved  

> **Normative subordination:** `packages/contract/src/catalog.ts`, its shared DTO/Zod schemas, the FINAL tm8 architecture corpus, `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11, its review ledger, and approved amendment dossiers govern. RULING M stamps the message-first public grammar, while the exact catalog/DTO changes remain dossier-gated. It does not silently reinterpret existing operations.

## 1. Decision being proposed

Retire the current prototype CLI and the inherited Maestro compatibility grammar. Build one graph-native and domain-native CLI:

```text
tm8 <singular-domain-noun> <verb> [arguments] [options]
```

The following vocabulary is rejected from the canonical CLI:

- `report`
- `progress`
- public `prompt` commands (the frozen execution operation is an internal-only delivery seam)
- `whoami`
- ambiguous root verbs such as bare `get`, `list`, `read`, and `status`
- `maestro collab`
- legacy compatibility aliases

The model is:

- state changes are explicit domain commands;
- durable communication is always a message;
- relationships are always edges;
- universal node operations are always entity commands;
- runtime lifecycle and terminal access are session commands;
- a command never hides an unrelated message plus state mutation behind a workflow word.

Thus ongoing work is represented by task state plus messages:

```bash
tm8 task transition task_1 working
tm8 message send --to task_1 "The architecture pass is complete."
tm8 task transition task_1 in_review
tm8 task complete task_1 --expect-version 8 --by teammate_1
```

## 2. Ubiquitous language

| Term | CLI meaning |
|---|---|
| Server | Root tm8 domain reached through one connection |
| `tm8-server` | Runtime hosting one Server |
| Space | Collaboration, membership, graph, and durable-event boundary |
| Workspace | Three-panel UI composition only; never a CLI container |
| Entity | Space-scoped graph node with envelope, typed content, hierarchy, messages, edges, reactions, and activity |
| Edge | Typed, Space-local relationship between two entities |
| Message | Durable communication anchored to an entity |
| Task | Work entity with status, priority, criteria, assignments, completion and awards |
| Channel | Named collaboration entity and message anchor |
| Doc | Versioned document entity |
| File | Graph entity for finalized blob metadata; bytes remain behind authorized grants |
| Collection | Curated or query-backed entity set |
| Graph | Entity/edge query projection, not a second store |
| Placement | Registered semantic relationship transformation used by UI drag/drop |
| Inbox | Durable targeted notification view; not a second message store |
| Saved View | Per-Member or Space-shared stored query/layout configuration |
| Action | Server-computed capability available to the current Member/Teammate in context |
| Kind | Registered core or custom entity discriminator and schema |
| Tracking | Server refresh of pull-request or commit metadata |
| Search | Reserved catalog query; honestly not implemented in Phase 1 |
| Handoff | Server-rendered projection of an entity delivered into a live work session under the frozen v2.10 §5.7 saga |
| Session | A `work_session` entity and its execution lifecycle |
| ProjectResource | Server-local configured execution root, addressed by `project` commands |
| Project projection | Restricted Space-scoped `project` entity, addressed by `entity` and `edge` commands |
| Member | Human Space member; owns personal inbox state and may own Teammates |
| Teammate | `team_member` agent persona with distinct authorship and inbox state; never interchangeable with its owning Member |
| Event | Durable Space-ordered graph change; `WorkspaceEvent` remains the current protocol name until separately amended |
| Presence | Ephemeral observation state that never advances a durable cursor |
| Launch Project | Optional singular ProjectResource selecting immutable initial execution provenance |
| Project association | Writable `in_project` edge from a task or work session to a project projection |
| UI Template | Static, shipped presentation-registry entry for this phase; no CLI/API authoring surface |
| Interaction Profile | Restricted, reusable harness policy selecting a static UI Template version plus prompt, discovery, feed, capture, and composer policy |

Identifier rules:

- `project` commands accept ProjectResource IDs.
- `entity` and `edge` commands accept graph entity IDs.
- `session` means `work_session`, never an authentication session.
- a session's Project set is its live `in_project` edges;
- `launchProjectId` is immutable provenance, not the Project set;
- adding or removing a Project association never changes cwd.

## 3. Grammar conventions

The normative syntax is the complete command list in §4. Commands use either a direct noun/verb path or a noun/subnoun/verb path; root discovery commands are explicit exceptions:

```ebnf
invocation      = "tm8", { global-option }, command, { global-option | command-option } ;
command         = root-command | domain-command ;
root-command    = "help", [ noun, [ verb ] ]
                | "completion", ( "bash" | "zsh" | "fish" ) ;
domain-command  = noun, { subnoun }, verb, { argument } ;
source          = inline-value | "@", path | "-" ;
json-source     = source ;
text-source     = source ;
actor-id        = member-id | team-member-id ;
custom-kind     = "c:", name ;
```

`noun`, `subnoun`, `verb`, and the ordered arguments/options are closed by §4 and generated command metadata; the EBNF does not admit arbitrary paths. `<c:name>` means the literal `c:` namespace followed by the custom-kind name. `<active-profile-id>` is an active Interaction Profile entity ID. `<feed-item-ref>` is the tagged logical identity `message:<id>` or `activity:<id>`. `<space-seq>` is a non-negative per-Space durable event sequence, and `<undo-token>` is the opaque Server-issued token returned by an undoable mutation.

Global options are `--space`, `--as`, `--format human|json|jsonl`, `--timeout`, `--no-color`, and `--quiet`. JSON/text sources accept an inline value, `@<path>`, or `-` for stdin where the individual command permits it. `<actor-id>` is the explicit tagged domain union Member ID | Teammate ID; the Server still validates act-as authority. Mutations use `--mutation-id`; pages use `--limit` plus opaque `--cursor`. Help and completion are root discovery commands listed in §4.16, not domain mutations.

Global context resolution order:

1. explicit `--space` or `--as`;
2. session-injected context;
3. local CLI configuration;
4. the Phase-1 implicit local Server where allowed.

The Server validates all context. `--as` selects an authorized Member or Teammate author and never asserts authorization. Remote Server selection belongs only to the Phase-2 transport delta.

Global options may occur before or after the command path but before a literal `--`. Structured commands may expose `--data <json-source>` as an exact-DTO escape hatch. `--data` is mutually exclusive with operation-specific payload flags; path IDs and global context remain outside it.

Domain enum values use their exact contract spelling, including `in_review`; the CLI does not invent a translated `in-review` value.

## 4. Complete command grammar

### 4.1 Identity

```text
tm8 identity get
```

### 4.2 Spaces

```text
tm8 space list
    [--limit <n>] [--cursor <cursor>]

tm8 space create <name>
    [--description <text-source>]
    [--visibility private|public]
    [--mutation-id <id>]

tm8 space get [<space-id>]

tm8 space update [<space-id>]
    [--name <name>]
    [--description <text-source>]
    [--github-repo <url|none>]
    [--mutation-id <id>]

tm8 space navigation get [<space-id>]
tm8 space home get [<space-id>]
tm8 space settings get [<space-id>]

tm8 space member list [<space-id>]
    [--limit <n>] [--cursor <cursor>]

tm8 space invite list [<space-id>]
    [--limit <n>] [--cursor <cursor>]

tm8 space invite create [<space-id>]
    [--max-uses <n>]
    [--expires-at <iso-time|none>]
    [--mutation-id <id>]

tm8 space invite revoke <invite-id>
    [--space <space-id>] --yes [--mutation-id <id>]

tm8 space invite redeem <code>
    [--mutation-id <id>]

tm8 space task-axis list [<space-id>]

tm8 space task-axis create <name>
    [--space <space-id>]
    --value <value>...
    --kind default|manual
    --position <n>
    [--mutation-id <id>]

tm8 space task-axis update <axis-id>
    [--space <space-id>]
    --name <name>
    --value <value>...
    --kind default|manual
    --position <n>
    [--mutation-id <id>]

tm8 space task-axis delete <axis-id>
    [--space <space-id>] --yes [--mutation-id <id>]

tm8 space leaderboard get [<space-id>]
    [--limit <n>] [--cursor <cursor>]

tm8 space award list [<space-id>]
    [--limit <n>] [--cursor <cursor>]
```

`spaces.githubRepo` is deprecated and should be hidden from ordinary help after the ProjectResource amendment is adopted. It remains available through exact DTO input while frozen.

Proposed v2.11 dossier-family commands:

```text
tm8 space menu get [<space-id>]

tm8 space menu update [<space-id>]
    --expect-revision <n>
    --data <json-source>
    [--mutation-id <id>]

tm8 space default-channel set <channel-id|none>
    [--space <space-id>]
    [--mutation-id <id>]
```

### 4.3 Universal entities

> **[PROPOSED extensions]** Repeatable initial connections and the flat connection-query filters below require §9 amendments; the remaining universal entity rows map to the frozen catalog.

```text
tm8 entity get <entity-id>

tm8 entity create <kind> <title>
    [--space <space-id>]
    [--parent <entity-id|none>]
    [--position <n>]
    [--content <json-source>]
    [--attach-to <entity-id>...]
    [--relate-to <entity-id>...]
    [--connect <edge-type>=<target-entity-id>...]
    [--mutation-id <id>]

tm8 entity update <entity-id>
    --expect-version <n>
    [--title <title>]
    [--content <json-source>]
    [--mutation-id <id>]

tm8 entity move <entity-id>
    --parent <entity-id|none>
    --position <n>
    --expect-version <n>
    [--mutation-id <id>]

tm8 entity delete <entity-id>
    --yes [--mutation-id <id>]

tm8 entity restore <entity-id>
    [--mutation-id <id>]

tm8 entity children <entity-id>
    [--limit <n>] [--cursor <cursor>]

tm8 entity hierarchy <entity-id>
    [--depth <n>]

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

tm8 entity versions <entity-id>
    [--limit <n>] [--cursor <cursor>]

tm8 entity activity <entity-id>
    [--limit <n>] [--cursor <cursor>]

tm8 entity feed <entity-id>
    [--scope direct_v1|session_chat_v1]
    [--order newest|oldest]
    [--around <feed-item-ref>]
    [--limit <n>] [--cursor <cursor>]

tm8 entity react <entity-id> like|dislike|star
    [--off] [--mutation-id <id>]

tm8 entity point grant <entity-id> <amount>
    --reason grant|award|seed
    [--reference <entity-id>]
    [--mutation-id <id>]

tm8 entity pull <entity-id>
    --pinned-version <n>
    [--local-id <id|none>]
    [--mutation-id <id>]
```

Restricted kinds still enforce their owning writers. There is no duplicate `task create`, `doc get`, `session list`, or generic project-projection mutation command.

Hierarchy is homogeneous: a parent and every direct child have the same entity kind and belong to the same Space. Consequently `entity children` has no `--kind` filter; if a different-kind relationship is wanted, it is an edge, not hierarchy.

Initial connection flags are repeatable atomic relationship tuples:

- `--attach-to <id>` is shorthand for `--connect attached_to=<id>`;
- `--relate-to <id>` is shorthand for `--connect relates_to=<id>`;
- `--connect <type>=<id>` is the general registered-edge form;
- shorthands do not bypass endpoint rules: the current `attached_to` source registry excludes `channel` and `message`, while `relates_to` is the universal `* -> *` fallback when no narrower relationship applies;
- duplicate `(type,target)` tuples collapse idempotently;
- every target must exist, be live, be in the same Space, be writable by the actor, and satisfy the edge registry's endpoint/props rules;
- all initial edges are validated before the entity is inserted, and entity plus edges commit all-or-nothing;
- the current singular `CreateEntityInput.attachTo` cannot implement this and requires an additive batch-initial-connections amendment.

`entity connections` is a flat, entity-centered `Page<EdgeView>` query with one cursor over the complete filtered result. Stable sorting appends edge ID as the final tie-breaker, and the opaque cursor is bound to the filter/sort fingerprint. Mutable/non-unique peer titles are not keyset keys, and the Server-owned edge-origin vocabulary is not exposed as a filter until frozen. `updated_at` sorting is amendment-dependent because the database column exists but `EdgeView` does not yet expose `updatedAt`; the same amendment adds an activity write for `edges.patch`. This intentionally replaces the current grouped `Connections` response for this CLI path: its per-group cursors cannot honestly support one `--cursor`. The API must either amend `entities.connections` to this paged shape or add a catalogued connection-query operation; until then the full filter/sort surface is amendment-dependent. The existing grouped structure may remain inside bounded `EntityDetail` as a summary, not as this paged command's DTO.

`entity feed` is a proposed universal `entities.feed` operation returning `Page<FeedItem>`: a Server-side `UNION ALL` of messages and activity for one anchor/entity over their shared `(created_at,id)` keyset. It creates no feed table or bespoke timeline read model. Client-side merging is rejected because two independently paged keyset streams cannot produce one correct cursor. `FeedItem` is a discriminated message-or-activity union, and Activity summaries must themselves be a discriminated union over the closed activity-verb set.

### 4.4 Entity queries and context

> **[PROPOSED]** `entity context` and `entity feed` require shared operations/DTOs. `entity query` maps the frozen collection query.

```text
tm8 entity query
    [--space <space-id>]
    [--kind <kind>...]
    [--subtree <entity-id>]
    [--parent <entity-id|none>]
    [--work-status <status>...]
    [--axis <name>=<value>...]
    [--assignee <actor-id>...]
    [--edge-type <type>
     --edge-direction incoming|outgoing
     --edge-entity <entity-id>]
    [--ready]
    [--in-review-for <actor-id>]
    [--mentioned <actor-id>]
    [--in-flight-for <actor-id>]
    [--needs <actor-id>]
    [--deleted exclude|only|include]
    [--layout list|board|tree|feed|gallery|graph]
    [--group-by workStatus|assignee|axis:<name>]
    [--sort activityAt_desc|createdAt_desc|position|dueDate|priority]
    [--limit <n>] [--cursor <cursor>]

tm8 entity query --data <json-source>
```

A proposed context-efficient read replaces `walk` only after a shared operation and DTO are approved:

```text
tm8 entity context <entity-id>
    [--depth 0|1|2|3]
    [--messages <0..50>]
    [--children <0..200>]
    [--edge-type <type>...]
```

The CLI must not invent a private aggregate JSON shape.

### 4.5 Task transitions

```text
tm8 task transition <task-id>
    open|pulled|working|in_review|blocked|cancelled
    [--mutation-id <id>]

tm8 task complete <task-id>
    --expect-version <n>
    --by <actor-id>...
    [--mutation-id <id>]

tm8 task link-pr <task-id> <url>
    [--project <project-resource-id>]
    [--mutation-id <id>]

tm8 task link-commit <task-id> <url>
    [--project <project-resource-id>]
    [--mutation-id <id>]
```

`complete` remains distinct because it owns completion criteria, completer relationships, awards, activity, and the atomic final transition.

The API enforces the same authority: `entities.commands.work` refuses `status='done'` with `invariant_violation` and `details.reason='use_complete_command'`. Only `entities.commands.complete` may enter `done`, after checking acceptance criteria and recording completers and awards. Transition time is Server-owned and recorded at commit; clients cannot backdate or future-date lifecycle history.

### 4.6 Edges

```text
tm8 edge list
    [--source <entity-id>]
    [--target <entity-id>]
    [--type <edge-type>]
    [--direction incoming|outgoing]
    [--limit <n>] [--cursor <cursor>]

tm8 edge create <source-entity-id> <edge-type> <target-entity-id>
    [--props <json-source>]
    [--mutation-id <id>]

tm8 edge update <edge-id>
    --props <json-source>
    [--mutation-id <id>]

tm8 edge delete <edge-id>
    --yes [--mutation-id <id>]

tm8 edge type list
```

`props.origin` is Server-owned and never accepted from clients.

### 4.7 Messages

> **[PROPOSED extensions]** Atomic multi-anchor send, delivery reads, versioned attachment mutation, and reply wake policy require the session-communication dossier. Singular message storage/read/edit/delete remain frozen.

```text
tm8 message list <anchor-entity-id>
    [--root <message-id>]
    [--order oldest|newest]
    [--limit <n>] [--cursor <cursor>]

tm8 message send --to <anchor-entity-id> [--to <anchor-entity-id>...] [<body>|-]
    [--body <text-source>]
    [--mention <actor-id>...]
    [--attach <file-entity-id>...]
    [--wait stored|settled]
    [--mutation-id <message-batch-id>]

tm8 message reply <message-id> [<body>|-]
    [--body <text-source>]
    [--mention <actor-id>...]
    [--attach <file-entity-id>...]
    [--notify-source inbox|live]
    [--wait stored|settled]
    [--mutation-id <id>]

tm8 message update <message-id> [<body>|-]
    [--body <text-source>]
    [--mention <actor-id>...]
    --expect-version <n>
    [--mutation-id <id>]

tm8 message delete <message-id>
    --expect-version <n>
    --yes [--mutation-id <id>]

tm8 message mark-read <anchor-entity-id>
    --through <message-id>
    [--mutation-id <id>]

tm8 message delivery <message-id>

tm8 message attachment add <message-id> <file-entity-id>...
    --expect-version <n>
    [--mutation-id <id>]

tm8 message attachment remove <message-id> <file-entity-id>...
    --expect-version <n>
    [--mutation-id <id>]
```

Address, body, and batch rules:

- `--to` is repeatable and must contain at least one anchor;
- duplicates collapse before validation while preserving first occurrence order;
- all anchors must be live rows in the same Space and readable/messageable by the author;
- the Server validates the entire anchor set before inserting anything;
- one correlated message row is created per anchor, each with its own message ID; `messageBatchId` equals the command's client-generated `clientMutationId`, and the batch mutation is all-or-nothing for graph persistence;
- replies are never multi-anchor: `message reply` derives the original message's single anchor and supplies it as `parentMessageId`, preserving same-anchor thread invariants;
- positional body and `--body` are mutually exclusive;
- when neither is present and stdin is piped, stdin is the body;
- a TTY with no body is a usage error; no editor opens unexpectedly;
- `--wait` defaults to `stored`; it returns exit 0 after the atomic graph commit and prints `delivery: pending` for unsettled work-session targets;
- `--wait settled` observes each work-session target's terminal delivery outcome and still returns the stored batch plus per-target outcomes; it never changes persistence or retries delivery, and returns exit 11 only when a requested delivery is non-delivered or does not settle before timeout;
- a delivery wait timeout returns the already-stored batch and last observed delivery state rather than implying the message was not created.

Mention and attachment validation is Server-owned:

- CLI inputs contain `mentionIds` and `attachmentIds`; the Server derives mention kind/display and file name/MIME/size/checksum;
- every attached file must be finalized, live, readable to the author and readable from every target anchor's Space context;
- attachment IDs are de-duplicated and checked against frozen count, aggregate-size, MIME, and per-file limits before any message row is written;
- for every message copy, the Server creates `file -> attached_to -> message` edges in the same graph transaction; `MessageView.attachments` is derived from those relationships rather than accepted as client-authored metadata;
- those message-owned edges cannot be created, patched, or deleted through generic edge commands; versioned `message attachment add|remove` is their only mutation surface;
- each target's audience must be a subset of the file's audience, otherwise the Server returns `attachment_audience_widening` (same-Space is only the current v1 reduction of that rule);
- a failure in any anchor, mention, attachment, or `attached_to` edge validation aborts the complete batch;
- `--attach` never means “attach this message to another anchor”; anchors use `--to`, while files use `--attach` and relationships use `attached_to`.

Multi-anchor send requires a catalog amendment (`messages.postMany` or an amended `messages.post` with `anchorIds`) and a shared `MessageBatchResult`; a CLI loop over singular `messages.post` is not atomic and is therefore insufficient.

Entity projection into a session is not a message attachment. It keeps the frozen handoff noun and state machine:

> **[v2.10 DOSSIER]** Handoff commands are approved design surfaces but do not yet have frozen catalog rows/bindings.

```text
tm8 handoff send <work-session-id> --entity <source-entity-id>
    [--expect-source-version <n>]
    [--mutation-id <handoff-id>]

tm8 handoff list <work-session-id>
    [--limit <n>] [--cursor <cursor>]

tm8 handoff withdraw <handoff-id>
    [--reason <text-source>]
    --yes [--mutation-id <id>]
```

`handoff` projects graph context, records the correlated bounded Discussion reference and conditionally creates recorder-owned `shared_into`; it cites v2.10 §5.7 rather than redefining that subsystem.

### 4.8 Graph, placement, undo, and search

```text
tm8 graph query
    [--space <space-id>]
    [--focus <entity-id>]
    [--hops <n>]
    [--edge-type <type>...]
    [--mode free|dependency]
    [entity-query flags...]
    [--limit <n>] [--cursor <cursor>]

tm8 graph query --data <json-source>

tm8 placement apply <source-entity-id>
    attach|assign|depend|subtask|embed|reparent
    <target-entity-id>
    [--mutation-id <id>]

tm8 undo apply <undo-token>
    [--mutation-id <id>]

tm8 search query <text>
    [--space <space-id>]
    [--kind <kind>...]
    [--limit <n>] [--cursor <cursor>]
```

`search query` remains discoverable but returns honest `not_implemented` while reserved.

### 4.9 ProjectResources

```text
tm8 project list
    [--limit <n>] [--cursor <cursor>]

tm8 project get <project-resource-id>

tm8 project create <name>
    --working-dir <absolute-path>
    [--repo-url <url|none>]
    [--trust trusted|untrusted]
    [--default-model <name|none>]
    [--default-agent-tool <name|none>]
    [--default-mode worker|coordinator|coordinated-worker|coordinated-coordinator|none]
    [--mutation-id <id>]

tm8 project update <project-resource-id>
    [--name <name>]
    [--working-dir <absolute-path>]
    [--repo-url <url|none>]
    [--trust trusted|untrusted]
    [--default-model <name|none>]
    [--default-agent-tool <name|none>]
    [--default-mode worker|coordinator|coordinated-worker|coordinated-coordinator|none]
    [--yes]
    [--mutation-id <id>]

tm8 project link <project-resource-id>
    [--space <space-id>]
    [--mutation-id <id>]

tm8 project unlink <project-resource-id>
    [--space <space-id>]
    --yes [--mutation-id <id>]
```

`project link` must expose both identities in its result:

```json
{
  "projectId": "project-resource-id",
  "projectEntityId": "space-projection-entity-id",
  "spaceId": "space-id"
}
```

### 4.10 Files

> **[PROPOSED composition]** Resume orchestration and finalization-with-edges extend the frozen upload-init/chunk/complete/abort operations; no single mutation ID is reused across those rows.

```text
tm8 file upload <path|->
    [--space <space-id>]
    [--name <name>]
    [--mime <mime-type>]
    [--attach-to <entity-id>...]
    [--size <bytes>]
    [--sha256 <lowercase-hex>]
    [--mutation-id <id>]

tm8 file upload resume <upload-id>
    <path|->
    [--mutation-id <id>]

tm8 file upload abort <upload-id>
    --yes [--mutation-id <id>]

tm8 file download <file-entity-id>
    --output <path|->
    [--overwrite]
```

`file upload` is an explicit composition: calculate/accept size and checksum, initialize, transfer bytes, and complete with every requested `file -> attached_to -> anchor` edge validated and created atomically with file finalization. Each catalog mutation receives its own deterministically derived mutation ID; one ID cannot be reused across different operations. Recoverable failures invoke abort automatically, while resume/abort remain explicit for process death and operator recovery.

For stdin uploads, name, MIME, size, and checksum are required unless the CLI safely spools the input before initializing.

### 4.11 Inbox and saved views

```text
tm8 inbox list
    [--for <team-member-id>]
    [--space <space-id>]
    [--unread]
    [--limit <n>] [--cursor <cursor>]

tm8 inbox mark-read <notification-id>
    [--mutation-id <id>]

tm8 saved-view list
    [--space <space-id>]
    [--limit <n>] [--cursor <cursor>]

tm8 saved-view create <name>
    [--space <space-id>]
    --share private|space
    --query <json-source>
    [--graph-layout <json-source>]
    [--mutation-id <id>]

tm8 saved-view update <saved-view-id>
    --expect-version <n>
    --name <name>
    --share private|space
    --query <json-source>
    [--graph-layout <json-source>]
    [--mutation-id <id>]

tm8 saved-view delete <saved-view-id>
    --yes [--mutation-id <id>]
```

`message mark-read` owns an anchor's read cursor; `inbox mark-read` owns notification state.

### 4.12 Actions, events, and presence

```text
tm8 action list [--for <entity-id>]

tm8 event list
    [--space <space-id>]
    [--after <space-seq>]
    [--limit <n>]

tm8 event watch
    [--space <space-id>]
    [--after <space-seq>]
    [--type <event-type>...]
    [--entity <entity-id>...]
    [--anchor <entity-id>...]
    [--presence]

tm8 presence get <entity-id>
```

`event watch` opens the event subscription and repairs reconnect gaps through event polling. Durable output is ordered by `(spaceId, seq)`. Presence and typing signals never advance the durable cursor. JSONL emits one complete event per line.

### 4.13 Work sessions

```text
tm8 session spawn
    [--space <space-id>]
    --teammate <team-member-id>
    [--task <task-id>...]
    [--launch-project <project-resource-id>]
    [--workdir project|worktree|scratch]
    [--base-ref <git-ref>]
    [--mode worker|coordinator|coordinated-worker|coordinated-coordinator]
    [--model <model|none>]
    [--agent-tool <tool|none>]
    [--interaction-profile <active-profile-id>]
    [--title <title>]
    [--context <text-source>]
    [--confirm-untrusted]
    [--mutation-id <id>]

tm8 session terminate <work-session-id>
    [--force]
    --yes [--mutation-id <id>]

tm8 session attach <work-session-id>
    --mode view|drive
    [--grant-only]
    [--mutation-id <id>]
```

Rules:

- `--launch-project` accepts a ProjectResource ID;
- with a launch Project, omitted workdir may default to `project` in the final schema;
- without a launch Project, `scratch` is required;
- `worktree` is discoverable reserved syntax and returns typed `not_implemented`/exit 8 until its implementation gate closes;
- cwd is always Server-computed;
- `--context` is launch-manifest context, not a runtime prompt;
- JSON implies `--grant-only` for attach because interactive terminal bytes are not DTO output;
- session reads and Project associations use universal entity/edge commands;
- in Phase 1, only an authenticated human Member with the Member/admin capability `canOverrideInteractionProfileAtSpawn` may supply `--interaction-profile`; Teammate/agent spawns use the resolved Teammate → Space → core default chain;
- there is no `session prompt`;
- `session terminate` without `--force` requests the provider's governed graceful termination path; `--force` requests immediate hard process termination after the same authorization, confirmation, ledger, and audit checks. It never broadens who may terminate the session.

### 4.14 Tracking and custom kinds

```text
tm8 tracking refresh [<pull-request-or-commit-entity-id>...]
    [--mutation-id <id>]

tm8 kind list [--space <space-id>]

tm8 kind create <c:name>
    [--space <space-id>]
    --schema <json-source>
    [--icon <value|none>]
    [--capabilities <json-source>]
    [--mutation-id <id>]

tm8 kind update <c:name>
    [--space <space-id>]
    [--schema <json-source>]
    [--icon <value|none>]
    [--capabilities <json-source>]
    [--allow-tightening]
    [--yes]
    [--mutation-id <id>]
```

There is deliberately no custom-kind delete command.

### 4.15 Interaction Profiles

> **[PROPOSED, non-template]** Interaction Profile lifecycle/default operations are outside the frozen 81. Static UI Templates have no CLI/API mutation surface.

The top-level family is admitted by the restricted-kind rule: a core kind may receive a named family only when universal create/patch is refused and its invariant-preserving lifecycle cannot fit universal CRUD plus the closed `entities.commands.*` namespace. The family adds writers and preview only; all ordinary profile reads remain `entity get/query/versions`. This rule does not admit aliases such as `task create` or `doc get`.

```text
tm8 interaction-profile propose --data <json-source> [--mutation-id <id>]
tm8 interaction-profile update <id>
    --expect-version <n> --data <json-source> [--mutation-id <id>]
tm8 interaction-profile validate <id>
    --expect-version <n> [--mutation-id <id>]
tm8 interaction-profile preview <id> --version <n>
tm8 interaction-profile activate <id>
    --validated-version <n> --validation-hash <hash> --yes [--mutation-id <id>]
tm8 interaction-profile retire <id> --yes [--mutation-id <id>]

tm8 teammate interaction-profile set-default
    <team-member-id> <interaction-profile-id|none>
    --yes [--mutation-id <id>]

tm8 space interaction-profile set-default
    <interaction-profile-id|none>
    [--space <space-id>] --yes [--mutation-id <id>]
```

There is deliberately no `ui-template` noun: UI Templates are static shipped registry entries in this phase. The Interaction Profile commands are named restricted writers beyond the frozen 81; generic entity mutation refuses the restricted kind. A Teammate may update only a draft it proposed; a human Space owner/admin may update any accessible draft. Teammates may select an already shipped static template version, but cannot author templates or activate configuration. `preview` is a read and deliberately has no mutation ID. Activation, retirement, and persistent defaults require an authenticated human Member with the Space owner/admin capability; an agent token or `--as <team-member-id>` is refused. `--validated-version` selects the exact recorded validated artifact and is not an optimistic guard on the latest draft. Activation binds that version/hash and shows generator provenance plus a structured policy/template diff; first activation shows the complete policy with an explicit no-prior-baseline label.

Retirement refuses while any Teammate or Space default still targets the profile (`profile_default_in_use` with authorized reference IDs); defaults must be cleared/replaced explicitly. Default setters and spawn overrides refuse retired profiles (`profile_retired`). Phase-1 profile validation accepts only `providerCaptureMode='explicit-only'`; other modes are reserved and rejected until the structured-capture gate closes. Trusted prompt/tool policy is closed structured data only, never agent-authored free prose. An agent-generated profile requires a separate human `space interaction-profile set-default` mutation and confirmation after activation; activation cannot set a default. Universal `entity get/query/versions` remain the read grammar. Exact lifecycle and authority are defined in `BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` §11.5-§11.6.

### 4.16 Local discovery

```text
tm8 help
tm8 help <noun>
tm8 help <noun> <verb>
tm8 <command> --help
tm8 help --format json
tm8 completion bash|zsh|fish
```

Static help explains syntax. `action list` reports what the current actor may actually perform in context.

## 5. Work-session messages, replies, and inbox fallback

This section records the user-facing direction. The detailed execution design is split into `SESSION-COMMUNICATION-MODEL.md` and must pass its own decision-level adversarial ledger because it changes the public surface around T-D20/R17.

### 5.1 Public law

- `message send` is the only public communication action for text;
- there is no `session prompt` CLI command;
- a message targeting a `work_session` is always persisted as an ordinary graph message first;
- when that session is live, the Server reserves at most one governed write attempt per delivery ID; ambiguous crashes resolve `unknown` and never claim exactly-once;
- the receiving session responds with `message reply <message-id>`, so responses remain durable messages in the same-anchor thread;
- entity projection uses `handoff`, not message attachments;
- the existing PTY delivery seam may remain an internal Phase-1 adapter until structured per-agent-tool receivers exist; removing its public catalog operation is gated, not assumed.

### 5.2 Graph provenance and participants

The authenticated Member or Teammate authors each message. When a caller is executing inside a work session, the Server records provenance with a Server-owned `authored_from` edge:

```text
message -> authored_from -> source work_session
```

Clients cannot assert `--from`. This replaces the rejected scalar `sourceWorkSessionId` relationship.

A work session may have one or more responsible Teammates through a proposed registered relationship:

```text
team_member -> participates_in -> work_session
```

Spawn creates the first participant edge for `ExecutionSpawnInput.teamMemberId`; additional participants are explicit graph relationships. Removing a participant from a live session uses a work-session-row-locked guard so concurrent removals cannot leave zero participants. Existing sessions receive only a conditional audited backfill from reliable launch/creator facts; the Server never guesses. This is a proposed amendment, not a claim about the current singular spawn schema. Participant membership never changes the running agent persona, launch provenance, permissions, or cwd.

### 5.3 Delivery and fallback

For every work-session anchor, persistence commits before delivery. The distinct plain-message machine is `pending -> dispatching -> delivered|failed_retryable|failed_permanent|unknown`, plus `pending -> expired|cancelled`. Only proof that no byte was written yields `failed_retryable`; retry needs a new ID. `unknown` is terminal and never reinjected. `message delivery` is the one status facade, and every non-delivered state is explicit in human and JSON output.

Delivery records live in an execution-side table and are settled by a narrowly scoped audited execution principal that survives restart. The batch locks deduplicated anchors and files in ascending UUID order, takes no session or ProjectResource locks, and attempts delivery after commit. The complete state, recovery, lock, rendering, retry, and exit-code rules are normative in `SESSION-COMMUNICATION-MODEL.md` revision 4.

### 5.4 One inbox family for humans and agent personas

The existing durable notification family is extended rather than duplicated. The delivered `recipient_member_id NOT NULL` remains the human routing owner; a nullable `recipient_team_member_id` discriminates Teammate-addressed items. `NotificationItem` adds a derived `recipient: ActorSummary`. This is an additive table/DTO extension, not a repointed FK.

```text
member | team_member
```

- a Member sees their personal inbox;
- a Teammate has an independent persona inbox consumed by sessions acting as that Teammate;
- the owning Member may inspect a Teammate inbox only through an explicit ownership/capability rule;
- failed delivery fans out to participant Teammates, their owning Members, the author, and the spawning/owning Member, deduplicated;
- notifications reference the original message ID and anchor; they do not copy the message body into a second communication store;
- opening an inbox item leads to `message reply <message-id>`;
- a reply notifies the original author; source-session live wake is opt-in through `--notify-source live`, defaults to inbox only, and is bounded by an automated-wake breaker.

This freezes `session_delivery_failed` and `message_reply` as the new targeted notification kinds. Exact owner visibility, deduplication key, and read authority require the named API/schema amendments.

The CLI becomes:

```text
tm8 inbox list
    [--for <team-member-id>]
    [--space <space-id>]
    [--unread]
    [--limit <n>] [--cursor <cursor>]

tm8 inbox mark-read <notification-id>
    [--mutation-id <id>]
```

### 5.5 Execution boundary

Phase 1 may implement direct delivery by invoking the existing governed PTY queue internally after message persistence. The delivered bytes are a Server-rendered message envelope with message ID, author, provenance, and explicit untrusted-content delimiters; they are never treated as a shell command. This preserves real coordinator-to-worker operation while structured receiver adapters are absent.

`execution.prompt` has no CLI surface. It remains frozen v1 and exact-lookup discoverable with `exposure='internal'` and `reason='use_message_send'`, but only the audited Server-internal delivery-adapter principal may invoke it after a stored message owns the communication and a delivery reservation owns the one write attempt. Every Member or Teammate caller—including owner/admin, session-scoped bearer, and authorized act-as—receives `forbidden` with `details.reason='use_message_send'` before queue admission and writes zero PTY bytes. Its later removal requires a catalog-version decision; W0 reverses T-D20/R17 only as to the public authoring route.

`session attach --mode drive` is separate interactive terminal ownership, not messaging. Phase 1 grants drive only to the spawning owner through short-lived non-transferable credentials; spawned work-session credentials cannot use drive to contact another session.

### 5.6 Permissions

The carrier uses three independent capabilities. `canMessage(anchor)` authorizes durable authoring on a visible anchor but never runtime contact. `canContactSession(sourceSession,targetSession)` authorizes an optional live delivery attempt after storage and is subject to self-contact refusal plus the universal pair budget. `canHandoffEntity(sourceEntity,targetSession)` authorizes the separately governed entity projection; it implies neither messaging nor live contact. The spawning-owner restriction for terminal drive is a fourth, unrelated grant. Messages and fallback notifications never widen the receiving Member or Teammate's Server permissions.

## 6. Project and multi-project execution rules

```text
tm8 project get <ProjectResourceId>
tm8 entity get <projectProjectionEntityId>
```

These IDs are never called merely “project ID” in help or errors.

Spawn with a launch Project:

```bash
tm8 session spawn \
  --space space_1 \
  --teammate teammate_1 \
  --launch-project project_resource_1 \
  --workdir project
```

This selects the initial execution root, stores immutable `launchProjectId`, and creates exactly one initial writable `in_project` edge. Worktree mode remains reserved/not implemented.

Additional association:

```bash
tm8 edge create session_1 in_project project_projection_2
```

This changes graph context only. It does not change cwd, mount a directory, re-root the process, compute an LCA, or alter launch provenance. A managed multi-root runtime requires a separate execution contract.

Scratch sessions use `<dataDir>/scratch/<sessionId>` and require the untrusted confirmation amendment.

PR/commit Project inference inside a work session:

- exactly one live association: CLI may auto-fill;
- zero associations: `--project` required;
- multiple associations: `--project` required;
- repository-string inference remains forbidden.

## 7. Output and scripting law

### 7.1 Output

- stdout contains requested data;
- stderr contains diagnostics, warnings, retry advice, and request IDs;
- human views are rendered from the same DTOs as JSON;
- IDs required by follow-up commands are never omitted;
- `--format json` emits the exact contract DTO, not a CLI-private shape;
- `--format jsonl` is for long-lived or explicitly paged streams;
- terminal/file bytes never mix with structured output.

Composed commands emit JSON only when their final result is a contract DTO. `file upload` emits the final file result; attach grant-only emits `StreamAttachGrant`; event watch emits one event per JSONL line. `entity context` cannot ship until its shared DTO exists.

### 7.2 Pagination

Paged commands use `--limit` and opaque `--cursor`. The CLI never decodes or edits cursors. Any future all-page mode must preserve contract pages, for example one `Page<T>` per JSONL line, rather than fabricate an aggregate DTO.

### 7.3 stdin and raw bytes

- `-` explicitly means stdin for body, JSON, or upload input;
- `-` means stdout only for file-download output;
- raw bytes and structured output are mutually exclusive;
- diagnostics never use stdout;
- stdin is consumed only when syntax requests it or piped body input is unambiguous.

### 7.4 Idempotency and concurrency

Every mutation accepts `--mutation-id`. If omitted, the CLI generates UUIDv7. A script retries transport uncertainty with the same ID. Entity/message content writes require `--expect-version`; the CLI performs no hidden read-before-write retry.

### 7.5 Destructive confirmation

`--yes` is required for entity/edge/message deletion, Project unlink, invite revoke, task-axis deletion, saved-view deletion, handoff withdrawal, file-upload abort, Interaction Profile activation/retirement/default changes, session termination, Project working-directory relocation, and custom-kind schema tightening. `project update` requires it exactly when `--working-dir` is supplied; `kind update` requires it exactly when `--allow-tightening` is supplied. Non-TTY execution never prompts. JSON does not imply consent. `--force` changes termination behavior and is not confirmation.

Optimistic-concurrency flags are domain-specific rather than aliases: `--expect-version` guards an entity/content version, `--expect-revision` guards a revisioned configuration row, and `--expect-source-version` freezes the source projection version for a handoff. A command exposes only the guard required by its owning DTO.

### 7.6 Exit codes

| Code | Meaning |
|---:|---|
| 0 | success |
| 2 | CLI usage/local validation/invalid input or cursor |
| 3 | unauthenticated |
| 4 | forbidden |
| 5 | not found |
| 6 | version conflict or invariant violation |
| 7 | retryable capacity/upstream/transport failure |
| 8 | not implemented |
| 9 | payload too large |
| 10 | other Server/protocol failure |
| 11 | under `--wait settled` only: message stored, but one or more requested work-session deliveries are incomplete or non-delivered |
| 130 | interrupted |

Machine consumers inspect typed error codes; exit codes remain broad shell categories.

## 8. Mechanical coverage of all 81 catalog operations

| # | Catalog operation | CLI disposition |
|---:|---|---|
| 1 | `identity.get` | `identity get` |
| 2 | `spaces.list` | `space list` |
| 3 | `spaces.create` | `space create` |
| 4 | `spaces.get` | `space get` |
| 5 | `spaces.update` | `space update` |
| 6 | `spaces.navigation` | `space navigation get` |
| 7 | `spaces.home` | `space home get` |
| 8 | `spaces.settings` | `space settings get` |
| 9 | `spaces.members.list` | `space member list` |
| 10 | `spaces.invites.list` | `space invite list` |
| 11 | `spaces.invites.create` | `space invite create` |
| 12 | `spaces.invites.revoke` | `space invite revoke` |
| 13 | `spaces.invites.redeem` | `space invite redeem` |
| 14 | `spaces.taskAxes.list` | `space task-axis list` |
| 15 | `spaces.taskAxes.create` | `space task-axis create` |
| 16 | `spaces.taskAxes.update` | `space task-axis update` |
| 17 | `spaces.taskAxes.delete` | `space task-axis delete` |
| 18 | `spaces.leaderboard` | `space leaderboard get` |
| 19 | `spaces.awards` | `space award list` |
| 20 | `entities.get` | `entity get` |
| 21 | `entities.create` | `entity create` |
| 22 | `entities.patch` | `entity update` |
| 23 | `entities.move` | `entity move` |
| 24 | `entities.delete` | `entity delete` |
| 25 | `entities.restore` | `entity restore` |
| 26 | `entities.children` | `entity children` |
| 27 | `entities.hierarchy` | `entity hierarchy` |
| 28 | `entities.connections` | `entity connections`; proposed flat filter/sort/page amendment replaces current grouped-cursor shape for this CLI read |
| 29 | `entities.versions` | `entity versions` |
| 30 | `entities.activity` | `entity activity` |
| 31 | `entities.react` | `entity react` |
| 32 | `entities.points.add` | `entity point grant` |
| 33 | `entities.commands.complete` | `task complete` |
| 34 | `entities.commands.work` | `task transition` |
| 35 | `entities.commands.pull` | `entity pull` |
| 36 | `entities.commands.linkPr` | `task link-pr` |
| 37 | `entities.commands.linkCommit` | `task link-commit` |
| 38 | `tracking.refresh` | `tracking refresh` |
| 39 | `edges.list` | `edge list` |
| 40 | `edges.create` | `edge create` |
| 41 | `edges.patch` | `edge update` |
| 42 | `edges.delete` | `edge delete` |
| 43 | `edgeTypes.list` | `edge type list` |
| 44 | `messages.list` | `message list` |
| 45 | `messages.post` | singular-target stage of `message send`; atomic multi-anchor form requires the named message-batch amendment |
| 46 | `messages.edit` | `message update` |
| 47 | `messages.delete` | `message delete` |
| 48 | `collections.query` | `entity query` |
| 49 | `graph.query` | `graph query` |
| 50 | `placements.apply` | `placement apply` |
| 51 | `commands.undo` | `undo apply` |
| 52 | `search.query` | `search query`; reserved and honest 501 |
| 53 | `projects.list` | `project list` |
| 54 | `projects.create` | `project create` |
| 55 | `projects.get` | `project get` |
| 56 | `projects.update` | `project update` |
| 57 | `projects.link` | `project link` |
| 58 | `projects.unlink` | `project unlink` |
| 59 | `files.uploadInit` | first stage of `file upload` |
| 60 | `files.uploadComplete` | final stage of `file upload` |
| 61 | `files.uploadAbort` | automatic cleanup and explicit `file upload abort` recovery command |
| 62 | `files.download` | `file download` |
| 63 | `bridge.fetchBlob` | intentionally not exposed; reserved internal Phase-2 bridge operation |
| 64 | `inbox.list` | `inbox list` |
| 65 | `inbox.markRead` | `inbox mark-read` |
| 66 | `readMarks.upsert` | `message mark-read` |
| 67 | `savedViews.list` | `saved-view list` |
| 68 | `savedViews.create` | `saved-view create` |
| 69 | `savedViews.update` | `saved-view update` |
| 70 | `savedViews.delete` | `saved-view delete` |
| 71 | `actions.list` | `action list` |
| 72 | `events.subscribe` | `event watch` |
| 73 | `events.poll` | `event list` and reconnect stage of `event watch` |
| 74 | `presence.get` | `presence get` |
| 75 | `execution.spawn` | `session spawn` |
| 76 | `execution.prompt` | no CLI exposure; exact lookup reports internal-only/`use_message_send`; only the audited Server delivery principal may invoke a pre-reserved stored-message delivery |
| 77 | `execution.terminate` | `session terminate` |
| 78 | `execution.streams.attach` | `session attach` |
| 79 | `entityKinds.list` | `kind list` |
| 80 | `entityKinds.create` | `kind create` |
| 81 | `entityKinds.update` | `kind update` |

Coverage is 81/81. Operation 76 is deliberately retained as v1, is not reserved, and has no public CLI command. Its route stays within the 80 mounted HTTP routes and the 78-registerable-handler ceiling; invocation policy, rather than catalog removal, enforces B1.

`message reply` projects through singular `messages.post` after Server-side parent/anchor derivation. Every other command without a frozen row is accounted for here; none is silently presented as catalogued:

| Proposed/dossier CLI surface | Contract status |
|---|---|
| `space menu get/update`, `space default-channel set` | v2.11 §8/§8.1 dossier family; exact bindings/DTOs required |
| `entity context` | proposed bounded aggregate operation/DTO |
| `entity feed` | proposed universal `entities.feed` + `FeedItem` |
| `message delivery`, `message attachment add/remove` | session-communication dossier operations |
| `handoff send/list/withdraw` | v2.10 §5.7 dossier command/read/withdraw operations |
| `file upload resume` | proposed resumable composition over upload state; no frozen catalog row |
| `event watch --presence` | proposed ephemeral presence subscription/frame; the durable WS row alone does not supply it |
| Interaction Profile lifecycle/default commands | proposed profile operations; static UI Templates add no operation |

Flags that extend a command mapped to a frozen row are accounted for separately:

| Frozen-row command with proposed extension | Required amendment |
|---|---|
| `entity create --connect/--attach-to` | atomic initial edge/attachment validation and creation |
| `task link-pr/link-commit --project` | optional ProjectResource attribution plus correction command |
| `message update/delete --expect-version` | optimistic message mutation contract |
| `message mark-read --through` | explicit read-through message ID |
| `project link` result | ProjectResource ↔ projection mapping DTO |
| `file upload --attach-to` | atomic finalization plus attachment-edge ownership |
| `session spawn --workdir scratch/--confirm-untrusted/--interaction-profile` | scratch/trust and Interaction Profile resolution/pinning dossier |

Together the frozen table and the two amendment tables account for both directions: every frozen catalog row has a CLI disposition, and every proposed command or flag is explicitly marked as amendment-dependent. This is a reviewable accounting claim; generated contract/grammar exhaustiveness remains the implementation gate.

## 9. Required amendments

### 9.1 Message, attachment, and session communication dossier

1. Record the user's public message-first ruling and the W0 disposition of T-D20/R17: no public CLI prompt; the governed PTY adapter remains solely for the audited Server-internal delivery principal.
2. Add atomic multi-anchor message input plus `MessageBatchResult`; keep one message row per singular anchor, set `messageBatchId == clientMutationId`, and enforce the stable-input identity hash plus `message_batch_identity_mismatch`.
3. Add `message reply <id>` semantics with Server-derived same-anchor parenting.
4. Replace client-authored Mention/FileAttachment DTOs with mention IDs and attachment IDs resolved by the Server.
5. Materialize `file -> attached_to -> message` atomically, guard those edges from generic mutation, derive `MessageView.attachments`, and add versioned attachment add/remove commands.
6. Add repeatable atomic initial connections to entity creation.
7. Add immutable Server-owned `authored_from` message→work_session provenance.
8. Add the Teammate participation relationship, a locked last-participant guard, and conditional audited legacy backfill.
9. Retain `notifications.recipient_member_id NOT NULL`, add nullable `recipient_team_member_id`, add `NotificationItem.recipient`, keep separate read state/owner-view authorization, and add Member-personal plus Teammate-specific partial cursor/unread indexes so owner routing cannot leak persona rows into the personal feed.
10. Add frozen `session_delivery_failed` and `message_reply` kinds with the deduplicated participant/owner/author fallback union.
11. Add the execution-side message-delivery table, scoped recovery principal, complete pending/dispatching/outcome machine, and `message delivery` facade without inventing `sessionEpoch`, a second inbox, automatic reinjection, or agent acknowledgment.
12. Define `--wait stored|settled` as observation only, make `stored` default with exit 0 after persistence, render every non-delivered state, return stored state on timeout, and reserve exit 11 for incomplete `--wait settled` delivery.
13. Keep handoff send/list/withdraw subordinate to the complete frozen v2.10 §5.7 model.
14. Keep `execution.prompt` v1 internal-only: every Member/Teammate caller is `forbidden/use_message_send` before queue admission with zero PTY bytes; only the audited delivery principal may use a pre-reserved stored-message attempt. Gate later catalog removal on an explicit version decision.
15. Apply spawning-owner-only, short-lived, non-transferable authorization to terminal drive grants.
16. Add `expectedVersion` to message update and delete.
17. Freeze default-inbox reply routing, explicit bounded `--notify-source live`, self-delivery suppression, and one durable row-locked unordered work-session-pair budget for every Teammate-authored live delivery, including top-level sends and replies. A thread root is never part of the key and cannot reset the allowance.
18. Freeze multi-anchor, attachment, MIME, bytes, request aggregate, and fallback-fan-out limits—including `anchorCount × attachmentCount <= 64`—plus ascending-ID/disjoint lock order.

The detailed proposal and open questions live in `SESSION-COMMUNICATION-MODEL.md` and must be reviewed as a decision-level delta.

### 9.2 Graph and context amendments

19. Replace or supplement grouped `entities.connections` with a flat filtered/sorted `Page<EdgeView>` query whose cursor is bound to its sort/filter fingerprint.
20. Remove the unsupported `entity children --kind`; explicitly preserve homogeneous hierarchy.
21. Promote a bounded shared `EntityContext` operation/DTO to a pre-ship agent-context requirement.
22. Add task acceptance-criterion commands so concurrent criterion updates do not rewrite the whole array.
23. Remove `workStatus` from generic task patching; make `task transition` the ordinary lifecycle writer but refuse `done` in both CLI and `entities.commands.work` with `use_complete_command`, preserving `entities.commands.complete` as the sole completion gate.
24. Add entity-visibility mutation if `Visibility` remains a writable domain concept.
25. Freeze typed inputs and exact output DTOs for every catalog operation currently missing them; type `ActivityItem.summary` as a discriminated union over the closed activity-verb set.
26. Amend message/read-mark input to carry `--through <message-id>`.
27. Add or explicitly rule the missing presence subscription operation/frame.
28. Add universal `entities.feed` returning `Page<FeedItem>` from a Server-side keyset-correct message/activity `UNION ALL`; add no feed table.
29. Add nullable `activity.work_session_id`, `ActivityItem.workSessionId?`, and its query index. This is universal mutation provenance; `authored_from` remains messages-only because message writes produce no activity row.
30. Add `EdgeView.updatedAt` and activity emission for `edges.patch` before exposing `updated_at` sort.

### 9.3 Execution, file, and security amendments

31. Add file upload resume and explicit abort; assign separate mutation identities per composed operation.
32. Add atomic attachment-edge creation during upload finalization.
33. Add `permissionMode` to `ExecutionSpawnInput` and expose its effective posture; remove or adjudicate unconditional Claude bypass.
34. Mark worktree spawn reserved/not implemented until its implementation gate closes.
35. Return ProjectResource-to-projection mapping from `project link` and enforce visibly distinct ID domains.
36. Add the already-ruled PR/commit Project-association correction command to the CLI.
37. Generate CLI schemas/help/completion and the coherence matrix from the shared contract.
38. Preserve the grandfathered `WorkspaceEvent` symbols; no `SpaceEvent` rename is proposed.

### 9.4 Chat-template coherence amendments

39. Keep UI Templates in a static, versioned, typed registry for this phase. Add no `ui_template` entity kind, mutation API, or CLI noun; dynamic/agent-authored templates are deferred.
40. Keep bindings non-authoritative even for static templates. Defer the inverse browser prompt-injection rule as a mandatory gate before any template content, binding, or variable becomes agent-influenced.
41. Carry static template key/version, validated schema version, resolved bindings, Interaction Profile version, and projector version in the immutable session pin. Registry versions cannot disappear while referenced by a live pin; removal requires an audited pin migration, and unresolved historical pins fall back visibly without erasing the failed key/version.
42. Admit `interaction_profile` as a restricted core entity that selects one static template key/version and owns prompt, tool-discovery, feed, provider-capture, and composer/interaction policies. `providerCaptureMode` is fixed to `explicit-only` in Phase 1; other modes are reserved and profile validation rejects them until the structured-capture gate closes. Use guarded `team_member --defaults_to_profile--> interaction_profile` as the future-spawn default and Server-materialized immutable `work_session --selected_profile--> interaction_profile` as a projection of `work_session_interaction_pins`, the sole runtime authority. `pulled` and `equips` are explicitly not reused. Add a typed Space default, optional active-profile spawn override, and the profile propose/update/validate/preview/activate/retire/default catalog operations. The manifest receives only the agent-facing profile projection; the browser receives only the presentation/feed/composer projection. Neither consumer sees the other's policy. A changed session selection creates a new pin revision and rematerializes `selected_profile`; public edge repair never changes runtime truth.

### 9.5 Existing v2.10 handoff/Project dossier remains authoritative

- Project projection kind and stable mapping.
- `launchProjectId` read exposure.
- Scratch workdir variant and `confirmUntrusted`.
- Project-locked `in_project` validation and union unlink guard.
- PR/commit optional `projectId` and correction command.
- Share-into-session handoff history and withdrawal.
- MenuConfig read/write/event and persisted default channel.
- ProjectResource `linkFrozen` and `activeLinkCount`.

There is no `tm8 push`. Git push is not a graph operation. A governed product operation would require a separately reviewed `vcs.*` family.

## 10. Required conformance cases added by this redesign

1. `message send --wait stored` to a live session commits, prints `delivery: pending`, and exits 0; a transport retry with the same mutation ID replays one stored batch.
2. `message send --wait settled` with one non-delivered target prints every stored message/outcome and exits 11 without retrying or deleting persistence.
3. `entities.commands.work(status='done')` returns `invariant_violation/use_complete_command` and creates no status, completion, relationship, activity, or award change.
4. `task complete` with incomplete criteria refuses atomically; with satisfied criteria it alone writes `done`, completer relationships, activity and awards.
5. A 16-anchor × 16-attachment batch is refused by the 64-edge product bound before any row; a product of exactly 64 succeeds when all other limits pass.
6. Two concurrent reservations for the same `(message,target,attempt)` produce one durable delivery identity; concurrent claim/settle calls serialize on that row.
7. Generic edge mutation refuses message-owned attachments and materialized `selected_profile`; their guarded owner/repair commands remain functional.
8. Member-personal inbox queries exclude Teammate-recipient rows owned by that Member; owner-inspection and Teammate feeds retain independent read state.

## 11. Review questions

The reviewer must evaluate both the CLI in isolation and CLI plus API as one architecture:

1. Is singular noun-first grammar regular and discoverable?
2. Are any nouns or verbs outside the ubiquitous language?
3. Does every one of the 81 catalog operations have an honest disposition?
4. Are any commands overly nested, duplicative, ambiguous, or procedural?
5. Does `message send --to <anchor>` fully replace user-facing prompt/report concepts?
6. Is the delivery model safe and implementable for real agent tools without unsafe PTY injection?
7. Does it preserve durable graph truth without confusing persistence with delivery?
8. Are ProjectResource and project-projection identifiers impossible to confuse?
9. Are multi-project session semantics coherent and free of hidden cwd changes?
10. Are JSON, streaming, idempotency, concurrency, error, and confirmation laws composable?
11. Which proposed commands lack sufficient API support or misuse current DTOs?
12. Which amendments are unnecessary, missing, or incorrectly scoped?
13. Does the combined API+CLI architecture remain one contract with projections rather than parallel semantics?
14. What prevents this design from reaching 10/10?

The requested output is severity-ordered findings with blockers/majors/minors, an 81-row coverage verification, a CLI-only score, a combined CLI+API score, and exact recommended corrections. No implementation work is authorized.
