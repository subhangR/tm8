-- =============================================================================
-- 379 — A LOOP CAN RUN A TOOL (Tools v2 PR-C, task 01a182cd-2f12; contract in
--       doc 01a182cb-de75 §4, "FINAL SEAM CONTRACT").
--
-- A scheduled firing has no HTTP request and no bearer. The loop executor runs
-- it under `claimsForLoop` (375): the firing member's identity, nodeAdmin false,
-- NO auth kind, no link, no work-session claim. Every HTTP request carries an
-- auth kind (the loopback auto-owner binds 'browser'), so empty-auth-kind claims
-- are reachable only from in-process server callers. Two doors are added for
-- that caller, and nothing existing is widened.
--
-- 1. `start_tool_session` GAINS A TRAILING `p_triggered_by_loop_id`.
--
--    When it is set, the run's `triggered_by` edge to the loop is written HERE,
--    in the run's own transaction, carrying 347's provenance marker under the
--    spawn writer, with no exception handler and no `on conflict` — 348's
--    execution_spawn block, copied. A run either has its provenance or does not
--    exist. Before anything is written the call is refused unless:
--      - the claims are no-bearer (no auth kind, no link, no work-session claim);
--      - the loop is live and in the run's space;
--      - the version is pinned (never null: the null form skips the stale-source
--        check and could run code the caller never validated);
--      - keep-open is off (a retained shell holds a cap slot, and the loop's
--        overlap guard would then skip the loop forever).
--    A replay (the executor's `tool-fire:<firingKey>` mutation id) returns only
--    a run this same loop fired. The Loops lane's migration that adds
--    `loops.tool_id` redefines this function to also require
--    `loops.tool_id = p_tool_id`; that column does not exist yet.
--
--    The signature changes, so the 10-argument form is DROPPED rather than left
--    beside this one (two overloads reachable by ten arguments is "function is
--    not unique"); 348 did the same to execution_spawn. Existing callers pass
--    ten arguments and resolve here through the new default.
--
-- 2. `issue_tool_session_loop_session` MINTS A LOOP RUN'S tm8 BEARER.
--
--    The authority is the MARKED edge from (1), not the caller's say-so: the
--    mint requires no-bearer claims, a live top-level tool run created by the
--    caller's own member, that run's provenance-marked `triggered_by` edge to
--    the loop, the loop live in the space with `team_member_id` = the persona,
--    and `can_act_as` that persona. The token is kind 'agent', acting as the
--    loop's runs-as persona (never a human-kind token, never a persona-less
--    agent token), pinned to the run and its space, scope read when the tool's
--    pinned access or the requested scope is read, and expires no later than the
--    run's pinned timeout + 60s. No parent: there is no bearer to descend from.
--    There is no fallback branch: the loop side decides whom a firing acts for
--    (armer, else creator, else the loop parks and never fires).
--
--    Revocation is unchanged: 319's settlement trigger and resolver backstop key
--    on work_session_id, and `revoke_agent_auth_session` works because the
--    token names a persona.
-- =============================================================================

set role tm8_graph_owner;

drop function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text);

