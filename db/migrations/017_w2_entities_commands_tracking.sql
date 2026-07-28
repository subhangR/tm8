-- =============================================================================
-- 017 W2.G02 — universal entity writes, provider mirrors, and tracking queue.
--
-- This migration is deliberately self-contained over 001..015.  It adds only
-- enumerable, typed SECURITY DEFINER RPCs; tm8_app retains SELECT + EXECUTE and
-- never receives direct table-write privileges.
-- =============================================================================
set role tm8_graph_owner;

-- A custom entity still needs the universal title carried by EntitySummary.
alter table public.custom_entities
  add column title text not null default 'Custom entity'
    check (char_length(btrim(title)) between 1 and 500);

-- Keep the shared content/snapshot dispatcher total, including the custom title.
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- The base graph omitted these content-bearing detail tables from versioning.
create trigger channels_w2_snapshot_version after update on public.channels
for each row execute function internal.snapshot_entity_version();
create trigger files_w2_snapshot_version after update on public.files
for each row execute function internal.snapshot_entity_version();
create trigger pull_requests_w2_snapshot_version after update on public.pull_requests
for each row execute function internal.snapshot_entity_version();
create trigger commits_w2_snapshot_version after update on public.commits
for each row execute function internal.snapshot_entity_version();

-- -----------------------------------------------------------------------------
-- Typed create RPCs for universal kinds not covered by 007.
-- -----------------------------------------------------------------------------
create or replace function public.create_file_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_mime_type text default 'application/octet-stream', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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

create or replace function public.create_spell_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_rule jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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

create or replace function public.create_skill_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_content text default '', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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

create or replace function public.create_pull_request_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_provider text default 'github',
  p_url text default null, p_repo text default null, p_number integer default null,
  p_state text default 'open', p_head_sha text default null, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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

create or replace function public.create_commit_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_provider text default 'github',
  p_url text default null, p_repo text default null, p_sha text default null,
  p_author text default null, p_committed_at timestamptz default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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

