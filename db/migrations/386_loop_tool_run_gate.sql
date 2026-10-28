-- =============================================================================
-- 386 — A LOOP-TRIGGERED TOOL RUN EXECUTES THE LOOP'S OWN TOOL (Loops PR3,
--       task 01a182d5-e482; design of record 01a182d4 §3.4 "Provenance edge").
-- Predecessor: 385_loop_run_claim.sql (Loops PR2). Redefines the function
-- 379_scheduled_tool_runs.sql (Tools PR-C) created, and reads the column
-- 384_loops_first_class.sql (Loops PR1) added, so it must follow both; 380 and
-- 381 are Tools PR-E/PR-F, 378 is #1389's — numbers reserved by the coordinator
-- (authored as 383, renumbered 2026-10-28 with the rest of the Loops lane).
--
-- 379 made `start_tool_session(..., p_triggered_by_loop_id)` write the run's
-- provenance-marked `triggered_by` edge inside the run's own transaction and
-- gated it on no-bearer claims, a live same-space loop, a pinned version and
-- keep-open off. Its header says what it could not check: "The Loops lane's
-- migration that adds `loops.tool_id` redefines this function to also require
-- `loops.tool_id = p_tool_id`; that column does not exist yet." 378 added the
-- column in a sibling lane and so could not reference 379's function either.
-- This file closes that gap: the ONE change is the `tool_id` check in 379's
-- gate block, so the marked edge — the authority the run's tm8 bearer is minted
-- on — can never bind a run of tool X to a loop configured for tool Y.
-- 23514 (invariant_violation): the executor passed a tool the loop does not
-- name, which the write-time doors make impossible for a stored loop.
--
-- Body: 379's verbatim (itself 318's plus the three 379 blocks) plus the one
-- 386 block. `create or replace` with the identical signature keeps 379's
-- grants. Rollback: db/rollback/386_loop_tool_run_gate.down.sql restores 379's
-- body verbatim.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.start_tool_session(p_space_id uuid,p_tool_id uuid,p_tool_version integer,p_inputs jsonb,
 p_keep_open boolean default false,p_node_id text default null,p_workdir_path text default null,
 p_session_cap integer default 8,p_actor_id uuid default null,p_client_mutation_id text default null,
 p_triggered_by_loop_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; actor uuid; target uuid; replay jsonb; d jsonb; i jsonb; v jsonb; k text; member uuid; invoker uuid;
 loop_entity public.entities;
begin
 perform internal.require_space_member(p_space_id); e:=internal.live_entity(p_tool_id,'tool');
 if e.space_id<>p_space_id or not internal.entity_readable(e.id) then raise exception 'tool unavailable' using errcode='42501'; end if;
 -- 379: a loop-triggered run is the in-process loop executor's, for a live
 -- loop in this space, pinned to the version it validated, never kept open.
 -- 386 adds: for a loop whose tool_id names this tool (the column 379 could not see).
 if p_triggered_by_loop_id is not null then
   if coalesce(internal.claim_text('tm8.auth_kind'),'')<>'' or internal.claim_text('tm8.via_link') is not null
   or internal.claim_text('tm8.work_session_id') is not null then
     raise exception 'a loop-triggered tool run is started only by the loop executor' using errcode='42501'; end if;
   loop_entity:=internal.live_entity(p_triggered_by_loop_id,'loop');
   if loop_entity.space_id<>p_space_id then raise exception 'loop belongs to another space' using errcode='22023'; end if;
   -- 386: the loop's configured tool is the tool this run executes (design 01a182d4 §3.4).
   if (select l.tool_id from public.loops l where l.entity_id=p_triggered_by_loop_id) is distinct from p_tool_id then
     raise exception 'loop tool_id does not name this tool' using errcode='23514'; end if;
   if p_tool_version is null then
     raise exception 'a loop-triggered tool run pins the tool version it validated' using errcode='22023'; end if;
   if coalesce(p_keep_open,false) then
     raise exception 'a loop-triggered tool run never keeps its shell open' using errcode='22023'; end if;
 end if;
 perform internal.require_replay_principal(p_client_mutation_id); replay:=internal.ledger_replay(p_client_mutation_id,'tools.run');
 if replay is not null then
   perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space');
   perform internal.require_replay_subject(replay#>>'{toolId}',p_tool_id::text,'tool');
   -- 379: a firing's retry replays only a run this same loop fired.
   if p_triggered_by_loop_id is not null and not exists(select 1 from public.edges g
     where g.src_id=(replay#>>'{entity,id}')::uuid and g.dst_id=p_triggered_by_loop_id
       and g.type='triggered_by' and g.props->>'provenance'='true') then
     raise exception 'clientMutationId belongs to a run this loop did not fire' using errcode='23514'; end if;
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
 -- 379: THE RUN'S PROVENANCE EDGE, written in this transaction (348:192-215).
 -- No `on conflict`, no exception handler: the run id was minted above, so a
 -- conflict is impossible and a failure aborts the run with it. 347's marker
 -- is refused to every writer but spawn, so the writer is set exactly as there.
 -- This marked edge is the only authority issue_tool_session_loop_session accepts.
 if p_triggered_by_loop_id is not null then
   perform internal.w1_set_writer('spawn');
   insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
   values(p_space_id,target,p_triggered_by_loop_id,'triggered_by',
     jsonb_build_object('provenance',true,
       'firedAt',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),actor);
   perform internal.w1_set_writer(null);
 end if;
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'tools.run',internal.command_result(target,null,
   internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','work_session','sessionKind','tool')),array[target,e.id])
   ||jsonb_build_object('toolId',e.id))||jsonb_build_object('__tm8_replayed',false);
end $$;

comment on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text,uuid) is
 '318 + 379 + 386: start a tool run; with p_triggered_by_loop_id, a loop firing: no-bearer claims, live same-space loop whose '
 'tool_id is p_tool_id, pinned version, keep-open off; writes the provenance-marked triggered_by edge in the same transaction.';

revoke all on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text,uuid) from public;
grant execute on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text,uuid) to tm8_app;
reset role;
