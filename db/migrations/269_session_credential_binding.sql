-- =============================================================================
-- 269 — R2: every session records its credential binding (credentials
-- release 1, stage S1; spec doc 01a0e248 §4 R2, §9 gates 1-2, §11 row S1;
-- task 01a0e268-0cb3). PROVISIONAL NUMBER: the integration coordinator
-- renumbers at merge.
--
-- RELEASE 1 IS ADDITIVE. The member and node rungs keep working; a session on
-- them records `legacy`. Nothing here refuses a launch that ran before.
--
-- WHAT LANDS
--   1. work_sessions.credential_binding
--        pending    minted, credentials not yet resolved (agent sessions only)
--        bound      every provider the session used names a space credential:
--                   one session_space_credentials row AND one `runs_on` edge each
--        none       needs no vendor credential, with credential_none_reason
--        unrecorded minted before this migration; we do not know what it ran on
--        legacy     ran on a rung release 2 removes (member or node)
--      plus credential_none_reason (`none` <=> a non-empty reason).
--   2. The mint: a BEFORE INSERT trigger fills the binding by session kind —
--      agent -> pending; shell -> none/'shell'; credential (a vendor login
--      terminal) -> none/'credential_login'; container_exec -> none/'container_exec'.
--      It does the mint's job for all four mints (execution_spawn 267,
--      start_shell_session 101, start_credential_session 183,
--      start_space_credential_login 239) and any future one, without copying
--      a mint body, so none of those functions is in the collision surface.
--   3. A guard: a session cannot go spawning -> running|idle while `pending`,
--      and re-entering `spawning` (resume, execution_resume 062) resets an
--      agent session to `pending`, so a resume must record its binding again.
--      The binding itself has one writer, internal.settle_credential_binding.
--   4. `runs_on` (work_session -> credential), a registered edge type.
--   5. The redefined record_session_manifest (206's body) settles the binding
--      from the manifest's launch block by the roll-up below;
--      record_session_credential_binding is resume's writer (resume does not
--      re-record the manifest row).
--   6. credential_binding_sweep(): reaps `pending` past a grace (those sessions
--      can never run), and REPORTS gate-1 violations without killing anything.
--   7. Two one-time data steps: the fenced legacy backfill, and the projection
--      of runs_on edges for the session_space_credentials rows that already
--      exist. They are counted separately (see §8 and §9).
--
-- THE ROLL-UP (spec §4 rule 0, pinned by the chat). Over EVERY provider key in
-- manifest->'launch'->'effectiveCredentialSources' (openai included):
--   any value member|node      -> legacy
--   every value space, each with its session_space_credentials row -> bound
--   empty map, tool echo-agent -> none/'echo-agent'
--   empty map, any other tool  -> refused (22023). Unreachable: every resolver
--                                 branch records the rung it used (S1 makes
--                                 the pre-space and link-bound gemini branches
--                                 record theirs), and github is always
--                                 resolved or the launch throws. A test
--                                 enumerates the branches. Prod evidence
--                                 (operator dry run, tm8_prod, 2026-09-27
--                                 ~10:58Z): no_effective_map was 1121 at
--                                 10:00 and 1121 at 10:58, and each of the
--                                 4 manifests written in between is mapped;
--                                 the 1121 are all pre-D9 and stay
--                                 `unrecorded`.
-- The path is `launch`, not `agent`: composeManifest writes
-- effectiveCredentialSources inside `launch:`; `agent:` is the persona. The
-- spec's first text said `agent`, which matches no row (measured on the 09-24
-- prod copy: 0 of 1124). Corrected in the spec, credited to this lane.
--
-- ECHO-AGENT is `legacy` (or `bound` if github is on space) in R1, and `none`
-- only after S4. Until isolation is unconditional an echo-agent session can
-- still reach a member token through its github resolution, so writing `none`
-- in R1 would claim "no credential reach" before the code makes that true.
--
-- `legacy` IS NEVER A FALLBACK. It is written only from a recorded member or
-- node rung: at bind time by the roll-up, or once, below, from a manifest that
-- records one. A manifest with no record stays `unrecorded` forever. Release 2
-- refuses `legacy` at the mint and in the recorder (a refusal plus a test, not
-- a CHECK: a CHECK cannot tell a new row from an old one).
--
-- runs_on VERSUS session_space_credentials (coordinator ruling). The TABLE is
-- the authoritative per-provider record; the EDGE is its graph-visible
-- projection. The edge is written only by the AFTER trigger on the table, in
-- the row's own statement and therefore its transaction: an insert projects
-- the edge, a re-point moves it, a delete removes it. That covers every writer
-- the table has — internal.record_session_space_credential (239),
-- repoint_session_space_credentials (206/239/255), the FK cascades — and any
-- future one, without redefining those bodies. Nothing else inserts, updates
-- or deletes a runs_on edge: the edge guard admits a write only while the
-- transaction-local GUC tm8.runs_on_write is 'on', and the projection restores
-- the previous value before it returns (so a later statement in the same
-- transaction cannot write one), or the delete is an FK cascade whose endpoint
-- or space is already gone. DEFERRED constraint triggers on both tables make "a row
-- without its edge" and "an edge without its row" fail at commit. The edge
-- survives a revoke, because 206 keeps revoked rows as tombstones.
--
-- runs_on DOES NOT MOVE activity_at (chat decision: EXCLUDE). Home sorts by
-- activity and lists credentials, and a credential's activity should mean a
-- person acted on it; the launch is already recorded on the session.
--
-- SHARED OBJECTS (register doc 01a0e26b; base = the LATEST definer, grepped
-- over every migration):
--   public.record_session_manifest(uuid,jsonb,text[],text,text,text)
--       base 206 §10. Delta: after the space-credential loop, calls
--       internal.settle_credential_binding and returns credentialBinding.
--   internal.touch_edge_activity()  (the function; its trigger is untouched)
--       base 001:851-865. Delta: ONE guard block at the top that returns early
--       when the edge is runs_on (on UPDATE, only when both rows are runs_on);
--       nothing else in the body changed.
--   public.work_sessions      ADD columns, checks, two new triggers.
--   public.edges              six new triggers, all WHEN type = 'runs_on': the
--                             write guard and the deferred pairing check, one
--                             per event (insert/update/delete);
--                             guard_w1_edge (211) is NOT redefined.
--   public.session_space_credentials  two new triggers (projection, pairing).
--   public.edge_types         one row, runs_on.
-- NOT redefined: execution_spawn (267), start_shell_session (101),
-- internal.record_session_space_credential (239),
-- repoint_session_space_credentials (255), guard_w1_edge (211).
--
-- DEPLOY WINDOW. Live sessions at migrate time are `unrecorded` or `legacy`;
-- the guard fires only on a status change out of `spawning` while `pending`,
-- so none of them is blocked. The new server writes the binding before every
-- spawning -> running transition (spawn: record_session_manifest; resume:
-- record_session_credential_binding, both before the PTY exists). An OLDER
-- server binary against this schema would leave a resume at `pending`, which
-- the guard refuses to run and the sweep reaps: acceptable only because the
-- migration and the code deploy together.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns. The default fills every existing row with `unrecorded` without a
--    rewrite; it is dropped after the backfill, so from here on only the mint
--    trigger (2) chooses the first value.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  add column credential_binding text not null default 'unrecorded',
  add column credential_none_reason text,
  add constraint work_sessions_credential_binding_check
    check (credential_binding in ('pending', 'bound', 'none', 'unrecorded', 'legacy')),
  add constraint work_sessions_credential_none_reason_check
    check ((credential_binding = 'none') = (credential_none_reason is not null)
           and (credential_none_reason is null or length(btrim(credential_none_reason)) > 0)),
  add constraint work_sessions_credential_pending_agent_check
    check (credential_binding <> 'pending' or session_kind = 'agent');

