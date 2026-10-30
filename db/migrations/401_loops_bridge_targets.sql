-- =============================================================================
-- 401 — Bridges L: a loop is a teammate on a schedule that posts to many groups
-- (BRIDGE-ENTITY-DESIGN.md D26, D30, D67–D69; BRIDGES-V2-DESIGN.md §2.2–§2.3).
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Task 01a189d7-7b8e-7cf2-a42f-390dc76353f2. Extends main's first-class loops
-- (384/385) — no new executor — on B1b-2's outbox (398) and B1b-3's provenance
-- recorder (399). Stacked on both PRs.
--
-- WHAT THIS FILE DOES
--   §1  loops: `targets` (bridges, each with its own text), action `post`,
--       concurrency `replace`, `mode` (one-shot | interactive) and the admin's
--       `quiet_hours_exempt`; loop_runs: action `post`; per-target results
--       (`loop_run_targets`) and held posts (`loop_held_posts`).
--   §2  the targets door (validation, the admin-only exemption).
--   §3  owner leaves (D26): a loop with bridge targets acts only as its armer
--       — no owner fallback — so it is suspended when the armer leaves, and
--       every admin gets an attention request; an admin's re-arm takes it over.
--   §4  quiet hours (D67): the outbox holds a loop's unprompted post while its
--       target is in quiet hours; when the hours end only the newest is sent.
--       The enqueue also records each target's result on the run.
--   §5  the post action and the agent action's per-target context.
--   §6  reply routing (D26, D69): a reply to a live interactive loop session's
--       post goes to that session, not the group's chat.
--   §7  provenance (D30, D69): `authored_from -> loop` on everything a loop's
--       session (and its children) creates, recorded like 399's bridge edges.
--   §8  authority (D26, D68): the door the operation gate calls to raise an
--       approval request to the owner.
--   §9  the executor's doors: runs to replace, interactive idle close.
--   §10 a removed bridge disables the loops that target it (v2 §2.3).
--
-- 398's bridge_runtime_inbound and bridge_outbox_enqueue are re-declared here
-- VERBATIM plus the blocks marked `401 (L)` (the 348 precedent). A rebase
-- onto a changed 398 re-copies them; nothing else in 398/399 is replaced but
-- 399's internal.guard_authored_from_bridge (one marked branch for loops).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Columns and tables.
-- -----------------------------------------------------------------------------
alter table public.loops drop constraint loops_action_check;
alter table public.loops add constraint loops_action_check
  check (action in ('spawn', 'dispatch', 'tool', 'post'));
alter table public.loops drop constraint loops_concurrency_check;
alter table public.loops add constraint loops_concurrency_check
  check (concurrency in ('skip', 'queue', 'replace'));
alter table public.loops
  -- [{bridgeId, text}]: the default posting targets (D26). For `post` the full
  -- recipient list, text being the message; for an agent loop, text is that
  -- group's own instruction. Content, so an edit re-arms (343).
  add column targets jsonb not null default '[]'::jsonb check (jsonb_typeof(targets) = 'array'),
  add column mode text not null default 'one-shot' check (mode in ('one-shot', 'interactive')),
  -- Set only by a space admin (D26): never held by quiet hours.
  add column quiet_hours_exempt boolean not null default false;
create index loops_targets_gin on public.loops using gin (targets jsonb_path_ops);

alter table public.loop_runs drop constraint loop_runs_action_check;
alter table public.loop_runs add constraint loop_runs_action_check
  check (action in ('spawn', 'dispatch', 'tool', 'post'));

-- One row per (run, target): what happened in that group (v2 §2.2's Loops tab:
-- posted · paused · held (quiet hours)).
create table public.loop_run_targets (
  run_id     uuid not null references public.loop_runs(id) on delete cascade,
  bridge_id  uuid not null references public.bridges(entity_id) on delete cascade,
  loop_id    uuid not null references public.loops(entity_id) on delete cascade,
  result     text not null check (result in ('pending', 'posted', 'paused', 'held', 'superseded', 'refused')),
  reason     text,
  message_id uuid references public.entities(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (run_id, bridge_id)
);
create index loop_run_targets_loop_idx on public.loop_run_targets(loop_id, updated_at desc);
alter table public.loop_run_targets enable row level security;
create policy loop_run_targets_select on public.loop_run_targets for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = loop_run_targets.loop_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.loop_run_targets to tm8_app;

-- The newest held post per (loop, bridge): released when quiet hours end (D67).
create table public.loop_held_posts (
  loop_id    uuid not null references public.loops(entity_id) on delete cascade,
  bridge_id  uuid not null references public.bridges(entity_id) on delete cascade,
  message_id uuid not null references public.messages(entity_id) on delete cascade,
  run_id     uuid references public.loop_runs(id) on delete set null,
  payload    jsonb not null,
  opts       jsonb not null,
  held_at    timestamptz not null default now(),
  primary key (loop_id, bridge_id)
);
alter table public.loop_held_posts enable row level security;
-- No policy and no grant: read and written only through the definer doors.

-- Held and superseded posts badge like any refusal (§2.7): the message stays.
alter table public.bridge_delivery_refusals drop constraint bridge_delivery_refusals_reason_check;
alter table public.bridge_delivery_refusals add constraint bridge_delivery_refusals_reason_check
  check (reason in ('bridge_paused', 'bridge_ended', 'direction_in', 'worker_posting_off',
                    'rate_limited', 'not_connected', 'credential_text', 'quiet_hours', 'superseded'));

-- The runner invariants (384) admit `post`: it starts no worker, so it names
-- no tool; a teammate is optional (each bridge's teammate signs otherwise).
create or replace function internal.assert_loop_runner(
  p_space_id uuid, p_action text, p_team_member_id uuid, p_tool_id uuid, p_timezone text
) returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if p_action is null or p_action not in ('spawn', 'dispatch', 'tool', 'post') then
    raise exception 'loop action must be spawn, dispatch, tool or post' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_timezone, ''))) not between 1 and 64 then
    raise exception 'loop timezone is required' using errcode = '22023';
  end if;
  if p_action = 'spawn' and p_team_member_id is null then
    raise exception 'a spawn loop requires team_member_id' using errcode = '22023';
  end if;
  if p_action = 'dispatch' and p_team_member_id is not null then
    raise exception 'a dispatch loop names no runner (team_member_id must be null)' using errcode = '22023';
  end if;
  if p_action = 'tool' then
    if p_tool_id is null then
      raise exception 'a tool loop requires tool_id' using errcode = '22023';
    end if;
    perform 1 from public.entities t
      where t.id = p_tool_id and t.space_id = p_space_id
        and t.kind = 'tool' and t.deleted_at is null;
    if not found then
      raise exception 'loop tool_id must name a live tool in this space' using errcode = '23503';
    end if;
  elsif p_tool_id is not null then
    raise exception 'tool_id is only meaningful for a tool loop' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.assert_loop_runner(uuid, text, uuid, uuid, text) from public;

