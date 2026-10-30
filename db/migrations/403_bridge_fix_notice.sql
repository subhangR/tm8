-- =============================================================================
-- 403 — Bridges F: the fix notice (D24, D70-D72). (Provisional number; the
-- bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- D24, D27, D29, D30, D31 and this file's D70-D72; build step F in §7.2,
-- acceptance F in §7.3. Task 01a189d7-8ba7. Builds on 398 (B1b-2: the outbox,
-- message_origins, bridge_signed) and 399 (B1b-3: the provenance recorder,
-- session_bridge_origins, bridge_stamp), and reads 391's labels (B0b).
--
-- WHAT THIS FILE DOES
--   §1  the origins of a task are its 399 provenance: every origins[] item on
--       its authored_from -> bridge edges (one edge per group, D31). No new
--       edge type (D71).
--   §2  a REPORT is a task a chat turn answering a bridged message created
--       (the chat holds turn-scoped origins), or a task labelled `bug` that
--       carries bridge origins. A report is armed: a born one gets the
--       pr_merged gate on its insert (no version moves), and a re-report
--       (below) arms an existing one that is not done.
--   §3  a RE-REPORT: a chat turn answering a message in another group posts on
--       the report (`tm8 message send --to <task>`). 399 already stamps that
--       message with the turn's origins; here they are stamped onto the task
--       through the same bridge_stamp, so the task gains that group's edge.
--   §4  the notice, one per (task, bridge, providerMessageId) with a durable
--       marker: a thread reply under the original report on the bridge's log,
--       authored and signed by the bridge's teammate, through 398's outbox.
--   §5  when it fires (D70): the merge event, with the gate's own predicate
--       re-evaluated then (>= 1 tracked PR, all merged, none CI-red), on a PR's
--       state or ci_status change, on a tracks edge, and on a new origin. And
--       (D72) a report entering the done category without that predicate
--       says what was done: the newest person or teammate message on it.
--
-- EVENT-DRIVEN. Every entry point is a deferred constraint trigger, so it runs
-- at the commit of the write that caused it (the tracking worker's PR facts,
-- link-pr, a status move) and costs nothing when nothing happens. A notice
-- never fails that write: a refusal is caught and logged as a warning.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. A task's origins: the providerMessageId-keyed items of its
--     authored_from -> bridge edges, one row per (bridge, providerMessageId).
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_task_origins(p_task uuid)
returns table (bridge_id uuid, message_id uuid, provider_message_id text)
language sql stable set search_path = public, internal, pg_temp as $$
  select distinct on (ed.dst_id, o.value ->> 'providerMessageId')
         ed.dst_id, nullif(o.value ->> 'messageId', '')::uuid, o.value ->> 'providerMessageId'
    from public.edges ed
    join public.entities be on be.id = ed.dst_id and be.kind = 'bridge'
    cross join lateral jsonb_array_elements(coalesce(ed.props -> 'origins', '[]'::jsonb)) with ordinality o
   where ed.src_id = p_task and ed.type = 'authored_from' and ed.props ? 'bridgeId'
     and nullif(o.value ->> 'providerMessageId', '') is not null
   order by ed.dst_id, o.value ->> 'providerMessageId', o.ordinality
$$;
revoke all on function internal.bridge_task_origins(uuid) from public;

-- -----------------------------------------------------------------------------
-- §2. Reports.
-- -----------------------------------------------------------------------------
create table public.bridge_fix_reports (
  task_id   uuid primary key references public.tasks(entity_id) on delete cascade,
  -- 'chat': born in a chat turn answering a bridged message; 'label': a task
  -- labelled bug that carries bridge origins; 're_report': stamped from a group.
  via       text not null check (via in ('chat', 'label', 're_report')),
  armed_at  timestamptz not null default now()
);
alter table public.bridge_fix_reports enable row level security;
create policy bridge_fix_reports_select on public.bridge_fix_reports for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_fix_reports.task_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_fix_reports to tm8_app;

-- The holder of the caller's origins when it is a chat with a live turn's
-- origins: "a task created from a group report" (D24, D71).
create or replace function internal.bridge_reporting_chat(p_space uuid)
returns uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare holder uuid := internal.bridge_caller_holder(p_space);
begin
  if holder is null then return null; end if;
  if not exists (select 1 from public.entities where id = holder and kind = 'chat') then return null; end if;
  if not exists (select 1 from public.session_bridge_origins where holder_id = holder) then return null; end if;
  return holder;
end
$$;
revoke all on function internal.bridge_reporting_chat(uuid) from public;

-- Is the task labelled with its space's `bug` label (391, D27)? An archived
-- `bug` still counts on the tasks it is on.
create or replace function internal.bridge_task_is_bug(p_task uuid)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities e
      join public.labels l on l.entity_id = any(e.labels) and l.space_id = e.space_id
     where e.id = p_task and lower(l.name) = 'bug')
