-- MCP definitions contain metadata only; credential values live in the sealed store.
-- 296 reserved by foundation worker; credentials use 297.
set role tm8_graph_owner;
insert into public.entity_kinds(kind,origin,space_id,icon) values ('mcp_server','core',null,'plug')
on conflict (kind) where space_id is null do nothing;
update public.edge_types set dst_kinds=array_append(dst_kinds,'mcp_server') where type='equips' and not ('mcp_server'=any(dst_kinds));

create or replace function internal.validate_mcp_definition(d jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare k text; a jsonb;
begin
 if jsonb_typeof(d) is distinct from 'object' or not (d ?& array['name','transport','envKeys','headerKeys','auth','approved']) then
   raise exception 'incomplete MCP definition' using errcode='22023'; end if;
 for k in select jsonb_object_keys(d) loop
   if not k=any(array['name','transport','command','args','url','envKeys','headerKeys','auth','approved','enabled','provenance','stdioTrusted','allowPrivateNetwork']) then
     raise exception 'unknown MCP field (literal env/header values are forbidden)' using errcode='22023'; end if;
 end loop;
 if (d->>'name') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$' or lower(d->>'name')='tm8' or d->>'transport' not in ('stdio','http')
    or jsonb_typeof(d->'approved')<>'boolean' or jsonb_typeof(d->'envKeys')<>'array' or jsonb_typeof(d->'headerKeys')<>'array' then
   raise exception 'invalid MCP name, transport or key declarations' using errcode='22023'; end if;
 if (d ? 'enabled' and jsonb_typeof(d->'enabled')<>'boolean') or (d ? 'stdioTrusted' and jsonb_typeof(d->'stdioTrusted')<>'boolean') or (d ? 'allowPrivateNetwork' and jsonb_typeof(d->'allowPrivateNetwork')<>'boolean') then
   raise exception 'MCP trust flags must be boolean' using errcode='22023'; end if;
 if jsonb_array_length(d->'envKeys')>32 or jsonb_array_length(d->'headerKeys')>32 then raise exception 'too many MCP keys' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(d->'envKeys') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')
 or exists(select 1 from jsonb_array_elements(d->'headerKeys') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[A-Za-z][A-Za-z0-9-]{0,127}$') then
   raise exception 'MCP keys must be names, never values' using errcode='22023'; end if;
 if d->>'transport'='http' and (not d ? 'url' or d ?| array['command','args'] or jsonb_array_length(d->'envKeys')<>0) then
   raise exception 'HTTP MCP requires URL and forbids subprocess fields' using errcode='22023'; end if;
 if d->>'transport'='stdio' and (not d ? 'command' or length(d->>'command') not between 1 and 1024 or d ? 'url' or jsonb_array_length(d->'headerKeys')<>0) then
   raise exception 'stdio MCP requires command and forbids HTTP fields' using errcode='22023'; end if;
 if d ? 'url' and (d->>'url' !~ '^https?://[^/@?#]+(/[^?#]*)?$' or length(d->>'url')>2048) then
   raise exception 'MCP URL must be HTTP(S), without credentials or query' using errcode='22023'; end if;
 if d ? 'args' then
   if jsonb_typeof(d->'args')<>'array' then raise exception 'MCP args must be an array' using errcode='22023'; end if;
   if jsonb_array_length(d->'args')>64 or exists(select 1 from jsonb_array_elements(d->'args') v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>4096) then
     raise exception 'invalid MCP args' using errcode='22023'; end if;
 end if;
 a:=d->'auth';
 if jsonb_typeof(a)<>'object' or coalesce(a->>'type','') not in ('none','api_key','oauth2') then raise exception 'invalid MCP auth' using errcode='22023'; end if;
 for k in select jsonb_object_keys(a) loop
   if not k=any(case a->>'type' when 'none' then array['type'] when 'api_key' then array['type','headerName','envKey','prefix'] else array['type','authorizationUrl','tokenUrl','clientId','scopes'] end) then
     raise exception 'literal MCP authentication values are forbidden' using errcode='22023'; end if;
 end loop;
 if a->>'type'<>'api_key' and jsonb_array_length(d->'envKeys')+jsonb_array_length(d->'headerKeys')<>0 then raise exception 'only API key auth declares a secret slot' using errcode='22023'; end if;
 if a->>'type'='api_key' then
   if jsonb_array_length(d->'envKeys')+jsonb_array_length(d->'headerKeys')<>1 then raise exception 'API key auth requires exactly one slot' using errcode='22023'; end if;
   if (d->>'transport'='http' and (not a ? 'headerName' or a ? 'envKey' or not (d->'headerKeys' ? (a->>'headerName'))))
   or (d->>'transport'='stdio' and (not a ? 'envKey' or a ? 'headerName' or not (d->'envKeys' ? (a->>'envKey'))))
   or (a ? 'prefix' and a->>'prefix' not in ('Bearer','none')) then raise exception 'MCP API key destination must be declared' using errcode='22023'; end if;
 end if;
 if a->>'type'='oauth2' then
   if d->>'transport'<>'http'
   or (a ? 'authorizationUrl' and a->>'authorizationUrl' !~ '^https?://[^/@?#]+(/[^?#]*)?$') or (a ? 'tokenUrl' and a->>'tokenUrl' !~ '^https?://[^/@?#]+(/[^?#]*)?$')
   or (a ? 'scopes' and jsonb_typeof(a->'scopes')<>'array') then raise exception 'invalid MCP OAuth metadata' using errcode='22023'; end if;
 end if;
end $$;

create table public.mcp_servers (
 entity_id uuid primary key references public.entities(id) on delete cascade,
 space_id uuid not null references public.spaces(id),
 title text not null,
 definition jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(space_id,title)
);
create trigger mcp_servers_validate_kind before insert or update of entity_id on public.mcp_servers
for each row execute function internal.validate_detail_envelope('mcp_server');
create or replace function internal.guard_mcp_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 perform internal.require_space_admin(new.space_id);
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then raise exception 'MCP space mismatch' using errcode='22023'; end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 return new;
end $$;
create trigger mcp_servers_guard before insert or update on public.mcp_servers for each row execute function internal.guard_mcp_definition();
create trigger mcp_servers_touch before update on public.mcp_servers for each row execute function internal.touch_updated_at();
create trigger mcp_servers_snapshot after update on public.mcp_servers for each row execute function internal.snapshot_entity_version();
alter table public.mcp_servers enable row level security;
create policy mcp_servers_select on public.mcp_servers for select to tm8_app using (exists(select 1 from public.entities e where e.id=entity_id and e.deleted_at is null offset 0));
grant select on public.mcp_servers to tm8_app;

-- Generic entity lifecycle is subject to the same admin gate, including restore.
create or replace function internal.guard_mcp_entity() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 perform internal.require_space_admin(old.space_id);
 if new.space_id<>old.space_id then raise exception 'MCP servers cannot move between spaces' using errcode='42501'; end if;
 return new;
end $$;
create trigger mcp_entity_lifecycle before update of deleted_at,parent_id,position,space_id on public.entities
for each row when (old.kind='mcp_server') execute function internal.guard_mcp_entity();

-- The generic edge RPC is not an approval bypass. Read access to a restricted
-- source is required in addition to membership; no credential is stored on edges.
create or replace function internal.guard_mcp_equips() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare edge public.edges; source public.entities; target public.entities; d jsonb;
begin
 if TG_OP='DELETE' then edge:=old; else edge:=new; end if;
 if TG_OP='UPDATE' and (old.src_id<>new.src_id or old.dst_id<>new.dst_id or old.type<>new.type) and exists(select 1 from public.entities where id=old.dst_id and kind='mcp_server') then raise exception 'MCP attachment endpoints are immutable' using errcode='42501'; end if;
 if edge.type<>'equips' then return coalesce(new,old); end if;
 select * into target from public.entities where id=edge.dst_id;
 if target.kind<>'mcp_server' then return coalesce(new,old); end if;
 source:=internal.live_entity(edge.src_id,null);
 perform internal.require_space_member(source.space_id);
 if source.space_id<>target.space_id or source.kind not in ('task','team_member','work_session') then raise exception 'invalid MCP attachment target' using errcode='42501'; end if;
 if not internal.entity_readable(target.id) then raise exception 'MCP connector is not accessible' using errcode='42501'; end if;
 if not internal.entity_readable(source.id) then raise exception 'MCP attachment target is not accessible' using errcode='42501'; end if;
 if TG_OP<>'DELETE' then
   select definition into d from public.mcp_servers where entity_id=target.id;
   if target.deleted_at is not null or (not (d->>'approved')::boolean or coalesce((d->>'enabled')::boolean,true)=false) then raise exception 'MCP attachment requires an approved connector' using errcode='42501'; end if;
   if edge.props<>'{}'::jsonb then raise exception 'MCP attachment cannot carry credentials or options' using errcode='22023'; end if;
 end if;
 return coalesce(new,old);
end $$;
create trigger mcp_equips_guard before insert or update or delete on public.edges for each row execute function internal.guard_mcp_equips();

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
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 283: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      -- 284: a space style's detail row. The row holds nothing secret (the
      -- document, tags and attribution), so the house form applies; the
      -- contract's camelCase shape is the read facade's job (`contentOf`).
      when 'style' then select to_jsonb(sty) - 'entity_id' into content from public.styles sty where sty.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

create or replace function public.create_mcp_server_entity(p_space_id uuid,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; target uuid;
begin
 perform internal.require_space_admin(p_space_id);
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'mcp.servers.create');
 if replay is not null then
   perform internal.require_replay_principal(p_client_mutation_id);
   perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space'); return replay;
 end if;
 actor:=internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
 perform internal.validate_mcp_definition(p_definition);
 target:=internal.create_envelope(p_space_id,'mcp_server',actor,null,null);
 insert into public.mcp_servers(entity_id,space_id,title,definition) values(target,p_space_id,p_definition->>'name',p_definition);
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'mcp.servers.create',internal.command_result(target,null,
 internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','mcp_server')),array[target]));
end $$;
create or replace function public.update_mcp_server_entity(p_entity_id uuid,p_expected_version integer,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; e public.entities;
begin
 e:=internal.live_entity(p_entity_id,'mcp_server'); perform internal.require_space_admin(e.space_id);
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'mcp.servers.update');
 if replay is not null then
   perform internal.require_replay_principal(p_client_mutation_id);
   perform internal.require_replay_subject(replay#>>'{entity,id}',p_entity_id::text,'entity'); return replay;
 end if;
 actor:=internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
 perform internal.assert_version(p_entity_id,p_expected_version);
 perform internal.validate_mcp_definition(p_definition);
 update public.mcp_servers set definition=p_definition where entity_id=p_entity_id;
 return internal.ledger_record(p_client_mutation_id,'mcp.servers.update',internal.command_result(p_entity_id,null,
 internal.record_activity(e.space_id,p_entity_id,actor,'updated',null,jsonb_build_object('kind','mcp_server')),array[p_entity_id]));
end $$;
revoke all on function public.create_mcp_server_entity(uuid,jsonb,uuid,text) from public;
grant execute on function public.create_mcp_server_entity(uuid,jsonb,uuid,text) to tm8_app;
revoke all on function public.update_mcp_server_entity(uuid,integer,jsonb,uuid,text) from public;
grant execute on function public.update_mcp_server_entity(uuid,integer,jsonb,uuid,text) to tm8_app;

-- Test inventory is private to the testing member and invalidated by definition edits.
create table public.mcp_server_health (
 server_id uuid not null references public.mcp_servers(entity_id) on delete cascade,
 member_id uuid not null references public.members(entity_id) on delete cascade,
 definition_version integer not null, result jsonb not null, checked_at timestamptz not null default now(),
 primary key(server_id,member_id)
);
alter table public.mcp_server_health enable row level security;
create policy mcp_health_select on public.mcp_server_health for select to tm8_app using (
 exists(select 1 from public.entities e where e.id=server_id and e.deleted_at is null and member_id=internal.current_member_id(e.space_id) offset 0));
grant select on public.mcp_server_health to tm8_app;
create or replace function public.record_mcp_server_health(p_server_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; m uuid;
begin
 e:=internal.live_entity(p_server_id,'mcp_server'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'MCP connector unavailable' using errcode='42501'; end if;
 m:=internal.current_member_id(e.space_id);
 if jsonb_typeof(p_result)<>'object' or not (p_result ?& array['ready','reason','tools','checkedAt'])
 or jsonb_typeof(p_result->'ready')<>'boolean' or jsonb_typeof(p_result->'tools')<>'array'
 or octet_length(p_result::text)>262144 then raise exception 'invalid MCP health result' using errcode='22023'; end if;
 insert into public.mcp_server_health(server_id,member_id,definition_version,result) values(e.id,m,e.version,p_result)
 on conflict(server_id,member_id) do update set definition_version=excluded.definition_version,result=excluded.result,checked_at=now();
 return p_result;
end $$;
revoke all on function public.record_mcp_server_health(uuid,jsonb) from public;
grant execute on function public.record_mcp_server_health(uuid,jsonb) to tm8_app;
reset role;
