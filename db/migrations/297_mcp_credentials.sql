-- MCP uses the existing sealed credential entity and sharing boundary.
set role tm8_graph_owner;
create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider in ('typesafe', 'mcp'), false) $$;
-- Compatibility fixtures can apply this migration without the historical W2
-- tranche that normally defines w2_sha256. Keep the canonical hash available
-- in that ordering while reusing the existing definition when it is present.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='internal' and p.proname='w2_sha256' and p.pronargs=1
  ) then
    execute $fn$
      create function internal.w2_sha256(value jsonb) returns text
      language sql immutable parallel safe as $w2$
        select encode(sha256(convert_to(value::text,'UTF8')),'hex')
      $w2$
    $fn$;
  end if;
end
$$;
alter table public.space_credentials
  drop constraint space_credentials_provider_check,
  add constraint space_credentials_provider_check check (provider in ('anthropic','openai','github','typesafe','mcp')),
  drop constraint space_credentials_provider_shape_check,
  add constraint space_credentials_provider_shape_check check (
    (provider = 'github' and shape = 'token') or
    (provider in ('anthropic','openai') and shape in ('login','api_key')) or
    (provider = 'typesafe' and shape = 'api_key') or
    (provider = 'mcp' and shape in ('api_key','token'))),
  add column mcp_server_id uuid,
  add column mcp_definition_fingerprint text,
  add column mcp_definition_version integer,
  add column mcp_expires_at timestamptz,
  add column mcp_refreshable boolean not null default false;
-- No cascading definition FK: credential removal never removes a connector.
create or replace function internal.mcp_security_fingerprint_json(d jsonb) returns text
language sql immutable as $$
 select internal.w2_sha256(jsonb_build_object(
   'transport',d->'transport','url',d->'url','command',d->'command','args',d->'args',
   'envKeys',d->'envKeys','headerKeys',d->'headerKeys','auth',d->'auth',
   'stdioTrusted',d->'stdioTrusted','allowPrivateNetwork',d->'allowPrivateNetwork'));
$$;
create or replace function internal.mcp_security_fingerprint(p_server uuid) returns text
language sql stable security definer set search_path=public,internal,pg_temp as $$
 select internal.mcp_security_fingerprint_json(s.definition) from public.mcp_servers s where s.entity_id=p_server;
$$;
create or replace function internal.mcp_security_fingerprint_json(d jsonb) returns text
language sql immutable as $$
 select internal.w2_sha256(jsonb_build_object(
   'transport',d->'transport','url',d->'url','command',d->'command','args',d->'args',
   'envKeys',d->'envKeys','headerKeys',d->'headerKeys','auth',d->'auth',
   'stdioTrusted',d->'stdioTrusted','allowPrivateNetwork',d->'allowPrivateNetwork'));
$$;
alter table public.mcp_servers add column if not exists mcp_security_revision integer not null default 1;
create or replace function internal.mcp_definition_lock() returns trigger
language plpgsql as $$ begin
 if internal.mcp_security_fingerprint_json(OLD.definition)<>internal.mcp_security_fingerprint_json(NEW.definition) then
   NEW.mcp_security_revision:=OLD.mcp_security_revision+1;
 else NEW.mcp_security_revision:=OLD.mcp_security_revision;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(NEW.entity_id::text,297)); return NEW; end $$;
drop trigger if exists mcp_definition_credential_lock on public.mcp_servers;
create trigger mcp_definition_credential_lock before update on public.mcp_servers
for each row execute function internal.mcp_definition_lock();
create function public.create_mcp_credential(p_id uuid, p_space uuid, p_server uuid,
  p_label text, p_ciphertext bytea, p_nonce bytea, p_shape text default 'api_key',
  p_expires_at timestamptz default null,p_refreshable boolean default false,p_expected_revision integer default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space);
  -- Serialize consent stamping with definition edits using the same transaction
  -- advisory lock acquired by the definition update trigger.
  perform pg_advisory_xact_lock(hashtextextended(p_server::text,297));
  if p_server is null or p_expected_revision is null or not exists (select 1 from public.entities e join public.mcp_servers s on s.entity_id=e.id where e.id=p_server and e.space_id=p_space and e.kind='mcp_server' and e.deleted_at is null and s.definition->>'approved'='true' and coalesce(s.definition->>'enabled','true')='true' and s.mcp_security_revision=p_expected_revision) then
    raise exception 'MCP server not found' using errcode='P0002';
  end if;
  result := public.create_space_credential(p_id,p_space,'mcp',p_shape,p_label,'mcp',p_ciphertext,p_nonce,null,'private',false,false);
  update public.space_credentials set mcp_server_id=p_server,mcp_definition_fingerprint=internal.mcp_security_fingerprint(p_server),mcp_definition_version=(select mcp_security_revision from public.mcp_servers where entity_id=p_server),mcp_expires_at=p_expires_at,mcp_refreshable=p_refreshable where id=p_id;
  return result || jsonb_build_object('serverId',p_server);
