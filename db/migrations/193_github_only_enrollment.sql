-- GitHub-only sign-in/signup. Keep old accounts and hashes for explicit
-- identity migration; password HTTP endpoints are refused by the application.
create or replace function internal.node_is_claimed_unsafe()
returns boolean language sql stable security definer
set search_path=public,internal,pg_temp as $$
  select exists(select 1 from public.accounts where password_hash is not null)
      or exists(select 1 from public.local_github_accounts);
$$;
grant execute on function public.claim_node(text,text,text,text,text,text) to tm8_graph_owner;
set role tm8_graph_owner;
create or replace function public.complete_local_github_login(p_subject text,p_email text,p_name text,p_parent uuid,p_invite text,p_hash text)
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
    if p_invite is null then raise exception 'Use an invitation, or ask your administrator to link your existing account to GitHub' using errcode='42501'; end if;
    if p_invite ~ '^tm8c_[A-Za-z0-9_-]{43}$' then
      -- GitHub proves identity; the private initial setup token authorizes
      -- ownership. claim_node serializes and burns it on the existing owner.
      created:=public.claim_node(encode(sha256(convert_to(substring(p_invite from 6),'UTF8')),'hex'),
        'github_'||p_subject,'scrypt','disabled:github-only',left(p_name,120),p_email);
      linked:=(created->>'id')::uuid;
    else
    -- No email or username matching. A provider identity can never claim an
    -- existing account without that account's authenticated linking session.
    created:=public.signup_via_invite(p_invite,'id_'||internal.new_id()::text,'github_'||p_subject,
      left(p_name,120),p_email,'scrypt','disabled:github-only');
    linked:=(created->'account'->>'id')::uuid;
    end if;
    update public.accounts set password_hash=null,password_algorithm=null where id=linked;
  end if;
  select * into a from public.accounts where id=linked and status='active' for update;
  if a.id is null then raise exception 'account unavailable' using errcode='42501'; end if;
  insert into public.local_github_accounts(subject,account_id) values(p_subject,linked) on conflict(subject) do nothing;
  insert into public.auth_sessions(account_id,kind,token_hash,label,expires_at)
    values(a.id,'browser',p_hash,'GitHub sign-in',now()+interval '30 days') returning * into s;
  return jsonb_build_object('sessionId',s.id,'expiresAt',s.expires_at,'accountId',a.id);
end $$;

reset role;
