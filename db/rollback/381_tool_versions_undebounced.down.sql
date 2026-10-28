-- =============================================================================
-- ROLLBACK for 381_tool_versions_undebounced.sql — NOT a migration
-- (db/migrate.mjs never reads this directory). Run by hand, as the migration
-- owner, only to undo 381:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/381_tool_versions_undebounced.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '381_tool_versions_undebounced.sql'"
--
-- After this: tool edits fold again (a same-actor edit inside 5 minutes
-- renumbers the previous snapshot, so a run pinned to it loses its source), and
-- new runs pin entities.version again, which config and secret writes advance.
-- Rows and pins 381 already wrote stay: a run pinned while 381 was live holds an
-- execution_version, which is a smaller number than the entities.version a
-- pre-381 reader expects; both still name a stored row. Any later trigger
-- created with 'undebounced' is debounced again once this restores 001's body;
-- check pg_trigger for tgnargs > 0 first.
-- =============================================================================

set role tm8_graph_owner;

drop trigger tools_snapshot on public.tools;
create trigger tools_snapshot after update on public.tools
for each row execute function internal.snapshot_entity_version();

-- 001's body, verbatim (db/migrations/001_core_graph.sql).
create or replace function internal.snapshot_entity_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid := internal.actor_id();
  next_version integer;
  latest record;
begin
  -- Nothing changed materially → no version, no snapshot.
  if to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return new;
  end if;

  if actor is null then
    select created_by into actor from public.entities where id = new.entity_id;
  end if;

  select version + 1 into next_version from public.entities where id = new.entity_id for update;

  select entity_id, version, changed_by, changed_at into latest
    from public.entity_versions
   where entity_id = new.entity_id
   order by version desc
   limit 1;

  if latest.entity_id is not null
     and latest.changed_by is not distinct from actor
     and latest.changed_at > now() - internal.version_debounce_window() then
    -- Debounced: fold this edit into the open snapshot. `version` still advances
    -- on the envelope so optimistic concurrency stays honest.
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    update public.entity_versions
       set version = next_version,
           snapshot = internal.entity_snapshot(new.entity_id),
           changed_at = now()
     where entity_id = new.entity_id and version = latest.version;
  else
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    insert into public.entity_versions(entity_id, version, snapshot, changed_by)
    values (new.entity_id, next_version, internal.entity_snapshot(new.entity_id), actor);
  end if;
  return new;
end
$$;

-- 318's body, verbatim (db/migrations/318_tools.sql), as create or replace.
create or replace function public.start_tool_session(p_space_id uuid,p_tool_id uuid,p_tool_version integer,p_inputs jsonb,
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

reset role;
