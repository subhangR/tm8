-- =============================================================================
-- 381 — Tool versions a run can trust (Tools v2 PR-F, task 01a183cd):
--   §1 every write to a tool row is its own stored version: the `tools`
--      snapshot trigger opts out of the 5-minute same-actor debounce;
--   §2 a run pins the DEFINITION version (tools.execution_version), not the
--      concurrency token (entities.version).
--
-- Number 381 is RESERVED by the Tools v2 coordinator (378 Loops PR1, 379 Tools
-- PR-C, 380 Tools PR-E, 381 this file, 382/383 Loops PR2/PR3). Nothing here
-- depends on 378-380.
--
-- The hole. A tool run pins `work_sessions.tool_version` and `tool_source_sha256`
-- (318 start_tool_session), and the audit promise is that the pinned version
-- resolves to the source that ran (entity_versions.snapshot ->
-- content.definition.source). Two things broke it:
--   (a) 318's `tools_snapshot` ran 001's debounce: a same-actor edit inside
--       `version_debounce_window()` RENUMBERS the latest row to the new version
--       and overwrites its snapshot. Create + two quick edits left one row (v3);
--       runs pinned to v1 and v2 kept a sha256 with no source behind it. Config
--       and secret writes fire the same trigger (they bump
--       `tools.config_revision`), so a config set right after an edit renumbered
--       the definition row a run had just pinned.
--   (b) the pin was `entities.version`, which rightly advances on every write.
--       `tm8 tool secret set` therefore moved the number the run header prints
--       (slack-notify v1 -> v2) although the definition did not change (PR-G
--       finding 4).
--
-- §1 Why the trigger and not the RPC. 055 §12 (artifacts.publish) writes its row
-- from the RPC because `artifacts` has no snapshot trigger. `tools` has one, and
-- every tools.* writer goes through it: update_tool_entity (definition),
-- set_tool_config, create_tool_credential and bind_tool_secret
-- (config_revision). A direct write in update_tool_entity alone would leave the
-- config writers folding into, and renumbering, the definition row. So the
-- generic function takes ONE optional trigger argument, 'undebounced', and
-- `tools_snapshot` is recreated with it: every material change to a tools row
-- bumps entities.version by one and appends its own entity_versions row in the
-- same statement, which is the `else` branch of 001's function. Still one writer
-- per change (001 §12); no RPC body is copied for this and no signature changes.
-- tools.create already writes v1 directly (record_initial_version); what lost
-- it was the next edit's fold.
--
-- Config and secret writes are unchanged in kind: they bumped entities.version
-- and wrote a snapshot before (events and optimistic concurrency need the bump)
-- and still do. Their snapshot carries the unchanged definition, so they are
-- not definition versions. They are just no longer folded.
--
-- §2 Which number is "the version". `tools.execution_version` (318
-- guard_tool_definition) is the entities.version at which source, runtime,
-- inputs, tm8Access or timeoutSeconds last changed: name, description and help
-- edits, config and secret writes leave it alone. With §1 in place the
-- entity_versions row numbered execution_version always exists and its
-- content.definition is the definition that runs, so start_tool_session now
-- pins `tool_version := tools.execution_version` instead of `e.version`. The
-- run header's v<N>, run history and the tool DTO's `executionVersion` are the
-- same number; `entities.version` stays the concurrency token and the 40001
-- stale check is untouched (it still compares the client's loaded
-- entities.version against the current one and execution_version). Only the
-- insert's pinned value changes; the body is otherwise 318's, verbatim.
--
-- Versions written before this migration may already have been folded; their
-- source cannot be recovered, and a pre-381 pin is an entities.version. Readers
-- treat a missing row as "source unavailable" and keep the sha256.
--
-- SHARED-OBJECT NOTICE: internal.snapshot_entity_version is copied VERBATIM
-- from 001 (its only definition until now; every versioned kind's trigger runs
-- it), plus the argument check and one condition on the debounce branch. A
-- trigger created with no argument behaves exactly as before. Whoever replaces
-- this function next must copy THIS body, or `tools` silently folds again.
-- public.start_tool_session is copied from 318 (its only definition until now)
-- with the one change marked "381".
-- Rollback: db/rollback/381_tool_versions_undebounced.down.sql.
-- =============================================================================

set role tm8_graph_owner;

-- §1 ---------------------------------------------------------------------------
create or replace function internal.snapshot_entity_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid := internal.actor_id();
  next_version integer;
  latest record;
  undebounced boolean;
begin
  -- 381: `execute function internal.snapshot_entity_version('undebounced')`
  -- never folds. Any other argument is a typo that would silently keep the
  -- debounce, so it fails loudly instead.
  undebounced := TG_NARGS = 1 and TG_ARGV[0] = 'undebounced';
  if TG_NARGS > 0 and not undebounced then
    raise exception 'snapshot_entity_version: unknown trigger arguments % on %', TG_ARGV, TG_TABLE_NAME
      using errcode = '22023';
  end if;

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

  if not undebounced
     and latest.entity_id is not null
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

-- Same name, so trigger firing order on public.tools is unchanged.
drop trigger tools_snapshot on public.tools;
create trigger tools_snapshot after update on public.tools
for each row execute function internal.snapshot_entity_version('undebounced');

-- §2 ---------------------------------------------------------------------------
create or replace function public.start_tool_session(p_space_id uuid,p_tool_id uuid,p_tool_version integer,p_inputs jsonb,
 p_keep_open boolean default false,p_node_id text default null,p_workdir_path text default null,
 p_session_cap integer default 8,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; target uuid; replay jsonb; d jsonb; i jsonb; v jsonb; k text; member uuid; invoker uuid; pinned integer;
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
 -- 381: the run pins the definition version (execution_version), not e.version.
 select definition,execution_version into d,pinned from public.tools where entity_id=e.id;
 if p_tool_version is not null and (p_tool_version>e.version or p_tool_version<pinned) then
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
   e.id,pinned,d->>'tm8Access',p_inputs,coalesce(p_keep_open,false),'running',now(),'',encode(sha256(convert_to(d->>'source','UTF8')),'hex'));
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