grant select (credential_binding, credential_none_reason) on public.work_sessions to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. The mint.
-- -----------------------------------------------------------------------------
create or replace function internal.credential_binding_at_mint() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.session_kind = 'agent' then
    if new.credential_binding is not null and new.credential_binding <> 'pending' then
      raise exception 'an agent session is minted pending; its binding is recorded when its credentials resolve'
        using errcode = '23514';
    end if;
    new.credential_binding := 'pending';
    new.credential_none_reason := null;
  else
    if new.credential_binding is not null and new.credential_binding <> 'none' then
      raise exception 'a % session needs no vendor credential and is minted none', new.session_kind
        using errcode = '23514';
    end if;
    new.credential_binding := 'none';
    new.credential_none_reason := case new.session_kind
      when 'shell' then 'shell'
      when 'credential' then 'credential_login'
      else new.session_kind end;
  end if;
  return new;
end
$$;

create trigger work_sessions_credential_binding_at_mint
before insert on public.work_sessions
for each row execute function internal.credential_binding_at_mint();

-- -----------------------------------------------------------------------------
-- 3. The guard: one writer for the binding, pending cannot run, resume resets.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_credential_binding() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.status = 'spawning' and old.status is distinct from 'spawning'
     and new.session_kind = 'agent' then
    -- Resume (062 is the only path back into spawning): the new run records
    -- its own binding, so the old one cannot vouch for it.
    new.credential_binding := 'pending';
    new.credential_none_reason := null;
  elsif (new.credential_binding, new.credential_none_reason)
          is distinct from (old.credential_binding, old.credential_none_reason)
        and coalesce(current_setting('tm8.credential_binding_write', true), '') <> 'on' then
    raise exception 'work_session.credential_binding has a single writer: its credential recorder'
      using errcode = '42501';
  end if;
  if new.credential_binding = 'unrecorded' and old.credential_binding is distinct from 'unrecorded' then
    raise exception 'unrecorded is the value of a session minted before 269; nothing writes it'
      using errcode = '23514';
  end if;
  if new.status in ('running', 'idle') and new.status is distinct from old.status
     and new.credential_binding = 'pending' then
    raise exception 'a session cannot run before it records the credential it runs on'
      using errcode = '23514',
            detail = jsonb_build_object('reason', 'credential_binding_pending')::text;
  end if;
  return new;
