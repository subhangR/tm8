-- 071 — Channels takes a collection ROW under Work (user ruling 2026-08-01).
--
-- 069 took channels out of the rail entirely, on the ruling that a channel is
-- an entity and belongs in the Entity List Panel. That was right about the
-- home and wrong about visibility: the workspace has TWO docks and three
-- collections that want to be on screen, so nothing pointed at channels on
-- arrival and they read as missing. Pointing a dock at them instead just took
-- sessions off the screen — one missing collection traded for another.
--
-- So the row goes where every other collection kind's row already is: under
-- Work, beside Docs. This is NOT the Channels GROUP 069 removed — that group's
-- rows were the space's live #channel entities, a second divergent home for
-- the kind. This is one row that opens the same list the dock switcher opens.
--
-- The contract's `MenuKindRef` un-excluded `channel` in the same change (it
-- excluded the kind back when it was `strategy: 'special'` with no `k/` route),
-- exactly as `worktree` was un-excluded on 2026-07-31. `message` stays
-- excluded: still anchored, still no collection view.
--
-- The caret-children cap is 8; this brings Work's list to 7.

set role tm8_graph_owner;

-- THE DB'S OWN TWIN OF THE EXCLUSION. internal.w2_normalize_menu_payload
-- rejects a kind ref that is channel or message outright — the same
-- pre-collection assumption the contract's MenuKindRef carried, written in
-- SQL. Without this arm the seeder below fails on its own payload, which is
-- how this migration first failed rather than shipping a menu the guard would
-- refuse at the next write.
--
-- The body below is the LIVE definition read out of the database with
-- pg_get_functiondef and patched at exactly the two rejection arms. It is NOT
-- re-authored from 029: that function was redefined by 031, so hand-copying
-- either file would silently drop the other's work — the create-or-replace
-- hazard this repo has already paid for once.
CREATE OR REPLACE FUNCTION internal.w2_normalize_menu_payload(p_space_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  group_value jsonb;
  item_value jsonb;
  leaf_value jsonb;
  item_children jsonb;
  group_id text;
  item_type text;
  item_ref text;
  group_ids text[] := array[]::text[];
  refs text[] := array[]::text[];
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ? 'groups')
     or exists (
       select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
        where key_name <> 'groups'
     )
     or jsonb_typeof(p_payload -> 'groups') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'groups') > 8 then
    raise exception 'invalid MenuConfig payload' using errcode = '22023';
  end if;

  for group_value in select value from jsonb_array_elements(p_payload -> 'groups') loop
    if jsonb_typeof(group_value) is distinct from 'object'
       or not (group_value ?& array['id','label','items'])
       or exists (
         select 1 from jsonb_object_keys(group_value) as group_keys(key_name)
          where key_name not in ('id','label','items')
       )
       or jsonb_typeof(group_value -> 'id') is distinct from 'string'
       or jsonb_typeof(group_value -> 'label') is distinct from 'string'
       or jsonb_typeof(group_value -> 'items') is distinct from 'array'
       or jsonb_array_length(group_value -> 'items') > 12 then
      raise exception 'invalid MenuConfig group' using errcode = '22023';
    end if;

    group_id := group_value ->> 'id';
    if group_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
       or char_length(group_value ->> 'label') not between 1 and 32
       or group_id = any(group_ids) then
      raise exception 'invalid or duplicate MenuConfig group' using errcode = '22023';
    end if;
    group_ids := array_append(group_ids, group_id);

    for item_value in select value from jsonb_array_elements(group_value -> 'items') loop
      if jsonb_typeof(item_value) is distinct from 'object'
         or not (item_value ?& array['type','ref'])
         or jsonb_typeof(item_value -> 'type') is distinct from 'string'
         or jsonb_typeof(item_value -> 'ref') is distinct from 'string' then
        raise exception 'invalid MenuConfig item' using errcode = '22023';
      end if;

      item_type := item_value ->> 'type';
      item_ref := item_value ->> 'ref';
      if item_ref = any(refs) then
        raise exception 'MenuConfig refs must be globally unique' using errcode = '22023';
      end if;
      refs := array_append(refs, item_ref);

      if item_type = 'view' then
        if exists (
             select 1 from jsonb_object_keys(item_value) as item_keys(key_name)
              where key_name not in ('type','ref','children')
           )
           or not exists (
             select 1 from public.menu_view_registry registry_row
              where registry_row.ref = item_ref
                and registry_row.menu_eligible
                and registry_row.implemented
           ) then
          raise exception 'unknown or unavailable MenuConfig view ref' using errcode = '22023';
        end if;

        if item_value ? 'children' then
          item_children := item_value -> 'children';
          if jsonb_typeof(item_children) is distinct from 'array'
             or jsonb_array_length(item_children) > 8 then
            raise exception 'invalid MenuConfig children' using errcode = '22023';
          end if;
          for leaf_value in select value from jsonb_array_elements(item_children) loop
            if jsonb_typeof(leaf_value) is distinct from 'object'
               or not (leaf_value ?& array['type','ref'])
               or exists (
                 select 1 from jsonb_object_keys(leaf_value) as leaf_keys(key_name)
                  where key_name not in ('type','ref')
               )
               or jsonb_typeof(leaf_value -> 'type') is distinct from 'string'
               or jsonb_typeof(leaf_value -> 'ref') is distinct from 'string' then
              raise exception 'invalid MenuConfig child' using errcode = '22023';
            end if;
            item_type := leaf_value ->> 'type';
            item_ref := leaf_value ->> 'ref';
            if item_ref = any(refs) then
              raise exception 'MenuConfig refs must be globally unique' using errcode = '22023';
            end if;
            refs := array_append(refs, item_ref);
            if item_type = 'view' then
              if not exists (
                select 1 from public.menu_view_registry registry_row
                 where registry_row.ref = item_ref
                   and registry_row.menu_eligible
                   and registry_row.implemented
              ) then
                raise exception 'unknown or unavailable MenuConfig child view ref'
                  using errcode = '22023';
              end if;
            elsif item_type = 'kind' then
              if item_ref in ('message') or not exists (
                select 1 from public.entity_kinds kind_row
                 where kind_row.kind = item_ref
                   and (kind_row.space_id = p_space_id or kind_row.space_id is null)
              ) then
                raise exception 'unknown or non-collection MenuConfig child kind ref'
                  using errcode = '22023';
              end if;
            else
              raise exception 'invalid MenuConfig child type' using errcode = '22023';
            end if;
          end loop;
        end if;
      elsif item_type = 'kind' then
        if exists (
             select 1 from jsonb_object_keys(item_value) as item_keys(key_name)
              where key_name not in ('type','ref')
           )
           or item_ref in ('message')
           or not exists (
             select 1 from public.entity_kinds kind_row
              where kind_row.kind = item_ref
                and (kind_row.space_id = p_space_id or kind_row.space_id is null)
           ) then
          raise exception 'unknown or non-collection MenuConfig kind ref' using errcode = '22023';
        end if;
      else
        raise exception 'invalid MenuConfig item type' using errcode = '22023';
      end if;
    end loop;
  end loop;

  if not ('settings' = any(refs)) then
    raise exception 'MenuConfig requires the settings view' using errcode = '22023';
  end if;
  return jsonb_build_object('groups', p_payload -> 'groups');
end
$function$;


create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 069 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. A space whose menu was hand-edited does not match
  -- and keeps its own arrangement.
  payload_069 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_069;
end
$$;

reset role;
