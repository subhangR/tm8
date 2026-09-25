-- =============================================================================
-- 226 — space_chat_defaults: the teammate + model a new chat about an entity
-- of a given kind starts with (entity-chat design 01a0da4e §3.4, task G).
--
-- WHAT IS HERE
--   1. `public.space_chat_defaults`, one row per space: `defaults` is a jsonb
--      object kind → {teammateId?, model?}. A kind with no default is absent.
--      RLS on, no policy, no grant: both doors below are SECURITY DEFINER.
--   2. `public.get_space_chat_defaults(space)` — any member of the space.
--   3. `public.set_space_chat_defaults(space, patch, cmid)` — a human
--      owner/admin (`internal.require_human_space_admin`, the gate of
--      `set_space_profile_default`). A PATCH over kinds: each kind in the patch
--      is replaced, and `null` or `{}` clears it; other kinds are untouched.
--
-- VALIDATION (mirrors packages/contract/src/chat-defaults.ts):
--   * a kind is a core slug or a custom `c:{name}` (001's rule), never
--     `message` or `chat` — a chat can be about neither;
--   * an entry carries only `teammateId` and `model`, both optional;
--   * `teammateId` names a live team_member of THIS space at write time. It
--     may be deleted later: the chat panel names a default that no longer
--     resolves rather than swapping it (§3.4 rule 2), so reads never filter;
--   * `model` is 1..200 chars after trim. Whether the node offers it is a
--     per-node launch-catalog fact, checked by the reader, not here.
--
-- WHY A TABLE, NOT A `spaces` COLUMN: every `spaces` settings write bumps
-- `settings_revision` under `w1_set_writer('space_settings')`, which
-- `spaces.interactionProfile.setDefault` and `spaces.defaultChannel.set` use
-- as their optimistic guard; a chat-defaults edit must not fail their
-- in-flight writes. This row has its own `revision`.
--
-- NO EVENT: nothing subscribes yet; readers fetch on open.
-- =============================================================================

set role tm8_graph_owner;

create table public.space_chat_defaults (
  space_id   uuid primary key references public.spaces(id) on delete cascade,
  defaults   jsonb not null default '{}'::jsonb check (jsonb_typeof(defaults) = 'object'),
  revision   integer not null default 0 check (revision >= 0),
  updated_by uuid references public.entities(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index space_chat_defaults_updated_by_idx on public.space_chat_defaults(updated_by);

alter table public.space_chat_defaults enable row level security;

create or replace function public.get_space_chat_defaults(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare row_ public.space_chat_defaults;
begin
  perform internal.require_identity();
  if not internal.is_space_member(p_space_id) then
    raise exception 'you are not a member of this space' using errcode = '42501';
  end if;
  select * into row_ from public.space_chat_defaults where space_id = p_space_id;
  return jsonb_build_object(
    'spaceId', p_space_id,
    'defaults', coalesce(row_.defaults, '{}'::jsonb),
    'revision', coalesce(row_.revision, 0)
  );
end
$$;

create or replace function public.set_space_chat_defaults(
  p_space_id uuid, p_defaults jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  member_id uuid;
  current_row public.space_chat_defaults;
  merged jsonb;
  k text;
  v jsonb;
  entry jsonb;
  extra text;
  teammate_text text;
  model_text text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.chatDefaults.set');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;

  member_id := internal.require_human_space_admin(p_space_id);
  perform internal.bind_actor(member_id);

  if p_defaults is null or jsonb_typeof(p_defaults) <> 'object' then
    raise exception 'chat defaults must be an object of kind -> entry' using errcode = '22023';
  end if;

  -- Serialize writers of one space's row; the space row itself is not locked,
  -- so settings_revision writers never wait on this.
  insert into public.space_chat_defaults(space_id) values (p_space_id)
    on conflict (space_id) do nothing;
  select * into current_row from public.space_chat_defaults where space_id = p_space_id for update;
  merged := current_row.defaults;

  for k, v in select key, value from jsonb_each(p_defaults) loop
    if k !~ '^([a-z][a-z0-9_]{0,48}|c:[a-z0-9][a-z0-9_]{0,48})$' then
      raise exception 'chat defaults: % is not an entity kind', k using errcode = '22023';
    end if;
    if k in ('message', 'chat') then
      raise exception 'chat defaults: a chat cannot be about a %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then
      merged := merged - k;
      continue;
    end if;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'chat defaults: the entry for % must be an object or null', k using errcode = '22023';
    end if;
    select min(key) into extra from jsonb_object_keys(v) key where key not in ('teammateId', 'model');
    if extra is not null then
      raise exception 'chat defaults: % is not a field of a chat default', extra using errcode = '22023';
    end if;

    entry := '{}'::jsonb;
    if v ? 'teammateId' and jsonb_typeof(v -> 'teammateId') <> 'null' then
      teammate_text := v ->> 'teammateId';
      if jsonb_typeof(v -> 'teammateId') <> 'string'
         or teammate_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (
           select 1 from public.entities e
             join public.team_members tm on tm.entity_id = e.id
            where e.id = teammate_text::uuid and e.space_id = p_space_id and e.deleted_at is null) then
        raise exception 'chat defaults: teammate % is not a live teammate of this space', teammate_text
          using errcode = '22023';
      end if;
      entry := entry || jsonb_build_object('teammateId', lower(teammate_text));
    end if;
    if v ? 'model' and jsonb_typeof(v -> 'model') <> 'null' then
      model_text := btrim(v ->> 'model');
      if jsonb_typeof(v -> 'model') <> 'string' or char_length(model_text) not between 1 and 200 then
        raise exception 'chat defaults: model for % must be 1..200 chars', k using errcode = '22023';
      end if;
      entry := entry || jsonb_build_object('model', model_text);
    end if;

    if entry = '{}'::jsonb then
      merged := merged - k;
    else
      merged := jsonb_set(merged, array[k], entry, true);
    end if;
  end loop;

  if merged is distinct from current_row.defaults then
    update public.space_chat_defaults
       set defaults = merged, revision = revision + 1, updated_by = member_id, updated_at = now()
     where space_id = p_space_id
     returning * into current_row;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'spaces.chatDefaults.set', jsonb_build_object(
    'spaceId', p_space_id,
    'defaults', current_row.defaults,
    'revision', current_row.revision
  ));
end
$$;

revoke all on function public.get_space_chat_defaults(uuid) from public;
grant execute on function public.get_space_chat_defaults(uuid) to tm8_app;
revoke all on function public.set_space_chat_defaults(uuid, jsonb, text) from public;
grant execute on function public.set_space_chat_defaults(uuid, jsonb, text) to tm8_app;

reset role;

analyze public.space_chat_defaults;
