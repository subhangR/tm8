-- =============================================================================
-- 090 — port the deployed staging line's per-account GitHub credential store.
--
-- This is the same storage decision as staging's 079, not a third mechanism:
-- GitHub tokens are string-shaped, encrypted with AES-256-GCM using a node-local
-- 0600 key, and bound to (account_id, provider) as AEAD additional data.
-- Claude and Codex remain file-shaped in the per-identity credential home.
--
-- tm8_app has column-level SELECT without ciphertext/nonce and no table writes.
-- Every RPC derives the caller's account from transaction identity; no input can
-- name another account. The only ciphertext read is the spawn-only RPC.
-- =============================================================================
set role tm8_graph_owner;

create table public.account_git_credentials (
  id               uuid primary key default internal.new_id(),
  account_id       uuid not null references public.accounts(id) on delete cascade,
  provider         text not null,
  login            text,
  token_ciphertext bytea not null,
  token_nonce      bytea not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint account_git_credentials_provider_check
    check (provider in ('github')),
  constraint account_git_credentials_login_check
    check (login is null or char_length(btrim(login)) between 1 and 100),
  constraint account_git_credentials_nonce_check
    check (octet_length(token_nonce) = 12),
  constraint account_git_credentials_ciphertext_check
    check (octet_length(token_ciphertext) between 17 and 4096),
  constraint account_git_credentials_one_per_provider
    unique (account_id, provider)
);

comment on table public.account_git_credentials is
  'Per-account GitHub credentials, encrypted with a node-local key. Ported from '
  'the deployed staging line''s migration 079; do not create a second store.';
comment on column public.account_git_credentials.token_ciphertext is
  'AES-256-GCM ciphertext||tag. AAD is <account_id>|<provider>. Never granted '
  'to tm8_app; reachable only through read_account_git_credential.';

create trigger account_git_credentials_touch_updated_at
before update on public.account_git_credentials
for each row execute function internal.touch_updated_at();

alter table public.account_git_credentials enable row level security;

create policy account_git_credentials_self_select on public.account_git_credentials
  for select using (account_id = internal.current_account_id());

grant select (id, account_id, provider, login, created_at, updated_at)
  on public.account_git_credentials to tm8_app;

create or replace function public.set_account_git_credential(
  p_provider text,
  p_login text,
  p_token_ciphertext bytea,
  p_token_nonce bytea
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_git_credentials;
begin
  perform internal.require_identity();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('github') then
    raise exception 'unsupported git credential provider' using errcode = '22023';
  end if;

  insert into public.account_git_credentials(
    account_id, provider, login, token_ciphertext, token_nonce
  ) values (
    v_account_id, p_provider, nullif(btrim(p_login), ''), p_token_ciphertext, p_token_nonce
  )
  on conflict (account_id, provider) do update
     set login            = excluded.login,
         token_ciphertext = excluded.token_ciphertext,
         token_nonce      = excluded.token_nonce
  returning * into stored;

  return jsonb_build_object(
    'connected', true,
    'provider', stored.provider,
    'login', stored.login,
    'updatedAt', stored.updated_at
  );
end
$$;

create or replace function public.delete_account_git_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  removed integer;
begin
  perform internal.require_identity();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  delete from public.account_git_credentials
   where account_id = v_account_id
     and provider = p_provider;
  get diagnostics removed = row_count;

  return jsonb_build_object(
    'connected', false,
    'provider', p_provider,
    'deleted', removed > 0
  );
end
$$;

create or replace function public.read_account_git_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_git_credentials;
begin
  perform internal.require_identity();
  v_account_id := internal.current_account_id();
  if v_account_id is null then return null; end if;

  select * into stored
    from public.account_git_credentials c
   where c.account_id = v_account_id
     and c.provider = p_provider;
  if stored.id is null then return null; end if;

  return jsonb_build_object(
    'accountId', stored.account_id,
    'provider', stored.provider,
    'login', stored.login,
    'tokenCiphertext', encode(stored.token_ciphertext, 'base64'),
    'tokenNonce', encode(stored.token_nonce, 'base64')
  );
end
$$;

revoke all on function public.set_account_git_credential(text, text, bytea, bytea) from public;
revoke all on function public.delete_account_git_credential(text) from public;
revoke all on function public.read_account_git_credential(text) from public;
grant execute on function public.set_account_git_credential(text, text, bytea, bytea) to tm8_app;
grant execute on function public.delete_account_git_credential(text) to tm8_app;
grant execute on function public.read_account_git_credential(text) to tm8_app;

reset role;