end $$;
-- Explicit id ONLY. Never consult member_defaults or the space default.
-- This returns ciphertext to the server; no public operation exposes this RPC.
create function public.read_mcp_credential(p_space uuid,p_server uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare c public.space_credentials; a uuid;
begin
  perform internal.require_space_member(p_space);
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'')='link' then
    raise exception 'linked MCP credentials are unavailable' using errcode='42501';
  end if;
  a := internal.current_account_id();
  select sc.* into c from public.space_credentials sc join public.mcp_servers ms on ms.entity_id=sc.mcp_server_id
    where sc.id=p_id and sc.space_id=p_space and sc.provider='mcp' and sc.mcp_server_id=p_server
    and sc.mcp_definition_fingerprint=internal.mcp_security_fingerprint(p_server) and sc.mcp_definition_version=ms.mcp_security_revision;
  if c.id is null or c.status <> 'active' or a is null or not (
    c.owner_account_id=a or c.visibility='public' or internal.space_credential_shared_with(c.id,a)) then
    raise exception 'MCP credential unavailable' using errcode='42501';
  end if;
  return jsonb_build_object('credentialId',c.id,'spaceId',c.space_id,'serverId',c.mcp_server_id,'definitionVersion',c.mcp_definition_version,
    'ciphertext',encode(c.secret_ciphertext,'base64'),'nonce',encode(c.secret_nonce,'base64'));
end $$;
-- Refresh uses compare-and-swap so a concurrent revoke or rotation wins.
create function public.refresh_mcp_credential(p_space uuid,p_server uuid,p_id uuid,p_old_nonce bytea,p_ciphertext bytea,p_nonce bytea,p_expires_at timestamptz default null,p_refreshable boolean default false)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform public.read_mcp_credential(p_space,p_server,p_id);
  update public.space_credentials set secret_ciphertext=p_ciphertext,secret_nonce=p_nonce,mcp_expires_at=p_expires_at,mcp_refreshable=p_refreshable
    where id=p_id and status='active' and secret_nonce=p_old_nonce;
  return found;
end $$;
revoke all on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer) from public;
revoke all on function public.read_mcp_credential(uuid,uuid,uuid) from public;
revoke all on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea,timestamptz,boolean) from public;
grant execute on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer) to tm8_app;
grant execute on function public.read_mcp_credential(uuid,uuid,uuid) to tm8_app;
grant execute on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea,timestamptz,boolean) to tm8_app;
-- Metadata only, evaluated against current membership/sharing.
create function public.list_mcp_credentials(p_server uuid,p_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,internal,pg_temp as $$
declare result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',sc.id,'serverId',sc.mcp_server_id,'label',sc.label,
  'authType',case when sc.shape='token' then 'oauth2' else 'api_key' end,
  'visibility',case when sc.visibility='public' then 'space' when exists(select 1 from public.space_credential_shares s where s.credential_id=sc.id) then 'selected' else 'private' end,
  'ownerId',sc.owner_account_id,'sharedMemberIds',coalesce((select jsonb_agg(m.entity_id) from public.space_credential_shares s join public.accounts a on a.id=s.grantee_account_id join public.members m on m.identity_id=a.identity_id and m.space_id=sc.space_id where s.credential_id=sc.id and (sc.owner_account_id=internal.current_account_id() or s.grantee_account_id=internal.current_account_id())),'[]'::jsonb),
  'usable',sc.status='active' and sc.mcp_definition_fingerprint=internal.mcp_security_fingerprint(sc.mcp_server_id) and sc.mcp_definition_version=(select mcp_security_revision from public.mcp_servers where entity_id=sc.mcp_server_id) and (sc.mcp_expires_at is null or sc.mcp_expires_at>now() or sc.mcp_refreshable) and (sc.visibility='public' or sc.owner_account_id=internal.current_account_id() or internal.space_credential_shared_with(sc.id,internal.current_account_id())),
  'manageable',sc.owner_account_id=internal.current_account_id(),
  'revoked',sc.status='revoked',
  'reason',case when sc.status='revoked' then 'credential_revoked' when sc.status<>'active' then 'credential_unavailable' when sc.mcp_definition_fingerprint<>internal.mcp_security_fingerprint(sc.mcp_server_id) or sc.mcp_definition_version<>(select mcp_security_revision from public.mcp_servers where entity_id=sc.mcp_server_id) then 'credential_definition_changed' when sc.mcp_expires_at<=now() and not sc.mcp_refreshable then 'credential_expired' when sc.visibility='public' or sc.owner_account_id=internal.current_account_id() or internal.space_credential_shared_with(sc.id,internal.current_account_id()) then 'ready' else 'access_denied' end
 ) order by sc.created_at),'[]'::jsonb) into result
 from public.space_credentials sc where sc.provider='mcp' and sc.mcp_server_id is not null
 and (p_server is null or sc.mcp_server_id=p_server) and (p_id is null or sc.id=p_id)
 and internal.is_space_member(sc.space_id);
 return result;
