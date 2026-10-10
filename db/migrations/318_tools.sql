-- Tools: versioned bash/python definitions, configured inputs and PTY run records.
-- SHARED-OBJECT NOTICE: internal.entity_content is copied VERBATIM from 304
-- with one tool arm. is_server_only_credential_provider retains typesafe/mcp.
-- The provider and session_kind CHECKs retain every existing value.
--
-- SESSION-KIND AUDIT: 083 agent caps/participants/repair remain agent-only;
-- 101/177 CHECK widened; 158/313 counts exclude tool; 187 sharing defaults
-- remain agent/shell only (live output is not redacted); 206/239/290 recorder
-- widened only for tool/tool; 273 mint/settle records bound or none/tool;
-- 302 outcome settles at tool exit and idle auto-close excludes tool.
-- execution_spawn/resume remain agent-only; shell/container caps stay disjoint.
-- PTY transitions and node ghost reconciliation still apply to every kind.
-- SHARED-OBJECT NOTICE: credential recorder/rollup are based on 290/273;
-- repoint overloads retain 290/309 bodies with an explicit tool refusal;
-- service-key reader retains 297; counts and auto-close retain 313/302.
set role tm8_graph_owner;

insert into public.entity_kinds(kind,origin,space_id,icon)
values ('tool','core',null,'terminal') on conflict (kind) where space_id is null do nothing;
insert into public.edge_types(type,src_kinds,dst_kinds,description)
values ('executes',array['work_session'],array['tool'],'A work session executes a pinned tool version')
on conflict (type) do nothing;

