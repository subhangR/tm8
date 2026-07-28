-- =============================================================================
-- 038  W2.SEC-1 STAGE 2 — the replay RESOURCE binding at the entities.patch
--                         LABEL. Eleven doors, all granted, all previously
--                         unbound.
--
-- ⚠ THIS MIGRATION BINDS A LABEL, NOT A FUNCTION. Same warning as 036, and it
--   is the reason all eleven are in this one file.
--
--   internal.ledger_replay(cmid, label) resolves a stored result from those two
--   values ALONE and cannot tell which function called it. Every function
--   sharing 'entities.patch' is a DOOR onto the same ledger rows. Measured from
--   pg_catalog on the applied 34-file chain (a799b7ef1b20a9b0): ELEVEN doors,
--   ALL granted to tm8_app, ALL unbound.
--
--   BINDING A SUBSET WOULD BE WORSE THAN BINDING NONE — an acceptance test that
--   drives one door goes green while the defect stays open through the other
--   ten, and the only executable proof of the defect is consumed. A fix that
--   makes the test lie is worse than no fix.
--
-- THE SUBJECT EXPRESSION, AND WHY IT IS NOT 036's
--
--   036 bound 'entities.create' with  replay #>> '{entity,space_id}'  against
--   p_space_id, because a create names a SPACE. THAT IS NOT THIS LABEL'S SHAPE.
--   Measured, per door, from proargnames and from each site's own
--   ledger_record call:
--
--     * all eleven store internal.command_result(<resource>, ...), whose
--       projection carries {entity,id} — so the stored resource identifier is
--       the ENTITY id, not the space id;
--     * ten doors name that resource p_entity_id;
--     * update_task_content names it p_task_id.
--
--   So the binding is  {entity,id}  against the door's OWN first argument.
--   NONE of these eleven functions takes a p_space_id at all — a binding copied
--   from 036 verbatim could not have compiled, and one copied "in spirit" would
--   have bound ten doors and silently skipped the eleventh.
--
-- ON THE DOUBLED PRINCIPAL PIN, recorded so it is not rediscovered as a defect
--
--   The two internal.require_replay_principal calls per door are REDUNDANT on
--   this chain and are here deliberately. 033 moved the principal comparison
--   INSIDE internal.ledger_replay, under the advisory lock, with a stronger
--   fail-closed three-branch form than require_replay_principal's
--   `is distinct from`. The per-site calls therefore add no protection today.
--   They are retained because 036 ships exactly this shape at eleven sibling
--   doors, and a reviewer diffing 038 against 036 should see one idiom rather
--   than two. Defence in depth if ledger_replay is ever weakened.
--
-- GENERATED, NOT TRANSCRIBED. Every body below is pg_get_functiondef output
-- from the applied chain with one transform applied to the replay branch; the
-- generator refuses to emit unless the diff against the original is confined to
-- the added lines. Eleven long bodies retyped by hand is a transcription
-- hazard, and a transcription of a line is not the line.
-- =============================================================================

set role tm8_graph_owner;

