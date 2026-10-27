-- Human tool-run bearer: the follow-up 319 left open. A human (browser or CLI)
-- running a tool with tm8Access read|write gets a run-scoped bearer that IS the
-- human's account, narrowed: pinned to the tool's space and run, capped by the
-- tool's pinned access, the caller's API scope and (when the caller arrived
-- with a bearer) that bearer's scope and lifetime. 319's settlement trigger and
-- resolve_auth_session backstop key on work_session_id, so the same exit,
-- PTY-end and parent-revocation rules apply unchanged.
set role tm8_graph_owner;

create function public.issue_tool_session_human_session(p_session_id uuid,
 p_token_hash text,p_expires_at timestamptz,p_api_scope text,p_parent_auth_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
 e public.entities; ws public.work_sessions; caller uuid; member uuid;
 account_row public.accounts; session_row public.auth_sessions; parent_auth public.auth_sessions;
 access text; scope text;
begin
 if coalesce(internal.claim_text('tm8.auth_kind'),'') not in ('browser','cli')
 or internal.claim_text('tm8.via_link') is not null then
  raise exception 'human tool API access requires a human session' using errcode='42501';
 end if;
 e:=internal.live_entity(p_session_id,'work_session');
 perform internal.require_space_member(e.space_id);
 member:=internal.current_member_id(e.space_id);
 caller:=internal.caller_work_session(e.space_id);
 -- The run must be the caller's own, started from where the caller stands:
 -- top level, or (a tool run from inside a human tool run) under that run.
 if member is null or e.created_by is distinct from member
 or caller=e.id or e.parent_id is distinct from caller then
  raise exception 'tool bearer must belong to the invoking human' using errcode='42501';
 end if;
 select * into ws from public.work_sessions where entity_id=e.id for update;
 if ws.session_kind<>'tool' or ws.tool_state<>'running' or ws.outcome<>'open' or ws.status not in ('spawning','running','idle') then
  raise exception 'live tool session required' using errcode='42501';
 end if;
 select a.* into account_row from public.accounts a
 where a.id=internal.current_account_id() and a.status='active';
 if account_row.id is null then raise exception 'active account required' using errcode='42501'; end if;
 -- A caller with a work session is a bearer by construction; it must name it.
 if caller is not null and p_parent_auth_session_id is null then
  raise exception 'live invoking human bearer required' using errcode='42501';
 end if;
 if p_parent_auth_session_id is not null then
  -- Share-lock so a concurrent revoke waits and 249's cascade sees the child.
  select * into parent_auth from public.auth_sessions where id=p_parent_auth_session_id for share;
  if parent_auth.id is null or parent_auth.kind not in ('browser','cli') or parent_auth.via_link_id is not null
  or parent_auth.account_id is distinct from account_row.id
  or parent_auth.work_session_id is distinct from caller
  or (parent_auth.space_id is not null and parent_auth.space_id is distinct from e.space_id)
  or parent_auth.revoked_at is not null or parent_auth.expires_at<=now() then
   raise exception 'live invoking human bearer required' using errcode='42501';
  end if;
 end if;
 access:=ws.tool_tm8_access;
 if access is null or access='none' then
  raise exception 'tool version has no tm8 API access' using errcode='42501';
 end if;
 if p_api_scope is null or p_api_scope not in ('read','write') or p_token_hash is null
 or p_token_hash !~ '^[a-f0-9]{64}$' or p_expires_at is null or p_expires_at<=now() then
  raise exception 'invalid tool credential' using errcode='22023';
 end if;
 scope:=case when access='read' or internal.claim_text('tm8.api_scope')='read' or p_api_scope='read'
   or parent_auth.api_scope='read' then 'read' else 'write' end;
 update public.auth_sessions set revoked_at=now() where work_session_id=e.id and revoked_at is null;
 insert into public.auth_sessions(account_id,kind,work_session_id,token_hash,label,expires_at,space_id,api_scope,parent_session_id)
 values(account_row.id,'cli',e.id,p_token_hash,'tool-run:'||e.id,
   least(p_expires_at,coalesce(parent_auth.expires_at,'infinity'),now()+make_interval(secs=>ws.tool_timeout_seconds::double precision+60)),
   e.space_id,scope,parent_auth.id)
 returning * into session_row;
 return to_jsonb(session_row)-'token_hash';
end $$;

revoke all on function public.issue_tool_session_human_session(uuid,text,timestamptz,text,uuid) from public;
grant execute on function public.issue_tool_session_human_session(uuid,text,timestamptz,text,uuid) to tm8_app;
reset role;