create function internal.validate_tool_input_value(i jsonb, v jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare t text:=i->>'type'; n numeric;
begin
 if v is null then raise exception 'input value is required' using errcode='22023'; end if;
 if t='secret' then raise exception 'secret values cannot be configured or defaulted' using errcode='22023'; end if;
 if (t in ('string','path','enum') and jsonb_typeof(v)<>'string')
 or (t='path' and length(v#>>'{}')=0)
 or (t='bool' and jsonb_typeof(v)<>'boolean')
 or (t in ('int','number') and jsonb_typeof(v)<>'number')
 or (t='enum' and not (i->'options' ? (v#>>'{}'))) then
   raise exception 'input value does not match its declaration' using errcode='22023'; end if;
 if t in ('int','number') then
   n:=(v#>>'{}')::numeric;
   if (t='int' and (n<>trunc(n) or abs(n)>9007199254740991))
   or (i ? 'min' and n<(i->>'min')::numeric) or (i ? 'max' and n>(i->>'max')::numeric) then
     raise exception 'input value is outside its declared range' using errcode='22023'; end if;
 end if;
end $$;

create function internal.validate_tool_definition(d jsonb) returns void
language plpgsql immutable set search_path=public,internal,pg_temp as $$
declare k text; i jsonb; t text; f text; env_name text; used_flags text[];
 names text[]:=array[]::text[]; flags text[]:=array[]::text[];
 envs text[]:=array[]::text[]; shorts text[]:=array[]::text[];
begin
 if jsonb_typeof(d) is distinct from 'object'
 or not (d ?& array['name','description','help','runtime','source','inputs','tm8Access','timeoutSeconds']) then
   raise exception 'incomplete tool definition' using errcode='22023'; end if;
 for k in select jsonb_object_keys(d) loop
   if not k=any(array['name','description','help','runtime','source','inputs','tm8Access','timeoutSeconds']) then
     raise exception 'unknown tool definition field' using errcode='22023'; end if;
 end loop;
 foreach k in array array['name','description','help','runtime','source','tm8Access'] loop
   if jsonb_typeof(d->k)<>'string' then raise exception 'tool metadata must be strings' using errcode='22023'; end if;
 end loop;
 if d->>'name' !~ '^[a-z][a-z0-9-]{1,62}$' or d->>'runtime' not in ('bash','python')
 or d->>'tm8Access' not in ('none','read','write') or length(d->>'description')>20000
 or length(d->>'help')>20000 or octet_length(d->>'source') not between 1 and 262144
 or jsonb_typeof(d->'inputs')<>'array' or jsonb_typeof(d->'timeoutSeconds')<>'number' then
   raise exception 'invalid tool definition' using errcode='22023'; end if;
 if (d->>'timeoutSeconds')::numeric<>trunc((d->>'timeoutSeconds')::numeric)
 or (d->>'timeoutSeconds')::numeric not between 1 and 2147483647
 or jsonb_array_length(d->'inputs')>64 then raise exception 'invalid tool limits' using errcode='22023'; end if;
 for i in select value from jsonb_array_elements(d->'inputs') loop
   if jsonb_typeof(i)<>'object' or not (i ?& array['name','type']) then raise exception 'invalid input declaration' using errcode='22023'; end if;
   t:=i->>'type';
   if jsonb_typeof(i->'name')<>'string' or i->>'name' !~ '^[a-z][a-z0-9_]{0,63}$'
   or jsonb_typeof(i->'type')<>'string' or t not in ('string','int','number','bool','enum','json','path','secret') then
     raise exception 'invalid input name or type' using errcode='22023'; end if;
   for k in select jsonb_object_keys(i) loop
     if not k=any(array['name','type','required','description','flag','short','env'])
     and not (k='default' and t<>'secret') and not (k in ('min','max') and t in ('int','number'))
     and not (k='options' and t='enum') then raise exception 'unknown input field' using errcode='22023'; end if;
   end loop;
   if (i ? 'required' and jsonb_typeof(i->'required')<>'boolean')
   or (i ? 'description' and (jsonb_typeof(i->'description')<>'string' or length(i->>'description')>20000))
   or (i ? 'flag' and (jsonb_typeof(i->'flag')<>'string' or i->>'flag' !~ '^[a-z][a-z0-9-]{0,63}$'))
   or (i ? 'short' and (jsonb_typeof(i->'short')<>'string' or i->>'short' !~ '^[A-Za-z]$'))
   or (i ? 'env' and (jsonb_typeof(i->'env')<>'string' or i->>'env' !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')) then
     raise exception 'invalid input metadata' using errcode='22023'; end if;
   f:=coalesce(i->>'flag',replace(i->>'name','_','-'));
   env_name:=coalesce(i->>'env',upper(i->>'name'));
   used_flags:=case t when 'bool' then array[f,'no-'||f] when 'secret' then array[f,f||'-from-env'] else array[f] end;
   if i->>'name'=any(names) or used_flags && flags or f='help'
   or env_name=any(envs) or upper(env_name) ~ '^(TM8_|LD_|DYLD_|PYTHON|BASH_FUNC_|LC_)'
   or upper(env_name)=any(array['PATH','HOME','SHELL','USER','LOGNAME','TERM','COLORTERM','LANG','TMPDIR','IFS','ENV','BASH_ENV','SHELLOPTS','BASHOPTS','CDPATH','GLOBIGNORE','PS4','PROMPT_COMMAND','PWD','OLDPWD'])
   or (i ? 'short' and (i->>'short'=any(shorts) or i->>'short'='h')) then
     raise exception 'duplicate or reserved input name, flag or environment' using errcode='22023'; end if;
   names:=array_append(names,i->>'name'); flags:=flags||used_flags; envs:=array_append(envs,env_name);
   if i ? 'short' then shorts:=array_append(shorts,i->>'short'); end if;
   if t='enum' then
     if jsonb_typeof(i->'options') is distinct from 'array' then raise exception 'enum requires options' using errcode='22023'; end if;
     if jsonb_array_length(i->'options') not between 1 and 256
     or exists(select 1 from jsonb_array_elements(i->'options') v where jsonb_typeof(v)<>'string' or length(v#>>'{}')=0)
     or (select count(distinct v) from jsonb_array_elements(i->'options') v)<>jsonb_array_length(i->'options') then
       raise exception 'invalid enum options' using errcode='22023'; end if;
   end if;
   foreach k in array array['min','max'] loop
     if i ? k then
       if jsonb_typeof(i->k)<>'number' then raise exception 'range bounds must be numeric' using errcode='22023'; end if;
       if t='int' and ((i->>k)::numeric<>trunc((i->>k)::numeric) or abs((i->>k)::numeric)>9007199254740991) then
         raise exception 'integer bounds must be safe integers' using errcode='22023'; end if;
     end if;
   end loop;
   if i ?& array['min','max'] and (i->>'min')::numeric>(i->>'max')::numeric then raise exception 'min exceeds max' using errcode='22023'; end if;
   if i ? 'default' then perform internal.validate_tool_input_value(i,i->'default'); end if;
 end loop;
end $$;

create table public.tools (
 entity_id uuid primary key references public.entities(id) on delete cascade,
 space_id uuid not null references public.spaces(id), title text not null,
 definition jsonb not null, execution_version integer not null default 1, config_revision integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index tools_name_lookup_idx on public.tools(space_id,title);
create trigger tools_validate_kind before insert or update of entity_id on public.tools
for each row execute function internal.validate_detail_envelope('tool');
create function internal.guard_tool_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 -- Serialize live-name checks; a soft-deleted definition frees its CLI handle.
 perform pg_advisory_xact_lock(hashtextextended(new.space_id::text||(new.definition->>'name'),318));
 perform internal.require_space_member(new.space_id);
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id)
 or not internal.entity_readable(new.entity_id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.validate_tool_definition(new.definition); new.title:=new.definition->>'name';
 if exists(select 1 from public.tools t join public.entities e on e.id=t.entity_id
   where t.space_id=new.space_id and t.title=new.title and t.entity_id<>new.entity_id and e.deleted_at is null) then
   raise exception 'a live tool already has this name' using errcode='23505';
 end if;
 if TG_OP='UPDATE' and (old.definition-array['name','description','help'])
   is distinct from (new.definition-array['name','description','help']) then
   select version+1 into new.execution_version from public.entities where id=new.entity_id;
 elsif TG_OP='UPDATE' then new.execution_version:=old.execution_version;
 else new.execution_version:=1;
 end if;
 return new;
end $$;
create trigger tools_guard before insert or update on public.tools for each row execute function internal.guard_tool_definition();
create function internal.guard_restored_tool_name() returns trigger
language plpgsql set search_path=public,internal,pg_temp as $$
declare t public.tools;
begin
 if new.kind='tool' and old.deleted_at is not null and new.deleted_at is null then
   select * into t from public.tools where entity_id=new.id;
   perform pg_advisory_xact_lock(hashtextextended(new.space_id::text||t.title,318));
   if exists(select 1 from public.tools other join public.entities e on e.id=other.entity_id
     where other.space_id=new.space_id and other.title=t.title and other.entity_id<>new.id and e.deleted_at is null) then
     raise exception 'a live tool already has this name' using errcode='23505';
   end if;
 end if;
 return new;
end $$;
create trigger entities_restore_tool_name before update of deleted_at on public.entities
 for each row execute function internal.guard_restored_tool_name();
create trigger tools_touch before update on public.tools for each row execute function internal.touch_updated_at();
create trigger tools_snapshot after update on public.tools for each row execute function internal.snapshot_entity_version();
alter table public.tools enable row level security;
create policy tools_select on public.tools for select to tm8_app using
 (exists(select 1 from public.entities e where e.id=entity_id and e.deleted_at is null offset 0));
grant select on public.tools to tm8_app;

create table public.tool_config (
 tool_id uuid not null references public.tools(entity_id) on delete cascade,
 input_name text not null, value jsonb not null, set_by uuid not null references public.entities(id),
 set_at timestamptz not null default now(), primary key(tool_id,input_name)
);
create table public.tool_secret_bindings (
 tool_id uuid not null references public.tools(entity_id) on delete cascade,
 input_name text not null, credential_id uuid not null references public.space_credentials(id),
 bound_by uuid not null references public.entities(id), bound_at timestamptz not null default now(),
 primary key(tool_id,input_name)
);
alter table public.tool_config enable row level security;
alter table public.tool_secret_bindings enable row level security;
create policy tool_config_select on public.tool_config for select to tm8_app using
 (exists(select 1 from public.entities e where e.id=tool_id and e.deleted_at is null offset 0));
create policy tool_secret_bindings_select on public.tool_secret_bindings for select to tm8_app using
 (exists(select 1 from public.entities e where e.id=tool_id and e.deleted_at is null offset 0));
grant select on public.tool_config,public.tool_secret_bindings to tm8_app;

create function internal.guard_tool_input_storage() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare e public.entities; i jsonb; c public.space_credentials;
begin
 e:=internal.live_entity(new.tool_id,'tool'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 select v into i from public.tools t, lateral jsonb_array_elements(t.definition->'inputs') v
 where t.entity_id=new.tool_id and v->>'name'=new.input_name;
 if i is null then raise exception 'input is not declared' using errcode='22023'; end if;
 if TG_TABLE_NAME='tool_config' then
   perform internal.validate_tool_input_value(i,new.value);
 else
   perform internal.require_human_auth_kind();
   new.bound_by:=internal.actor_id(); new.bound_at:=now();
   select * into c from public.space_credentials where id=new.credential_id;
   if i->>'type'<>'secret' or c.space_id is distinct from e.space_id or c.provider is distinct from 'tool'
   or c.status is distinct from 'active' or not (c.owner_account_id=internal.current_account_id()
     or c.visibility='public' or internal.space_credential_shared_with(c.id,internal.current_account_id())) then
     raise exception 'tool credential unavailable' using errcode='42501'; end if;
 end if;
 return new;
end $$;
create trigger tool_config_guard before insert or update on public.tool_config for each row execute function internal.guard_tool_input_storage();
create trigger tool_secret_bindings_guard before insert or update on public.tool_secret_bindings for each row execute function internal.guard_tool_input_storage();

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
      when 'op_request' then select to_jsonb(opr) - 'entity_id' - 'requester_identity_id' - 'decided_identity_id'
        into content from public.op_requests opr where opr.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      -- 304: the design's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'design' then select to_jsonb(dsg) - 'entity_id' into content from public.designs dsg where dsg.entity_id = target;
      when 'tool' then select to_jsonb(tl) - 'entity_id'
        || jsonb_build_object('config', coalesce((select jsonb_object_agg(c.input_name,c.value) from public.tool_config c where c.tool_id=target),'{}'::jsonb),
          'secretBindings', coalesce((select jsonb_agg(jsonb_build_object('inputName',b.input_name,'credentialId',b.credential_id,'boundBy',b.bound_by,'boundAt',b.bound_at)) from public.tool_secret_bindings b where b.tool_id=target),'[]'::jsonb))
        into content from public.tools tl where tl.entity_id=target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

create function public.create_tool_entity(p_space_id uuid,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; target uuid;
begin
 perform internal.require_space_member(p_space_id); perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'tools.create');
 if replay is not null then
   perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space'); return replay;
 end if;
 actor:=internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
 perform internal.validate_tool_definition(p_definition);
 target:=internal.create_envelope(p_space_id,'tool',actor,null,null);
 insert into public.tools(entity_id,space_id,title,definition) values(target,p_space_id,p_definition->>'name',p_definition);
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'tools.create',internal.command_result(target,null,
   internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','tool')),array[target]));
end $$;

create function public.update_tool_entity(p_entity_id uuid,p_expected_version integer,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; e public.entities; c record; i jsonb;
begin
 e:=internal.live_entity(p_entity_id,'tool'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'tools.update');
 if replay is not null then perform internal.require_replay_subject(replay#>>'{entity,id}',p_entity_id::text,'entity'); return replay; end if;
 actor:=internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
 perform internal.assert_version(e.id,p_expected_version); perform internal.validate_tool_definition(p_definition);
 -- Source/help edits preserve every binding. Remove only slots no longer declared
 -- with the same secret/non-secret role; reject invalid retained config values.
 delete from public.tool_config tc where tc.tool_id=e.id and not exists
   (select 1 from jsonb_array_elements(p_definition->'inputs') v where v->>'name'=tc.input_name and v->>'type'<>'secret');
 delete from public.tool_secret_bindings b where b.tool_id=e.id and not exists
   (select 1 from jsonb_array_elements(p_definition->'inputs') v where v->>'name'=b.input_name and v->>'type'='secret');
 for c in select * from public.tool_config where tool_id=e.id loop
   select v into i from jsonb_array_elements(p_definition->'inputs') v where v->>'name'=c.input_name;
   perform internal.validate_tool_input_value(i,c.value);
 end loop;
 update public.tools set definition=p_definition where entity_id=e.id;
 return internal.ledger_record(p_client_mutation_id,'tools.update',internal.command_result(e.id,null,
   internal.record_activity(e.space_id,e.id,actor,'updated',null,'{}'::jsonb),array[e.id]));
end $$;

create function public.set_tool_config(p_tool_id uuid,p_expected_version integer,p_input_name text,p_value jsonb,
 p_unset boolean default false,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; replay jsonb; i jsonb; op text:=case when p_unset then 'tools.config.unset' else 'tools.config.set' end;
begin
 e:=internal.live_entity(p_tool_id,'tool'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.require_replay_principal(p_client_mutation_id); replay:=internal.ledger_replay(p_client_mutation_id,op);
 if replay is not null then perform internal.require_replay_subject(replay#>>'{entity,id}',p_tool_id::text,'entity'); return replay; end if;
 actor:=internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor); perform internal.assert_version(e.id,p_expected_version);
 select v into i from public.tools t,lateral jsonb_array_elements(t.definition->'inputs') v where t.entity_id=e.id and v->>'name'=p_input_name;
 if i is null or i->>'type'='secret' then raise exception 'config requires a declared non-secret input' using errcode='22023'; end if;
 if p_unset then delete from public.tool_config where tool_id=e.id and input_name=p_input_name;
 else
   perform internal.validate_tool_input_value(i,p_value);
   insert into public.tool_config(tool_id,input_name,value,set_by) values(e.id,p_input_name,p_value,actor)
   on conflict(tool_id,input_name) do update set value=excluded.value,set_by=excluded.set_by,set_at=now();
 end if;
 update public.tools set config_revision=config_revision+1 where entity_id=e.id;
 return internal.ledger_record(p_client_mutation_id,op,internal.command_result(e.id,null,
   internal.record_activity(e.space_id,e.id,actor,'updated',null,jsonb_build_object('input',p_input_name)),array[e.id]));
end $$;

-- 297 pattern: tool is server-only, never a vendor launch credential/default.
create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider in ('typesafe','mcp','tool'),false) $$;
alter table public.space_credentials
 drop constraint space_credentials_provider_check,
 add constraint space_credentials_provider_check check (provider in ('anthropic','openai','github','typesafe','mcp','tool')),
 drop constraint space_credentials_provider_shape_check,
 add constraint space_credentials_provider_shape_check check (
   (provider='github' and shape='token') or (provider in ('anthropic','openai') and shape in ('login','api_key'))
   or (provider='typesafe' and shape='api_key') or (provider='mcp' and shape in ('api_key','token'))
   or (provider='tool' and shape='api_key'));

create function public.create_tool_credential(p_id uuid,p_space uuid,p_tool uuid,p_input_name text,p_label text,p_key_hint text,
 p_ciphertext bytea,p_nonce bytea,p_expected_version integer,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; replay jsonb; result jsonb;
begin
 perform internal.require_human_auth_kind(); e:=internal.live_entity(p_tool,'tool');
 perform internal.require_space_member(p_space);
 if e.space_id<>p_space or not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.require_replay_principal(p_client_mutation_id); replay:=internal.ledger_replay(p_client_mutation_id,'tools.secrets.create');
 if replay is not null then perform internal.require_replay_subject(replay#>>'{entity,id}',p_tool::text,'entity'); return replay; end if;
 actor:=internal.resolve_actor(p_actor_id,p_space); perform internal.bind_actor(actor); perform internal.assert_version(e.id,p_expected_version);
 if not exists(select 1 from public.tools t,lateral jsonb_array_elements(t.definition->'inputs') v
   where t.entity_id=e.id and v->>'name'=p_input_name and v->>'type'='secret') then raise exception 'secret input is not declared' using errcode='22023'; end if;
 result:=public.create_space_credential(p_id,p_space,'tool','api_key',p_label,p_key_hint,p_ciphertext,p_nonce,null,'private',false,false);
 insert into public.tool_secret_bindings(tool_id,input_name,credential_id) values(e.id,p_input_name,p_id)
 on conflict(tool_id,input_name) do update set credential_id=excluded.credential_id;
 update public.tools set config_revision=config_revision+1 where entity_id=e.id;
 return internal.ledger_record(p_client_mutation_id,'tools.secrets.create',internal.command_result(e.id,null,
   internal.record_activity(e.space_id,e.id,actor,'updated',null,jsonb_build_object('input',p_input_name)),array[e.id,p_id]));
end $$;

create function public.bind_tool_secret(p_tool_id uuid,p_expected_version integer,p_input_name text,p_credential_id uuid,
 p_unbind boolean default false,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; replay jsonb; op text:=case when p_unbind then 'tools.secrets.unbind' else 'tools.secrets.bind' end;
begin
 perform internal.require_human_auth_kind(); e:=internal.live_entity(p_tool_id,'tool'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.require_replay_principal(p_client_mutation_id); replay:=internal.ledger_replay(p_client_mutation_id,op);
 if replay is not null then perform internal.require_replay_subject(replay#>>'{entity,id}',p_tool_id::text,'entity'); return replay; end if;
 actor:=internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor); perform internal.assert_version(e.id,p_expected_version);
 if not exists(select 1 from public.tools t,lateral jsonb_array_elements(t.definition->'inputs') v
   where t.entity_id=e.id and v->>'name'=p_input_name and v->>'type'='secret') then raise exception 'secret input is not declared' using errcode='22023'; end if;
 if p_unbind then delete from public.tool_secret_bindings where tool_id=e.id and input_name=p_input_name;
 else insert into public.tool_secret_bindings(tool_id,input_name,credential_id) values(e.id,p_input_name,p_credential_id)
   on conflict(tool_id,input_name) do update set credential_id=excluded.credential_id;
 end if;
 update public.tools set config_revision=config_revision+1 where entity_id=e.id;
 return internal.ledger_record(p_client_mutation_id,op,internal.command_result(e.id,null,
   internal.record_activity(e.space_id,e.id,actor,'updated',null,jsonb_build_object('input',p_input_name)),array[e.id]));
end $$;

-- Private server-side resolver; ciphertext never appears in graph content/DTOs.
create function public.read_tool_credential(p_space uuid,p_tool uuid,p_input_name text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,internal,pg_temp as $$
declare c public.space_credentials; a uuid;
begin
 perform internal.require_space_member(p_space);
 if coalesce(internal.claim_text('tm8.via_link'),'')<>'' or coalesce(internal.claim_text('tm8.auth_kind'),'')='link' then
   raise exception 'linked tool credentials are unavailable' using errcode='42501'; end if;
 if not internal.entity_readable(p_tool) then raise exception 'tool unavailable' using errcode='42501'; end if;
 a:=internal.current_account_id();
 select sc.* into c from public.space_credentials sc join public.tool_secret_bindings b on b.credential_id=sc.id
 join public.tools t on t.entity_id=b.tool_id join public.entities e on e.id=t.entity_id
 where sc.id=p_id and sc.space_id=p_space and sc.provider='tool' and b.tool_id=p_tool and b.input_name=p_input_name
   and e.space_id=p_space and e.deleted_at is null;
 if c.id is null or c.status<>'active' or a is null or not (c.owner_account_id=a or c.visibility='public'
   or internal.space_credential_shared_with(c.id,a)) then raise exception 'tool credential unavailable' using errcode='42501'; end if;
 return jsonb_build_object('credentialId',c.id,'ciphertext',encode(c.secret_ciphertext,'base64'),'nonce',encode(c.secret_nonce,'base64'));
end $$;

alter table public.work_sessions
 drop constraint work_sessions_session_kind_check,
 add constraint work_sessions_session_kind_check check (session_kind in ('agent','credential','shell','container_exec','tool')),
 add column tool_id uuid references public.tools(entity_id),
 add column tool_version integer,
 add column tool_tm8_access text,
 add column tool_inputs jsonb,
 add column tool_keep_open boolean,
 add column tool_state text,
 add column tool_exit_code integer,
 add column tool_started_at timestamptz,
 add column tool_exited_at timestamptz,
 add column tool_output_tail text,
 add column tool_source_sha256 text,
 add constraint work_sessions_tool_shape check (
   (session_kind='tool' and tool_id is not null and tool_version is not null and tool_version>0
     and tool_tm8_access is not null and tool_tm8_access in ('none','read','write')
     and tool_source_sha256 is not null and tool_source_sha256 ~ '^[0-9a-f]{64}$'
     and tool_inputs is not null and jsonb_typeof(tool_inputs)='object' and tool_keep_open is not null
     and tool_state is not null and tool_state in ('running','exited','timed_out','killed')
     and tool_output_tail is not null and octet_length(tool_output_tail)<=65536
     and ((tool_state='running' and tool_exit_code is null and tool_exited_at is null)
       or (tool_state<>'running' and tool_exited_at is not null)))
   or (session_kind<>'tool' and tool_id is null and tool_version is null and tool_tm8_access is null and tool_inputs is null
     and tool_keep_open is null and tool_state is null and tool_exit_code is null and tool_started_at is null
     and tool_exited_at is null and tool_output_tail is null and tool_source_sha256 is null));
comment on column public.work_sessions.session_kind is
 'agent, credential (083), shell (101), container_exec (177), tool (318). Read 101 and 318 audits before adding values.';
comment on column public.work_sessions.tool_tm8_access is
 'Pinned token ceiling for this run; minting never reads the subsequently edited tool definition.';
comment on column public.work_sessions.tool_keep_open is
 'UI launches true; CLI/agent launches false. Tool outcome and PTY lifetime are independent. No idle autoclose for the retained shell.';
create index work_sessions_tool_runs_idx on public.work_sessions(tool_id,entity_id) where session_kind='tool';

create or replace function public.read_space_service_key(p_space_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account uuid; v_source text;
begin
  if p_provider in ('mcp','tool') then raise exception 'MCP/tool requires an explicit definition and account' using errcode='42501'; end if;
  if not internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is not a server-only credential; a launch reads it with read_space_credential_for_spawn', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_server_only', 'provider', p_provider)::text;
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot read a service key' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_space_id);

  if coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli') then
    v_account := internal.current_account_id();
    select sc.* into stored
      from public.member_defaults md
      join public.space_credentials sc on sc.id = md.credential_id and sc.space_id = md.space_id
     where md.space_id = p_space_id and md.account_id = v_account
       and md.provider = p_provider and sc.provider = p_provider
       and sc.status = 'active' and sc.owner_account_id = v_account;
    if stored.id is not null then v_source := 'my_default'; end if;
  end if;

  if stored.id is null then
    select * into stored from public.space_credentials
     where space_id = p_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then return null; end if;
    v_source := 'space_default';
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'source', v_source,
    'secretCiphertext', encode(stored.secret_ciphertext, 'base64'),
    'secretNonce', encode(stored.secret_nonce, 'base64')
  );
end
$$;

alter table public.session_space_credentials
 drop constraint session_space_credentials_pkey,
 add primary key(work_session_id,provider,space_credential_id),
 drop constraint session_space_credentials_provider_check,
 add constraint session_space_credentials_provider_check check(provider in ('anthropic','openai','github','tool')),
 drop constraint session_space_credentials_not_server_only,
 add constraint session_space_credentials_not_server_only check
   (provider='tool' or not internal.is_server_only_credential_provider(provider));
create unique index session_space_credentials_vendor_unique on public.session_space_credentials(work_session_id,provider) where provider<>'tool';
comment on constraint session_space_credentials_not_server_only on public.session_space_credentials is
 'Server-only secrets never reach agent launches. Tool rows are exclusively for tool sessions (pairing trigger).';
create function internal.guard_tool_session_credential_pairing() returns trigger
language plpgsql set search_path=public,internal,pg_temp as $$
declare kind text;
begin
 select session_kind into kind from public.work_sessions where entity_id=new.work_session_id;
 if (new.provider='tool') is distinct from (kind='tool') then
   raise exception 'tool credentials belong exclusively to tool sessions' using errcode='23514';
 end if;
 return new;
end $$;
create trigger session_space_credentials_tool_pairing before insert or update on public.session_space_credentials
 for each row execute function internal.guard_tool_session_credential_pairing();


create or replace function internal.record_session_space_credential(
  p_work_session_id uuid,
  p_provider text,
  p_credential_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_launcher uuid;
  inserted integer;
  v_session_space uuid;
  v_session_status text;
  v_credential public.space_credentials;
  v_usable uuid;
begin
  -- Tool credentials cannot travel through a linked Space, including retries.
  if p_provider='tool' then
    if coalesce(internal.claim_text('tm8.via_link'),'')<>'' or coalesce(internal.claim_text('tm8.auth_kind'),'')='link' then
      raise exception 'linked tool credentials are unavailable' using errcode='42501';
    end if;
    if not exists (select 1 from public.work_sessions ws join public.entities e on e.id=ws.entity_id
      join public.tool_secret_bindings b on b.tool_id=ws.tool_id and b.credential_id=p_credential_id
      where ws.entity_id=p_work_session_id and ws.session_kind='tool' and e.deleted_at is null
        and internal.entity_readable(e.id) and internal.can_act_as(e.created_by,e.space_id)
        and ws.tool_inputs#>>array[b.input_name,'secret']=p_credential_id::text) then
      raise exception 'credential is not bound to this tool run' using errcode='42501';
    end if;
  end if;
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select sc.id into v_usable
    from public.space_credentials sc
   where sc.id = p_credential_id
     and sc.provider = p_provider
     and sc.status = 'active'
     and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher
          or internal.space_credential_shared_with(sc.id, v_launcher))
     for share of sc;
  if v_usable is null then
    select e.space_id into v_session_space
      from public.entities e where e.id = p_work_session_id and e.deleted_at is null;
    select * into v_credential from public.space_credentials where id = p_credential_id;
    if v_credential.id is null or v_credential.space_id is distinct from v_session_space
       or v_credential.provider is distinct from p_provider then
      raise exception 'space credential is not in this session''s space' using errcode = '42501';
    end if;
    if v_credential.status <> 'active' then
      raise exception 'space credential is %', v_credential.status using errcode = '23514';
    end if;
    raise exception 'space credential "%" is private to its owner', v_credential.label
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  -- A2: a retried manifest write (a timed-out write may have committed)
  -- must not fail a spawn that succeeded. The identical row is a no-op;
  -- a DIFFERENT credential for the provider is refused below.
  if exists (select 1 from public.session_space_credentials
              where work_session_id = p_work_session_id and provider = p_provider
                and space_credential_id = p_credential_id) then
    return;
  end if;

  begin
    insert into public.session_space_credentials(
      work_session_id, provider, space_credential_id, space_id, launcher_account_id,
      owner_account_id, agent_session_id)
    select ws.entity_id, sc.provider, sc.id, sc.space_id, v_launcher,
           sc.owner_account_id,
           (select pws.entity_id from public.work_sessions pws
             where pws.entity_id = e.parent_id)
      from public.space_credentials sc
      join public.entities e on e.space_id = sc.space_id
      join public.work_sessions ws on ws.entity_id = e.id
     where sc.id = p_credential_id
       and sc.provider = p_provider
       and sc.status = 'active'
       and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher
            or internal.space_credential_shared_with(sc.id, v_launcher))
       and e.id = p_work_session_id
       and e.kind = 'work_session'
       and e.deleted_at is null
       and ws.status = 'spawning'
       and ((ws.session_kind='agent' and not internal.is_server_only_credential_provider(p_provider))
         or (ws.session_kind='tool' and p_provider='tool'))
       for share of sc;
    get diagnostics inserted = row_count;
  exception when unique_violation then
    raise exception 'session already records a different % space credential', p_provider
      using errcode = '23505';
  end;

  if inserted = 1 then
    return;
  end if;

  -- Nothing inserted: say which condition failed. These reads only explain a
  -- refusal the insert above already made; they decide nothing.
  select e.space_id, ws.status into v_session_space, v_session_status
    from public.entities e join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null;
  select * into v_credential from public.space_credentials where id = p_credential_id;
  if v_credential.id is null or v_credential.space_id is distinct from v_session_space
     or v_credential.provider is distinct from p_provider then
    raise exception 'space credential is not in this session''s space' using errcode = '42501';
  end if;
  if v_session_status is distinct from 'spawning' then
    raise exception 'a space credential is recorded only while a session is spawning'
      using errcode = '23514';
  end if;
  -- 992: the insert's own (newer) snapshot no longer saw a share the lock
  -- statement did — it was withdrawn while this launch waited.
  if v_credential.status = 'active' then
    raise exception 'space credential "%" is private to its owner', v_credential.label
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;
  raise exception 'space credential is %', v_credential.status using errcode = '23514';
end
$$;

create or replace function public.repoint_session_space_credentials(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_launcher uuid;
  v_recorded integer;
  v_active integer;
  v_usable integer;
  rows jsonb;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if exists(select 1 from public.work_sessions where entity_id=p_work_session_id and session_kind='tool') then
    raise exception 'tool sessions cannot be repointed or resumed' using errcode='55000';
  end if;
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select count(*) into v_recorded from public.session_space_credentials
   where work_session_id = p_work_session_id;
  select count(*) into v_active
    from (
    select sc.id from public.space_credentials sc
      join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
     where ssc.work_session_id = p_work_session_id
       and sc.status = 'active'
       and sc.space_id = e.space_id
     order by sc.id
       for share of sc
  ) locked;
  -- 992: usability is read in a NEW statement, after the FOR SHARE locks are
  -- held. unshare takes FOR UPDATE on the credential but rewrites no tuple,
  -- so a statement that waited behind it would still see the withdrawn share
  -- in its own snapshot; this one starts after that commit.
  select count(*) into v_usable
    from public.space_credentials sc
    join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
   where ssc.work_session_id = p_work_session_id
     and sc.status = 'active'
     and sc.space_id = e.space_id
     and (sc.visibility = 'public' or sc.owner_account_id is null
          or sc.owner_account_id = v_launcher
          or internal.space_credential_shared_with(sc.id, v_launcher));
  if v_active <> v_recorded then
    raise exception 'a space credential this session launched on is no longer active'
      using errcode = '23514';
  end if;
  if v_usable <> v_recorded then
    raise exception 'a space credential this session launched on is private to its owner'
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable')::text;
  end if;

  update public.session_space_credentials
     set launcher_account_id = v_launcher, updated_at = now()
   where work_session_id = p_work_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', provider, 'spaceCredentialId', space_credential_id)
           order by provider), '[]'::jsonb)
    into rows
    from public.session_space_credentials where work_session_id = p_work_session_id;
  return jsonb_build_object('workSessionId', p_work_session_id,
                            'launcherAccountId', v_launcher, 'credentials', rows);
end
$$;

CREATE OR REPLACE FUNCTION public.repoint_session_space_credentials(p_work_session_id uuid, p_providers text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  e public.entities;
  v_status text;
  v_persona uuid;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if exists(select 1 from public.work_sessions where entity_id=p_work_session_id and session_kind='tool') then
    raise exception 'tool sessions cannot be repointed or resumed' using errcode='55000';
  end if;
  if internal.current_account_id() is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  -- F-R13a: the resume window only, under the row lock execution_resume (062)
  -- takes. 'spawning' is entered by the spawn insert and by execution_resume
  -- alone (work_session_transition refuses it), and a fresh spawn never
  -- re-points, so 'spawning' with a resume on record IS the resume window.
  select status into v_status from public.work_sessions
   where entity_id = p_work_session_id for update;
  if v_status is distinct from 'spawning'
     or not exists (select 1 from public.activity a
                     where a.entity_id = p_work_session_id and a.verb = 'restored'
                       and a.summary ->> 'action' = 'resumed') then
    raise exception 'only a session being resumed can be re-pointed' using errcode = '55000';
  end if;
  -- Resume's authorization, not bare membership: the caller may act as the
  -- session's persona, exactly as execution_resume requires.
  -- 309: the session's teammate is `participates_in` (teammate -> session);
  -- the legacy relates_to duplicate it used to read is gone.
  select src_id into v_persona from public.edges
   where dst_id = p_work_session_id and type = 'participates_in'
   limit 1;
  if v_persona is not null and not internal.can_act_as(v_persona, e.space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;
  delete from public.session_space_credentials
   where work_session_id = p_work_session_id
     and provider <> all (coalesce(p_providers, array[]::text[]));
  return public.repoint_session_space_credentials(p_work_session_id);
end
$function$
;

create or replace function internal.credential_binding_at_mint() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.session_kind in ('shell', 'credential', 'container_exec', 'tool') then
    if new.credential_binding is not null and new.credential_binding <> 'none' then
      raise exception 'a % session needs no vendor credential and is minted none', new.session_kind
        using errcode = '23514';
    end if;
    new.credential_binding := 'none';
    new.credential_none_reason := case new.session_kind
      when 'tool' then 'tool'
      when 'shell' then 'shell'
      when 'credential' then 'credential_login'
      when 'container_exec' then 'container_exec' end;
  else
    -- agent, and the DELIBERATE fall-through for any kind with no arm here:
    -- `none` is a claim about reach that a new kind has not earned, so it is
    -- `pending` and the guard (3) refuses to run it, naming the kind.
    if new.credential_binding is not null and new.credential_binding <> 'pending' then
      raise exception 'a % session is minted pending; its binding is recorded when its credentials resolve',
        new.session_kind using errcode = '23514';
    end if;
    new.credential_binding := 'pending';
    new.credential_none_reason := null;
  end if;
  return new;
end
$$;

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
  if v_ws.session_kind='tool' and v_ws.status='spawning' then
    v_binding:=case when exists(select 1 from public.session_space_credentials
      where work_session_id=p_session_id and provider='tool') then 'bound' else 'none' end;
    v_reason:=case when v_binding='none' then 'tool' end;
    v_prev:=coalesce(current_setting('tm8.credential_binding_write',true),'');
    perform set_config('tm8.credential_binding_write','on',true);
    update public.work_sessions set credential_binding=v_binding,credential_none_reason=v_reason where entity_id=p_session_id;
    perform set_config('tm8.credential_binding_write',v_prev,true);
    return v_binding;
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
      -- NOT none in R1: an echo-agent process can still reach a member or node
      -- token until S4's isolation helper lands (header, ECHO-AGENT). S4 flips
      -- this to none/'echo-agent' together with that helper.
      v_binding := 'legacy';
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

reset role;

create or replace function public.completed_sessions_to_close(p_node_id text)
returns table(session_id uuid, minutes integer) language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select ws.entity_id, sp.session_autoclose_minutes
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id and e.deleted_at is null
    join public.spaces sp on sp.id = e.space_id
   where ws.node_id = p_node_id
     and ws.session_kind <> 'tool'
     and ws.outcome = 'completed'
     and ws.status in ('spawning', 'running', 'idle')
     and sp.session_autoclose_minutes > 0
     and greatest(ws.outcome_at, e.activity_at) < now() - make_interval(mins => sp.session_autoclose_minutes)
     -- D2 follow-on (6 Oct): never close a session that still has running children.
     and not exists (
       select 1 from public.entities ce join public.work_sessions cws on cws.entity_id = ce.id
        where ce.parent_id = ws.entity_id and ce.deleted_at is null
          and cws.status in ('spawning', 'running', 'idle'))
     and internal.is_space_member(e.space_id)
$$;

set role tm8_graph_owner;

create or replace function public.space_kind_counts(p_space_id uuid)
returns table(kind text, total integer, unseen integer)
language sql stable security invoker set search_path = public, internal, pg_temp as $$
  with me as (
    select m.entity_id, m.entities_seen_since from public.members m
     where m.space_id = p_space_id and m.identity_id = internal.identity_id()
       and m.status = 'active' and internal.is_space_member(p_space_id)
  )
  select e.kind, count(*)::integer,
    count(*) filter (where e.created_at > me.entities_seen_since and s.entity_id is null)::integer
  from public.entities e
  cross join me
  left join public.entity_seen s on s.member_id = me.entity_id and s.entity_id = e.id
  where e.space_id = p_space_id and e.deleted_at is null
    and not exists (select 1 from public.work_sessions ws
                    where ws.entity_id = e.id and ws.session_kind in ('credential','tool'))
  group by e.kind
$$;

grant select (tool_id,tool_version,tool_tm8_access,tool_source_sha256,tool_inputs,tool_keep_open,tool_state,tool_exit_code,tool_started_at,tool_exited_at,tool_output_tail) on public.work_sessions to tm8_app;

create function internal.tool_session_count(p_member uuid,p_space uuid) returns integer
language sql stable set search_path=public,internal,pg_temp as $$
 select count(*)::integer from public.work_sessions ws join public.entities e on e.id=ws.entity_id
 left join public.team_members tm on tm.entity_id=e.created_by
 where ws.session_kind='tool' and ws.status in ('spawning','running','idle') and e.deleted_at is null
 and e.space_id=p_space and (e.created_by=p_member or tm.owner_member_id=p_member)
$$;

create function public.start_tool_session(p_space_id uuid,p_tool_id uuid,p_tool_version integer,p_inputs jsonb,
 p_keep_open boolean default false,p_node_id text default null,p_workdir_path text default null,
 p_session_cap integer default 8,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; target uuid; replay jsonb; d jsonb; i jsonb; v jsonb; k text; member uuid; invoker uuid;
begin
 perform internal.require_space_member(p_space_id); e:=internal.live_entity(p_tool_id,'tool');
 if e.space_id<>p_space_id or not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 perform internal.require_replay_principal(p_client_mutation_id); replay:=internal.ledger_replay(p_client_mutation_id,'tools.run');
 if replay is not null then
   perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space');
   perform internal.require_replay_subject(replay#>>'{toolId}',p_tool_id::text,'tool');
   return replay||jsonb_build_object('__tm8_replayed',true);
 end if;
 actor:=internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
 member:=internal.current_member_id(p_space_id);
 -- Serialize the member's cap check; concurrent launches cannot both take the last slot.
 perform pg_advisory_xact_lock(hashtextextended(member::text||p_space_id::text,318));
 if internal.tool_session_count(member,p_space_id)>=greatest(coalesce(p_session_cap,8),1) then
   raise exception 'tool session concurrency cap reached; close an open tool tab or terminate a tool session' using errcode='53400'; end if;
 -- Lock the envelope before selecting its pinned definition. Config/title/help
 -- edits may advance the version while retaining the same execution settings.
 select * into e from public.entities where id=p_tool_id for share;
 if e.deleted_at is not null or not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 select definition into d from public.tools where entity_id=e.id;
 if p_tool_version is not null and (p_tool_version>e.version or p_tool_version<
   (select execution_version from public.tools where entity_id=e.id)) then
   raise exception 'tool source changed or execution settings changed; reload before running' using errcode='40001';
 end if;
 if jsonb_typeof(p_inputs) is distinct from 'object' then raise exception 'resolved inputs must be an object' using errcode='22023'; end if;
 for k in select jsonb_object_keys(p_inputs) loop
   if not exists(select 1 from jsonb_array_elements(d->'inputs') declared where declared->>'name'=k) then
     raise exception 'undeclared tool input' using errcode='22023'; end if;
 end loop;
 for i in select value from jsonb_array_elements(d->'inputs') loop
   if not p_inputs ? (i->>'name') then
     if coalesce((i->>'required')::boolean,false) then raise exception 'required input is missing: %',i->>'name' using errcode='22023'; end if;
     continue;
   end if;
   v:=p_inputs->(i->>'name');
   if i->>'type'='secret' then
     if jsonb_typeof(v) is distinct from 'object' or not (v ? 'secret') or (select count(*) from jsonb_object_keys(v))<>1
     or jsonb_typeof(v->'secret')<>'string' then raise exception 'secret input requires a reference, never a value' using errcode='22023'; end if;
     if v->>'secret'<>'passed' then
       if v->>'secret' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
         raise exception 'invalid secret reference' using errcode='22023'; end if;
       perform public.read_tool_credential(p_space_id,e.id,i->>'name',(v->>'secret')::uuid);
     end if;
   else perform internal.validate_tool_input_value(i,v);
   end if;
 end loop;
 invoker:=internal.caller_work_session(p_space_id);
 target:=internal.create_envelope(p_space_id,'work_session',actor,invoker,null);
 insert into public.work_sessions(entity_id,title,node_id,workdir_mode,workdir_path,status,session_kind,
   tool_id,tool_version,tool_tm8_access,tool_inputs,tool_keep_open,tool_state,tool_started_at,tool_output_tail,tool_source_sha256)
 values(target,d->>'name',p_node_id,'scratch',p_workdir_path,'spawning','tool',
   e.id,e.version,d->>'tm8Access',p_inputs,coalesce(p_keep_open,false),'running',now(),'',encode(sha256(convert_to(d->>'source','UTF8')),'hex'));
 -- Record every bound credential before the binding may settle to bound.
 for i in select value from jsonb_array_elements(d->'inputs') loop
   if i->>'type'='secret' and p_inputs ? (i->>'name')
     and p_inputs#>>array[i->>'name','secret']<>'passed' then
     perform internal.record_session_space_credential(target,'tool',(p_inputs#>>array[i->>'name','secret'])::uuid);
   end if;
 end loop;
 perform internal.settle_credential_binding(target,'{}'::jsonb);
 insert into public.edges(space_id,src_id,dst_id,type,created_by) values(p_space_id,target,e.id,'executes',actor);
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'tools.run',internal.command_result(target,null,
   internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','work_session','sessionKind','tool')),array[target,e.id])
   ||jsonb_build_object('toolId',e.id))||jsonb_build_object('__tm8_replayed',false);
end $$;

create function public.record_tool_exit(p_session_id uuid,p_exit_code integer,p_state text default 'exited',p_output_tail text default '')
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; ws public.work_sessions; previous_writer text;
begin
 e:=internal.live_entity(p_session_id,'work_session'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) or not internal.can_act_as(e.created_by,e.space_id) then
   raise exception 'tool run is not controlled by caller' using errcode='42501'; end if;
 select * into ws from public.work_sessions where entity_id=e.id for update;
 if ws.session_kind<>'tool' then raise exception 'session is not a tool run' using errcode='22023'; end if;
 if p_state is null or p_state not in ('exited','timed_out','killed') or (p_state='exited' and p_exit_code is null)
 or p_output_tail is null or octet_length(p_output_tail)>65536 then raise exception 'invalid tool outcome' using errcode='22023'; end if;
 if ws.tool_state='running' then
   -- Tool exit is the work outcome, independent of the retained PTY process.
   -- Extend 302's guarded writer; a run record is its receipt, not an agent message.
   previous_writer:=coalesce(current_setting('tm8.work_session_outcome',true),'');
   perform set_config('tm8.work_session_outcome','on',true);
   update public.work_sessions set tool_state=p_state,tool_exit_code=p_exit_code,
     tool_exited_at=now(),tool_output_tail=p_output_tail,
     outcome=case when outcome='open' then case when p_state='exited' then 'completed' else 'stopped' end else outcome end,
     outcome_at=case when outcome='open' then now() else outcome_at end,
     outcome_by=case when outcome='open' then e.created_by else outcome_by end,
     outcome_source=case when outcome='open' then 'self' else outcome_source end
     where entity_id=e.id;
   perform set_config('tm8.work_session_outcome',previous_writer,true);
   update public.entities set version=version+1,activity_at=now(),updated_at=now() where id=e.id;
 end if;
 -- PTY status is deliberately untouched. The launcher handles the ordinary
 -- work_session_transition when the process really exits (keepOpen=false).
 return internal.command_result(e.id,null,null,array[e.id]);
end $$;

revoke all on function public.create_tool_entity(uuid,jsonb,uuid,text) from public;
revoke all on function public.update_tool_entity(uuid,integer,jsonb,uuid,text) from public;
revoke all on function public.set_tool_config(uuid,integer,text,jsonb,boolean,uuid,text) from public;
revoke all on function public.create_tool_credential(uuid,uuid,uuid,text,text,text,bytea,bytea,integer,uuid,text) from public;
revoke all on function public.bind_tool_secret(uuid,integer,text,uuid,boolean,uuid,text) from public;
revoke all on function public.read_tool_credential(uuid,uuid,text,uuid) from public;
revoke all on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text) from public;
revoke all on function public.record_tool_exit(uuid,integer,text,text) from public;
grant execute on function public.create_tool_entity(uuid,jsonb,uuid,text) to tm8_app;
grant execute on function public.update_tool_entity(uuid,integer,jsonb,uuid,text) to tm8_app;
grant execute on function public.set_tool_config(uuid,integer,text,jsonb,boolean,uuid,text) to tm8_app;
grant execute on function public.create_tool_credential(uuid,uuid,uuid,text,text,text,bytea,bytea,integer,uuid,text) to tm8_app;
grant execute on function public.bind_tool_secret(uuid,integer,text,uuid,boolean,uuid,text) to tm8_app;
grant execute on function public.read_tool_credential(uuid,uuid,text,uuid) to tm8_app;
grant execute on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text) to tm8_app;
grant execute on function public.record_tool_exit(uuid,integer,text,text) to tm8_app;
analyze public.tools,public.tool_config,public.tool_secret_bindings;
reset role;
