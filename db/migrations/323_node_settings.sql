-- 323: node settings (Node admin → Configuration) and space visibility.
--
-- 1. internal.node_settings — the curated server env knobs a node admin may
--    set from the UI (packages/server/src/configs/node-settings.ts). The
--    server reads the table once at boot, before loadConfig, and writes each
--    stored value into its env where the operator left the variable unset:
--    PRECEDENCE IS env > stored > default, and every setting applies at the
--    next restart. Provider keys are never stored here (Node credentials).
--
--    No grant to tm8_app: the two SECURITY DEFINER functions below are the
--    only doors, and both require a human session of an active node admin.
--
-- 2. set_node_setting's lockout guard. A value that turns off the loopback
--    auto-owner at the next boot (TM8_NODE_MODE=multi, TM8_DISABLE_AUTO_OWNER
--    =true) is refused unless the caller's own account has a password, so the
--    admin making the change can still sign in afterwards. The facade refuses
--    the same write from the auto-owner arm itself (configs-handlers.ts).
--
-- 3. w2_update_space accepts `visibility` (private | public), 302's body plus
--    that one key.

set local lock_timeout = '5s';

set role tm8_graph_owner;

create table internal.node_settings (
  name                  text primary key,
  value                 text not null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  updated_at            timestamptz not null default now(),
  constraint node_settings_name_check check (name in (
    'TM8_SESSION_CAP', 'TM8_TERMINAL_CAP', 'TM8_WORKTREE_CAP',
    'TM8_NODE_MODE', 'TM8_DISABLE_AUTO_OWNER', 'TM8_SPACE_SESSIONS',
    'TM8_AUTH_MAX_ATTEMPTS', 'TM8_AUTH_ATTEMPT_WINDOW_MS',
    'TM8_AUTH_MAX_FAILURES', 'TM8_AUTH_FAILURE_WINDOW_MS',
    'TM8_PROJECT_ROOTS')),
  constraint node_settings_value_check check (char_length(value) between 1 and 4096)
);
revoke all on table internal.node_settings from public;

-- Every stored setting: {name: {value, updatedAt}}.
create or replace function public.node_settings_list()
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_human_auth_kind();
  perform internal.require_node_admin();
  return coalesce((select jsonb_object_agg(name, jsonb_build_object(
                            'value', value, 'updatedAt', updated_at))
                     from internal.node_settings), '{}'::jsonb);
end
$$;
revoke all on function public.node_settings_list() from public;
grant execute on function public.node_settings_list() to tm8_app;

-- Store (or, with null, clear) one setting. The value arrives normalised by
-- the facade; the name check is the table's.
create or replace function public.set_node_setting(p_name text, p_value text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored internal.node_settings;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_node_admin();
  if (p_name = 'TM8_NODE_MODE' and p_value = 'multi')
     or (p_name = 'TM8_DISABLE_AUTO_OWNER' and p_value = 'true') then
    if not exists (
      select 1 from public.accounts a
       where a.identity_id = internal.identity_id()
         and a.status = 'active'
         and (a.is_node_admin or a.is_owner)
         and a.password_hash is not null
    ) then
      raise exception 'turning off loopback sign-in needs an admin account with a password'
        using errcode = '42501';
    end if;
  end if;
  if p_value is null then
    delete from internal.node_settings where name = p_name;
    return jsonb_build_object('name', p_name, 'value', null);
  end if;
  insert into internal.node_settings(name, value, updated_by_account_id)
  values (p_name, p_value, internal.current_account_id())
  on conflict (name) do update
     set value = excluded.value,
         updated_by_account_id = excluded.updated_by_account_id,
         updated_at = now()
  returning * into stored;
  return jsonb_build_object('name', stored.name, 'value', stored.value,
                            'updatedAt', stored.updated_at);
end
$$;
revoke all on function public.set_node_setting(text, text) from public;
grant execute on function public.set_node_setting(text, text) to tm8_app;

create or replace function public.w2_update_space(p_space_id uuid, p_patch jsonb, p_client_mutation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  space_row public.spaces;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in 031's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{space,id}', p_space_id::text, 'space');
    return replay;
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'Space metadata patch must be a non-empty object'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) patch_key
     where patch_key not in ('name', 'description', 'githubRepo',
                             'sessionShareDefault', 'sessionDriveDefault',
                             'sessionAutoCloseMinutes', 'visibility')
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
  -- Checked here rather than left to the column CHECK so a bad value is a 400
  -- naming the field, not a 500 naming a constraint.
  if p_patch ? 'sessionShareDefault'
     and (jsonb_typeof(p_patch -> 'sessionShareDefault') <> 'string'
          or p_patch ->> 'sessionShareDefault' not in ('none','space')) then
    raise exception 'sessionShareDefault must be "none" or "space"'
      using errcode = '22023';
  end if;
  if p_patch ? 'sessionDriveDefault'
     and (jsonb_typeof(p_patch -> 'sessionDriveDefault') <> 'string'
          or p_patch ->> 'sessionDriveDefault' not in ('owner','space')) then
    raise exception 'sessionDriveDefault must be "owner" or "space"'
      using errcode = '22023';
  end if;

  -- 301 (Spec D1 Q3): minutes a completed session's process may stay idle
  -- before it is closed; 0 = never.
  if p_patch ? 'sessionAutoCloseMinutes'
     and (jsonb_typeof(p_patch -> 'sessionAutoCloseMinutes') <> 'number'
          or (p_patch ->> 'sessionAutoCloseMinutes')::numeric <> trunc((p_patch ->> 'sessionAutoCloseMinutes')::numeric)
          or (p_patch ->> 'sessionAutoCloseMinutes')::numeric not between 0 and 10080) then
    raise exception 'sessionAutoCloseMinutes must be a whole number of minutes from 0 (never) to 10080'
      using errcode = '22023';
  end if;

  -- 323: who can discover the space (01 §2); the same vocabulary as create.
  if p_patch ? 'visibility'
     and (jsonb_typeof(p_patch -> 'visibility') <> 'string'
          or p_patch ->> 'visibility' not in ('private','public')) then
    raise exception 'invalid space visibility' using errcode = '22023';
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
         end,
         session_share_default = case
           when p_patch ? 'sessionShareDefault' then p_patch ->> 'sessionShareDefault'
           else session_share_default
         end,
         session_drive_default = case
           when p_patch ? 'sessionDriveDefault' then p_patch ->> 'sessionDriveDefault'
           else session_drive_default
         end,
         session_autoclose_minutes = case
           when p_patch ? 'sessionAutoCloseMinutes' then (p_patch ->> 'sessionAutoCloseMinutes')::integer
           else session_autoclose_minutes
         end,
         visibility = case
           when p_patch ? 'visibility' then p_patch ->> 'visibility'
           else visibility
         end
   where id = p_space_id
   returning * into space_row;
  if space_row.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'space', to_jsonb(space_row) || jsonb_build_object(
      'member_count', (select count(*) from public.members where space_id = p_space_id)
      -- no 'unread_total' — see 161's header
    ),
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$function$;