-- -----------------------------------------------------------------------------
-- §2. The targets door. Null leaves a field as it is. Called by loops.create
-- and loops.update in their own transaction, after create_loop/update_loop.
-- -----------------------------------------------------------------------------
create or replace function public.set_loop_bridge_fields(
  p_loop_id uuid, p_targets jsonb default null, p_mode text default null, p_quiet_hours_exempt boolean default null
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  l public.loops; e public.entities; item jsonb; seen uuid[] := '{}'; v_bridge uuid; v_text text;
  clean jsonb := '[]'::jsonb;
begin
  select * into e from public.entities where id = p_loop_id and kind = 'loop' and deleted_at is null;
  if e.id is null then raise exception 'loop % not found', p_loop_id using errcode = 'P0002'; end if;
  perform internal.require_space_member(e.space_id);
  select * into l from public.loops where entity_id = p_loop_id for update;

  if p_targets is not null then
    if jsonb_typeof(p_targets) <> 'array' then raise exception 'targets is an array' using errcode = '22023'; end if;
    if jsonb_array_length(p_targets) > 32 then raise exception 'a loop has at most 32 targets' using errcode = '22023'; end if;
    for item in select value from jsonb_array_elements(p_targets) loop
      if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'bridgeId', '') !~* '^[0-9a-f-]{36}$' then
        raise exception 'each target is {bridgeId, text}' using errcode = '22023';
      end if;
      v_bridge := (item ->> 'bridgeId')::uuid;
      if v_bridge = any(seen) then raise exception 'target % is listed twice', v_bridge using errcode = '22023'; end if;
      seen := seen || v_bridge;
      if not exists (select 1 from public.bridges b join public.entities be on be.id = b.entity_id
                      where b.entity_id = v_bridge and b.space_id = e.space_id and b.ended_at is null
                        and be.deleted_at is null) then
        raise exception 'target % is not a live bridge in this space', v_bridge using errcode = '22023';
      end if;
      v_text := nullif(btrim(coalesce(item ->> 'text', '')), '');
      if char_length(v_text) > 4000 then raise exception 'a target''s text is at most 4000 characters' using errcode = '22023'; end if;
      clean := clean || jsonb_build_array(jsonb_build_object('bridgeId', v_bridge, 'text', v_text));
    end loop;
    l.targets := clean;
  end if;
  if p_mode is not null then
    if p_mode not in ('one-shot', 'interactive') then raise exception 'mode is one-shot or interactive' using errcode = '22023'; end if;
    l.mode := p_mode;
  end if;
  if p_quiet_hours_exempt is not null and p_quiet_hours_exempt is distinct from l.quiet_hours_exempt then
    if p_quiet_hours_exempt and not internal.is_space_admin(e.space_id) then
      raise exception 'only a space admin can exempt a loop from quiet hours' using errcode = '42501',
        detail = jsonb_build_object('reason', 'admin_only')::text;
    end if;
    l.quiet_hours_exempt := p_quiet_hours_exempt;
  end if;

  if l.action = 'post' then
    if jsonb_array_length(l.targets) = 0 then
      raise exception 'a post loop needs at least one target' using errcode = '22023';
    end if;
    if l.mode <> 'one-shot' then
      raise exception 'a post loop starts no session, so it has no interactive mode' using errcode = '22023';
    end if;
    if btrim(l.prompt) = '' and exists (select 1 from jsonb_array_elements(l.targets) t where t.value ->> 'text' is null) then
      raise exception 'a post loop needs text for every target (or a prompt to post where none is set)' using errcode = '22023';
    end if;
  end if;

  update public.loops set targets = l.targets, mode = l.mode, quiet_hours_exempt = l.quiet_hours_exempt
   where entity_id = p_loop_id
     and (targets, mode, quiet_hours_exempt) is distinct from (l.targets, l.mode, l.quiet_hours_exempt);
end
$$;
revoke all on function public.set_loop_bridge_fields(uuid, jsonb, text, boolean) from public;
grant execute on function public.set_loop_bridge_fields(uuid, jsonb, text, boolean) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. Owner leaves (D26).
-- -----------------------------------------------------------------------------
create or replace function internal.loop_has_targets(p_loop_id uuid) returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce((select jsonb_array_length(l.targets) > 0 from public.loops l where l.entity_id = p_loop_id), false)
$$;
revoke all on function internal.loop_has_targets(uuid) from public;

-- 385's rule, plus: a loop with bridge targets runs only as its armer. With
-- the armer gone it has no one to act as, so the due read skips it.
create or replace function internal.loop_acting_identity(p_loop_id uuid)
returns text
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select m.identity_id
       from public.loops l
       join public.entities e on e.id = l.entity_id
       join public.members m on m.identity_id = l.armed_by_identity_id
                            and m.space_id = e.space_id
      where l.entity_id = p_loop_id
        and m.status = 'active'),
    (select m.identity_id
       from public.entities e
       join public.members m on m.space_id = e.space_id
      where e.id = p_loop_id
        and not internal.loop_has_targets(p_loop_id)   -- 401 (L): no fallback for bridge loops
        and m.role = 'owner'
        and m.status = 'active'
      order by m.entity_id
      limit 1))
$$;
revoke all on function internal.loop_acting_identity(uuid) from public;

