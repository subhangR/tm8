-- =============================================================================
-- ROLLBACK for 384_loops_first_class.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 384:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/384_loops_first_class.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '384_loops_first_class.sql'"
--
-- DESTROYS DATA: every loop_runs row, and every loop's action, tool, timezone,
-- pause and policy columns. A tool loop (no 091 meaning) is left as a dispatch
-- loop if it names no runner. Restores the 091 doors, 343's trigger body, 375's
-- due read and 292's header kinds verbatim.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.loop_run_settle(uuid,text,text);
drop function if exists public.loop_run_record(uuid,timestamptz,text,text,integer,text,text,uuid,uuid,text,uuid,text);
drop table if exists public.loop_runs;

drop function if exists public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text,text,uuid,jsonb,text,text,integer,integer,integer);
drop function if exists public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text,text,uuid,boolean,jsonb,text,timestamptz,boolean,text,integer,boolean,integer,integer,integer);
drop function if exists internal.assert_loop_runner(uuid,text,uuid,uuid,text);

-- 343's body, verbatim, before the columns it no longer names are dropped.
create or replace function internal.stamp_loop_armed_by() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_member uuid; v_human boolean; v_content_changed boolean;
begin
  -- Fails closed on every non-human shape: an agent or agent_runtime bearer, a
  -- link session, the in-process scheduler (no claim at all), and an
  -- unrecognised kind are all "not a human bearer".
  v_human := coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
             and coalesce(internal.claim_text('tm8.via_link'), '') = '';

  if tg_op = 'INSERT' then
    if not v_human then return new; end if;
  else
    /*
     * B26: armed_by NAMES THE HUMAN WHO LAST AUTHORISED THE LOOP'S CONTENT,
     * which is stricter than B21's "never cleared" and is the fix for the
     * lead's F2.
     *
     * The hole F2 found: `update_loop` requires only membership (091), so BOB's
     * agent — or Bob himself — could rewrite the prompt, the persona or the
     * subject of a loop ALICE armed, and the firing would run Bob's
     * instructions on Alice's connections. Preserving the stamp across any
     * write is therefore wrong; what matters is whether the CONTENT moved.
     *
     * So: a write that touches only SCHEDULING BOOKKEEPING preserves the stamp
     * — that is the executor's own tick, which advances next_run_at and records
     * the outcome through the same door on every firing. That list is closed and
     * SUBTRACTED from the row rather than compared field by field, so a column
     * added later counts as content until someone adds it to the list.
     *
     * Any other changed column re-stamps to the writer when the writer is a
     * human bearer, and NULLS the stamp when it is not. A NULL means the next
     * firing has no human provenance and is lent nothing, which fails closed
     * until a human re-arms the loop.
     *
     * enabled false -> true is RESUMING, so it counts as content. true -> false
     * only narrows, so it is allowed to keep the stamp.
     */
    /*
     * INVERTED ON PURPOSE (B28): the comparison subtracts the BOOKKEEPING
     * columns and asks whether anything else moved, rather than enumerating the
     * content columns. Listing content would mean a column added to
     * `public.loops` later — or one already there that nobody remembered — read
     * as bookkeeping and silently PRESERVED the stamp, which is the direction
     * that leaks. This way an unlisted column is content, so a new field is
     * safe-by-default and only an explicit addition to the bookkeeping list can
     * make it harmless.
     *
     * BOOKKEEPING is what the executor's tick writes through the same door on
     * every firing: next_run_at, last_run_at, last_error, updated_at. That is
     * the whole set on 091's table today — there are no lease or run-count
     * columns — and `armed_by_*` are subtracted because this trigger is what
     * writes them, so their own change must not count as content. `enabled` is
     * subtracted and judged separately: false -> true is RESUMING, which is
     * authorising the content again, while true -> false only narrows.
     */
    v_content_changed :=
         (to_jsonb(new) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'armed_by_member_id' - 'armed_by_identity_id')
      is distinct from
         (to_jsonb(old) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'armed_by_member_id' - 'armed_by_identity_id')
      or (new.enabled and not old.enabled);
    if not v_content_changed then
      -- Bookkeeping only (last_run_at, next_run_at, last_error, updated_at, or
      -- a pause): whoever wrote it, the stamp stands.
      new.armed_by_member_id := old.armed_by_member_id;
      new.armed_by_identity_id := old.armed_by_identity_id;
      return new;
    end if;
    if not v_human then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
      return new;
    end if;
  end if;

  select space_id into v_space from public.entities where id = new.entity_id;
  if v_space is null then return new; end if;
  -- Pinned (227): a space-pinned session resolves a member only for its pin, so
  -- this can never stamp a member of a Space the caller is not acting in.
  v_member := internal.current_member_id(v_space);
  if v_member is null then
    -- A human bearer who is not a member of this Space cannot have authorised
    -- the content either. Fail closed rather than leave a stale stamp.
    if tg_op <> 'INSERT' then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
    end if;
    return new;
  end if;
  new.armed_by_member_id := v_member;
  new.armed_by_identity_id := internal.identity_id();
  return new;
end
$$;

alter table public.loops disable trigger loops_stamp_armed_by;
alter table public.loops disable trigger loops_touch_updated_at;
alter table public.loops disable trigger loops_w2_snapshot_version;
alter table public.loops
  drop column action, drop column tool_id, drop column tool_inputs, drop column timezone,
  drop column paused_until, drop column armed_at, drop column concurrency,
  drop column max_runtime_seconds, drop column retry_attempts,
  drop column retry_delay_seconds, drop column retry_attempt;