CREATE OR REPLACE FUNCTION public.update_channel(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_topic text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
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
  e := internal.live_entity(p_entity_id, 'channel');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.channels
     set name = coalesce(lower(btrim(p_name)), name), topic = coalesce(p_topic, topic), updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'channel')), array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_collection(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_collection_type text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
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
  e := internal.live_entity(p_entity_id, 'collection');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.collections
     set name = coalesce(p_name, name), description = coalesce(p_description, description),
         collection_type = coalesce(p_collection_type, collection_type), updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'collection')), array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_commit_entity(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_url text DEFAULT NULL::text, p_author text DEFAULT NULL::text, p_committed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'commit'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.commits set message = coalesce(p_title, message), url = coalesce(p_url, url),
    author = coalesce(p_author, author), committed_at = coalesce(p_committed_at, committed_at)
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
    jsonb_build_object('kind','commit'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_custom_entity(p_entity_id uuid, p_expected_version integer, p_title text DEFAULT NULL::text, p_actor_id uuid DEFAULT NULL::uuid, p_fields jsonb DEFAULT NULL::jsonb, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id);
  if e.kind !~ '^c:' then raise exception 'entity is not a custom kind' using errcode = '22023'; end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.custom_entities set title = coalesce(p_title, title), fields = coalesce(p_fields, fields)
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
    jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_document(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_body text DEFAULT NULL::text, p_format text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'doc');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.documents
     set title = coalesce(p_title, title),
         body = coalesce(p_body, body),
         format = coalesce(p_format, format),
         updated_at = now()
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'doc'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_file_entity(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'file'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.files set name = coalesce(p_title, name), mime_type = coalesce(p_mime_type, mime_type)
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','file'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_pull_request_entity(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_url text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_head_sha text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'pull_request'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.pull_requests set title = coalesce(p_title, title), url = coalesce(p_url, url),
    state = coalesce(p_state, state), head_sha = coalesce(p_head_sha, head_sha)
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
    jsonb_build_object('kind','pull_request'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_skill_entity(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_content text DEFAULT NULL::text, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'skill'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.skills set name = coalesce(p_title, name), description = coalesce(p_description, description),
    content = coalesce(p_content, content) where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','skill'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_spell_entity(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_rule jsonb DEFAULT NULL::jsonb, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
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
  e := internal.live_entity(p_entity_id, 'spell'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.spells set name = coalesce(p_title, name), description = coalesce(p_description, description),
    rule = coalesce(p_rule, rule) where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','spell'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_task_content(p_task_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_axes jsonb DEFAULT NULL::jsonb, p_work_status text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_acceptance_criteria jsonb DEFAULT NULL::jsonb, p_points_estimate integer DEFAULT NULL::integer, p_due_date date DEFAULT NULL::date, p_clear_due_date boolean DEFAULT false, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_task_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);
  if p_work_status = 'done' then
    raise exception 'completion goes through complete_task' using errcode = '23514';
  end if;

  update public.tasks
     set title = coalesce(p_title, title),
         description = coalesce(p_description, description),
         axes = coalesce(p_axes, axes),
         work_status = coalesce(p_work_status, work_status),
         priority = coalesce(p_priority, priority),
         acceptance_criteria = coalesce(p_acceptance_criteria, acceptance_criteria),
         points_estimate = coalesce(p_points_estimate, points_estimate),
         due_date = case when p_clear_due_date then null else coalesce(p_due_date, due_date) end,
         updated_at = now()
   where entity_id = p_task_id;
  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'task'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_task_id, null, activity_id, array[p_task_id]));
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_team_member(p_entity_id uuid, p_expected_version integer, p_actor_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_identity text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_agent_tool text DEFAULT NULL::text, p_mode text DEFAULT NULL::text, p_permission_mode text DEFAULT NULL::text, p_capabilities jsonb DEFAULT NULL::jsonb, p_command_permissions jsonb DEFAULT NULL::jsonb, p_avatar text DEFAULT NULL::text, p_memories jsonb DEFAULT NULL::jsonb, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  owner_member uuid;
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
  e := internal.live_entity(p_entity_id, 'team_member');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  -- Only the owning human (or a space admin) reshapes a persona. An agent
  -- rewriting its own permissions is precisely the escalation S13 forbids.
  select owner_member_id into owner_member from public.team_members where entity_id = p_entity_id;
  if not internal.is_space_admin(e.space_id)
     and owner_member is distinct from internal.current_member_id(e.space_id) then
    raise exception 'only the owning member or a space admin may update this persona'
      using errcode = '42501';
  end if;

  update public.team_members
     set name = coalesce(p_name, name), role = coalesce(p_role, role),
         identity = coalesce(p_identity, identity), model = coalesce(p_model, model),
         agent_tool = coalesce(p_agent_tool, agent_tool), mode = coalesce(p_mode, mode),
         permission_mode = coalesce(p_permission_mode, permission_mode),
         capabilities = coalesce(p_capabilities, capabilities),
         command_permissions = coalesce(p_command_permissions, command_permissions),
         avatar = coalesce(p_avatar, avatar), memories = coalesce(p_memories, memories),
         updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'team_member')), array[p_entity_id]));
end
$function$
;

reset role;