create or replace function internal.loop_suspended(p_loop_id uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.loop_has_targets(p_loop_id)
     and not exists (select 1 from public.loops l join public.entities e on e.id = l.entity_id
                       join public.members m on m.identity_id = l.armed_by_identity_id and m.space_id = e.space_id
                      where l.entity_id = p_loop_id and m.status = 'active')
$$;
revoke all on function internal.loop_suspended(uuid) from public;

create or replace function internal.loop_suspended_reason() returns text
language sql immutable as $$
  select 'suspended: the member who armed this loop left the space; a space admin can take it over by re-arming it'::text
$$;
revoke all on function internal.loop_suspended_reason() from public;

-- Suspend and notify: every active admin and owner gets one request (D26).
create or replace function internal.loop_suspend_for_owner_left(p_loop_id uuid) returns integer
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; l public.loops; a record; n integer := 0; r record;
begin
  select * into e from public.entities where id = p_loop_id and deleted_at is null;
  select * into l from public.loops where entity_id = p_loop_id;
  if e.id is null or not internal.loop_suspended(p_loop_id) then return 0; end if;
  update public.loops set last_error = internal.loop_suspended_reason(), updated_at = now()
   where entity_id = p_loop_id and last_error is distinct from internal.loop_suspended_reason();
  for a in select m.entity_id from public.members m
            where m.space_id = e.space_id and m.status = 'active' and m.role in ('owner', 'admin')
            order by m.entity_id loop
    select * into r from internal.raise_attention_signal(e.space_id, p_loop_id,
      'loop.owner_left:' || p_loop_id || ':' || a.entity_id,
      format('The loop "%s" posts to groups and its owner left the space, so it is suspended. Take it over by re-arming it: tm8 loop enable %s', l.title, p_loop_id),
      'high', 'decide', a.entity_id);
    update public.attention_requests set assignee_id = a.entity_id where id = r.request_id and assignee_id is null;
    if r.created then n := n + 1; end if;
  end loop;
  return n;
end
$$;
revoke all on function internal.loop_suspend_for_owner_left(uuid) from public;

create or replace function internal.loops_on_member_left() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare lp record;
begin
  if old.status = 'active' and new.status <> 'active' then
    for lp in select l.entity_id from public.loops l join public.entities e on e.id = l.entity_id
               where e.space_id = new.space_id and e.deleted_at is null
                 and l.armed_by_identity_id = new.identity_id and jsonb_array_length(l.targets) > 0 loop
      perform internal.loop_suspend_for_owner_left(lp.entity_id);
    end loop;
  end if;
  return null;
end
$$;
revoke all on function internal.loops_on_member_left() from public;
create trigger members_loops_owner_left after update of status on public.members
for each row execute function internal.loops_on_member_left();

-- 384's armer stamp, plus the takeover (401, marked): a human's write to a
-- suspended loop (D26) re-arms it in their name, and only an admin may.
create or replace function internal.stamp_loop_armed_by() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_member uuid; v_human boolean; v_content_changed boolean; v_takeover boolean := false;
begin
  v_human := coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
             and coalesce(internal.claim_text('tm8.via_link'), '') = '';

  if tg_op = 'INSERT' then
    if not v_human then
      new.armed_at := null;
      return new;
    end if;
  else
    v_content_changed :=
         (to_jsonb(new) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      is distinct from
         (to_jsonb(old) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      or (new.enabled and not old.enabled);
    -- 401 (L): a human enabling or editing a suspended bridge loop takes it over.
    -- Read off the OLD row: an edit made while disabled, or one that clears the
    -- targets, is still a takeover (else a member edits, then enables, as armer);
    -- only disabling it is not. The suspension's own write (an admin's
    -- remove_space_member runs it under their claims) is not a takeover either.
    if v_human and (v_content_changed or new.enabled) and jsonb_array_length(old.targets) > 0
       and not (new.last_error is not distinct from internal.loop_suspended_reason()
                and old.last_error is distinct from new.last_error)
       and old.armed_by_identity_id is not null
       and old.armed_by_identity_id is distinct from internal.identity_id()
       and not exists (select 1 from public.entities e join public.members m on m.space_id = e.space_id
                        where e.id = new.entity_id and m.identity_id = old.armed_by_identity_id and m.status = 'active') then
      select space_id into v_space from public.entities where id = new.entity_id;
      if not internal.is_space_admin(v_space) then
        raise exception 'this loop''s owner left the space: only a space admin can take it over' using errcode = '42501',
          detail = jsonb_build_object('reason', 'admin_only')::text;
      end if;
      v_takeover := true;
      v_content_changed := true;
    end if;
    if not v_content_changed then
      new.armed_by_member_id := old.armed_by_member_id;
      new.armed_by_identity_id := old.armed_by_identity_id;
      new.armed_at := old.armed_at;
      return new;
    end if;
    if not v_human then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
      new.armed_at := null;
      return new;
    end if;
  end if;

  select space_id into v_space from public.entities where id = new.entity_id;
  if v_space is null then return new; end if;
  v_member := internal.current_member_id(v_space);
  if v_member is null then
    if tg_op <> 'INSERT' then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
    end if;
    new.armed_at := null;
    return new;
  end if;
  new.armed_by_member_id := v_member;
  new.armed_by_identity_id := internal.identity_id();
  new.armed_at := now();
  -- 401 (L): the takeover clears the suspension and its requests.
  if v_takeover or (tg_op = 'UPDATE' and old.last_error = internal.loop_suspended_reason()) then
    if new.last_error = internal.loop_suspended_reason() or new.last_error like 'needs arming%' then new.last_error := null; end if;
    update public.attention_requests
       set status = 'cleared', resolved_by = null, resolved_at = now(), version = version + 1,
           resolution_note = 'taken over and re-armed'
     where entity_id = new.entity_id and signal_key like 'loop.owner_left:' || new.entity_id || ':%'
       and status in ('open', 'acknowledged');
  end if;
  return new;
end
$$;
revoke all on function internal.stamp_loop_armed_by() from public;

-- -----------------------------------------------------------------------------
-- §4. Quiet hours (D67).
-- -----------------------------------------------------------------------------
-- In the window? `{start,end}` HH:MM, evaluated in p_tz; a window may cross midnight.
create or replace function internal.in_quiet_hours(p_quiet jsonb, p_tz text, p_at timestamptz) returns boolean
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare t time; s time; e time;
begin
  if p_quiet is null or jsonb_typeof(p_quiet) <> 'object' then return false; end if;
  s := (p_quiet ->> 'start')::time; e := (p_quiet ->> 'end')::time;
  t := (p_at at time zone coalesce(nullif(p_tz, ''), 'UTC'))::time;
  return case when s < e then t >= s and t < e else t >= s or t < e end;
end
$$;
revoke all on function internal.in_quiet_hours(jsonb, text, timestamptz) from public;

-- The loop run a post belongs to: named by the post action, else the open run
-- of the posting session (an agent loop's worker).
create or replace function internal.loop_run_of_post(p_opts jsonb) returns public.loop_runs
language sql stable set search_path = public, internal, pg_temp as $$
  select r.* from public.loop_runs r
   where (nullif(p_opts ->> 'runId', '') is not null and r.id = (p_opts ->> 'runId')::uuid)
      or (nullif(p_opts ->> 'runId', '') is null and nullif(p_opts ->> 'sessionId', '') is not null
          and r.session_id = (p_opts ->> 'sessionId')::uuid and r.outcome is null and r.launch = 'fired')
   order by r.fired_at desc limit 1
$$;
revoke all on function internal.loop_run_of_post(jsonb) from public;

create or replace function internal.loop_record_target(p_run uuid, p_loop uuid, p_bridge uuid, p_result text,
  p_reason text, p_message uuid) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if p_run is null then return; end if;
  insert into public.loop_run_targets(run_id, bridge_id, loop_id, result, reason, message_id)
  values (p_run, p_bridge, p_loop, p_result, p_reason, p_message)
  on conflict (run_id, bridge_id) do update
     set result = excluded.result, reason = excluded.reason,
         message_id = coalesce(excluded.message_id, loop_run_targets.message_id), updated_at = now()
   -- A group already posted to stays posted; a held one may be superseded or released.
   where loop_run_targets.result <> 'posted' or excluded.result = 'posted';
end
$$;
revoke all on function internal.loop_record_target(uuid, uuid, uuid, text, text, uuid) from public;

-- 398's enqueue, verbatim plus the 401 (L) blocks: the hold, and each target's result.
create or replace function internal.bridge_outbox_enqueue(
  p_bridge uuid, p_message uuid, p_kind text, p_payload jsonb, p_opts jsonb
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges; conn public.bridge_connections;
  v_poster text := coalesce(p_opts ->> 'poster', 'member');
  v_teammate uuid := nullif(p_opts ->> 'teammateId', '')::uuid;
  v_directed boolean := coalesce((p_opts ->> 'directed')::boolean, false);
  reason text; retry_ms integer; oldest timestamptz; row_id uuid; existing public.bridge_outbox;
  -- 401 (L)
  v_run public.loop_runs; v_loop public.loops; v_held public.loop_held_posts;
begin
  if p_kind not in ('send', 'react') then raise exception 'unknown outbox kind' using errcode = '22023'; end if;
  select * into existing from public.bridge_outbox
   where message_id = p_message and kind = p_kind
     and (p_kind = 'send' or reaction is not distinct from p_opts ->> 'reaction');
  if existing.id is not null then
    return jsonb_build_object('status', 'pending', 'outboxId', existing.id, 'replayed', true);
  end if;

  select * into b from public.bridges where entity_id = p_bridge;
  select * into conn from public.bridge_connections where id = b.connection_id;
  -- Every row on one number is decided one at a time, so the buckets hold.
  perform pg_advisory_xact_lock(hashtextextended('bridge-outbox:' || coalesce(conn.id, p_bridge)::text, 0));

  reason := case
    when b.entity_id is null or b.ended_at is not null then 'bridge_ended'
    when conn.id is null or conn.status = 'removed' then 'not_connected'
    when b.paused_at is not null or b.muted_until > now() then 'bridge_paused'
    when b.policy ->> 'direction' = 'in' then 'direction_in'
    when v_poster = 'worker' and not b.worker_posting then 'worker_posting_off'
    when not (b.external_conversation_id = any(internal.bridge_allowlist_ids(conn.id))) then 'not_connected'
    when p_kind = 'send' and internal.bridge_text_looks_secret(coalesce(p_payload ->> 'text', '')) then 'credential_text'
  end;

  -- 401 (L, D67): quiet hours hold a loop's unprompted post (never a reply, never
  -- an exempt loop's); a newer held post supersedes the older one.
  if p_kind = 'send' then
    v_run := internal.loop_run_of_post(p_opts);
    if v_run.id is not null then select * into v_loop from public.loops where entity_id = v_run.loop_id; end if;
  end if;
  if reason is null and v_loop.entity_id is not null and not v_directed
     and nullif(p_opts ->> 'replyToExternalId', '') is null
     and not coalesce((p_opts ->> 'release')::boolean, false)
     and not v_loop.quiet_hours_exempt
     and internal.in_quiet_hours(b.quiet_hours, v_loop.timezone, now()) then
    select * into v_held from public.loop_held_posts
     where loop_id = v_loop.entity_id and bridge_id = p_bridge for update;
    if v_held.message_id is not null and v_held.message_id <> p_message then
      update public.bridge_delivery_refusals set reason = 'superseded', created_at = now() where message_id = v_held.message_id;
      update public.loop_run_targets set result = 'superseded', reason = 'a newer post was held', updated_at = now()
       where message_id = v_held.message_id and result = 'held';
    end if;
    insert into public.loop_held_posts(loop_id, bridge_id, message_id, run_id, payload, opts)
    values (v_loop.entity_id, p_bridge, p_message, v_run.id, p_payload, p_opts - 'release')
    on conflict (loop_id, bridge_id) do update
       set message_id = excluded.message_id, run_id = excluded.run_id, payload = excluded.payload,
           opts = excluded.opts, held_at = now();
    insert into public.bridge_delivery_refusals(message_id, bridge_id, reason, retry_after_ms)
    values (p_message, p_bridge, 'quiet_hours', null)
    on conflict (message_id) do update set reason = 'quiet_hours', retry_after_ms = null, created_at = now();
    perform internal.loop_record_target(v_run.id, v_loop.entity_id, p_bridge, 'held', 'quiet_hours', p_message);
    return jsonb_build_object('status', 'held', 'reason', 'quiet_hours');
  end if;

  -- Buckets, tightest first (§2.7, §6). Each answers how long until it has room.
  if reason is null then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox where connection_id = conn.id and created_at > now() - interval '1 minute'
       order by created_at desc limit 60) w having count(*) >= 60;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
  end if;
  if reason is null then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox where bridge_id = p_bridge and created_at > now() - interval '1 minute'
       order by created_at desc limit 30) w having count(*) >= 30;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
  end if;
  if reason is null and v_teammate is not null and v_poster in ('worker', 'chat') then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox
       where teammate_id = v_teammate and bridge_id = p_bridge and poster in ('worker', 'chat')
         and created_at > now() - interval '1 minute'
       order by created_at desc limit 20) w having count(*) >= 20;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
    if reason is null and not v_directed then
      select min(created_at) into oldest from (
        select created_at from public.bridge_outbox
         where teammate_id = v_teammate and bridge_id = p_bridge and poster in ('worker', 'chat') and not directed
           and created_at > now() - interval '10 minutes'
         order by created_at desc limit 6) w having count(*) >= 6;
      if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '10 minutes' - now()) * 1000); end if;
    end if;
  end if;

  if reason is not null then
    if p_kind = 'send' then
      insert into public.bridge_delivery_refusals(message_id, bridge_id, reason, retry_after_ms)
      values (p_message, p_bridge, reason, greatest(retry_ms, 0))
      on conflict (message_id) do update set reason = excluded.reason, retry_after_ms = excluded.retry_after_ms,
        created_at = now();
    end if;
    -- 401 (L): the run's result for this group.
    if v_run.id is not null then
      perform internal.loop_record_target(v_run.id, v_loop.entity_id, p_bridge,
        case reason when 'bridge_paused' then 'paused' else 'refused' end, reason, p_message);
    end if;
    return jsonb_strip_nulls(jsonb_build_object('status', 'refused', 'reason', reason,
                                                'retryAfterMs', greatest(retry_ms, 0)));
  end if;

  insert into public.bridge_outbox(bridge_id, message_id, external_reply_to, payload, kind, reaction, connection_id,
    external_conversation_id, poster, teammate_id, session_id, directed)
  values (p_bridge, p_message, p_opts ->> 'replyToExternalId', p_payload, p_kind, p_opts ->> 'reaction', conn.id,
          b.external_conversation_id, v_poster, v_teammate, nullif(p_opts ->> 'sessionId', '')::uuid, v_directed)
  returning id into row_id;
  delete from public.bridge_delivery_refusals where message_id = p_message and p_kind = 'send';
  -- 401 (L): the run's result for this group.
  if v_run.id is not null then
    perform internal.loop_record_target(v_run.id, v_loop.entity_id, p_bridge, 'posted', null, p_message);
  end if;
  return jsonb_build_object('status', 'pending', 'outboxId', row_id);
