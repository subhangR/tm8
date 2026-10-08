-- Managed providers can be connected by a human member without registering
-- arbitrary endpoints. Custom definitions and lifecycle policy remain admin-only.
set role tm8_graph_owner;

alter table public.mcp_servers add column builtin_provider text
  check (builtin_provider is null or builtin_provider = 'jira');
create unique index mcp_builtin_provider_per_space on public.mcp_servers(space_id,builtin_provider)
  where builtin_provider is not null;

create function internal.builtin_mcp_definition(p_provider text) returns jsonb
language plpgsql immutable set search_path=public,internal,pg_temp as $$
begin
 if p_provider is distinct from 'jira' then
  raise exception 'Unknown MCP provider' using errcode='22023';
 end if;
 return jsonb_build_object(
  'name','jira','transport','http','url','https://mcp.atlassian.com/v2/mcp',
  'envKeys','[]'::jsonb,'headerKeys','[]'::jsonb,
  'auth',jsonb_build_object('type','oauth2','scopes',jsonb_build_array(
    'read:me','read:account','offline_access',
    'read:jira:agent-interface','write:jira:agent-interface','search:jira:agent-interface')),
  'provenance','Atlassian Jira','approved',true,'enabled',true,'allowPrivateNetwork',false);
end $$;

create or replace function internal.guard_mcp_definition() returns trigger
language plpgsql set search_path=public,internal,pg_temp as $$
begin
 if tg_op='INSERT' and new.builtin_provider is not null
    and new.definition=internal.builtin_mcp_definition(new.builtin_provider) then
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(new.space_id);
 else
  perform internal.require_space_admin(new.space_id);
 end if;
 if tg_op='UPDATE' and new.builtin_provider is distinct from old.builtin_provider then
  raise exception 'Managed MCP provider identity is immutable' using errcode='42501';
 end if;
 if new.builtin_provider is not null and
    (new.definition-array['approved','enabled','provenance']) is distinct from
    (internal.builtin_mcp_definition(new.builtin_provider)-array['approved','enabled','provenance']) then
  raise exception 'Managed MCP provider configuration is fixed' using errcode='42501';
 end if;
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then
  raise exception 'MCP space mismatch' using errcode='22023';
 end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 return new;
end $$;

create function public.ensure_mcp_provider_server(p_space_id uuid,p_provider_id text,
 p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare d jsonb; replay jsonb; target uuid; actor uuid; e public.entities;
begin
 perform internal.require_human_auth_kind();
 perform internal.require_space_member(p_space_id);
 d:=internal.builtin_mcp_definition(p_provider_id);
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'mcp.providers.connect');
 if replay is not null then
  perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space');
 end if;
 -- First connects from different members share one definition, never an account.
 perform pg_advisory_xact_lock(hashtextextended(p_space_id::text||':'||p_provider_id,314));
 select s.entity_id,s.definition into target,d from public.mcp_servers s
  where s.space_id=p_space_id and s.builtin_provider=p_provider_id;
 if target is not null then
  select * into e from public.entities where id=target;
  if e.deleted_at is not null or d->>'approved'<>'true' or coalesce(d->>'enabled','true')<>'true' then
   raise exception 'Jira has been disabled by an administrator' using errcode='42501';
  end if;
  if not internal.entity_readable(target) then
   raise exception 'MCP provider is not accessible' using errcode='42501';
  end if;
  if replay is not null then return replay; end if;
  return internal.ledger_record(p_client_mutation_id,'mcp.providers.connect',
    internal.command_result(target,null,null,array[target]));
 end if;
 if replay is not null then
  raise exception 'MCP provider is no longer available' using errcode='42501';
 end if;
 if exists(select 1 from public.mcp_servers where space_id=p_space_id and title=p_provider_id) then
  raise exception 'A custom Jira connector already uses this name; an administrator must rename it' using errcode='23505';
 end if;
 d:=internal.builtin_mcp_definition(p_provider_id);
 actor:=internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
 target:=internal.create_envelope(p_space_id,'mcp_server',actor,null,null);
 insert into public.mcp_servers(entity_id,space_id,title,definition,builtin_provider)
  values(target,p_space_id,p_provider_id,d,p_provider_id);
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'mcp.providers.connect',
  internal.command_result(target,null,
   internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','mcp_server','providerId',p_provider_id)),
   array[target]));
end $$;
revoke all on function public.ensure_mcp_provider_server(uuid,text,uuid,text) from public;
grant execute on function public.ensure_mcp_provider_server(uuid,text,uuid,text) to tm8_app;
reset role;
