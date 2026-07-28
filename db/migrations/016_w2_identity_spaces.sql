-- =============================================================================
-- 016 W2.G01 — identity and Spaces API command foundations.
--
-- Reads continue through tm8_app SELECT + RLS. This migration adds only the
-- route-bound command RPCs that cannot be expressed faithfully through the
-- shipped signatures, and closes the command-ledger retry race by serializing
-- every non-empty clientMutationId before replay inspection.
-- =============================================================================

set role tm8_graph_owner;

-- Two concurrent first attempts used to both pass ledger_replay, perform their
-- domain writes, and only race at ledger_record. The losing ledger insert did
-- not undo its earlier domain write. A transaction-scoped advisory lock makes
-- the mutation id the first lock for every ledgered command, so the second
-- attempt observes and returns the committed result before any side effect.
create or replace function internal.ledger_replay(p_cmid text, p_operation text)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare ledger_row public.command_ledger;
begin
  perform internal.bind_cmid(p_cmid);
  if p_cmid is null or btrim(p_cmid) = '' then
    return null;
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_cmid, 0));

  select * into ledger_row
    from public.command_ledger
   where client_mutation_id = p_cmid;
  if ledger_row.client_mutation_id is null then
    return null;
  end if;
  if ledger_row.operation <> p_operation then
    raise exception 'client mutation id % already used for operation %',
      p_cmid, ledger_row.operation
      using errcode = '23514',
            detail = 'one clientMutationId belongs to one operation (DEV-9)';
  end if;
  return coalesce(ledger_row.result, '{}'::jsonb);
end
$$;

