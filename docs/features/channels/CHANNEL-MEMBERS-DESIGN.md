# Channel members

**Status:** designed, not built. Deferred from task `019fd744` item 4 by user
ruling 2026-08-07 ("for now ignore this, but create a design doc and tm8 task
for this to pick up later").

> "Channel has members. Should be able to add members while creating or
> updating a channel." — task `019fd744`, item 4

## The finding: there is no membership anywhere

This is not "the UI does not show members yet". There is nothing to show.

- **No edge type.** `public.edge_types` (001_core_graph.sql:900, plus the later
  inserts in 015/056/057/064/065/066) registers no member→channel membership
  relation. `member_of` exists and is `team_member → team_member`
  ("Secondary team affiliation", 001:922) — a different concept entirely.
- **No column, no join table.** `public.channels` is
  `(entity_id, space_id, name, topic, created_at, updated_at)` and nothing else
  (001:500).
- **No contract projection.** `ChannelDetail`'s content arm is
  `{ kind: 'channel'; topic: string; pinned: EntitySummary[]; autoTabs: ChannelTab[] }`
  (contract.ts:282) and its summary arm is
  `{ topic, unreadCount, workingAgentCount }` (contract.ts:109). No roster in
  either.

The nearest existing thing is `pulled` (`member|team_member → channel`, "Local
projection/adoption", 001:903). **It is not membership** and should not be
overloaded into it: `pulled` already means something in the UI, and a term
carrying two meanings is how the next reader gets it wrong.

## Design

### 1. Schema — a new edge type

A migration registering the relation, in the idiom 057/065/066 already use:

```sql
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema)
values (
  'member_of_channel',
  array['member','team_member'],
  array['channel'],
  'Channel membership; props {role, joinedAt}. A teammate is a member like a human.',
  false,
  '{"type":"object","properties":{"role":{"enum":["owner","member"]}}}'::jsonb
);
```

Notes that are decisions, not detail:

- **`team_member` is a legal source.** Agents belong to channels the way people
  do — the channel's `workingAgentCount` badge already assumes agents are
  present in a channel, and a membership model that only admitted humans would
  contradict a badge that ships today.
- **NOT acyclic, NOT unique-by-constraint at the edge level.** Use a partial
  unique index on `(src_id, dst_id)` where `type = 'member_of_channel'` so a
  double-add is a no-op rather than two rows.
- **`role` in props, not a second edge type.** Owner-vs-member is an attribute
  of one relation. Two edge types would make "is X in this channel?" a union.

### 2. Server

- `create_channel` gains nothing. Initial membership rides on
  `CreateEntityInput.connections` — `InitialConnectionInput { type, targetId, props }`
  already exists (contract.ts:981) and is created **in the same transaction as
  the entity**. That is what makes "add members while creating" atomic rather
  than a create followed by N edge writes that can half-fail.
- Add/remove after the fact is `edges.create` / `edges.delete`, which are
  already in the seam (`seam.ts:414`). **No new command is needed** for the
  update path.
- `ChannelDetail` grows `members: ActorSummary[]`, projected from the edge the
  same way `state.assignees` is projected from `assigned_to` — a projection,
  never an array the client PUTs.

### 3. UI

Almost nothing new, and that is the point of the shape shipped in this ticket:

- The channel's registry `editFields` grows one entry with a new `target`
  (`'connections'`) or a dedicated `EditFieldSpec.kind: 'actors'`. The dialog
  already renders "whatever the kind declared".
- The roster renders in `HubBody` beside `pinned`, from the new `members`
  projection.
- Create-with-members needs `useNewTask` to pass `connections` through
  `newEntityInput` — one optional parameter, exactly like the `parentId` this
  ticket added for subchannels.

### 4. Visibility is NOT part of this

Membership is a roster, not an ACL. `restricted` visibility on this node means
invisible to everyone (it is not an access-control list), so wiring membership
to visibility would be a much larger change with a security surface. Members
answer "who is in this channel"; they must not silently become "who can read
it" without a separate, explicit ruling.

## Acceptance criteria

1. A migration registers `member_of_channel` and it survives the edge guard
   (`internal.validate_edge`) for both `member` and `team_member` sources.
2. `entities.create` with `connections: [{ type: 'member_of_channel', targetId }]`
   creates the channel and the membership in ONE transaction; a refused edge
   rolls back the channel.
3. `ChannelDetail.members` returns the roster, and a member removed through
   `edges.delete` disappears from it.
4. The edit dialog adds and removes members on an existing channel.
5. A double-add is idempotent, proven by a real-DB test — `FakeDb` unit tests
   cannot see plpgsql-level constraints.
6. `docs/features/channels/README.md` item 4 moves from Deferred to Shipped.

## Deployment note

This is a server change. `tm8-staging-ui.service` is vite dev on source so a UI
change ships with a `git checkout`, but the server half needs
`systemctl restart tm8-staging.service`, which requires a human — the `tm8` user
has no passwordless sudo.