create or replace function public.create_custom_entity(
  p_space_id uuid, p_kind text, p_title text, p_actor_id uuid default null,
  p_fields jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
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
-- Typed patch RPCs. Detail-table snapshot triggers exclusively own version bumps.
-- -----------------------------------------------------------------------------
create or replace function public.update_file_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_mime_type text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'file'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.files set name = coalesce(p_title, name), mime_type = coalesce(p_mime_type, mime_type)
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','file'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

create or replace function public.update_spell_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null, p_rule jsonb default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'spell'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.spells set name = coalesce(p_title, name), description = coalesce(p_description, description),
    rule = coalesce(p_rule, rule) where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','spell'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

create or replace function public.update_skill_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null, p_content text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'skill'); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.skills set name = coalesce(p_title, name), description = coalesce(p_description, description),
    content = coalesce(p_content, content) where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null, jsonb_build_object('kind','skill'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

create or replace function public.update_pull_request_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_url text default null, p_state text default null,
  p_head_sha text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
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
$$;

create or replace function public.update_commit_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_url text default null, p_author text default null,
  p_committed_at timestamptz default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
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
$$;

create or replace function public.update_custom_entity(
  p_entity_id uuid, p_expected_version integer, p_title text default null,
  p_actor_id uuid default null, p_fields jsonb default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch'); if replay is not null then return replay; end if;
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
$$;

-- Generic lifecycle commands must not cross ownership boundaries.
create or replace function public.move_entity(
  p_entity_id uuid, p_parent_id uuid, p_position double precision, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.move'); if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_entity_id and deleted_at is null for update;
  if e.id is null then raise exception 'entity not found' using errcode = 'P0002'; end if;
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.entities set parent_id = p_parent_id, position = p_position, version = version + 1,
    updated_at = now(), activity_at = now() where id = p_entity_id;
  insert into public.entity_versions(entity_id,version,snapshot,changed_by)
  select p_entity_id,current.version,internal.entity_snapshot(p_entity_id),actor
    from public.entities current where current.id=p_entity_id
  on conflict(entity_id,version) do nothing;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'moved', null,
    jsonb_build_object('fromParentId',e.parent_id,'toParentId',p_parent_id));
  return internal.ledger_record(p_client_mutation_id, 'entities.move',
    internal.command_result(p_entity_id, null, activity_id, array[p_entity_id],
      internal.issue_undo_token(e.space_id, actor, 'Undo move', 'entities.move',
        jsonb_build_object('entityId',p_entity_id,'parentId',e.parent_id,'position',e.position,
                           'expectedVersion',e.version + 1))));
end
$$;

create or replace function public.delete_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.delete'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id); perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  with recursive subtree(id, path, depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path || child.id, s.depth + 1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct s.id) into affected from subtree s join public.entities e2 on e2.id=s.id
   where e2.deleted_at is null;
  update public.entities set deleted_at=now(), updated_at=now()
   where id = any(coalesce(affected,array[]::uuid[]));
  activity_id := internal.record_activity(e.space_id,p_entity_id,actor,'deleted',null,jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.delete',
    internal.command_result(p_entity_id,null,activity_id,coalesce(affected,array[p_entity_id]),
      internal.issue_undo_token(e.space_id,actor,'Undo delete','entities.restore',jsonb_build_object('entityId',p_entity_id))));
end
$$;

create or replace function public.restore_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.restore'); if replay is not null then return replay; end if;
  select * into e from public.entities where id=p_entity_id for update;
  if e.id is null then raise exception 'entity not found' using errcode='P0002'; end if;
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
  if e.parent_id is not null and exists(select 1 from public.entities p where p.id=e.parent_id and p.deleted_at is not null) then
    raise exception 'restore the parent first' using errcode='23514';
  end if;
  with recursive subtree(id,path,depth) as (
    select p_entity_id,array[p_entity_id],0
    union all
    select child.id,s.path||child.id,s.depth+1 from public.entities child join subtree s on child.parent_id=s.id
     where s.depth<256 and not child.id=any(s.path)
  )
  select array_agg(distinct id) into affected from subtree;
  update public.entities set deleted_at=null,updated_at=now()
   where id=any(coalesce(affected,array[p_entity_id])) and deleted_at is not null;
  activity_id := internal.record_activity(e.space_id,p_entity_id,actor,'restored',null,jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.restore',
    internal.command_result(p_entity_id,null,activity_id,coalesce(affected,array[p_entity_id])));
end
$$;

-- Reactions are always authored by an actual human member. An explicit
-- teammate actor is refused instead of silently falling back to the caller.
create or replace function public.react(
  p_entity_id uuid, p_reaction text, p_enabled boolean default true,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; target public.entities; actor uuid; edge_type text; opposite text;
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.react'); if replay is not null then return replay; end if;
  edge_type := case lower(p_reaction) when 'like' then 'likes' when 'likes' then 'likes'
    when 'dislike' then 'dislikes' when 'dislikes' then 'dislikes'
    when 'star' then 'stars' when 'stars' then 'stars' else null end;
  if edge_type is null then raise exception 'unsupported reaction: %',p_reaction using errcode='22023'; end if;
  target := internal.live_entity(p_entity_id); perform internal.require_space_member(target.space_id);
  actor := case when p_actor_id is null then internal.current_member_id(target.space_id)
                else internal.resolve_actor(p_actor_id,target.space_id) end;
  if actor is null or not exists(select 1 from public.members where entity_id=actor and space_id=target.space_id) then
    raise exception 'reactions are authored by a human member' using errcode='42501';
  end if;
  perform internal.bind_actor(actor);
  if not p_enabled then
    delete from public.edges where src_id=actor and dst_id=p_entity_id and type=edge_type;
  else
    opposite := case edge_type when 'likes' then 'dislikes' when 'dislikes' then 'likes' else null end;
    if opposite is not null then delete from public.edges where src_id=actor and dst_id=p_entity_id and type=opposite; end if;
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
    values(target.space_id,actor,p_entity_id,edge_type,actor)
    on conflict(src_id,dst_id,type) do update set updated_at=now();
  end if;
  return internal.ledger_record(p_client_mutation_id,'entities.react',
    internal.command_result(p_entity_id,null,
      internal.record_activity(target.space_id,p_entity_id,actor,'reacted',null,
        jsonb_build_object('reaction',edge_type,'enabled',p_enabled)),array[p_entity_id]));
end
$$;

-- Pulls pin an immutable projection and its provenance, not just a version number.
create or replace function public.set_pull_state(
  p_entity_id uuid, p_pinned_version integer, p_local_id text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; edge_id uuid; projection jsonb; source_changed_at timestamptz;
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.pull'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id); perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
  if p_pinned_version<1 or p_pinned_version>e.version then
    raise exception 'pinned version % is not a version of this entity',p_pinned_version using errcode='22023';
  end if;
  select snapshot,changed_at into projection,source_changed_at from public.entity_versions
   where entity_id=p_entity_id and version=p_pinned_version;
  if projection is null and p_pinned_version=e.version then
    projection := internal.entity_snapshot(p_entity_id); source_changed_at := e.updated_at;
  end if;
  if projection is null then raise exception 'pinned version is no longer retained' using errcode='P0002'; end if;
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(e.space_id,actor,p_entity_id,'pulled',jsonb_build_object(
    'localId',p_local_id,'pinnedVersion',p_pinned_version,'pulledAt',now(),
    'projection',projection,'projectionHash',md5(projection::text),'sourceActivityAt',source_changed_at),actor)
  on conflict(src_id,dst_id,type) do update set props=excluded.props,updated_at=now()
  returning id into edge_id;
  return internal.ledger_record(p_client_mutation_id,'entities.commands.pull',
    internal.command_result(p_entity_id,edge_id,
      internal.record_activity(e.space_id,p_entity_id,actor,'pulled',edge_id,
        jsonb_build_object('pinnedVersion',p_pinned_version,'projectionHash',md5(projection::text))),array[p_entity_id]));
end
$$;

-- Project association shared only by the two provider-link RPCs. The caller
-- must already hold the ProjectResource lock; this helper rechecks the active
-- Space link and live projection while that lock is held.
create or replace function internal.w2_associate_tracking_project(
  p_space_id uuid, p_artifact_id uuid, p_project_id uuid, p_actor_id uuid
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare projection_id uuid; association_id uuid; prior_origin text;
begin
  if p_project_id is null then return null; end if;
  select links.project_entity_id into projection_id
    from public.space_projects memberships
    join public.project_links links on links.space_id=memberships.space_id and links.project_id=memberships.project_id
    join public.project_projection_details details on details.entity_id=links.project_entity_id
                                               and details.project_id=memberships.project_id
    join public.entities projection on projection.id=links.project_entity_id
   where memberships.space_id=p_space_id and memberships.project_id=p_project_id
     and projection.space_id=p_space_id and projection.kind='project' and projection.deleted_at is null;
  if projection_id is null then
    raise exception 'Project is not actively linked to this Space'
      using errcode='23514', detail='project_not_linked';
  end if;

  select id,props->>'origin' into association_id,prior_origin from public.edges
   where src_id=p_artifact_id and dst_id=projection_id and type='in_project' for update;
  if association_id is null then
    perform internal.w1_set_writer('materialized');
    insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
    values(p_space_id,p_artifact_id,projection_id,'in_project','{}'::jsonb,p_actor_id)
    returning id into association_id;
    perform internal.w1_set_writer(null);
  elsif coalesce(prior_origin,'user') <> 'materialized' then
    -- project_correction is the frozen privileged writer accepted by the W1
    -- edge guard. The marker is what G06 uses to demote instead of remove.
    perform internal.w1_set_writer('project_correction');
    update public.edges set props=props || jsonb_build_object(
      'origin','materialized','promotedFromOrigin',coalesce(prior_origin,'user')),updated_at=now()
     where id=association_id;
    perform internal.w1_set_writer(null);
  end if;
  return projection_id;
end
$$;

create or replace function public.link_pull_request(
  p_task_id uuid, p_url text, p_provider text, p_repo text, p_number integer,
  p_project_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; task public.entities; actor uuid; artifact_id uuid; tracks_id uuid;
  projection_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.linkPr'); if replay is not null then return replay; end if;
  if p_project_id is not null then
    perform 1 from public.projects where id=p_project_id for update;
    if not found then raise exception 'Project not found' using errcode='23514',detail='project_not_linked'; end if;
  end if;
  select * into task from public.entities where id=p_task_id and kind='task' and deleted_at is null for update;
  if task.id is null then raise exception 'task not found' using errcode='P0002'; end if;
  perform internal.require_space_member(task.space_id);
  actor := internal.resolve_actor(p_actor_id,task.space_id); perform internal.bind_actor(actor);
  if nullif(btrim(p_repo),'') is null or p_number<1 or nullif(btrim(p_url),'') is null then
    raise exception 'invalid pull request reference' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(task.space_id::text||':pr:'||lower(p_provider)||':'||lower(p_repo)||':'||p_number,0));
  select entity_id into artifact_id from public.pull_requests
   where space_id=task.space_id and provider=lower(p_provider) and repo=p_repo and number=p_number for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(task.space_id,'pull_request',actor,null,null);
    insert into public.pull_requests(entity_id,space_id,provider,url,repo,number,title,state)
    values(artifact_id,task.space_id,lower(p_provider),p_url,p_repo,p_number,p_repo||' #'||p_number,'open');
    perform internal.record_initial_version(artifact_id,actor);
  else
    update public.pull_requests set url=p_url,updated_at=now() where entity_id=artifact_id and url is distinct from p_url;
  end if;
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(task.space_id,p_task_id,artifact_id,'tracks',jsonb_build_object('url',p_url),actor)
  on conflict(src_id,dst_id,type) do update set props=excluded.props,updated_at=now()
  returning id into tracks_id;
  if p_project_id is not null then
    perform 1 from public.spaces where id=task.space_id for update;
    projection_id := internal.w2_associate_tracking_project(task.space_id,artifact_id,p_project_id,actor);
  end if;
  activity_id := internal.record_activity(task.space_id,p_task_id,actor,'pr.linked',tracks_id,
    jsonb_build_object('pullRequestId',artifact_id,'url',p_url,'projectId',p_project_id));
  return internal.ledger_record(p_client_mutation_id,'entities.commands.linkPr',
    internal.command_result(p_task_id,tracks_id,activity_id,
      array_remove(array[p_task_id,artifact_id,projection_id],null)));
end
$$;

create or replace function public.link_commit(
  p_task_id uuid, p_url text, p_provider text, p_repo text, p_sha text,
  p_project_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; task public.entities; actor uuid; artifact_id uuid; tracks_id uuid;
  projection_id uuid; activity_id uuid; normalized_sha text := lower(p_sha);
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.linkCommit'); if replay is not null then return replay; end if;
  if p_project_id is not null then
    perform 1 from public.projects where id=p_project_id for update;
    if not found then raise exception 'Project not found' using errcode='23514',detail='project_not_linked'; end if;
  end if;
  select * into task from public.entities where id=p_task_id and kind='task' and deleted_at is null for update;
  if task.id is null then raise exception 'task not found' using errcode='P0002'; end if;
  perform internal.require_space_member(task.space_id);
  actor := internal.resolve_actor(p_actor_id,task.space_id); perform internal.bind_actor(actor);
  if nullif(btrim(p_repo),'') is null or normalized_sha !~ '^[a-f0-9]{7,64}$' then
    raise exception 'invalid commit reference' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(task.space_id::text||':commit:'||lower(p_provider)||':'||lower(p_repo)||':'||normalized_sha,0));
  select entity_id into artifact_id from public.commits
   where space_id=task.space_id and provider=lower(p_provider) and repo=p_repo and sha=normalized_sha for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(task.space_id,'commit',actor,null,null);
    insert into public.commits(entity_id,space_id,provider,url,repo,sha,message)
    values(artifact_id,task.space_id,lower(p_provider),p_url,p_repo,normalized_sha,normalized_sha);
    perform internal.record_initial_version(artifact_id,actor);
  else
    update public.commits set url=p_url,updated_at=now() where entity_id=artifact_id and url is distinct from p_url;
  end if;
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(task.space_id,p_task_id,artifact_id,'tracks',jsonb_build_object('url',p_url),actor)
  on conflict(src_id,dst_id,type) do update set props=excluded.props,updated_at=now()
  returning id into tracks_id;
  if p_project_id is not null then
    perform 1 from public.spaces where id=task.space_id for update;
    projection_id := internal.w2_associate_tracking_project(task.space_id,artifact_id,p_project_id,actor);
  end if;
  activity_id := internal.record_activity(task.space_id,p_task_id,actor,'linked',tracks_id,
    jsonb_build_object('commitId',artifact_id,'url',p_url,'projectId',p_project_id));
  return internal.ledger_record(p_client_mutation_id,'entities.commands.linkCommit',
    internal.command_result(p_task_id,tracks_id,activity_id,
      array_remove(array[p_task_id,artifact_id,projection_id],null)));
end
$$;

create or replace function public.queue_tracking_refresh(
  p_entity_ids uuid[] default '{}'::uuid[], p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; row_value record; requester uuid; actor uuid; request_id uuid; request_ids uuid[] := '{}';
  normalized uuid[] := array(select distinct value from unnest(coalesce(p_entity_ids,'{}'::uuid[])) value order by value);
begin
  replay := internal.ledger_replay(p_client_mutation_id,'tracking.refresh'); if replay is not null then return replay; end if;
  if cardinality(normalized)>0 and exists(
    select 1 from unnest(normalized) requested
    left join public.entities e on e.id=requested and e.deleted_at is null and e.kind in ('pull_request','commit')
    where e.id is null or not internal.is_space_member(e.space_id)
  ) then
    raise exception 'tracking entity not found or not readable' using errcode='P0002';
  end if;
  for row_value in
    select memberships.space_id,
      case when cardinality(normalized)=0 then null::uuid[]
           else array_agg(e.id order by e.id) end entity_ids
      from public.members memberships
      left join public.entities e on cardinality(normalized)>0 and e.id=any(normalized)
                                 and e.space_id=memberships.space_id
     where memberships.identity_id=internal.identity_id()
       and (cardinality(normalized)=0 or e.id is not null)
     group by memberships.space_id
     order by memberships.space_id
  loop
    requester := internal.current_member_id(row_value.space_id);
    actor := internal.resolve_actor(p_actor_id,row_value.space_id); perform internal.bind_actor(actor);
    insert into public.tracking_refresh_requests(space_id,requested_by,entity_ids)
    values(row_value.space_id,requester,row_value.entity_ids) returning id into request_id;
    request_ids := request_ids || request_id;
  end loop;
  if cardinality(request_ids)=0 then raise exception 'no readable Space to refresh' using errcode='42501'; end if;
  return internal.ledger_record(p_client_mutation_id,'tracking.refresh',jsonb_build_object(
    'accepted',true,'status','queued','requestIds',request_ids));
end
$$;

-- New functions default to PUBLIC EXECUTE. Restore the audited posture and then
-- grant only the concrete contract RPCs to tm8_app.
revoke all on function public.create_file_entity(uuid,text,uuid,text,uuid,double precision,text) from public;
revoke all on function public.create_spell_entity(uuid,text,uuid,text,jsonb,uuid,double precision,text) from public;
revoke all on function public.create_skill_entity(uuid,text,uuid,text,text,uuid,double precision,text) from public;
revoke all on function public.create_pull_request_entity(uuid,text,uuid,text,text,text,integer,text,text,uuid,double precision,text) from public;
revoke all on function public.create_commit_entity(uuid,text,uuid,text,text,text,text,text,timestamptz,uuid,double precision,text) from public;
revoke all on function public.create_custom_entity(uuid,text,text,uuid,jsonb,uuid,double precision,text) from public;
revoke all on function public.update_file_entity(uuid,integer,uuid,text,text,text) from public;
revoke all on function public.update_spell_entity(uuid,integer,uuid,text,text,jsonb,text) from public;
revoke all on function public.update_skill_entity(uuid,integer,uuid,text,text,text,text) from public;
revoke all on function public.update_pull_request_entity(uuid,integer,uuid,text,text,text,text,text) from public;
revoke all on function public.update_commit_entity(uuid,integer,uuid,text,text,text,timestamptz,text) from public;
revoke all on function public.update_custom_entity(uuid,integer,text,uuid,jsonb,text) from public;
revoke all on function public.link_pull_request(uuid,text,text,text,integer,uuid,uuid,text) from public;
revoke all on function public.link_commit(uuid,text,text,text,text,uuid,uuid,text) from public;
revoke all on function public.queue_tracking_refresh(uuid[],uuid,text) from public;

grant execute on function public.create_file_entity(uuid,text,uuid,text,uuid,double precision,text),
  public.create_spell_entity(uuid,text,uuid,text,jsonb,uuid,double precision,text),
  public.create_skill_entity(uuid,text,uuid,text,text,uuid,double precision,text),
  public.create_pull_request_entity(uuid,text,uuid,text,text,text,integer,text,text,uuid,double precision,text),
  public.create_commit_entity(uuid,text,uuid,text,text,text,text,text,timestamptz,uuid,double precision,text),
  public.create_custom_entity(uuid,text,text,uuid,jsonb,uuid,double precision,text),
  public.update_file_entity(uuid,integer,uuid,text,text,text),
  public.update_spell_entity(uuid,integer,uuid,text,text,jsonb,text),
  public.update_skill_entity(uuid,integer,uuid,text,text,text,text),
  public.update_pull_request_entity(uuid,integer,uuid,text,text,text,text,text),
  public.update_commit_entity(uuid,integer,uuid,text,text,text,timestamptz,text),
  public.update_custom_entity(uuid,integer,text,uuid,jsonb,text),
  public.link_pull_request(uuid,text,text,text,integer,uuid,uuid,text),
  public.link_commit(uuid,text,text,text,text,uuid,uuid,text),
  public.queue_tracking_refresh(uuid[],uuid,text)
to tm8_app;

revoke all on function internal.w2_associate_tracking_project(uuid,uuid,uuid,uuid) from public;
reset role;