-- The shipped SECURITY DEFINER unread aggregate checked Space membership but
-- not the canonical anchor's entity visibility. Reapply the same entity-read
-- predicate used by message RLS before any row can affect navigation totals.
create or replace function public.unread_counts(p_space_id uuid)
returns table(anchor_id uuid, unread integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (select internal.current_member_id(p_space_id) as member_id)
  select message_row.anchor_id, count(*)::integer as unread
    from public.messages message_row
    join public.entities message_entity
      on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
    join public.entities anchor_entity
      on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = p_space_id
    left join public.read_marks mark_row
      on mark_row.anchor_id = message_row.anchor_id
     and mark_row.member_id = (select member_id from me)
   where internal.is_space_member(p_space_id)
     and internal.entity_readable(message_row.entity_id)
     and internal.entity_readable(message_row.anchor_id)
     and message_row.author_id is distinct from (select member_id from me)
     and (mark_row.last_read_at is null
       or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
   group by message_row.anchor_id
$$;

-- PATCH /v2/spaces/:spaceId. A jsonb patch is intentional: the shipped
-- positional function cannot distinguish an omitted githubRepo from an
-- explicit null, while the frozen DTO requires null to clear the field.
create or replace function public.w2_update_space(
  p_space_id uuid,
  p_patch jsonb,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space_row public.spaces;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then return replay; end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'Space metadata patch must be a non-empty object'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) patch_key
     where patch_key not in ('name', 'description', 'githubRepo')
  ) then
    raise exception 'Space metadata patch contains an unknown field'
      using errcode = '22023';
  end if;
  if p_patch ? 'name' and (
       jsonb_typeof(p_patch -> 'name') <> 'string'
       or char_length(btrim(p_patch ->> 'name')) not between 1 and 200
  ) then
    raise exception 'Space name must contain 1 to 200 characters'
      using errcode = '22023';
  end if;
  if p_patch ? 'description' and jsonb_typeof(p_patch -> 'description') <> 'string' then
    raise exception 'Space description must be a string'
      using errcode = '22023';
  end if;
  if p_patch ? 'githubRepo'
     and jsonb_typeof(p_patch -> 'githubRepo') not in ('string', 'null') then
    raise exception 'githubRepo must be a string or null'
      using errcode = '22023';
  end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  update public.spaces
     set name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
         description = case
           when p_patch ? 'description' then p_patch ->> 'description'
           else description
         end,
         github_repo = case
           when p_patch ? 'githubRepo' then p_patch ->> 'githubRepo'
           else github_repo
         end
   where id = p_space_id
   returning * into space_row;
  if space_row.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'space', to_jsonb(space_row) || jsonb_build_object(
      'member_count', (select count(*) from public.members where space_id = p_space_id),
      'unread_total', coalesce((
        select sum(unread) from public.unread_counts(p_space_id)
      ), 0)
    ),
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;

-- POST /v2/spaces/:spaceId/task-axes. This route-bound replacement keeps
-- actor attribution honest; the shipped positional RPC never validated a
-- caller-supplied actor claim for the target Space.
create or replace function public.w2_create_task_axis(
  p_space_id uuid,
  p_name text,
  p_axis_values text[],
  p_kind text,
  p_position integer,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis_row public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.create');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(p_actor_id, p_space_id);
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'task axis name must contain 1 to 100 characters'
      using errcode = '22023';
  end if;
  if p_axis_values is null or array_position(p_axis_values, null) is not null
     or exists (select 1 from unnest(p_axis_values) value where btrim(value) = '')
     or cardinality(p_axis_values) <> cardinality(array(select distinct value from unnest(p_axis_values) value)) then
    raise exception 'task axis values must be unique non-empty strings'
      using errcode = '22023';
  end if;
  if p_kind not in ('default', 'manual') then
    raise exception 'invalid task axis kind' using errcode = '22023';
  end if;

  insert into public.task_axes(space_id, name, axis_values, kind, position)
  values (p_space_id, p_name, p_axis_values, p_kind, p_position)
  returning * into axis_row;
  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.taskAxes.create',
    jsonb_build_object('axis', to_jsonb(axis_row), 'patches', '[]'::jsonb)
  );
end
$$;

-- PATCH /v2/spaces/:spaceId/task-axes/:axisId. The route Space is a real
-- authorization/resource binding, not decorative path text. The full frozen
-- TaskAxisInput is applied atomically, including kind.
create or replace function public.w2_update_task_axis(
  p_space_id uuid,
  p_axis_id uuid,
  p_name text,
  p_axis_values text[],
  p_kind text,
  p_position integer,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis_row public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.update');
  if replay is not null then return replay; end if;

  -- Authorize the route Space before resolving its child id. An unauthorized
  -- caller receives the same refusal for a real and a fabricated axis id.
  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  select * into axis_row
    from public.task_axes
   where id = p_axis_id and space_id = p_space_id
   for update;
  if axis_row.id is null then
    raise exception 'task axis not found' using errcode = 'P0002';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'task axis name must contain 1 to 100 characters'
      using errcode = '22023';
  end if;
  if p_axis_values is null or array_position(p_axis_values, null) is not null
     or exists (select 1 from unnest(p_axis_values) value where btrim(value) = '')
     or cardinality(p_axis_values) <> cardinality(array(select distinct value from unnest(p_axis_values) value)) then
    raise exception 'task axis values must be unique non-empty strings'
      using errcode = '22023';
  end if;
  if p_kind not in ('default', 'manual') then
    raise exception 'invalid task axis kind' using errcode = '22023';
  end if;
  if axis_row.kind = 'default' and p_kind <> 'default' then
    raise exception 'the default task axis cannot be demoted'
      using errcode = '23514';
  end if;
  if p_name <> axis_row.name and exists (
    select 1
      from public.tasks task_row
      join public.entities entity_row on entity_row.id = task_row.entity_id
     where entity_row.space_id = p_space_id and task_row.axes ? axis_row.name
  ) then
    raise exception 'cannot rename a task axis that tasks still use'
      using errcode = '23514';
  end if;
  if cardinality(axis_row.axis_values) > 0 and exists (
    select 1
      from unnest(axis_row.axis_values) old_value
     where old_value <> all(p_axis_values)
       and exists (
         select 1
           from public.tasks task_row
           join public.entities entity_row on entity_row.id = task_row.entity_id
          where entity_row.space_id = p_space_id
            and task_row.axes ->> axis_row.name = old_value
       )
  ) then
    raise exception 'cannot remove a task axis value that tasks still use'
      using errcode = '23514';
  end if;

  update public.task_axes
     set name = p_name,
         axis_values = p_axis_values,
         kind = p_kind,
         position = p_position
   where id = p_axis_id
   returning * into axis_row;

  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.taskAxes.update',
    jsonb_build_object('axis', to_jsonb(axis_row), 'patches', '[]'::jsonb)
  );
end
$$;

-- DELETE /v2/spaces/:spaceId/task-axes/:axisId. Default configuration is
-- required, and an in-use axis cannot be removed out from under task content.
create or replace function public.w2_delete_task_axis(
  p_space_id uuid,
  p_axis_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis_row public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.delete');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  select * into axis_row
    from public.task_axes
   where id = p_axis_id and space_id = p_space_id
   for update;
  if axis_row.id is null then
    raise exception 'task axis not found' using errcode = 'P0002';
  end if;
  if axis_row.kind = 'default' then
    raise exception 'the default task axis cannot be deleted'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.tasks task_row
      join public.entities entity_row on entity_row.id = task_row.entity_id
     where entity_row.space_id = p_space_id and task_row.axes ? axis_row.name
  ) then
    raise exception 'task axis is still in use by tasks'
      using errcode = '23514';
  end if;

  delete from public.task_axes where id = p_axis_id;
  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.taskAxes.delete',
    jsonb_build_object('axisId', p_axis_id, 'patches', '[]'::jsonb)
  );
end
$$;

-- POST /v2/spaces/:spaceId/invites/:inviteId/revoke. Matching both ids avoids
-- a caller addressing an invite through a misleading different-Space route.
create or replace function public.w2_revoke_invite(
  p_space_id uuid,
  p_invite_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  invite_row public.space_invites;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.revoke');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  select * into invite_row
    from public.space_invites
   where id = p_invite_id and space_id = p_space_id
   for update;
  if invite_row.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  update public.space_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = p_invite_id
   returning * into invite_row;

  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.invites.revoke',
    jsonb_build_object('invite', to_jsonb(invite_row), 'patches', '[]'::jsonb)
  );
end
$$;

-- PostgreSQL grants new functions to PUBLIC by default. Close that implicit
-- surface, then enumerate the five G01 additions for the application role.
revoke execute on function
  public.w2_update_space(uuid, jsonb, text),
  public.w2_create_task_axis(uuid, text, text[], text, integer, uuid, text),
  public.w2_update_task_axis(uuid, uuid, text, text[], text, integer, text),
  public.w2_delete_task_axis(uuid, uuid, text),
  public.w2_revoke_invite(uuid, uuid, text)
from public;

grant execute on function
  public.w2_update_space(uuid, jsonb, text),
  public.w2_create_task_axis(uuid, text, text[], text, integer, uuid, text),
  public.w2_update_task_axis(uuid, uuid, text, text[], text, integer, text),
  public.w2_delete_task_axis(uuid, uuid, text),
  public.w2_revoke_invite(uuid, uuid, text)
to tm8_app;

reset role;