alter table public.loops enable trigger loops_w2_snapshot_version;
alter table public.loops enable trigger loops_touch_updated_at;
alter table public.loops enable trigger loops_stamp_armed_by;

-- 091's doors, verbatim.
create or replace function public.create_loop(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_schedule text default null, p_team_member_id uuid default null,
  p_subject_id uuid default null, p_prompt text default '',
  p_config jsonb default '{}'::jsonb, p_enabled boolean default true,
  p_next_run_at timestamptz default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  loop_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'loop title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_schedule, ''))) not between 1 and 200 then
    raise exception 'loop schedule is required (1..200 chars after trim)' using errcode = '22023';
  end if;

  -- Both references must live in THIS space. Without these two checks a loop
  -- could name a teammate or a subject from another space and fire across the
  -- boundary every period, under the loop creator's authority — a scheduled
  -- confused deputy. The FKs alone do not say "same space".
  if p_team_member_id is not null then
    perform 1 from public.entities e
      where e.id = p_team_member_id and e.space_id = p_space_id
        and e.kind = 'team_member' and e.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities e
      where e.id = p_subject_id and e.space_id = p_space_id and e.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;

  loop_id := internal.create_envelope(p_space_id, 'loop', actor, p_parent_id, p_position);
  insert into public.loops(entity_id, title, schedule, team_member_id, subject_id, prompt,
                           config, enabled, next_run_at)
  values (loop_id, btrim(p_title), btrim(p_schedule), p_team_member_id, p_subject_id,
          coalesce(p_prompt, ''), coalesce(p_config, '{}'::jsonb),
          coalesce(p_enabled, true), p_next_run_at);
  perform internal.record_initial_version(loop_id, actor);

  activity_id := internal.record_activity(p_space_id, loop_id, actor, 'created',
                   null, jsonb_build_object('kind', 'loop'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(loop_id, null, activity_id, array[loop_id]));
end
$$;

create or replace function public.update_loop(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_schedule text default null,
  p_team_member_id uuid default null, p_clear_team_member boolean default false,
  p_subject_id uuid default null, p_clear_subject boolean default false,
  p_prompt text default null, p_config jsonb default null,
  p_enabled boolean default null,
  p_next_run_at timestamptz default null, p_clear_next_run_at boolean default false,
  p_last_run_at timestamptz default null,
  p_last_error text default null, p_clear_last_error boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'loop');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_schedule is not null and length(btrim(p_schedule)) not between 1 and 200 then
    raise exception 'loop schedule must be 1..200 chars after trim' using errcode = '22023';
  end if;
  -- Same-space containment as the create door: a patch is just as capable of
  -- pointing a loop across a space boundary as a create is.
  if p_team_member_id is not null then
    perform 1 from public.entities tm
      where tm.id = p_team_member_id and tm.space_id = e.space_id
        and tm.kind = 'team_member' and tm.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities s
      where s.id = p_subject_id and s.space_id = e.space_id and s.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'loop title must be 1..200 chars after trim' using errcode = '22023';
  end if;

  update public.loops
     set title          = coalesce(btrim(p_title), title),
         schedule       = coalesce(btrim(p_schedule), schedule),
         team_member_id = case when p_clear_team_member then null
                               else coalesce(p_team_member_id, team_member_id) end,
         subject_id     = case when p_clear_subject then null
                               else coalesce(p_subject_id, subject_id) end,
         prompt         = coalesce(p_prompt, prompt),
         config         = coalesce(p_config, config),
         enabled        = coalesce(p_enabled, enabled),
         next_run_at    = case when p_clear_next_run_at then null
                               else coalesce(p_next_run_at, next_run_at) end,
         last_run_at    = coalesce(p_last_run_at, last_run_at),
         last_error     = case when p_clear_last_error then null
                                else coalesce(p_last_error, last_error) end,
         updated_at     = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'loop')), array[p_entity_id]));
end
$$;

revoke all on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text) from public;
grant execute on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text) to tm8_app;
revoke all on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text) from public;
grant execute on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text) to tm8_app;


-- 375's due read, verbatim.
create or replace function public.loops_due_for_executor(p_limit integer default 25)
returns table (
  entity_id        uuid,
  space_id         uuid,
  title            text,
  schedule         text,
  team_member_id   uuid,
  subject_id       uuid,
  prompt           text,
  config           jsonb,
  version          integer,
  act_as_identity  text
)
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select l.entity_id,
         e.space_id,
         l.title,
         l.schedule,
         l.team_member_id,
         l.subject_id,
         l.prompt,
         l.config,
         e.version,
         coalesce(
           -- 1. the human who armed the schedule (343), still an active member.
           (select m.identity_id
              from public.members m
             where m.identity_id = l.armed_by_identity_id
               and m.space_id = e.space_id
               and m.status = 'active'),
           -- 2. else the space owner, so the loop outlives whoever armed it.
           (select m.identity_id
              from public.members m
             where m.space_id = e.space_id
               and m.role = 'owner'
               and m.status = 'active'
             order by m.entity_id
             limit 1)
         ) act_as_identity
    from public.loops l
    join public.entities e on e.id = l.entity_id
   where internal.is_loops_worker()
     and l.enabled
     and e.deleted_at is null
     and l.next_run_at is not null
     and l.next_run_at <= now()
   order by l.next_run_at
   limit greatest(coalesce(p_limit, 25), 0)
$$;

-- 292's header kinds, verbatim.
create or replace function internal.header_kind_allowed(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('team_member', 'doc', 'artifact', 'drawing', 'file', 'task', 'collection', 'story')
$$;

reset role;