end $$;
revoke all on function public.list_mcp_credentials(uuid,uuid) from public;
grant execute on function public.list_mcp_credentials(uuid,uuid) to tm8_app;
create function public.mcp_credential_readiness(p_server uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,internal,pg_temp as $$
declare c public.space_credentials;
begin
 if p_id is null then return jsonb_build_object('ready',false,'reason','credential_required'); end if;
 select * into c from public.space_credentials where id=p_id and provider='mcp' and mcp_server_id=p_server;
 if c.id is null or not internal.is_space_member(c.space_id) then return jsonb_build_object('ready',false,'reason','credential_unavailable'); end if;
 if c.status='revoked' then return jsonb_build_object('ready',false,'reason','credential_revoked'); end if;
 if c.mcp_definition_fingerprint<>internal.mcp_security_fingerprint(p_server) or c.mcp_definition_version<>(select mcp_security_revision from public.mcp_servers where entity_id=p_server) then return jsonb_build_object('ready',false,'reason','credential_definition_changed'); end if;
 if c.mcp_expires_at<=now() and not c.mcp_refreshable then return jsonb_build_object('ready',false,'reason','credential_expired'); end if;
 begin
  perform public.read_mcp_credential(c.space_id,p_server,p_id);
 exception when others then return jsonb_build_object('ready',false,'reason','credential_unavailable'); end;
 return jsonb_build_object('ready',true,'reason','ready');
end $$;
revoke all on function public.mcp_credential_readiness(uuid,uuid) from public;
grant execute on function public.mcp_credential_readiness(uuid,uuid) to tm8_app;
create or replace function public.read_space_service_key(p_space_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account uuid; v_source text;
begin
  if p_provider='mcp' then raise exception 'MCP requires an explicit server and account' using errcode='42501'; end if;
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
-- Tool audit contains references and outcomes only: no request/response JSON or tokens.
create table public.mcp_call_audit (
 id bigint generated always as identity primary key,
 space_id uuid not null references public.spaces(id),
 session_id uuid not null, server_id uuid not null, credential_id uuid,
 method text not null check(method in ('tools/list','tools/call')),
 outcome text not null check(outcome in ('started','succeeded','failed')),
 occurred_at timestamptz not null default now()
);
alter table public.mcp_call_audit enable row level security;
create policy mcp_call_audit_read on public.mcp_call_audit for select to tm8_app using(internal.is_space_admin(space_id));
grant select on public.mcp_call_audit to tm8_app;
create function public.record_mcp_call(p_space uuid,p_session uuid,p_server uuid,p_credential uuid,p_method text,p_outcome text)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
 perform internal.require_space_member(p_space);
 insert into public.mcp_call_audit(space_id,session_id,server_id,credential_id,method,outcome)
 values(p_space,p_session,p_server,p_credential,p_method,p_outcome);
end $$;
revoke all on function public.record_mcp_call(uuid,uuid,uuid,uuid,text,text) from public;
grant execute on function public.record_mcp_call(uuid,uuid,uuid,uuid,text,text) to tm8_app;
analyze public.mcp_call_audit;
reset role;
