-- =============================================================================
-- 003 read model — activity, read marks, TARGETED notifications, a
--                  transport-agnostic outbox, the durable event log with a
--                  per-space monotonic sequence, and saved views.
--
-- Three deliberate departures from the legacy branch, each fixing an audited
-- defect (01 §4):
--   * notifications are TARGETED (mention / assignment / award / unblock /
--     invite / approval), not broadcast to every member. The old all-members
--     fan-out turned one update into 1 activity + N notifications + N events.
--   * the outbox is alive but TRANSPORT-AGNOSTIC (T-D20): it has a `channel`
--     column and no chosen transport. It ships empty, not dead.
--   * `workspace_events` carries the AM-2 §3 envelope, and its `seq` is a
--     per-space MONOTONIC counter — the client's dedupe key, ordering key, and
--     the `events.poll` cursor. Not a timestamp, not a uuid.
-- =============================================================================
set role tm8_graph_owner;

-- The originating command id, threaded onto every event derived from a ledgered
-- mutation (DEV-9). RPCs bind it once on entry; triggers read it here.
create or replace function internal.claim_cmid() returns text
language sql stable as $$ select internal.claim_text('tm8.client_mutation_id') $$;

-- -----------------------------------------------------------------------------
-- 1. Activity — the shared feed. Closed verb set (01 §S3).
--
-- `message.created` deliberately writes NO activity row: a thread is its own
-- record, and mentions notify directly.
-- -----------------------------------------------------------------------------
create table public.activity (
  id         uuid primary key default internal.new_id(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  entity_id  uuid references public.entities(id) on delete set null,
  actor_id   uuid references public.entities(id) on delete set null,
  verb       text not null check (verb in (
                'created','updated','moved','deleted','restored','linked','unlinked',
                'reacted','awarded','completed','joined','pulled','work.changed',
                'pr.linked','unblocked')),
  ref_id     uuid,
  summary    jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);
-- The `id` tiebreaker the audit flagged as missing: keyset paging needs it.
create index activity_space_created_idx on public.activity(space_id, created_at desc, id desc);
create index activity_entity_created_idx on public.activity(entity_id, created_at desc, id desc);

create or replace function internal.record_activity(
  p_space uuid, p_entity uuid, p_actor uuid, p_verb text,
  p_ref uuid default null, p_summary jsonb default '{}'::jsonb
) returns uuid language sql set search_path = public, internal, pg_temp as $$
  insert into public.activity(space_id, entity_id, actor_id, verb, ref_id, summary)
  values (p_space, p_entity, p_actor, p_verb, p_ref, coalesce(p_summary, '{}'::jsonb))
  returning id
$$;

-- -----------------------------------------------------------------------------
-- 2. Read marks.
-- -----------------------------------------------------------------------------
create table public.read_marks (
  member_id    uuid not null references public.members(entity_id) on delete cascade,
  anchor_id    uuid not null references public.entities(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (member_id, anchor_id)
);
create index read_marks_anchor_idx on public.read_marks(anchor_id);

-- -----------------------------------------------------------------------------
-- 3. Notifications — the durable inbox, targeted.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id                  uuid primary key default internal.new_id(),
  space_id            uuid not null references public.spaces(id) on delete cascade,
  recipient_member_id uuid not null references public.members(entity_id) on delete cascade,
  activity_id         uuid references public.activity(id) on delete set null,
  target_entity_id    uuid references public.entities(id) on delete set null,
  actor_id            uuid references public.entities(id) on delete set null,
  -- Open by contract (NotificationItem.kind widens to string): mention,
  -- assignment, award, unblock, review_request, approval_request, invite, join, stale.
  kind                text not null,
  payload             jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  read_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index notifications_recipient_cursor_idx
  on public.notifications(recipient_member_id, created_at desc, id desc);
create index notifications_unread_idx
  on public.notifications(recipient_member_id) where read_at is null;

-- Transport-agnostic dispatch queue (T-D20). No transport is chosen here: a
-- future worker claims rows `for update skip locked` per `channel`. Alive from
-- day one (policies + writer path exist) but empty until a transport lands —
-- which is the opposite of the legacy branch's dead table.
create table public.notification_outbox (
  id              uuid primary key default internal.new_id(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel         text not null,
  payload         jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  attempts        integer not null default 0,
  last_error      text,
  claimed_at      timestamptz,
  processed_at    timestamptz,
  dead_lettered_at timestamptz,
  created_at      timestamptz not null default now()
);
create index notification_outbox_pending_idx on public.notification_outbox(created_at)
  where processed_at is null and dead_lettered_at is null;

-- A notification always lands on a MEMBER's inbox. An agent persona has no inbox
-- of its own — its work surfaces to the human who owns it.
create or replace function internal.recipient_member(actor uuid) returns uuid
language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select m.entity_id from public.members m where m.entity_id = actor),
    (select tm.owner_member_id from public.team_members tm where tm.entity_id = actor)
  )
$$;

create or replace function internal.notify(
  p_space uuid, p_recipient uuid, p_kind text,
  p_target uuid default null, p_actor uuid default null,
  p_payload jsonb default '{}'::jsonb, p_activity uuid default null
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare notification_id uuid;
begin
  -- Never notify an actor about their own action, and never notify a non-member.
  if p_recipient is null
     or p_recipient = internal.recipient_member(p_actor)
     or not exists (select 1 from public.members m where m.entity_id = p_recipient and m.space_id = p_space) then
    return null;
  end if;
  insert into public.notifications(space_id, recipient_member_id, activity_id, target_entity_id, actor_id, kind, payload)
  values (p_space, p_recipient, p_activity, p_target, p_actor, p_kind, coalesce(p_payload, '{}'::jsonb))
  returning id into notification_id;
  return notification_id;
end
$$;

-- Mentions (from the message's own `mentions` array) — the canonical example of
-- targeting: the people named, and nobody else.
create or replace function internal.fan_out_message_mentions() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  space uuid;
  mention jsonb;
begin
  select space_id into space from public.entities where id = new.entity_id;
  for mention in select jsonb_array_elements(new.mentions) loop
    perform internal.notify(
      space,
      internal.recipient_member((mention ->> 'entityId')::uuid),
      'mention',
      new.anchor_id,
      new.author_id,
      jsonb_build_object('messageId', new.entity_id, 'anchorId', new.anchor_id,
                         'excerpt', left(new.body, 280))
    );
  end loop;
  return new;
exception when invalid_text_representation then
  -- A malformed mention must not fail the message write; the body is the truth.
  return new;
end
$$;
create trigger messages_fan_out_mentions after insert on public.messages
for each row execute function internal.fan_out_message_mentions();

-- Assignment and approval requests are edge writes, so the edge is the trigger.
create or replace function internal.fan_out_edge_notification() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare kind text;
begin
  kind := case new.type
            when 'assigned_to' then 'assignment'
            when 'approval_requested_from' then 'approval_request'
            else null
          end;
  if kind is null then
    return new;
  end if;
  perform internal.notify(new.space_id, internal.recipient_member(new.dst_id), kind,
                          new.src_id, new.created_by, jsonb_build_object('edgeType', new.type));
  return new;
end
$$;
create trigger edges_fan_out_notification after insert on public.edges
for each row execute function internal.fan_out_edge_notification();

-- -----------------------------------------------------------------------------
-- 4. Dependency resolution and the unblock signal (01 §5.2).
-- -----------------------------------------------------------------------------
create or replace function internal.is_resolved(target uuid) returns boolean
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; resolved boolean;
begin
  select * into e from public.entities where id = target;
  if e.id is null or e.deleted_at is not null then
    return false;
  end if;
  case e.kind
    when 'task' then
      select t.work_status = 'done' into resolved from public.tasks t where t.entity_id = target;
    when 'pull_request' then
      select p.state = 'merged' into resolved from public.pull_requests p where p.entity_id = target;
    else
      -- doc/spell/skill/file/commit: existing and not deleted IS resolved.
      resolved := true;
  end case;
  return coalesce(resolved, false);
end
$$;

-- When a dependency target resolves, everything waiting on it hard becomes
-- unblocked: one activity row per waiter, targeted at that waiter.
create or replace function internal.announce_unblocked(target uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare
  waiter record;
  space uuid;
  announced integer := 0;
  activity_id uuid;
begin
  if not internal.is_resolved(target) then
    return 0;
  end if;
  select space_id into space from public.entities where id = target;
  for waiter in
    select e.src_id as waiting_id
      from public.edges e
     where e.dst_id = target
       and e.type = 'depends_on'
       and coalesce((e.props ->> 'hard')::boolean, true)
  loop
    -- Still blocked by something else? Then it is not unblocked yet.
    if not exists (
      select 1 from public.edges e2
       where e2.src_id = waiter.waiting_id
         and e2.type = 'depends_on'
         and coalesce((e2.props ->> 'hard')::boolean, true)
         and not internal.is_resolved(e2.dst_id)
    ) then
      activity_id := internal.record_activity(space, waiter.waiting_id, internal.actor_id(), 'unblocked',
                       target, jsonb_build_object('resolvedId', target));
      announced := announced + 1;
      -- Whoever is assigned to / working on the waiter wants to know.
      perform internal.notify(space, internal.recipient_member(e.dst_id), 'unblock',
                              waiter.waiting_id, internal.actor_id(),
                              jsonb_build_object('resolvedId', target), activity_id)
        from public.edges e
       where e.src_id = waiter.waiting_id and e.type in ('assigned_to');
    end if;
  end loop;
  return announced;
end
$$;

create or replace function internal.on_resolution_change() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.announce_unblocked(new.entity_id);
  return new;
end
$$;
create trigger tasks_announce_unblocked after update of work_status on public.tasks
for each row when (new.work_status = 'done' and old.work_status <> 'done')
execute function internal.on_resolution_change();
create trigger pull_requests_announce_unblocked after update of state on public.pull_requests
for each row when (new.state = 'merged' and old.state <> 'merged')
execute function internal.on_resolution_change();

-- -----------------------------------------------------------------------------
-- 5. The durable event log (AM-2 §3).
--
-- `seq` is per-space and MONOTONIC, assigned from a counter row. That makes it a
-- real cursor: `where space_id = $1 and seq > $2 order by seq` is exact, cheap,
-- and immune to clock skew and to uuid generation races.
--
-- `recipient_member_id` splits the two feeds: NULL = the space feed everyone in
-- the space receives; set = one member's personal feed (notifications). This is
-- what kills the write amplification the audit found — a notification no longer
-- puts a row on the space feed for every member.
-- -----------------------------------------------------------------------------
create table public.space_event_seq (
  space_id uuid primary key references public.spaces(id) on delete cascade,
  last_seq bigint not null default 0
);

create or replace function internal.next_event_seq(target_space uuid) returns bigint
language sql set search_path = public, internal, pg_temp as $$
  insert into public.space_event_seq(space_id, last_seq) values (target_space, 1)
  on conflict (space_id) do update set last_seq = space_event_seq.last_seq + 1
  returning last_seq
$$;

create table public.workspace_events (
  id                  uuid primary key default internal.new_id(),
  space_id            uuid not null references public.spaces(id) on delete cascade,
  seq                 bigint not null,
  event_type          text not null,
  payload             jsonb not null,
  -- AM-2 §3 envelope: cmid on every event derived from a ledgered mutation.
  client_mutation_id  text,
  recipient_member_id uuid references public.members(entity_id) on delete cascade,
  occurred_at         timestamptz not null default now(),
  schema_version      integer not null default 1,
  unique (space_id, seq)
);
create index workspace_events_space_seq_idx on public.workspace_events(space_id, seq);
create index workspace_events_recipient_idx on public.workspace_events(recipient_member_id, seq)
  where recipient_member_id is not null;
create index workspace_events_prune_idx on public.workspace_events(occurred_at);

comment on column public.workspace_events.seq is
  'Per-space monotonic sequence. THE poll cursor and client dedupe/order key '
  '(AM-2 §3). Assigned by internal.next_event_seq from space_event_seq.';

-- One capture trigger for the whole log. It emits raw row payloads; the server''s
-- event mapper re-projects them into contract WorkspaceEvents (L3: derived truth
-- is assembled in exactly one place, and that place is not a trigger).
create or replace function internal.capture_workspace_event() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  deleting boolean := tg_op = 'DELETE';
  row_value jsonb;
  space uuid;
  event_name text;
  recipient uuid;
  target uuid;
begin
  -- NEW and OLD are only assigned for their own operations, so every field read
  -- happens inside a branch that knows which one exists. (Touching new.<field>
  -- in a DELETE trigger is an error, not a NULL.)
  if deleting then row_value := to_jsonb(old); else row_value := to_jsonb(new); end if;

  if tg_table_name = 'entities' then
    if deleting then
      space := old.space_id;
      event_name := 'entity.deleted';
    else
      space := new.space_id;
      event_name := case when new.deleted_at is not null then 'entity.deleted' else 'entity.upsert' end;
    end if;
  elsif tg_table_name = 'edges' then
    if deleting then
      space := old.space_id;
      event_name := 'edge.deleted';
    else
      space := new.space_id;
      event_name := 'edge.upsert';
    end if;
  elsif tg_table_name = 'messages' then
    if deleting then
      target := old.entity_id;
      event_name := 'message.deleted';
    else
      target := new.entity_id;
      event_name := case when tg_op = 'INSERT' then 'message.created' else 'message.updated' end;
    end if;
    select space_id into space from public.entities where id = target;
  elsif tg_table_name = 'entity_counters' then
    if deleting then target := old.entity_id; else target := new.entity_id; end if;
    select space_id into space from public.entities where id = target;
    event_name := 'counter.changed';
  elsif tg_table_name = 'activity' then
    space := new.space_id;
    event_name := 'activity.created';
  elsif tg_table_name = 'notifications' then
    space := new.space_id;
    recipient := new.recipient_member_id;
    event_name := case when tg_op = 'INSERT' then 'notification.created' else 'notification.read' end;
  else
    if deleting then return old; end if;
    return new;
  end if;

  if space is not null then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id, recipient_member_id)
    values (space, internal.next_event_seq(space), event_name, row_value, internal.claim_cmid(), recipient);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger entities_capture_event after insert or update or delete on public.entities
for each row execute function internal.capture_workspace_event();
create trigger edges_capture_event after insert or update or delete on public.edges
for each row execute function internal.capture_workspace_event();
create trigger messages_capture_event after insert or update or delete on public.messages
for each row execute function internal.capture_workspace_event();
-- Counters: UPDATE only. Every entity gets a counter row at creation, and an
-- `entity.upsert` already tells the client that; a zeroed counter event would be
-- pure noise on the socket.
create trigger counters_capture_event after update on public.entity_counters
for each row execute function internal.capture_workspace_event();
create trigger activity_capture_event after insert on public.activity
for each row execute function internal.capture_workspace_event();
create trigger notifications_capture_event after insert or update of read_at on public.notifications
for each row execute function internal.capture_workspace_event();

-- Retention (01 §10): 7 days. The reconnect window is minutes; the rest is
-- debugging headroom.
create or replace function internal.prune_workspace_events(retain interval default interval '7 days')
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  delete from public.workspace_events where occurred_at < now() - retain;
  get diagnostics removed = row_count;
  return removed;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Saved views (01 §S6) — a lens on the graph, deliberately NOT an entity.
-- -----------------------------------------------------------------------------
create table public.saved_views (
  id              uuid primary key default internal.new_id(),
  space_id        uuid not null references public.spaces(id) on delete cascade,
  owner_member_id uuid not null references public.members(entity_id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  share_mode      text not null default 'private' check (share_mode in ('private','space')),
  query           jsonb not null check (jsonb_typeof(query) = 'object'),
  graph_layout    jsonb check (graph_layout is null or jsonb_typeof(graph_layout) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index saved_views_space_owner_idx on public.saved_views(space_id, owner_member_id, created_at desc, id desc);
create trigger saved_views_touch_updated_at before update on public.saved_views
for each row execute function internal.touch_updated_at();

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
