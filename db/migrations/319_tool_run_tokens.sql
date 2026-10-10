-- Tool run bearer scopes. Existing sessions retain full API access ('write').
-- SHARED-OBJECT NOTICE: public.resolve_auth_session is copied from 256 verbatim
-- plus apiScope and a live-tool backstop; 318 owns tool outcomes and idle-close.
-- Persona edges use participates_in (teammate -> session), the canonical 309
-- relationship. No relates_to duplicate is created or consumed.
set role tm8_graph_owner;

alter table public.auth_sessions add column api_scope text not null default 'write'
 check (api_scope in ('read','write'));
comment on column public.auth_sessions.api_scope is
 'Immutable API scope, independent of harness permission mode. read permits only catalog read operations; write preserves existing access.';

create function internal.guard_auth_api_scope() returns trigger
language plpgsql set search_path=public,internal,pg_temp as $$
begin
 if new.api_scope is distinct from old.api_scope then
  raise exception 'auth API scope is immutable' using errcode='23514';
 end if;
 return new;
end $$;
create trigger auth_sessions_api_scope_immutable before update of api_scope on public.auth_sessions
 for each row execute function internal.guard_auth_api_scope();

create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'runtimeMemberId', s.runtime_member_id,
    'runtimeThreadRootId', s.runtime_thread_root_id,
    'runtimeChatId', s.runtime_chat_id,
    'spaceId', s.space_id,
    'viaLinkId', s.via_link_id,
    'expiresAt', s.expires_at, 'label', s.label,
    'apiScope', s.api_scope)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
     and not exists (select 1 from public.work_sessions ws
       where ws.entity_id=s.work_session_id and ws.session_kind='tool'
       and (ws.tool_state<>'running' or ws.status not in ('spawning','running','idle')))
$$;

create function public.issue_tool_session_agent_session(p_session_id uuid,p_team_member_id uuid,
 p_token_hash text,p_expires_at timestamptz,p_api_scope text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
 e public.entities; ws public.work_sessions; parent public.work_sessions;
 caller uuid; account_row public.accounts; session_row public.auth_sessions;
 access text; scope text;
begin
 if internal.claim_text('tm8.auth_kind') is distinct from 'agent'
 or internal.claim_text('tm8.via_link') is not null then
  raise exception 'tool API access requires an invoking agent work session' using errcode='42501';
 end if;
 e:=internal.live_entity(p_session_id,'work_session');
 perform internal.require_space_member(e.space_id);
 caller:=internal.caller_work_session(e.space_id);
 if caller is null or caller=e.id or e.parent_id is distinct from caller
 or internal.actor_id() is distinct from p_team_member_id
 or not internal.can_act_as(p_team_member_id,e.space_id) then
  raise exception 'tool bearer must use the invoking session persona' using errcode='42501';
 end if;
 select * into ws from public.work_sessions where entity_id=e.id for update;
 select * into parent from public.work_sessions where entity_id=caller;
 if ws.session_kind<>'tool' or ws.tool_state<>'running' or ws.status not in ('spawning','running','idle')
 or parent.session_kind<>'agent' or parent.status not in ('running','idle')
 or not exists(select 1 from public.edges g where g.src_id=p_team_member_id and g.dst_id=caller
   and g.type='participates_in' and g.space_id=e.space_id) then
  raise exception 'live invoking agent/tool session pair required' using errcode='42501';
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
 scope:=case when access='read' or internal.claim_text('tm8.api_scope')='read' or p_api_scope='read'
   then 'read' else 'write' end;
 select a.* into account_row from public.accounts a
 where a.id=internal.current_account_id() and a.status='active';
 if account_row.id is null then raise exception 'active account required' using errcode='42501'; end if;
 perform internal.bind_actor(p_team_member_id);
 insert into public.edges(space_id,src_id,dst_id,type,created_by)
 values(e.space_id,p_team_member_id,e.id,'participates_in',p_team_member_id) on conflict do nothing;
 update public.auth_sessions set revoked_at=now() where work_session_id=e.id and revoked_at is null;
 insert into public.auth_sessions(account_id,kind,acting_as_team_member_id,work_session_id,
   token_hash,label,expires_at,space_id,api_scope)
 values(account_row.id,'agent',p_team_member_id,e.id,p_token_hash,'tool-run:'||e.id,
   least(p_expires_at,now()+make_interval(secs=>coalesce((select (v.snapshot#>>'{content,definition,timeoutSeconds}')::integer
     from public.entity_versions v where v.entity_id=ws.tool_id and v.version=ws.tool_version),900)+60)),e.space_id,scope)
 returning * into session_row;
 return to_jsonb(session_row)-'token_hash';
end $$;

-- DB-owned revocation survives a launcher failure. Both tool settlement and
-- any PTY end revoke every bearer for the run, even if no status file exists.
create function internal.revoke_settled_tool_tokens() returns trigger
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
 if new.session_kind='tool' and (new.tool_state<>'running' or new.status not in ('spawning','running','idle')) then
  update public.auth_sessions set revoked_at=coalesce(revoked_at,now())
  where work_session_id=new.entity_id and revoked_at is null;
 end if;
 return new;
end $$;
create trigger work_sessions_revoke_tool_tokens after update of tool_state,status on public.work_sessions
 for each row execute function internal.revoke_settled_tool_tokens();
revoke all on function public.issue_tool_session_agent_session(uuid,uuid,text,timestamptz,text) from public;
grant execute on function public.issue_tool_session_agent_session(uuid,uuid,text,timestamptz,text) to tm8_app;
revoke all on function public.resolve_auth_session(text) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;
revoke all on function internal.guard_auth_api_scope(),internal.revoke_settled_tool_tokens() from public;
reset role;
