-- OAuth proof is accepted only by the separate enrollment principal. Ordinary
-- tm8_app connections cannot bind a provider identity or manufacture a login.
set role tm8_graph_owner;
create table public.local_github_accounts (
  subject text primary key check(subject ~ '^[0-9]{1,20}$'),
  account_id uuid not null unique references public.accounts(id),
  created_at timestamptz not null default now()
);
create table public.local_github_flows (
  state_hash text primary key,
  verifier text not null,
  parent_session uuid references public.auth_sessions(id),
  invitation_code text,
  expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table public.local_github_accounts enable row level security;
alter table public.local_github_flows enable row level security;

create function public.begin_local_github_flow(p_hash text,p_verifier text,p_parent uuid,p_invite text)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'enrollment principal required' using errcode='42501';
  end if;
  delete from public.local_github_flows where expires_at<now();
  if p_parent is not null and not exists(select 1 from public.auth_sessions s join public.accounts a on a.id=s.account_id
      where s.id=p_parent and s.kind in ('browser','cli') and s.revoked_at is null and s.expires_at>now() and a.status='active') then
    raise exception 'active human session required' using errcode='42501';
  end if;
  insert into public.local_github_flows(state_hash,verifier,parent_session,invitation_code) values(p_hash,p_verifier,p_parent,p_invite);
end $$;

create function public.consume_local_github_flow(p_hash text) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare f public.local_github_flows;
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'enrollment principal required' using errcode='42501';
  end if;
  delete from public.local_github_flows where state_hash=p_hash and expires_at>now() returning * into f;
  if f.state_hash is null then raise exception 'OAuth flow expired or already used' using errcode='42501'; end if;
  return to_jsonb(f)-'state_hash';
end $$;

create function public.complete_local_github_login(p_subject text,p_email text,p_name text,p_parent uuid,p_invite text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare a public.accounts; linked uuid; parent_account uuid; created jsonb; s public.auth_sessions;
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'enrollment principal required' using errcode='42501';
  end if;
  if p_subject is null or p_subject !~ '^[0-9]{1,20}$' then raise exception 'invalid provider subject' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('github:'||p_subject,0));
  select account_id into linked from public.local_github_accounts where subject=p_subject;
  if p_parent is not null then
    select s0.account_id into parent_account from public.auth_sessions s0 join public.accounts a0 on a0.id=s0.account_id
      where s0.id=p_parent and s0.kind in ('browser','cli') and s0.revoked_at is null and s0.expires_at>now() and a0.status='active';
    if parent_account is null then raise exception 'linking session expired' using errcode='42501'; end if;
    if linked is not null and linked<>parent_account then raise exception 'GitHub account already linked' using errcode='23505'; end if;
    linked:=parent_account;
  elsif linked is null then
    if p_invite is null then raise exception 'Sign in with your password to link GitHub, or use an invitation' using errcode='42501'; end if;
    -- No email or username matching. A provider identity can never claim an
    -- existing account without that account's authenticated linking session.
    created:=public.signup_via_invite(p_invite,'id_'||internal.new_id()::text,'github_'||p_subject,
      left(p_name,120),p_email,'scrypt','disabled:github-only');
    linked:=(created->'account'->>'id')::uuid;
    update public.accounts set password_hash=null,password_algorithm=null where id=linked;
  end if;
  select * into a from public.accounts where id=linked and status='active' for update;
  if a.id is null then raise exception 'account unavailable' using errcode='42501'; end if;
  insert into public.local_github_accounts(subject,account_id) values(p_subject,linked) on conflict(subject) do nothing;
  insert into public.auth_sessions(account_id,kind,token_hash,label,expires_at)
    values(a.id,'browser',p_hash,'GitHub sign-in',now()+interval '30 days') returning * into s;
  return jsonb_build_object('sessionId',s.id,'expiresAt',s.expires_at,'accountId',a.id);
end $$;
revoke all on function public.begin_local_github_flow(text,text,uuid,text),public.consume_local_github_flow(text),
  public.complete_local_github_login(text,text,text,uuid,text,text) from public;
grant execute on function public.begin_local_github_flow(text,text,uuid,text),public.consume_local_github_flow(text),
  public.complete_local_github_login(text,text,text,uuid,text,text) to tm8_node_enrollment;
reset role;