$$;
revoke all on function internal.bridge_task_is_bug(uuid) from public;

-- A born report is gated in its own insert, before the row exists, so the
-- task's version and its create receipt do not move (D71).
create or replace function internal.bridge_fix_gate_on_birth() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare sp uuid;
begin
  select space_id into sp from public.entities where id = new.entity_id;
  if new.completion_gate = 'none' and internal.bridge_reporting_chat(sp) is not null then
    new.completion_gate := 'pr_merged';
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_fix_gate_on_birth() from public;
create trigger tasks_bridge_fix_gate before insert on public.tasks
for each row execute function internal.bridge_fix_gate_on_birth();

create or replace function internal.bridge_fix_mark_born() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare sp uuid;
begin
  select space_id into sp from public.entities where id = new.entity_id;
  if internal.bridge_reporting_chat(sp) is not null then
    insert into public.bridge_fix_reports(task_id, via) values (new.entity_id, 'chat') on conflict do nothing;
  end if;
  return null;
end
$$;
revoke all on function internal.bridge_fix_mark_born() from public;
create trigger tasks_bridge_fix_report after insert on public.tasks
for each row execute function internal.bridge_fix_mark_born();

-- Arm an existing report: the gate goes on unless it is done or already gated.
-- This one moves the version (it is set_task_gate's write), so it runs only for
-- a re-report, never in the create that a receipt describes.
create or replace function internal.bridge_fix_arm(p_task uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  update public.tasks t set completion_gate = 'pr_merged', updated_at = now()
    from public.entities e
   where t.entity_id = p_task and e.id = t.entity_id and e.deleted_at is null
     and t.completion_gate = 'none'
     and e.status_category is distinct from 'done' and e.status_category is distinct from 'cancelled';
end
$$;
revoke all on function internal.bridge_fix_arm(uuid) from public;

-- -----------------------------------------------------------------------------
-- §4. The notice.
-- -----------------------------------------------------------------------------
create table public.bridge_fix_notices (
  task_id             uuid not null references public.entities(id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  provider_message_id text not null,
  kind                text not null check (kind in ('merged', 'done_without_pr')),
  -- The reply on the log; null when the report's message was not found there.
  message_id          uuid references public.messages(entity_id) on delete set null,
  delivery            jsonb,
  created_at          timestamptz not null default now(),
  primary key (task_id, bridge_id, provider_message_id)
);
alter table public.bridge_fix_notices enable row level security;
create policy bridge_fix_notices_select on public.bridge_fix_notices for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_fix_notices.task_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_fix_notices to tm8_app;

-- The gate's predicate (082 C4 / 151), asked of a task without moving it.
create or replace function internal.bridge_fix_merged(p_task uuid)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select exists (select 1 from public.edges ed join public.pull_requests pr on pr.entity_id = ed.dst_id
                  where ed.src_id = p_task and ed.type = 'tracks')
     and not exists (select 1 from public.edges ed join public.pull_requests pr on pr.entity_id = ed.dst_id
                      where ed.src_id = p_task and ed.type = 'tracks'
                        and (pr.state <> 'merged' or pr.ci_status = 'failing'))
$$;
revoke all on function internal.bridge_fix_merged(uuid) from public;

-- What was done (D72): the newest message on the task by a person or a
-- teammate. A bridge's own copies and notices are not.
create or replace function internal.bridge_fix_what_was_done(p_task uuid)
returns text language sql stable set search_path = public, internal, pg_temp as $$
  select left(btrim(m.body), 700)
    from public.messages m
    join public.entities me on me.id = m.entity_id and me.deleted_at is null
    join public.entities au on au.id = m.author_id and au.kind in ('member', 'team_member')
   where m.anchor_id = p_task and btrim(m.body) <> ''
     and coalesce(m.message_batch_id, '') not like 'bridge-%'
   order by m.created_at desc, m.entity_id desc
   limit 1
$$;
revoke all on function internal.bridge_fix_what_was_done(uuid) from public;

-- Post one reply under one report. The marker is written first and is the
-- idempotency: a second merge event, a re-tracked PR or a redelivered origin
-- finds it and posts nothing.
create or replace function internal.bridge_fix_post(
  p_task uuid, p_bridge uuid, p_message uuid, p_provider_message_id text, p_kind text, p_text text)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges; o public.message_origins; anchor uuid; anchor_e public.entities; parent_row public.messages;
  author uuid; poster text; msg uuid; v_delivery jsonb; n integer;
begin
  insert into public.bridge_fix_notices(task_id, bridge_id, provider_message_id, kind)
  values (p_task, p_bridge, p_provider_message_id, p_kind)
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return; end if;

  select * into b from public.bridges where entity_id = p_bridge;
  if b.entity_id is null or b.ended_at is not null then return; end if;
  anchor := internal.bridge_log_anchor(b);
  select * into anchor_e from public.entities where id = anchor;

  -- The report on the log: the origin's own row, else the inbound row by its
  -- provider id (the origin may name the routed copy).
  if p_message is not null then o := internal.bridge_origin_of(p_message); end if;
  if o.message_id is null or o.bridge_id <> p_bridge then
    select * into o from public.message_origins
     where bridge_id = p_bridge and external_message_id = p_provider_message_id and direction = 'in';
  end if;
  if o.message_id is not null then
    select * into parent_row from public.messages where entity_id = o.message_id and anchor_id = anchor;
  end if;

  -- Signed with the bridge's teammate (D24, D25); the bridge's own notice
  -- voice when it has none.
  if b.teammate_id is not null and exists (
       select 1 from public.entities where id = b.teammate_id and kind = 'team_member'
          and space_id = b.space_id and deleted_at is null) then
    author := b.teammate_id; poster := 'chat';
  else
    author := b.entity_id; poster := 'notice';
  end if;

  msg := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (msg, b.space_id, 'message', parent_row.entity_id, null, author, anchor_e.visibility);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
  values (msg, anchor,
          case when parent_row.entity_id is not null then coalesce(parent_row.root_message_id, parent_row.entity_id) end,
          author, p_text, 'bridge-fix:' || p_task || ':' || p_bridge || ':' || p_provider_message_id);
  v_delivery := internal.bridge_outbox_enqueue(b.entity_id, msg, 'send',
    jsonb_strip_nulls(jsonb_build_object('text', internal.bridge_signed(b, author, null, poster, p_text),
      'replyTo', case when parent_row.entity_id is not null then internal.bridge_quote_ref(parent_row.entity_id) end)),
    jsonb_strip_nulls(jsonb_build_object('poster', poster,
      'teammateId', case when poster = 'chat' then author end,
      -- An answer to the reporter: not an unprompted post (§2.7's 6/10 min).
      'directed', true,
      'replyToExternalId', case when parent_row.entity_id is not null then o.external_message_id end)));
  update public.bridge_fix_notices set message_id = msg, delivery = v_delivery
   where task_id = p_task and bridge_id = p_bridge and provider_message_id = p_provider_message_id;
end
$$;
revoke all on function internal.bridge_fix_post(uuid, uuid, uuid, text, text, text) from public;

-- -----------------------------------------------------------------------------
-- §5. When: one check, asked by every event that can make it true.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fix_check(p_task uuid)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  t public.tasks; e public.entities; v_kind text; body text; done_text text; prs text; posted integer := 0; r record;
begin
  select * into e from public.entities where id = p_task and kind = 'task' and deleted_at is null;
  if e.id is null then return 0; end if;
  if not exists (select 1 from public.bridge_fix_reports where task_id = p_task) then
    if not internal.bridge_task_is_bug(p_task) then return 0; end if;
    if not exists (select 1 from internal.bridge_task_origins(p_task)) then return 0; end if;
    insert into public.bridge_fix_reports(task_id, via) values (p_task, 'label') on conflict do nothing;
  end if;
  select * into t from public.tasks where entity_id = p_task;

  if internal.bridge_fix_merged(p_task) then
    v_kind := 'merged';
    select string_agg(pr.url, ' ' order by pr.number) into prs
      from public.edges ed join public.pull_requests pr on pr.entity_id = ed.dst_id
     where ed.src_id = p_task and ed.type = 'tracks';
    body := format('Fixed: %s. Merged %s', t.title, prs);
  elsif e.status_category = 'done' then
    v_kind := 'done_without_pr';
    done_text := internal.bridge_fix_what_was_done(p_task);
    body := case when done_text is not null then format('Done: %s. %s', t.title, done_text)
                 else format('Done: %s (closed without a pull request).', t.title) end;
  else
    return 0;
  end if;

  for r in select * from internal.bridge_task_origins(p_task) loop
    begin
      perform internal.bridge_fix_post(p_task, r.bridge_id, r.message_id, r.provider_message_id, v_kind, body);
      posted := posted + 1;
    exception when others then
      -- A refusal (another session's open answer on the report, a vanished
      -- bridge) must not fail the merge or status write that got us here. The
      -- marker rolled back with the savepoint, so a later event retries.
      raise warning 'bridge fix notice for task % on bridge %: %', p_task, r.bridge_id, sqlerrm;
    end;
  end loop;
  return posted;
end
$$;
revoke all on function internal.bridge_fix_check(uuid) from public;

-- A PR's merge or its CI leaving red: every task tracking it.
create or replace function internal.bridge_fix_on_pr() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare task uuid;
begin
  for task in select distinct ed.src_id from public.edges ed where ed.dst_id = new.entity_id and ed.type = 'tracks' loop
    perform internal.bridge_fix_check(task);
  end loop;
  return null;
end
$$;
revoke all on function internal.bridge_fix_on_pr() from public;
create constraint trigger pull_requests_bridge_fix after update of state, ci_status on public.pull_requests
  deferrable initially deferred for each row
  when (new.state = 'merged' and (old.state is distinct from 'merged' or old.ci_status is distinct from new.ci_status))
  execute function internal.bridge_fix_on_pr();

-- A tracks edge (link-pr, maybe to a PR already merged), and a new or grown
-- bridge origin on a task. A bridge origin on a MESSAGE posted on a report by a
-- chat turn is a re-report (§3): stamped onto the task.
create or replace function internal.bridge_fix_on_edge() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare src public.entities; m public.messages; turn_origins jsonb;
begin
  select * into src from public.entities where id = new.src_id and deleted_at is null;
  if src.id is null then return null; end if;
  if new.type = 'tracks' then
    if src.kind = 'task' then perform internal.bridge_fix_check(src.id); end if;
    return null;
  end if;
  -- authored_from with props.bridgeId, to the bridge itself.
  if not exists (select 1 from public.entities where id = new.dst_id and kind = 'bridge') then return null; end if;
  if src.kind = 'task' then
    perform internal.bridge_fix_check(src.id);
    return null;
  end if;
  if src.kind <> 'message' then return null; end if;
  select * into m from public.messages where entity_id = src.id;
  if m.entity_id is null then return null; end if;
  if not exists (select 1 from public.entities where id = m.anchor_id and kind = 'task' and deleted_at is null) then
    return null;
  end if;
  if not exists (select 1 from public.bridge_fix_reports where task_id = m.anchor_id)
     and not internal.bridge_task_is_bug(m.anchor_id) then
    return null;
  end if;
  -- Only a chat turn's origins: they are exactly the message it is answering
  -- (turn-scoped, §2.8). A worker's accumulated origins are what started it,
  -- not a report of this bug (D30).
  select coalesce(jsonb_agg(o.value), '[]'::jsonb) into turn_origins
    from jsonb_array_elements(coalesce(new.props -> 'origins', '[]'::jsonb)) o
    join public.entities via on via.id::text = o.value ->> 'viaSessionId' and via.kind = 'chat';
  if jsonb_array_length(turn_origins) = 0 then return null; end if;
  insert into public.bridge_fix_reports(task_id, via) values (m.anchor_id, 're_report') on conflict do nothing;
  perform internal.bridge_fix_arm(m.anchor_id);
  -- bridge_stamp writes the task's edge; its own trigger (this one) then runs
  -- the check for the task.
  perform internal.bridge_stamp(m.anchor_id, turn_origins);
  return null;
end
$$;
revoke all on function internal.bridge_fix_on_edge() from public;
create constraint trigger edges_bridge_fix after insert or update of props on public.edges
  deferrable initially deferred for each row
  when (new.type = 'tracks' or (new.type = 'authored_from' and new.props ? 'bridgeId'))
  execute function internal.bridge_fix_on_edge();

-- A report entering done (D72), and `bug` added to a task with origins.
create or replace function internal.bridge_fix_on_entity() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.kind = 'task' then perform internal.bridge_fix_check(new.id); end if;
  return null;
end
$$;
revoke all on function internal.bridge_fix_on_entity() from public;
create constraint trigger entities_bridge_fix_done after update of status_category on public.entities
  deferrable initially deferred for each row
  when (new.kind = 'task' and new.status_category = 'done' and old.status_category is distinct from 'done')
  execute function internal.bridge_fix_on_entity();
create constraint trigger entities_bridge_fix_label after update of labels on public.entities
  deferrable initially deferred for each row
  when (new.kind = 'task' and new.labels is distinct from old.labels)
  execute function internal.bridge_fix_on_entity();

reset role;

analyze public.bridge_fix_reports;
analyze public.bridge_fix_notices;
