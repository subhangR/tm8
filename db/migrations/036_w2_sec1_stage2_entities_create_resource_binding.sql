-- =============================================================================
-- 036 W2.SEC-1 STAGE 2 (BOUNDED) — the replay RESOURCE binding at the
--                                  entities.create LABEL, plus repair of two
--                                  bindings we shipped that are bypassable.
--
-- ⚠ THIS MIGRATION BINDS A LABEL, NOT A FUNCTION. READ THIS BEFORE EDITING IT.
--
--   internal.ledger_replay(cmid, operation_label) resolves a stored result from
--   those two values ALONE. It cannot tell which function called it. So every
--   function sharing an operation label is a DOOR onto the same ledger rows, and
--   a guard written at one door does nothing at any other.
--
--   'entities.create' has ELEVEN doors, and all eleven are granted to tm8_app.
--   Measured from pg_catalog on the applied chain, not read off the files.
--
--   BINDING ONE DOOR WOULD HAVE BEEN WORSE THAN BINDING NONE. The acceptance
--   test for this defect, packages/server/test/w3/xg03-same-principal-resource-
--   confusion.test.ts, drives one door. Bind that door alone and XG03 GOES GREEN
--   WHILE THE DEFECT STAYS FULLY OPEN through the other ten — the only executable
--   proof of the defect is consumed, and the artifact that would have caught the
--   remainder reads green forever. A fix that makes the test lie is worse than no
--   fix. That is why all eleven are here.
--
-- THE DEFECT, MEASURED AT THE PUBLIC HTTP BOUNDARY (not inferred)
--
--   POST /v2/entities naming SPACE B, replaying a clientMutationId recorded
--   against SPACE A, SAME principal -> 201, errorCode null, returned entity id ==
--   the original, returned space == SPACE A, and nothing created in Space B. The
--   caller named Space B and received Space A's entity under a 201.
--
--   The positive control passed in the same test: same principal, same cmid, SAME
--   Space still returns the stored entity byte-identical. So this is RESOURCE
--   CONFUSION, not broken idempotency — the mechanism is not refusing everyone,
--   it is failing to distinguish resources.
--
-- IT IS NOBODY'S IMPLEMENTATION FAILURE, AND THE RECORD SHOULD SAY SO
--
--   Both existing guards behave exactly as designed. entities.create is not one
--   of 032's seven sites, so it has no resource binding at all. 033's pin is
--   PRINCIPAL-only and PASSES here, because Phase-1 runs a single loopback
--   identity so attacker and victim are the same account BY CONSTRUCTION — and
--   033 structurally cannot supply the resource half, because ledger_replay never
--   sees the addressed resource. A defect emerging from two correct components
--   meeting a platform constraint is not a coding error, and writing it up as one
--   would misdirect whoever picks up the tail.
--
-- WHAT THIS FILE SUPERSEDES
--
--   THE ELEVEN entities.create DOORS:
--     * public.create_task                supersedes 007_rpc_catalog.sql:907
--     * public.create_document            supersedes 007_rpc_catalog.sql:990
--     * public.create_channel             supersedes 007_rpc_catalog.sql:1051
--     * public.create_collection          supersedes 007_rpc_catalog.sql:1104
--     * public.create_team_member         supersedes 007_rpc_catalog.sql:1198
--     * public.create_file_entity         supersedes 017_w2_entities_commands_tracking.sql:62
--     * public.create_spell_entity        supersedes 017_w2_entities_commands_tracking.sql:85
--     * public.create_skill_entity        supersedes 017_w2_entities_commands_tracking.sql:107
--     * public.create_pull_request_entity supersedes 017_w2_entities_commands_tracking.sql:129
--     * public.create_commit_entity       supersedes 017_w2_entities_commands_tracking.sql:156
--     * public.create_custom_entity       supersedes 017_w2_entities_commands_tracking.sql:184
--
--   THE TWO REPAIRS — bindings we ALREADY SHIPPED that are bypassable:
--     * public.update_space               supersedes 007_rpc_catalog.sql:483
--     * public.update_project             supersedes 007_rpc_catalog.sql:779
--
--   Every body below is the LANDED text verbatim with the guards added and
--   NOTHING else changed. The landed text was extracted from the applied chain
--   (last definition wins) and each body was verified to differ from it by
--   exactly one removed line — the bare `return replay` — plus the additions.
--
-- WHY THE TWO REPAIRS ARE HERE AND ARE NOT SCOPE CREEP
--
--   The rule applied is: WE FIX WHAT WE FALSELY CLAIMED; WE DO NOT FIX WHAT WE
--   MERELY FAILED TO CLAIM. That set is closed by construction and cannot grow.
--
--     'projects.update' — 032 bound public.update_project_w2 and the record says
--       that label is bound. public.update_project (007:779) is GRANTED to
--       tm8_app, has a bare return, and stores the same project projection. The
--       shipped binding is walkable around by an ordinary caller.
--     'spaces.update'   — 031 bound public.w2_update_space. public.update_space
--       (007:483) is GRANTED, bare return, stores the Space projection. Same.
--
--   Unlike public.post_message — which 032 bound while it was NOT executable by
--   tm8_app, so latent — BOTH of these siblings are granted. These two are LIVE.
--
-- WHAT IS DELIBERATELY *NOT* HERE
--
--   'entities.patch' is also ELEVEN doors, all granted, and structurally
--   identical to entities.create. It is UNMEASURED — XG03 does not drive it and
--   no gate has demonstrated it — and it was explicitly declined as scope. IT IS
--   NOT JUDGED SAFE. It is the largest single item in the Stage 2 backlog. See
--   docs/plans/TM8-SEC1-STAGE2-ENUMERATION.md, which classifies all 63 operation
--   labels, all 16 label collisions and all 98 live ledger_replay callers, and
--   carries this idiom for whoever continues.
--
-- THE ORDERING IS THE SECURITY PROPERTY
--
--   The principal pin is called TWICE at every site: once BEFORE
--   internal.ledger_replay and once INSIDE the replay branch. The pre-check alone
--   is insufficient — it runs with NO LOCK HELD, so against a victim's
--   UNCOMMITTED ledger row it reads "not found", pins nothing, then blocks inside
--   ledger_replay on the advisory lock, and after the victim commits it proceeds
--   with the comparison already skipped. The call inside the branch runs with
--   ledger_replay's pg_advisory_xact_lock (016:26) already held. Do NOT
--   "simplify" this to one call.
--
--   The subject binding must live inside the branch because it needs the stored
--   projection. For the eleven create doors it compares the stored entity's
--   space_id — internal.command_entity is to_jsonb(entities) so space_id is
--   always present — against the Space the request addresses.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- SITE 1 of 11 — public.create_task. The door XG03 drives, and the one SEC-1b's
-- own suite used. It is FIRST here only for readability; it has no privileged
-- status, and the other ten are not optional extras.
-- -----------------------------------------------------------------------------
create or replace function public.create_task(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_axes jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_priority text default 'medium',
  p_acceptance_criteria jsonb default '[]'::jsonb, p_points_estimate integer default null,
  p_due_date date default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  task_id uuid;
  activity_id uuid;
  result jsonb;
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

  task_id := internal.create_envelope(p_space_id, 'task', actor, p_parent_id, p_position);
  insert into public.tasks(entity_id, title, description, axes, priority,
                           acceptance_criteria, points_estimate, due_date)
  values (task_id, p_title, coalesce(p_description, ''), coalesce(p_axes, '{}'::jsonb),
          coalesce(p_priority, 'medium'), coalesce(p_acceptance_criteria, '[]'::jsonb),
          p_points_estimate, p_due_date);
  perform internal.record_initial_version(task_id, actor);
  perform internal.attach_on_create(p_space_id, task_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, task_id, actor, 'created',
                   null, jsonb_build_object('kind', 'task'));

  result := internal.command_result(task_id, null, activity_id, array[task_id]);
  return internal.ledger_record(p_client_mutation_id, 'entities.create', result);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 2 of 11 — public.create_document.
-- -----------------------------------------------------------------------------
create or replace function public.create_document(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_body text default '',
  p_format text default 'markdown', p_parent_id uuid default null,
  p_position double precision default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  doc_id uuid;
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

  doc_id := internal.create_envelope(p_space_id, 'doc', actor, p_parent_id, p_position);
  insert into public.documents(entity_id, title, body, format)
  values (doc_id, p_title, coalesce(p_body, ''), coalesce(p_format, 'markdown'));
  perform internal.record_initial_version(doc_id, actor);
  perform internal.attach_on_create(p_space_id, doc_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, doc_id, actor, 'created',
                   null, jsonb_build_object('kind', 'doc'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(doc_id, null, activity_id, array[doc_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 3 of 11 — public.create_channel.
-- -----------------------------------------------------------------------------
create or replace function public.create_channel(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_topic text default '',
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  channel_id uuid;
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
  channel_id := internal.create_envelope(p_space_id, 'channel', actor, p_parent_id, p_position);
  insert into public.channels(entity_id, space_id, name, topic)
  values (channel_id, p_space_id, lower(btrim(p_name)), coalesce(p_topic, ''));
  perform internal.record_initial_version(channel_id, actor);
  activity_id := internal.record_activity(p_space_id, channel_id, actor, 'created',
                   null, jsonb_build_object('kind', 'channel'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(channel_id, null, activity_id, array[channel_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 4 of 11 — public.create_collection.
-- -----------------------------------------------------------------------------
create or replace function public.create_collection(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_description text default '',
  p_collection_type text default 'manual', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  collection_id uuid;
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
  collection_id := internal.create_envelope(p_space_id, 'collection', actor, p_parent_id, p_position);
  insert into public.collections(entity_id, name, description, collection_type)
  values (collection_id, p_name, coalesce(p_description, ''), coalesce(p_collection_type, 'manual'));
  perform internal.record_initial_version(collection_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(collection_id, null,
             internal.record_activity(p_space_id, collection_id, actor, 'created',
               null, jsonb_build_object('kind', 'collection')), array[collection_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 5 of 11 — public.create_team_member. Its stored projection is a member
-- entity carrying identity_id and display_name, so a cross-Space replay here
-- discloses a persona row, not just an id.
-- -----------------------------------------------------------------------------
create or replace function public.create_team_member(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_role text default '',
  p_identity text default '', p_model text default null, p_agent_tool text default null,
  p_mode text default null, p_permission_mode text default null,
  p_capabilities jsonb default '{}'::jsonb, p_command_permissions jsonb default '{}'::jsonb,
  p_avatar text default null, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  owner_member uuid;
  persona_id uuid;
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

  -- A persona is owned by a HUMAN member: an agent cannot mint another agent for
  -- itself, or can_act_as would grow a new root every spawn.
  owner_member := internal.current_member_id(p_space_id);
  if owner_member is null then
    raise exception 'only a member may own a team_member persona' using errcode = '42501';
  end if;
  persona_id := internal.create_envelope(p_space_id, 'team_member', actor, p_parent_id, p_position);
  insert into public.team_members(entity_id, owner_member_id, name, role, identity, model,
                                  agent_tool, mode, permission_mode, capabilities,
                                  command_permissions, avatar)
  values (persona_id, owner_member, p_name, coalesce(p_role, ''), coalesce(p_identity, ''),
          p_model, p_agent_tool, p_mode, p_permission_mode,
          coalesce(p_capabilities, '{}'::jsonb), coalesce(p_command_permissions, '{}'::jsonb), p_avatar);
  perform internal.record_initial_version(persona_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(persona_id, null,
             internal.record_activity(p_space_id, persona_id, actor, 'created',
               null, jsonb_build_object('kind', 'team_member')), array[persona_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 6 of 11 — public.create_file_entity (017).
-- -----------------------------------------------------------------------------
create or replace function public.create_file_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_mime_type text default 'application/octet-stream', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, 'file', actor, p_parent_id, p_position);
  insert into public.files(entity_id, name, mime_type, size_bytes, storage_path)
  values (entity_id, p_title, coalesce(nullif(p_mime_type, ''), 'application/octet-stream'), 0,
          'spaces/' || p_space_id::text || '/' || entity_id::text);
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', 'file'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 7 of 11 — public.create_spell_entity (017).
-- -----------------------------------------------------------------------------
create or replace function public.create_spell_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_rule jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, 'spell', actor, p_parent_id, p_position);
  insert into public.spells(entity_id, name, description, rule)
  values (entity_id, p_title, coalesce(p_description, ''), coalesce(p_rule, '{}'::jsonb));
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', 'spell'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 8 of 11 — public.create_skill_entity (017).
-- -----------------------------------------------------------------------------
create or replace function public.create_skill_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_content text default '', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, 'skill', actor, p_parent_id, p_position);
  insert into public.skills(entity_id, name, description, content)
  values (entity_id, p_title, coalesce(p_description, ''), coalesce(p_content, ''));
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', 'skill'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 9 of 11 — public.create_pull_request_entity (017).
-- -----------------------------------------------------------------------------
create or replace function public.create_pull_request_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_provider text default 'github',
  p_url text default null, p_repo text default null, p_number integer default null,
  p_state text default 'open', p_head_sha text default null, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  if nullif(btrim(p_url), '') is null or nullif(btrim(p_repo), '') is null or coalesce(p_number, 0) < 1 then
    raise exception 'pull request url, repository, and positive number are required' using errcode = '22023';
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, 'pull_request', actor, p_parent_id, p_position);
  insert into public.pull_requests(entity_id, space_id, provider, url, repo, number, title, state, head_sha)
  values (entity_id, p_space_id, coalesce(nullif(p_provider, ''), 'github'), p_url, p_repo,
          p_number, p_title, coalesce(p_state, 'open'), p_head_sha);
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', 'pull_request'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 10 of 11 — public.create_commit_entity (017).
-- -----------------------------------------------------------------------------
create or replace function public.create_commit_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_provider text default 'github',
  p_url text default null, p_repo text default null, p_sha text default null,
  p_author text default null, p_committed_at timestamptz default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  if nullif(btrim(p_repo), '') is null or nullif(btrim(p_sha), '') is null then
    raise exception 'commit repository and sha are required' using errcode = '22023';
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, 'commit', actor, p_parent_id, p_position);
  insert into public.commits(entity_id, space_id, provider, url, repo, sha, message, author, committed_at)
  values (entity_id, p_space_id, coalesce(nullif(p_provider, ''), 'github'), p_url, p_repo,
          lower(p_sha), p_title, p_author, p_committed_at);
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', 'commit'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 11 of 11 — public.create_custom_entity (017). Custom kinds are
-- user-defined, so this door's projection shape is the least predictable of the
-- eleven — which is exactly why it must not be the one left open.
-- -----------------------------------------------------------------------------
create or replace function public.create_custom_entity(
  p_space_id uuid, p_kind text, p_title text, p_actor_id uuid default null,
  p_fields jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
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
  if p_kind !~ '^c:' then raise exception 'custom entity kind must be c:*' using errcode = '22023'; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id); perform internal.bind_actor(actor);
  entity_id := internal.create_envelope(p_space_id, p_kind, actor, p_parent_id, p_position);
  insert into public.custom_entities(entity_id, title, fields)
  values (entity_id, p_title, coalesce(p_fields, '{}'::jsonb));
  perform internal.record_initial_version(entity_id, actor);
  activity_id := internal.record_activity(p_space_id, entity_id, actor, 'created', null,
                   jsonb_build_object('kind', p_kind));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
    internal.command_result(entity_id, null, activity_id, array[entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- REPAIR 1 of 2 — public.update_space / spaces.update.
-- 031 bound public.w2_update_space and the record says this label is bound. This
-- sibling is GRANTED, has a bare return at 007:494, and stores the whole Space
-- projection. Binding it is what makes the shipped claim true.
-- -----------------------------------------------------------------------------
create or replace function public.update_space(
  p_space_id uuid, p_name text default null, p_description text default null,
  p_github_repo text default null, p_visibility text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{space,id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  if p_visibility is not null and p_visibility not in ('private','public') then
    raise exception 'invalid space visibility' using errcode = '22023';
  end if;
  update public.spaces
     set name = coalesce(p_name, name),
         description = coalesce(p_description, description),
         github_repo = coalesce(p_github_repo, github_repo),
         visibility = coalesce(p_visibility, visibility)
   where id = p_space_id;
  if not found then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  result := jsonb_build_object('space', (select to_jsonb(s) from public.spaces s where s.id = p_space_id),
                               'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- REPAIR 2 of 2 — public.update_project / projects.update.
-- 032 bound public.update_project_w2 — that was mine, and this is the door it
-- left open. GRANTED, bare return at 007:790, same project projection.
-- -----------------------------------------------------------------------------
create or replace function public.update_project(
  p_project_id uuid, p_name text default null, p_working_dir text default null,
  p_repo_url text default null, p_trust text default null, p_defaults jsonb default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  project public.projects;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.update');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{project,id}', p_project_id::text, 'project');
    return replay;
  end if;
  perform internal.require_node_admin();
  if p_trust is not null and p_trust not in ('trusted','untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  update public.projects
     set name = coalesce(p_name, name),
         working_dir = coalesce(p_working_dir, working_dir),
         repo_url = coalesce(p_repo_url, repo_url),
         trust = coalesce(p_trust, trust),
         defaults = coalesce(p_defaults, defaults)
   where id = p_project_id
  returning * into project;
  if project.id is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return internal.ledger_record(p_client_mutation_id, 'projects.update',
           jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

reset role;