end
$$;
revoke all on function internal.bridge_outbox_enqueue(uuid, uuid, text, jsonb, jsonb) from public;

-- 398's inbound, verbatim plus the 401 (L) block: reply routing (§6).
create or replace function public.bridge_runtime_inbound(p_frame jsonb, p_command boolean default false) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  conn public.bridge_connections;
  b public.bridges;
  ext text := p_frame ->> 'externalMessageId';
  conv text := p_frame ->> 'conversationId';
  sender text := p_frame #>> '{sender,externalId}';
  sender_name text := nullif(btrim(coalesce(p_frame #>> '{sender,name}', '')), '');
  alt text := p_frame #>> '{sender,altId}';
  body text := coalesce(p_frame ->> 'body', '');
  author jsonb;
  log_anchor uuid;
  anchor_e public.entities;
  parent_msg uuid;
  parent_row public.messages;
  thread_root uuid;
  reply_ext text := p_frame #>> '{replyTo,externalMessageId}';
  log_id uuid;
  copy_id uuid;
  batch text;
  ts timestamptz;
  triggered boolean := false;
  allowed boolean;
  routed boolean := false;
  chat_row public.chats;
  actor_kind text;
  existing uuid;
  wake jsonb := null;
  target_e public.entities;
  -- 401 (L)
  loop_sid uuid;
  sess_e public.entities;
begin
  perform internal.bridge_runtime_session();
  if ext is null or conv is null or char_length(ext) > 256 then
    raise exception 'inbound needs a conversationId and an externalMessageId' using errcode = '22023';
  end if;
  select * into conn from public.bridge_connections where id = (p_frame ->> 'connectionId')::uuid;
  if conn.id is null or conn.status = 'removed' then
    return jsonb_build_object('status', 'refused', 'reason', 'unknown_connection');
  end if;
  -- A reaction or a poll vote is not a message: nothing is stored for it yet.
  if p_frame -> 'reaction' is not null and jsonb_typeof(p_frame -> 'reaction') = 'object' then
    return jsonb_build_object('status', 'ignored', 'reason', 'reaction');
  end if;
  if p_frame -> 'pollVote' is not null and jsonb_typeof(p_frame -> 'pollVote') = 'object' then
    return jsonb_build_object('status', 'ignored', 'reason', 'poll_vote');
  end if;

  select br.* into b from public.bridges br join public.entities e on e.id = br.entity_id and e.deleted_at is null
   where br.connection_id = conn.id and br.external_conversation_id = conv
     and br.ended_at is null and br.paused_at is null
   for update of br;
  if b.entity_id is null then
    -- D28: the runtime forwarded something off its allowlist. Push it again.
    update public.bridge_connections
       set allowlist_dirty = true,
           runtime_counters = jsonb_set(coalesce(runtime_counters, '{}'::jsonb), '{serverRefused}',
             to_jsonb(coalesce((runtime_counters ->> 'serverRefused')::integer, 0) + 1))
     where id = conn.id;
    return jsonb_build_object('status', 'refused', 'reason', 'not_on_allowlist');
  end if;

  -- Exactly once per bridge, from any number (D20).
  perform pg_advisory_xact_lock(hashtextextended('bridge-in:' || b.entity_id || ':' || ext, 0));
  select message_id into existing from public.message_origins
   where bridge_id = b.entity_id and external_message_id = ext and direction = 'in';
  if existing is not null then
    return jsonb_build_object('status', 'duplicate', 'messageId', existing, 'bridgeId', b.entity_id);
  end if;

  -- Presence (§2.4): the participant row the resolver reads alternate ids from.
  if sender is not null then
    insert into public.bridge_participants(bridge_id, external_id, alt_external_ids, display_name,
                                           first_seen_at, last_seen_at, message_count)
    values (b.entity_id, sender, case when alt is null then '{}' else array[alt] end, sender_name, now(), now(), 1)
    on conflict (bridge_id, external_id) do update
      set display_name = coalesce(excluded.display_name, bridge_participants.display_name),
          alt_external_ids = case when alt is null or alt = any(bridge_participants.alt_external_ids)
                                  then bridge_participants.alt_external_ids
                                  else bridge_participants.alt_external_ids || alt end,
          last_seen_at = now(), message_count = bridge_participants.message_count + 1;
    author := internal.bridge_resolve_author(b.entity_id, sender);
  else
    author := jsonb_build_object('kind', 'bridge', 'actorId', b.entity_id, 'trust', 'guest',
                                 'participant', jsonb_build_object('displayName', coalesce(sender_name, 'Guest')));
  end if;

  if body = '' then
    body := coalesce((select string_agg(coalesce(m ->> 'caption', '[' || coalesce(m ->> 'kind', 'media') || ']'), E'\n')
                        from jsonb_array_elements(coalesce(p_frame -> 'media', '[]'::jsonb)) m), '');
  end if;
  if body = '' then body := '[message]'; end if;
  body := left(body, 10000);

  log_anchor := internal.bridge_log_anchor(b);
  select * into anchor_e from public.entities where id = log_anchor;
  -- A quote of a message we hold threads under its log copy.
  if reply_ext is not null then
    select o.message_id into parent_msg from public.message_origins o
     join public.messages m on m.entity_id = o.message_id and m.anchor_id = log_anchor
     where o.bridge_id = b.entity_id and o.external_message_id = reply_ext
     order by o.direction limit 1;
    if parent_msg is not null then
      select * into parent_row from public.messages where entity_id = parent_msg;
      thread_root := coalesce(parent_row.root_message_id, parent_row.entity_id);
    end if;
  end if;

  ts := case when p_frame ? 'ts' and jsonb_typeof(p_frame -> 'ts') = 'number'
             then to_timestamp((p_frame ->> 'ts')::double precision) end;   -- epoch SECONDS (B1a)
  batch := 'bridge-in:' || b.entity_id || ':' || ext;
  log_id := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (log_id, b.space_id, 'message', parent_msg, null, (author ->> 'actorId')::uuid, anchor_e.visibility);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
  values (log_id, log_anchor, thread_root, (author ->> 'actorId')::uuid, body, batch);

  insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
    external_conversation_id, external_sender_id, external_reply_to_id, external_ts, command_state,
    sender_display, media)
  values (log_id, b.entity_id, conn.id, 'in', ext, conv, sender, reply_ext, ts,
          case when p_command then 'pending' end, sender_name,
          nullif(coalesce(p_frame -> 'media', '[]'::jsonb), '[]'::jsonb));

  -- A command is stored, never routed (§2.3 step 2).
  if p_command then
    return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                              'command', true, 'routed', false);
  end if;

  -- 401 (L, D26, D69): a reply to a post by a live interactive loop session goes
  -- to that session, which becomes its answerer and gains the group as an
  -- origin (D30). Once the session has closed, the chat answers as before.
  if parent_msg is not null
     and (b.policy ->> 'whoMayTrigger' = 'anyone' or author ->> 'kind' = 'member') then
    loop_sid := internal.loop_reply_session(parent_msg);
    if loop_sid is not null then
      select * into sess_e from public.entities where id = loop_sid;
      copy_id := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      values (copy_id, b.space_id, 'message', null, null, (author ->> 'actorId')::uuid, sess_e.visibility);
      insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
      values (copy_id, loop_sid, null, (author ->> 'actorId')::uuid, body, batch);
      perform public.set_bridge_answerer(log_id, loop_sid);
      perform public.add_bridge_origin(loop_sid,
        jsonb_build_object('bridgeId', b.entity_id, 'messageId', log_id, 'providerMessageId', ext,
                           'sender', jsonb_build_object('participant', author -> 'participant',
                             'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
                           'command', null));
      update public.message_origins set routed = true where message_id = log_id;
      return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                                'command', false, 'routed', true, 'copyId', copy_id, 'wakeChat', null,
                                'wakeSession', jsonb_build_object('sessionId', loop_sid), 'author', author);
    end if;
  end if;

  -- Step 5: trigger and whoMayTrigger.
  triggered := case b.policy ->> 'trigger'
    when 'every' then true
    when 'mention' then
         body ~* '(^|[^[:alnum:]_])@tm8([^[:alnum:]_]|$)'
      or exists (select 1 from jsonb_array_elements_text(coalesce(p_frame -> 'mentions', '[]'::jsonb)) j(id)
                  where j.id = any(conn.self_ids))
      or (reply_ext is not null and exists (
            select 1 from public.message_origins o
             where o.bridge_id = b.entity_id and o.external_message_id = reply_ext and o.direction = 'out'))
    else false end;
  allowed := b.policy ->> 'whoMayTrigger' = 'anyone' or author ->> 'kind' = 'member';

  if triggered and allowed and b.target_kind = 'chat' then
    select * into chat_row from public.chats where entity_id = b.target_id;
    select * into target_e from public.entities where id = b.target_id;
    if chat_row.entity_id is not null and target_e.deleted_at is null then
      copy_id := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      values (copy_id, b.space_id, 'message', null, null, (author ->> 'actorId')::uuid, target_e.visibility);
      insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
      values (copy_id, b.target_id, null, (author ->> 'actorId')::uuid, body, batch);
      select e.kind into actor_kind from public.entities e where e.id = (author ->> 'actorId')::uuid;
      insert into public.chat_turns(chat_id, root_message_id, user_message_id, requested_by_member_id,
        requested_by_actor_id, requested_by_session_id, requested_by_chat_id, requested_by_auth_kind,
        mode, pricing_provider, pricing_model, queued_at)
      values (chat_row.entity_id, null, copy_id,
              case when actor_kind = 'member' then (author ->> 'actorId')::uuid end,
              (author ->> 'actorId')::uuid, null, null, null,
              chat_row.chat_mode, chat_row.provider, chat_row.model, now());
      routed := true;
      wake := jsonb_build_object('chatId', chat_row.entity_id, 'identityId', chat_row.configured_by_identity_id);
      -- B1b-3: the chat answers it, and the turn carries the bridge origin (D30).
      perform internal.bridge_try('public.set_bridge_answerer', 'uuid,uuid', log_id::text, b.target_id::text);
      perform internal.bridge_try('public.add_bridge_origin', 'uuid,jsonb', b.target_id::text,
        jsonb_build_object('bridgeId', b.entity_id, 'messageId', log_id, 'providerMessageId', ext,
                           'sender', jsonb_build_object('participant', author -> 'participant',
                             'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
                           'command', null)::text);
    end if;
  end if;
  if routed then
    update public.message_origins set routed = true where message_id = log_id;
  end if;

  return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                            'command', false, 'routed', routed, 'copyId', copy_id, 'wakeChat', wake,
                            'author', author);
end
$$;
revoke all on function public.bridge_runtime_inbound(jsonb, boolean) from public;
grant execute on function public.bridge_runtime_inbound(jsonb, boolean) to tm8_app;

-- The release (D67): every held post whose group is out of quiet hours is
-- sent, newest only (older ones were superseded when it was held). The loops
-- executor calls this each tick.
create or replace function public.loop_release_held(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare h record; delivery jsonb; n integer := 0;
begin
  if not internal.is_loops_worker() then
    raise exception 'held loop posts are released by the loop executor' using errcode = '42501';
  end if;
  for h in
    select hp.*, l.timezone, l.quiet_hours_exempt, b.quiet_hours
      from public.loop_held_posts hp
      join public.loops l on l.entity_id = hp.loop_id
      join public.bridges b on b.entity_id = hp.bridge_id
     order by hp.held_at
     for update of hp skip locked
  loop
    if not h.quiet_hours_exempt and internal.in_quiet_hours(h.quiet_hours, h.timezone, p_now) then continue; end if;
    delete from public.loop_held_posts where loop_id = h.loop_id and bridge_id = h.bridge_id;
    delete from public.bridge_delivery_refusals where message_id = h.message_id and reason = 'quiet_hours';
    delivery := internal.bridge_outbox_enqueue(h.bridge_id, h.message_id, 'send', h.payload,
      h.opts || jsonb_build_object('release', true) || jsonb_strip_nulls(jsonb_build_object('runId', h.run_id)));
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function public.loop_release_held(timestamptz) from public;
grant execute on function public.loop_release_held(timestamptz) to tm8_app;

-- -----------------------------------------------------------------------------
-- §5. Firing: the post action and the agent action's per-target context.
-- -----------------------------------------------------------------------------
-- The caller of a firing door: the loop executor, or the member it fires as.
create or replace function internal.require_loop_firer(p_loop_id uuid) returns public.entities
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = p_loop_id and kind = 'loop' and deleted_at is null;
  if e.id is null then raise exception 'loop % not found', p_loop_id using errcode = 'P0002'; end if;
  if not internal.is_loops_worker() then perform internal.require_space_member(e.space_id); end if;
  return e;
end
$$;
revoke all on function internal.require_loop_firer(uuid) from public;

-- The post action (v2 §2.2): no session. Posts each target's text on the
-- bridge's log anchor, signed by the loop's teammate (else the bridge's), and
-- queues it through the outbox. Idempotent per (run, target).
create or replace function public.loop_post_targets(p_loop_id uuid, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities; l public.loops; t jsonb; b public.bridges; anchor_e public.entities;
  v_text text; v_signer uuid; msg uuid; batch text; delivery jsonb; out jsonb := '[]'::jsonb; result text;
begin
  e := internal.require_loop_firer(p_loop_id);
  select * into l from public.loops where entity_id = p_loop_id;
  if l.action <> 'post' then raise exception 'only a post loop posts directly' using errcode = '22023'; end if;
  if not exists (select 1 from public.loop_runs where id = p_run_id and loop_id = p_loop_id) then
    raise exception 'run % is not this loop''s', p_run_id using errcode = '22023';
  end if;
  for t in select value from jsonb_array_elements(l.targets) loop
    select * into b from public.bridges where entity_id = (t ->> 'bridgeId')::uuid;
    batch := 'loop-post:' || p_run_id || ':' || b.entity_id;
    select m.entity_id into msg from public.messages m where m.message_batch_id = batch limit 1;
    if msg is not null then
      out := out || jsonb_build_array(jsonb_build_object('bridgeId', b.entity_id, 'messageId', msg, 'replayed', true));
      continue;
    end if;
    if b.entity_id is null or b.ended_at is not null then
      perform internal.loop_record_target(p_run_id, p_loop_id, (t ->> 'bridgeId')::uuid, 'refused', 'bridge_ended', null);
      out := out || jsonb_build_array(jsonb_build_object('bridgeId', t ->> 'bridgeId', 'result', 'refused', 'reason', 'bridge_ended'));
      continue;
    end if;
    v_text := left(coalesce(t ->> 'text', nullif(btrim(l.prompt), '')), 9990);
    v_signer := coalesce(l.team_member_id, b.teammate_id);
    if v_text is null or v_signer is null then
      perform internal.loop_record_target(p_run_id, p_loop_id, b.entity_id, 'refused',
        case when v_text is null then 'no_text' else 'no_teammate' end, null);
      out := out || jsonb_build_array(jsonb_build_object('bridgeId', b.entity_id, 'result', 'refused',
        'reason', case when v_text is null then 'no_text' else 'no_teammate' end));
      continue;
    end if;
    select * into anchor_e from public.entities where id = internal.bridge_log_anchor(b);
    msg := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
    values (msg, b.space_id, 'message', null, null, v_signer, anchor_e.visibility);
    insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
    values (msg, anchor_e.id, null, v_signer, v_text, batch);
    perform internal.loop_stamp(msg, jsonb_build_array(jsonb_build_object('loopId', p_loop_id, 'runId', p_run_id,
      'inherited', false, 'viaSessionId', null, 'depth', 0)));
    delivery := internal.bridge_outbox_enqueue(b.entity_id, msg, 'send',
      jsonb_build_object('text', internal.bridge_signed(b, v_signer, null, 'chat', v_text)),
      jsonb_build_object('poster', 'worker', 'teammateId', v_signer, 'directed', false,
                         'loopId', p_loop_id, 'runId', p_run_id));
    result := case delivery ->> 'status' when 'pending' then 'posted' when 'held' then 'held'
                   else case delivery ->> 'reason' when 'bridge_paused' then 'paused' else 'refused' end end;
    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('bridgeId', b.entity_id, 'messageId', msg,
      'result', result, 'reason', delivery ->> 'reason')));
  end loop;
  return out;
end
$$;
revoke all on function public.loop_post_targets(uuid, uuid) from public;
grant execute on function public.loop_post_targets(uuid, uuid) to tm8_app;

-- The agent action's start (v2 §2.2): each target with its own instruction,
-- its state and its recent log, for the worker's launch context. Records
-- `paused` for a paused group (the run goes on) and `pending` for the rest.
create or replace function public.loop_fire_targets(p_loop_id uuid, p_run_id uuid, p_recent integer default 15)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; l public.loops; t jsonb; b public.bridges; out jsonb := '[]'::jsonb; recent jsonb; state text;
begin
  e := internal.require_loop_firer(p_loop_id);
  select * into l from public.loops where entity_id = p_loop_id;
  for t in select value from jsonb_array_elements(l.targets) loop
    select * into b from public.bridges where entity_id = (t ->> 'bridgeId')::uuid;
    if b.entity_id is null then continue; end if;
    state := case when b.ended_at is not null then 'ended'
                  when b.paused_at is not null or b.muted_until > now() then 'paused'
                  when not l.quiet_hours_exempt and internal.in_quiet_hours(b.quiet_hours, l.timezone, now()) then 'quiet'
                  else 'live' end;
    if p_run_id is not null then
      perform internal.loop_record_target(p_run_id, p_loop_id, b.entity_id,
        case state when 'paused' then 'paused' when 'ended' then 'refused' else 'pending' end,
        case state when 'paused' then 'bridge_paused' when 'ended' then 'bridge_ended' end, null);
    end if;
    select coalesce(jsonb_agg(x.j order by x.at), '[]'::jsonb) into recent from (
      select m.created_at as at, jsonb_build_object('messageId', m.entity_id, 'at', m.created_at,
               'from', coalesce(o.sender_display, tm.name, mem.display_name, 'tm8'), 'text', left(m.body, 500)) as j
        from public.messages m
        join public.entities me on me.id = m.entity_id and me.deleted_at is null
        left join public.message_origins o on o.message_id = m.entity_id
        left join public.team_members tm on tm.entity_id = m.author_id
        left join public.members mem on mem.entity_id = m.author_id
       where m.anchor_id = internal.bridge_log_anchor(b)
       order by m.created_at desc limit greatest(least(coalesce(p_recent, 15), 50), 0)) x;
    out := out || jsonb_build_array(jsonb_build_object(
      'bridgeId', b.entity_id, 'name', coalesce(b.conversation ->> 'title', ''), 'purpose', b.purpose,
      'instruction', t ->> 'text', 'state', state, 'quietHours', b.quiet_hours, 'recent', recent));
  end loop;
  return out;
end
$$;
revoke all on function public.loop_fire_targets(uuid, uuid, integer) from public;
grant execute on function public.loop_fire_targets(uuid, uuid, integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. Reply routing (D26, D69): the live interactive loop session that posted
-- the message being replied to, if any.
-- -----------------------------------------------------------------------------
create or replace function internal.loop_reply_session(p_parent_message uuid) returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select r.session_id from public.loop_runs r join public.loops l on l.entity_id = r.loop_id
   where r.session_id = internal.bridge_message_session(p_parent_message)
     and r.launch = 'fired' and r.outcome is null and l.mode = 'interactive'
     and internal.bridge_session_live(r.session_id)
   order by r.fired_at desc limit 1
$$;
revoke all on function internal.loop_reply_session(uuid) from public;

-- -----------------------------------------------------------------------------
-- §7. Provenance (D30, D69): authored_from -> loop.
--
-- 396's index allows ONE unmarked authored_from per source (the session/chat
-- origin), and every reader of that origin filters `not (props ? 'bridgeId')`.
-- A loop edge therefore carries D31's provenance marker as `bridgeId: null`
-- with `loopId` naming its target, and the guard admits exactly that shape.
-- -----------------------------------------------------------------------------
update public.edge_types
   set dst_kinds = array_append(dst_kinds, 'loop')
 where type = 'authored_from' and not ('loop' = any(dst_kinds));
update public.edge_types
   set props_schema = jsonb_set(jsonb_set(props_schema, '{properties,bridgeId}', '{"type": ["string", "null"]}'::jsonb),
                                '{properties,loopId}', '{"type": "string"}'::jsonb)
 where type = 'authored_from';

-- A session's loop lineage: the loop that fired it (depth 0) or that fired an
-- ancestor (inherited, depth + 1). Written by the server only.
create table public.session_loop_origins (
  holder_id      uuid not null references public.entities(id) on delete cascade,
  loop_id        uuid not null references public.loops(entity_id) on delete cascade,
  inherited      boolean not null,
  via_session_id uuid,
  depth          integer not null default 0 check (depth >= 0),
  added_at       timestamptz not null default now(),
  primary key (holder_id, loop_id)
);
create index session_loop_origins_loop_idx on public.session_loop_origins(loop_id);
alter table public.session_loop_origins enable row level security;
create policy session_loop_origins_select on public.session_loop_origins for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = session_loop_origins.holder_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.session_loop_origins to tm8_app;

-- Write (or merge) the authored_from -> loop edge(s) for one entity.
create or replace function internal.loop_stamp(p_entity_id uuid, p_origins jsonb) returns integer
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  e public.entities; o jsonb; existing public.edges; n integer := 0; v_loop uuid;
  -- Runs inside the entities/edges AFTER INSERT triggers: restore the creating
  -- path's writer, never clear it (399's review F1).
  prev_writer text := internal.w1_writer();
begin
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then raise exception 'entity % not found', p_entity_id using errcode = 'P0002'; end if;
  for o in select value from jsonb_array_elements(coalesce(p_origins, '[]'::jsonb)) loop
    v_loop := (o ->> 'loopId')::uuid;
    if v_loop = e.id or not exists (select 1 from public.entities where id = v_loop and space_id = e.space_id) then continue; end if;
    perform internal.w1_set_writer('entity_recorder');
    select * into existing from public.edges where src_id = e.id and dst_id = v_loop and type = 'authored_from' for update;
    if existing.id is null then
      insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
      values (e.space_id, e.id, v_loop, 'authored_from', e.created_by,
              jsonb_build_object('bridgeId', null, 'loopId', v_loop) || (o - 'loopId'))
      on conflict (src_id, dst_id, type) do nothing;
      n := n + 1;
    end if;
    perform internal.w1_set_writer(nullif(prev_writer, ''));
  end loop;
  return n;
end
$$;
revoke all on function internal.loop_stamp(uuid, jsonb) from public;

-- A spawn loop's firing: execution_spawn writes session -triggered_by-> loop
-- in the spawn's transaction (348). That edge gives the session its lineage
-- and its own authored_from -> loop, before the worker can create anything.
-- A dispatch firing's session is the space's shared dispatcher: never.
create or replace function internal.loop_lineage_on_trigger() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.type <> 'triggered_by' then return null; end if;
  if not exists (select 1 from public.entities s where s.id = new.src_id and s.kind = 'work_session') then return null; end if;
  if not exists (select 1 from public.loops l where l.entity_id = new.dst_id and l.action = 'spawn') then return null; end if;
  insert into public.session_loop_origins(holder_id, loop_id, inherited, via_session_id, depth)
  values (new.src_id, new.dst_id, false, null, 0) on conflict do nothing;
  perform internal.loop_stamp(new.src_id, jsonb_build_array(jsonb_build_object('loopId', new.dst_id,
    'inherited', false, 'viaSessionId', null, 'depth', 0)));
  return null;
end
$$;
revoke all on function internal.loop_lineage_on_trigger() from public;
create trigger edges_loop_lineage after insert on public.edges
for each row execute function internal.loop_lineage_on_trigger();

-- The recorder: everything a session holding a loop lineage creates.
create or replace function internal.loop_record_provenance() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare holder uuid; o record; origins jsonb := '[]'::jsonb;
begin
  holder := internal.caller_work_session(new.space_id);
  if holder is null or holder = new.id then return null; end if;
  for o in select * from public.session_loop_origins where holder_id = holder loop
    if new.kind = 'work_session' then
      insert into public.session_loop_origins(holder_id, loop_id, inherited, via_session_id, depth)
      values (new.id, o.loop_id, true, holder, o.depth + 1) on conflict do nothing;
    end if;
    origins := origins || jsonb_build_array(jsonb_build_object('loopId', o.loop_id, 'inherited', true,
      'viaSessionId', holder, 'depth', o.depth + case when new.kind = 'work_session' then 1 else 0 end));
  end loop;
  if jsonb_array_length(origins) > 0 then perform internal.loop_stamp(new.id, origins); end if;
  return null;
end
$$;
revoke all on function internal.loop_record_provenance() from public;
create trigger entities_loop_provenance after insert on public.entities
for each row execute function internal.loop_record_provenance();

-- 399's guard, plus the loop branch (401, marked).
create or replace function internal.guard_authored_from_bridge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare dst_kind text;
begin
  if coalesce(internal.w1_writer(), '') not in ('message_recorder', 'memory_recorder', 'artifact_publisher',
      'form_recorder', 'entity_recorder', 'commit_recorder', 'edge_migration') then
    return new;
  end if;
  select kind into dst_kind from public.entities where id = new.dst_id;
  -- 401 (L): authored_from -> loop carries {bridgeId: null, loopId: <dst>}.
  if dst_kind = 'loop' or new.props ? 'loopId' and jsonb_typeof(new.props -> 'bridgeId') = 'null' then
    if dst_kind is distinct from 'loop' or coalesce(new.props ->> 'loopId', '') <> new.dst_id::text
       or jsonb_typeof(new.props -> 'bridgeId') is distinct from 'null' then
      raise exception 'authored_from -> loop carries {bridgeId: null, loopId: <the loop>}' using errcode = '22023';
    end if;
    return new;
  end if;
  if dst_kind = 'bridge' and coalesce(new.props ->> 'bridgeId', '') <> new.dst_id::text then
    raise exception 'authored_from -> bridge must name the bridge in props.bridgeId'
      using errcode = '22023';
  end if;
  if new.props ? 'bridgeId' then
    if dst_kind is distinct from 'bridge' and dst_kind is distinct from 'message' then
      raise exception 'bridge provenance (props.bridgeId) points at a bridge or a message, not a %', coalesce(dst_kind, 'missing entity')
        using errcode = '22023';
    end if;
    if not exists (select 1 from public.entities
                    where id::text = new.props ->> 'bridgeId' and kind = 'bridge') then
      raise exception 'props.bridgeId must name a bridge' using errcode = '22023';
    end if;
    if jsonb_typeof(new.props -> 'origins') is distinct from 'array' then
      raise exception 'bridge provenance carries origins[]' using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;
revoke all on function internal.guard_authored_from_bridge() from public;

-- -----------------------------------------------------------------------------
-- §8. Authority (D26, D68). A bridge loop's worker acts on its owner's
-- authority with no per-run approval for the granted list; the server's
-- operation gate calls this for the gated list and refuses the operation.
-- The request goes to the owner in tm8, never to a group.
-- -----------------------------------------------------------------------------
-- The bridge loop whose authority the calling session runs under, if any.
create or replace function public.loop_session_authority(p_session_id uuid) returns jsonb
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object('loopId', l.entity_id, 'title', l.title, 'ownerMemberId', l.armed_by_member_id)
    from public.session_loop_origins o
    join public.loops l on l.entity_id = o.loop_id
   where o.holder_id = p_session_id and jsonb_array_length(l.targets) > 0
   order by o.depth, o.added_at limit 1
$$;
revoke all on function public.loop_session_authority(uuid) from public;
grant execute on function public.loop_session_authority(uuid) to tm8_app;

create or replace function public.loop_request_approval(p_session_id uuid, p_operation text, p_summary text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare s public.entities; auth jsonb; r record; v_owner uuid; v_space uuid;
begin
  select * into s from public.entities where id = p_session_id and kind = 'work_session' and deleted_at is null;
  if s.id is null or internal.caller_work_session(s.space_id) is distinct from p_session_id then
    raise exception 'only the session itself asks for its approval' using errcode = '42501';
  end if;
  auth := public.loop_session_authority(p_session_id);
  if auth is null then return null; end if;
  v_space := s.space_id;
  v_owner := nullif(auth ->> 'ownerMemberId', '')::uuid;
  select * into r from internal.raise_attention_signal(v_space, (auth ->> 'loopId')::uuid,
    'loop.approval:' || (auth ->> 'loopId') || ':' || p_session_id || ':' || p_operation,
    left(format('The loop "%s" asks to run %s: %s', auth ->> 'title', p_operation, coalesce(nullif(btrim(p_summary), ''), p_operation)), 500),
    'high', 'decide', coalesce(v_owner, p_session_id), null, p_session_id);
  if v_owner is not null then
    update public.attention_requests set assignee_id = v_owner where id = r.request_id and assignee_id is null;
  end if;
  return jsonb_build_object('requestId', r.request_id, 'created', r.created, 'loopId', auth ->> 'loopId',
                            'ownerMemberId', v_owner);
end
$$;
revoke all on function public.loop_request_approval(uuid, text, text) from public;
grant execute on function public.loop_request_approval(uuid, text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §9. The executor's doors.
-- -----------------------------------------------------------------------------
-- concurrency 'replace': this loop's open runs with a session, to stop first.
create or replace function public.loop_runs_to_replace(p_loop_id uuid)
returns table (run_id uuid, session_id uuid)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select r.id, r.session_id from public.loop_runs r
   where (internal.is_loops_worker() or internal.is_space_member(r.space_id))
     and r.loop_id = p_loop_id and r.launch = 'fired' and r.outcome is null and r.session_id is not null
     and r.action = 'spawn'
   order by r.fired_at
$$;
revoke all on function public.loop_runs_to_replace(uuid) from public;
grant execute on function public.loop_runs_to_replace(uuid) to tm8_app;

-- Interactive runs with nothing addressed to their session for p_idle (D26).
create or replace function public.loop_runs_idle_interactive(p_now timestamptz default now(),
  p_idle interval default interval '30 minutes')
returns table (run_id uuid, loop_id uuid, space_id uuid, session_id uuid, act_as_identity text)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select r.id, r.loop_id, r.space_id, r.session_id,
         coalesce((select m.identity_id from public.members m
                    where m.identity_id = r.acted_as_identity_id and m.space_id = r.space_id and m.status = 'active'),
                  internal.loop_acting_identity(r.loop_id))
    from public.loop_runs r join public.loops l on l.entity_id = r.loop_id
   where internal.is_loops_worker()
     and l.mode = 'interactive' and r.launch = 'fired' and r.outcome is null and r.session_id is not null
     and greatest(r.fired_at,
                  coalesce((select max(a.assigned_at) from public.bridge_message_answerers a
                             where a.answerer_id = r.session_id), r.fired_at)) <= p_now - p_idle
   order by r.fired_at
   limit 200
$$;
revoke all on function public.loop_runs_idle_interactive(timestamptz, interval) from public;
grant execute on function public.loop_runs_idle_interactive(timestamptz, interval) to tm8_app;


-- -----------------------------------------------------------------------------
-- §10. A removed bridge (v2 §2.3, "Removed"): every loop that targets it, or
-- has it as its subject, is disabled (`enabled: false`, `last_error: 'bridge
-- removed'`) and kept, so a human can re-point it. Its targets are left as
-- they were. Disabling is bookkeeping, so the armer stays (343); a human who
-- edits the targets and enables the loop re-arms it as usual.
-- -----------------------------------------------------------------------------
create or replace function internal.loops_on_bridge_removed() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if old.ended_at is null and new.ended_at is not null then
    update public.loops l
       set enabled = false, last_error = 'bridge removed', updated_at = now()
      from public.entities e
     where e.id = l.entity_id and e.deleted_at is null
       and (l.targets @> jsonb_build_array(jsonb_build_object('bridgeId', new.entity_id)) or l.subject_id = new.entity_id)
       and (l.enabled or l.last_error is distinct from 'bridge removed');
  end if;
  return null;
end
$$;
revoke all on function internal.loops_on_bridge_removed() from public;
create trigger bridges_loops_on_removed after update of ended_at on public.bridges
for each row execute function internal.loops_on_bridge_removed();

reset role;

analyze public.loop_run_targets, public.loop_held_posts, public.session_loop_origins;