end
$$;

create trigger work_sessions_credential_binding_guard
before update on public.work_sessions
for each row execute function internal.guard_credential_binding();

-- -----------------------------------------------------------------------------
-- 4. runs_on.
-- -----------------------------------------------------------------------------
insert into public.edge_types (type, src_kinds, dst_kinds, description, props_schema, acyclic, append_only) values
  ('runs_on', array['work_session'], array['credential'],
   'This session runs on that credential. The graph projection of a session_space_credentials row, '
   || 'written only by that table''s trigger (269); props.provider names the provider.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'provider', jsonb_build_object('type', 'string')),
    'additionalProperties', false),
   false, false)
on conflict (type) do nothing;

-- The edge guard: no runs_on write outside the projection.
create or replace function internal.guard_runs_on_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if coalesce(current_setting('tm8.runs_on_write', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE'
     and (not exists (select 1 from public.entities where id = old.src_id)
          or not exists (select 1 from public.entities where id = old.dst_id)
          or not exists (select 1 from public.spaces where id = old.space_id)) then
    -- An FK cascade: an endpoint or the space is already gone.
    return old;
  end if;
  raise exception 'runs_on edges are written only by the session credential record'
    using errcode = '42501', detail = 'runs_on_edge_owned';
end
$$;

-- One trigger per event: an INSERT trigger's WHEN cannot read OLD, nor a
-- DELETE trigger's NEW.
create trigger edges_runs_on_guard_insert
before insert on public.edges
for each row when (new.type = 'runs_on')
execute function internal.guard_runs_on_edge();
create trigger edges_runs_on_guard_update
before update on public.edges
for each row when (new.type = 'runs_on' or old.type = 'runs_on')
execute function internal.guard_runs_on_edge();
create trigger edges_runs_on_guard_delete
before delete on public.edges
for each row when (old.type = 'runs_on')
execute function internal.guard_runs_on_edge();

-- The projection. SECURITY DEFINER: the table's writers are definers already,
-- and the edge write must not depend on the caller's grants. The GUC is
-- restored to its previous value before returning.
create or replace function internal.project_runs_on_edge() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_prev text := coalesce(current_setting('tm8.runs_on_write', true), '');
begin
  perform set_config('tm8.runs_on_write', 'on', true);
  begin
    if tg_op in ('DELETE', 'UPDATE') then
      delete from public.edges
       where src_id = old.work_session_id and dst_id = old.space_credential_id and type = 'runs_on'
         and (tg_op = 'DELETE' or old.space_credential_id is distinct from new.space_credential_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
      values (new.space_id, new.work_session_id, new.space_credential_id, 'runs_on',
              jsonb_build_object('provider', new.provider), new.work_session_id)
      on conflict (src_id, dst_id, type) do nothing;
    end if;
  exception when others then
    perform set_config('tm8.runs_on_write', v_prev, true);
    raise;
  end;
  perform set_config('tm8.runs_on_write', v_prev, true);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger session_space_credentials_project_runs_on
after insert or update of space_credential_id or delete on public.session_space_credentials
for each row execute function internal.project_runs_on_edge();

-- The pairing, checked at commit: a row without its edge, or an edge without
-- its row, cannot be committed by any path.
create or replace function internal.check_runs_on_pairing() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_session uuid;
  v_credential uuid;
  v_row boolean;
  v_edge boolean;
begin
  if tg_table_name = 'edges' then
    if tg_op = 'DELETE' then v_session := old.src_id; v_credential := old.dst_id;
    else v_session := new.src_id; v_credential := new.dst_id; end if;
  else
    if tg_op = 'DELETE' then v_session := old.work_session_id; v_credential := old.space_credential_id;
    else v_session := new.work_session_id; v_credential := new.space_credential_id; end if;
  end if;
  select exists (select 1 from public.session_space_credentials
                  where work_session_id = v_session and space_credential_id = v_credential)
    into v_row;
  select exists (select 1 from public.edges
                  where src_id = v_session and dst_id = v_credential and type = 'runs_on')
    into v_edge;
  if v_row and not v_edge then
    raise exception 'session % records credential % without its runs_on edge', v_session, v_credential
      using errcode = '23514';
  end if;
  if v_edge and not v_row then
    raise exception 'runs_on edge from session % to credential % has no session_space_credentials row',
      v_session, v_credential using errcode = '23514';
  end if;
  return null;
end
$$;

create constraint trigger session_space_credentials_runs_on_pairing
after insert or update or delete on public.session_space_credentials
deferrable initially deferred
for each row execute function internal.check_runs_on_pairing();
create constraint trigger edges_runs_on_pairing_insert
after insert on public.edges
deferrable initially deferred
for each row when (new.type = 'runs_on')
execute function internal.check_runs_on_pairing();
create constraint trigger edges_runs_on_pairing_update
after update on public.edges
deferrable initially deferred
for each row when (new.type = 'runs_on' or old.type = 'runs_on')
execute function internal.check_runs_on_pairing();
create constraint trigger edges_runs_on_pairing_delete
after delete on public.edges
deferrable initially deferred
for each row when (old.type = 'runs_on')
execute function internal.check_runs_on_pairing();

-- -----------------------------------------------------------------------------
-- 5. internal.touch_edge_activity: 001:851-865 copied verbatim, same language
--    and search_path; the ONLY change is the guard block marked ADDED IN 269
--    at the top. The trigger edges_touch_activity (001:866) is untouched: it
--    stays one AFTER INSERT OR UPDATE OR DELETE trigger (a WHEN cannot read
--    NEW on its DELETE arm, and dropping or splitting that arm would stop
--    activity moving when any edge is removed).
--    OLD reads as NULL on INSERT and NEW reads as NULL on DELETE, in PG11 and
--    later, so the guard reads both without raising. Do not wrap it in tg_op
--    branches to avoid `record "old" is not assigned yet`; that failure cannot
--    happen here.
-- -----------------------------------------------------------------------------
create or replace function internal.touch_edge_activity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- ADDED IN 269. runs_on moves neither end's activity_at. An UPDATE is
  -- skipped only when both rows are runs_on; a retype still moves both ends.
  if (tg_op = 'INSERT' or old.type = 'runs_on')
     and (tg_op = 'DELETE' or new.type = 'runs_on') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op in ('DELETE','UPDATE') then
    update public.entities set activity_at = now()
     where id in (old.src_id, old.dst_id) and deleted_at is null;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.entities set activity_at = now()
     where id in (new.src_id, new.dst_id) and deleted_at is null;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The roll-up, and the one writer of the binding.
-- -----------------------------------------------------------------------------
create or replace function internal.settle_credential_binding(p_session_id uuid, p_launch jsonb)
returns text
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_ws public.work_sessions;
  v_effective jsonb := p_launch -> 'effectiveCredentialSources';
  v_ids jsonb := p_launch -> 'spaceCredentialIds';
  v_binding text;
  v_reason text;
  v_provider text;
  v_source text;
  v_prev text;
begin
  select * into v_ws from public.work_sessions where entity_id = p_session_id for update;
  if v_ws.entity_id is null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;
  -- Only an agent session in its spawn/resume window settles. Anything else
  -- keeps the value it has (a shell is none from its mint; a finished run
  -- keeps what it ran on).
  if v_ws.session_kind <> 'agent' or v_ws.status <> 'spawning' then
    return v_ws.credential_binding;
  end if;

  if v_effective is not null and jsonb_typeof(v_effective) <> 'object' then
    raise exception 'manifest launch.effectiveCredentialSources must be an object' using errcode = '22023';
  end if;
  for v_provider, v_source in select key, value from jsonb_each_text(coalesce(v_effective, '{}'::jsonb)) loop
    if v_source is null or v_source not in ('member', 'node', 'space') then
      raise exception 'manifest launch.effectiveCredentialSources.% is not a credential source', v_provider
        using errcode = '22023';
    end if;
  end loop;

  if v_effective is null or v_effective = '{}'::jsonb then
    if p_launch ->> 'tool' = 'echo-agent' then
      v_binding := 'none';
      v_reason := 'echo-agent';
    else
      raise exception 'manifest records no credential source for any provider, so the session''s binding cannot be recorded'
        using errcode = '22023';
    end if;
  elsif exists (select 1 from jsonb_each_text(v_effective) s where s.value in ('member', 'node')) then
    -- The pessimistic roll-up: one provider on a removed rung is enough.
    v_binding := 'legacy';
  else
    for v_provider in select key from jsonb_each_text(v_effective) loop
      if not exists (select 1 from public.session_space_credentials ssc
                      where ssc.work_session_id = p_session_id and ssc.provider = v_provider
                        and ssc.space_credential_id::text = (v_ids ->> v_provider)) then
        raise exception 'manifest names space as the % source without a recorded space credential', v_provider
          using errcode = '22023';
      end if;
    end loop;
    v_binding := 'bound';
  end if;

  v_prev := coalesce(current_setting('tm8.credential_binding_write', true), '');
  perform set_config('tm8.credential_binding_write', 'on', true);
  update public.work_sessions
     set credential_binding = v_binding, credential_none_reason = v_reason
   where entity_id = p_session_id;
  perform set_config('tm8.credential_binding_write', v_prev, true);
  return v_binding;
end
$$;
revoke all on function internal.settle_credential_binding(uuid, jsonb) from public;

-- Resume's writer: resume re-resolves and re-points its rows (255) but does
-- not re-record the manifest row, so it records the binding here, before the
-- PTY exists.
create or replace function public.record_session_credential_binding(p_session_id uuid, p_launch jsonb)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_status text;
  v_binding text;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_launch is null or jsonb_typeof(p_launch) <> 'object' then
    raise exception 'launch must be an object' using errcode = '22023';
  end if;
  select status into v_status from public.work_sessions where entity_id = p_session_id;
  if v_status is distinct from 'spawning' then
    raise exception 'a credential binding is recorded only while a session is spawning'
      using errcode = '55000';
  end if;
  v_binding := internal.settle_credential_binding(p_session_id, p_launch);
  return jsonb_build_object('workSessionId', p_session_id, 'credentialBinding', v_binding);
end
$$;
revoke all on function public.record_session_credential_binding(uuid, jsonb) from public;
grant execute on function public.record_session_credential_binding(uuid, jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- 7. The sweep (gate 2). Node admin only. Reaps `pending` past the grace —
--    such a session never reached its PTY and the guard will not let it run —
--    by writing a failed ending exactly as work_session_transition does, and
--    REPORTS the other violations without killing anything (R1 is additive).
--    Pre-269 `unrecorded` sessions are not violations.
-- -----------------------------------------------------------------------------
create or replace function public.credential_binding_sweep(
  p_grace interval default interval '10 minutes', p_limit integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_reaped uuid[];
  v_violations jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;

  with stale as (
    select ws.entity_id
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id and e.deleted_at is null
     where ws.session_kind = 'agent' and ws.status = 'spawning'
       and ws.credential_binding = 'pending'
       and ws.status_changed_at < now() - coalesce(p_grace, interval '10 minutes')
     order by ws.entity_id
     limit v_limit
     for update of ws skip locked
  )
  select coalesce(array_agg(entity_id), array[]::uuid[]) into v_reaped from stale;

  if cardinality(v_reaped) > 0 then
    perform set_config('tm8.work_session_transition', 'on', true);
    update public.work_sessions
       set status = 'failed',
           error = coalesce(error, 'credential binding sweep: the launch never recorded the credential it runs on'),
           ended_kind = coalesce(ended_kind, 'unknown'),
           ended_reason = coalesce(ended_reason, 'Stopped because its launch never recorded which credential it runs on.'),
           exited_at = coalesce(exited_at, now())
     where entity_id = any(v_reaped);
    perform set_config('tm8.work_session_transition', 'off', true);
    update public.entities
       set version = version + 1, activity_at = now(), updated_at = now()
     where id = any(v_reaped);
  end if;

  select coalesce(jsonb_agg(v.row order by v.work_session_id, v.problem), '[]'::jsonb) into v_violations
    from (
      select ws.entity_id as work_session_id, 'pending' as problem,
             jsonb_build_object('workSessionId', ws.entity_id, 'status', ws.status,
                                'credentialBinding', ws.credential_binding, 'problem', 'pending') as row
        from public.work_sessions ws
       where ws.session_kind = 'agent' and ws.status in ('running', 'idle')
         and ws.credential_binding = 'pending'
      union all
      select ws.entity_id, 'bound_without_row',
             jsonb_build_object('workSessionId', ws.entity_id, 'status', ws.status,
                                'credentialBinding', ws.credential_binding, 'problem', 'bound_without_row',
                                'provider', src.key)
        from public.work_sessions ws
        join public.session_manifests sm on sm.work_session_id = ws.entity_id
        cross join lateral jsonb_each_text(
          case when jsonb_typeof(sm.manifest #> '{launch,effectiveCredentialSources}') = 'object'
               then sm.manifest #> '{launch,effectiveCredentialSources}' else '{}'::jsonb end) src
       where ws.status in ('spawning', 'running', 'idle') and ws.credential_binding = 'bound'
         and not exists (select 1 from public.session_space_credentials ssc
                          where ssc.work_session_id = ws.entity_id and ssc.provider = src.key)
      union all
      select ws.entity_id, 'bound_without_any_row',
             jsonb_build_object('workSessionId', ws.entity_id, 'status', ws.status,
                                'credentialBinding', ws.credential_binding, 'problem', 'bound_without_any_row')
        from public.work_sessions ws
       where ws.status in ('spawning', 'running', 'idle') and ws.credential_binding = 'bound'
         and not exists (select 1 from public.session_space_credentials ssc
                          where ssc.work_session_id = ws.entity_id)
      union all
      select ssc.work_session_id, 'row_without_edge',
             jsonb_build_object('workSessionId', ssc.work_session_id, 'status', ws.status,
                                'credentialBinding', ws.credential_binding, 'problem', 'row_without_edge',
                                'provider', ssc.provider, 'credentialId', ssc.space_credential_id)
        from public.session_space_credentials ssc
        join public.work_sessions ws on ws.entity_id = ssc.work_session_id
       where ws.status in ('spawning', 'running', 'idle')
         and not exists (select 1 from public.edges ed
                          where ed.src_id = ssc.work_session_id and ed.dst_id = ssc.space_credential_id
                            and ed.type = 'runs_on')
      limit v_limit
    ) v;

  return jsonb_build_object('reaped', to_jsonb(v_reaped), 'violations', v_violations);
end
$$;
revoke all on function public.credential_binding_sweep(interval, integer) from public;
grant execute on function public.credential_binding_sweep(interval, integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- 8. ONE-TIME DATA STEP: the fenced legacy backfill. On tm8_prod at ~10:58Z
--    2026-09-27 the dry run (db/reports/269_backfill_dry_run.sql) counted
--    245 legacy, 1121 no map, 0 all-space, 0 unrecognized, of 1366 manifests.
--    Not a function, not
--    shared with the mint or the recorder, and it never runs again. The
--    predicate between the markers is copied VERBATIM into the operator's
--    read-only report; a test compares the two texts.
-- -----------------------------------------------------------------------------
-- BEGIN 269 BACKFILL PREDICATE
with manifest_rollup as (
  select sm.work_session_id,
         case
           when jsonb_typeof(sm.manifest #> '{launch,effectiveCredentialSources}') is distinct from 'object'
             or sm.manifest #> '{launch,effectiveCredentialSources}' = '{}'::jsonb
             then 'no_effective_map'
           when exists (select 1 from jsonb_each_text(sm.manifest #> '{launch,effectiveCredentialSources}') src
                         where src.value in ('member', 'node'))
             then 'any_used_provider_on_removed_rung'
           when not exists (select 1 from jsonb_each_text(sm.manifest #> '{launch,effectiveCredentialSources}') src
                             where src.value is distinct from 'space')
             then 'every_used_provider_names_a_credential'
           else 'unrecognized_source'
         end as bucket
    from public.session_manifests sm
)
-- END 269 BACKFILL PREDICATE
update public.work_sessions ws
   set credential_binding = 'legacy'
  from manifest_rollup r
 where r.work_session_id = ws.entity_id
   and r.bucket = 'any_used_provider_on_removed_rung'
   and ws.credential_binding = 'unrecorded';

alter table public.work_sessions alter column credential_binding drop default;

-- -----------------------------------------------------------------------------
-- 9. ONE-TIME DATA STEP: project a runs_on edge for every existing
--    session_space_credentials row (3 on tm8_prod, dry run 2026-09-27 ~10:58Z). Transcription of
--    the authoritative row, not invention; counted apart from the backfill.
-- -----------------------------------------------------------------------------
do $$
begin
  perform set_config('tm8.runs_on_write', 'on', true);
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  select ssc.space_id, ssc.work_session_id, ssc.space_credential_id, 'runs_on',
         jsonb_build_object('provider', ssc.provider), ssc.work_session_id
    from public.session_space_credentials ssc
  on conflict (src_id, dst_id, type) do nothing;
  perform set_config('tm8.runs_on_write', '', true);
end
$$;

reset role;

-- -----------------------------------------------------------------------------
-- 10. record_session_manifest, re-created OUTSIDE tm8_graph_owner (199 created
--     it as the migration role; 206 re-created it the same way). The body up
--     to the marked block is 206's verbatim.
-- -----------------------------------------------------------------------------
create or replace function public.record_session_manifest(
  p_session_id uuid, p_manifest jsonb, p_env_var_names text[] default '{}'::text[],
  p_system_prompt text default null, p_task_prompt text default null,
  p_agent_config_dir text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_sources jsonb;
  v_ids jsonb;
  v_provider text;
  v_binding text;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  if p_agent_config_dir is not null and p_agent_config_dir !~ '^/' then
    raise exception using errcode = '22023', message = 'agent config dir must be absolute';
  end if;

  insert into public.session_manifests(
    work_session_id, manifest, env_var_names, system_prompt, task_prompt)
  values (
    p_session_id, p_manifest, coalesce(p_env_var_names, '{}'::text[]),
    nullif(p_system_prompt, ''), nullif(p_task_prompt, ''))
  on conflict (work_session_id) do update
    set manifest      = excluded.manifest,
        env_var_names = excluded.env_var_names,
        system_prompt = coalesce(excluded.system_prompt, session_manifests.system_prompt),
        task_prompt   = coalesce(excluded.task_prompt, session_manifests.task_prompt);

  update public.work_sessions
     set agent_config_dir = coalesce(agent_config_dir, nullif(p_agent_config_dir, '')),
         skills = coalesce(p_manifest -> 'effectiveSkills', skills)
   where entity_id = p_session_id;

  -- ADDED IN 206 (M9). launch.credentialSources[p] = 'space' and
  -- launch.spaceCredentialIds[p] must name the same providers; each pair is
  -- recorded in session_space_credentials in THIS transaction, so the manifest
  -- and the table cannot disagree.
  v_sources := p_manifest #> '{launch,credentialSources}';
  v_ids := p_manifest #> '{launch,spaceCredentialIds}';
  if v_ids is not null and jsonb_typeof(v_ids) <> 'object' then
    raise exception 'manifest launch.spaceCredentialIds must be an object' using errcode = '22023';
  end if;
  if jsonb_typeof(v_sources) = 'object' then
    for v_provider in
      select key from jsonb_each_text(v_sources) where value = 'space'
    loop
      if v_ids is null or jsonb_typeof(v_ids -> v_provider) is distinct from 'string' then
        raise exception 'manifest names space as the % source without a credential id', v_provider
          using errcode = '22023';
      end if;
    end loop;
  end if;
  if v_ids is not null then
    for v_provider in select key from jsonb_each(v_ids) order by key loop
      if v_sources is null or (v_sources ->> v_provider) is distinct from 'space' then
        raise exception 'manifest carries a space credential id for %, whose source is not space', v_provider
          using errcode = '22023';
      end if;
      if (v_ids ->> v_provider) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'manifest launch.spaceCredentialIds.% is not a credential id', v_provider
          using errcode = '22023';
      end if;
      perform internal.record_session_space_credential(
        p_session_id, v_provider, (v_ids ->> v_provider)::uuid);
    end loop;
  end if;

  -- ADDED IN 269. The binding, by the roll-up, in the same transaction as the
  -- manifest and the rows it rolls up (the runs_on edges follow the rows).
  v_binding := internal.settle_credential_binding(
    p_session_id, coalesce(p_manifest -> 'launch', '{}'::jsonb));

  return jsonb_build_object('workSessionId', p_session_id, 'credentialBinding', v_binding);
end
$$;