-- 318's body verbatim, plus the three blocks marked 379.
create function public.start_tool_session(p_space_id uuid,p_tool_id uuid,p_tool_version integer,p_inputs jsonb,
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
 if p_triggered_by_loop_id is not null then
   if coalesce(internal.claim_text('tm8.auth_kind'),'')<>'' or internal.claim_text('tm8.via_link') is not null
   or internal.claim_text('tm8.work_session_id') is not null then
     raise exception 'a loop-triggered tool run is started only by the loop executor' using errcode='42501'; end if;
   loop_entity:=internal.live_entity(p_triggered_by_loop_id,'loop');
   if loop_entity.space_id<>p_space_id then raise exception 'loop belongs to another space' using errcode='22023'; end if;
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

create function public.issue_tool_session_loop_session(p_session_id uuid,p_loop_id uuid,p_team_member_id uuid,
 p_token_hash text,p_expires_at timestamptz,p_api_scope text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
 e public.entities; ws public.work_sessions; runs_as uuid; member uuid;
 account_row public.accounts; session_row public.auth_sessions; access text; scope text;
begin
 -- The loop executor's claims only: no bearer of any kind to act through.
 if coalesce(internal.claim_text('tm8.auth_kind'),'')<>'' or internal.claim_text('tm8.via_link') is not null
 or internal.claim_text('tm8.work_session_id') is not null then
  raise exception 'a loop tool bearer is minted only for the loop executor' using errcode='42501';
 end if;
 e:=internal.live_entity(p_session_id,'work_session');
 perform internal.require_space_member(e.space_id);
 member:=internal.current_member_id(e.space_id);
 -- The firing member's own top-level run.
 if member is null or e.created_by is distinct from member or e.parent_id is not null
 or internal.caller_work_session(e.space_id) is not null then
  raise exception 'loop tool bearer must belong to the firing member''s own run' using errcode='42501';
 end if;
 select * into ws from public.work_sessions where entity_id=e.id for update;
 if ws.session_kind<>'tool' or ws.tool_state<>'running' or ws.outcome<>'open' or ws.status not in ('spawning','running','idle') then
  raise exception 'live tool session required' using errcode='42501';
 end if;
 -- THE AUTHORITY: the marked edge start_tool_session wrote in the run's own
 -- transaction. An unmarked (run-history) edge is never enough (347).
 if not exists(select 1 from public.edges g where g.src_id=e.id and g.dst_id=p_loop_id
   and g.type='triggered_by' and g.space_id=e.space_id and g.props->>'provenance'='true') then
  raise exception 'loop tool bearer requires the run''s provenance edge to that loop' using errcode='42501';
 end if;
 -- The loop, live in this space, names this persona as its runs-as teammate.
 select l.team_member_id into runs_as from public.loops l join public.entities le on le.id=l.entity_id
  where l.entity_id=p_loop_id and le.kind='loop' and le.space_id=e.space_id and le.deleted_at is null;
 if not found or p_team_member_id is null or runs_as is distinct from p_team_member_id then
  raise exception 'loop tool bearer acts only as the loop''s runs-as persona' using errcode='42501';
 end if;
 if not exists(select 1 from public.entities t where t.id=p_team_member_id and t.kind='team_member'
   and t.space_id=e.space_id and t.deleted_at is null)
 or not internal.can_act_as(p_team_member_id,e.space_id) then
  raise exception 'loop tool bearer acts only as the loop''s runs-as persona' using errcode='42501';
 end if;
 -- Pin the access decision to the SAME version as the source the run executes.
 access:=ws.tool_tm8_access;
 if access is null or access='none' then
  raise exception 'tool version has no tm8 API access' using errcode='42501';
 end if;
 if p_api_scope is null or p_api_scope not in ('read','write') or p_token_hash is null
 or p_token_hash !~ '^[a-f0-9]{64}$' or p_expires_at is null or p_expires_at<=now() then
  raise exception 'invalid tool credential' using errcode='22023';
 end if;
 scope:=case when access='read' or p_api_scope='read' or internal.claim_text('tm8.api_scope')='read'
   then 'read' else 'write' end;
 select a.* into account_row from public.accounts a
 where a.id=internal.current_account_id() and a.status='active';
 if account_row.id is null then raise exception 'active account required' using errcode='42501'; end if;
 perform internal.bind_actor(p_team_member_id);
 insert into public.edges(space_id,src_id,dst_id,type,created_by)
 values(e.space_id,p_team_member_id,e.id,'participates_in',p_team_member_id) on conflict do nothing;
 update public.auth_sessions set revoked_at=now() where work_session_id=e.id and revoked_at is null;
 insert into public.auth_sessions(account_id,kind,acting_as_team_member_id,work_session_id,
   token_hash,label,expires_at,space_id,api_scope,parent_session_id)
 values(account_row.id,'agent',p_team_member_id,e.id,p_token_hash,'tool-loop:'||e.id,
   least(p_expires_at,now()+make_interval(secs=>ws.tool_timeout_seconds::double precision+60)),e.space_id,scope,null)
 returning * into session_row;
 return to_jsonb(session_row)-'token_hash';
end $$;

comment on function public.issue_tool_session_loop_session(uuid,uuid,uuid,text,timestamptz,text) is
 '379: the tm8 bearer of a loop-triggered tool run. No-bearer (loop executor) claims only; authority is the run''s '
 'provenance-marked triggered_by edge written by start_tool_session. Kind agent, acting as the loop''s runs-as persona.';

revoke all on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text,uuid) from public;
revoke all on function public.issue_tool_session_loop_session(uuid,uuid,uuid,text,timestamptz,text) from public;
grant execute on function public.start_tool_session(uuid,uuid,integer,jsonb,boolean,text,text,integer,uuid,text,uuid) to tm8_app;
grant execute on function public.issue_tool_session_loop_session(uuid,uuid,uuid,text,timestamptz,text) to tm8_app;
reset role;
