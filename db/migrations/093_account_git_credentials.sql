-- =============================================================================
-- 093 — per-account GitHub credentials: the string-shaped half of Tier B.
--
-- `account_agent_credentials` (083) is deliberately only an INDEX for the
-- file-shaped Anthropic and OpenAI stores. A GitHub token is a string, so it
-- lives in this separate encrypted store and never in that index.
--
-- SECURITY POSTURE (the same posture as 083, plus encrypted secret columns):
--
--   * RLS exposes only the transaction identity's own account. There is no
--     node-admin bypass.
--   * tm8_app receives a COLUMN-LEVEL SELECT grant that omits ciphertext and
--     nonce. It receives no direct INSERT, UPDATE, or DELETE privilege.
--   * set/delete are SECURITY DEFINER RPCs, derive the account themselves,
--     accept no account parameter, and require browser|cli auth in SQL as well
--     as at the facade guard.
--   * the narrow spawn reader also derives the account and returns only that
--     row's sealed bytes. It is intentionally not human-only: an agent-spawned
--     child inherits its owner's member-credential posture, but it still sees
--     no other account because the identity claim and row predicate are fixed.
--   * token_ciphertext is AES-256-GCM ciphertext||tag. The 32-byte key lives
--     at <dataDir>/.git-credential.key (0600), outside Postgres. AAD is
--     <account_id>|github, so ciphertext moved between rows will not open.
--
-- The host is in the trust boundary: the tm8 OS account can read both the key
-- and the database. Encryption protects dumps, replicas, backups, and a SQL
-- compromise of tm8_app; it cannot protect against root on the node that must
-- legitimately decrypt the token for a spawned process.
-- =============================================================================

set role tm8_graph_owner;

create table public.account_git_credentials (
  id               uuid primary key default internal.new_id(),
  account_id       uuid not null references public.accounts(id) on delete cascade,
  provider         text not null,
  login            text not null,
  token_ciphertext bytea not null,
  token_nonce      bytea not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint account_git_credentials_provider_check
    check (provider = 'github'),
  constraint account_git_credentials_login_check
    check (char_length(btrim(login)) between 1 and 100),
  -- AES-GCM uses a 12-byte nonce and appends a 16-byte authentication tag.
  constraint account_git_credentials_nonce_check
    check (octet_length(token_nonce) = 12),
  constraint account_git_credentials_ciphertext_check
    check (octet_length(token_ciphertext) between 17 and 4096),
  constraint account_git_credentials_one_per_provider
    unique (account_id, provider)
);

comment on table public.account_git_credentials is
  'Per-account string-shaped GitHub credentials. Secret columns are AES-256-GCM '
  'sealed with a node-filesystem key and are never granted to tm8_app. Read the '
  '093 header before changing a column, policy, grant, or RPC.';

comment on column public.account_git_credentials.token_ciphertext is
  'AES-256-GCM ciphertext||tag, AAD-bound to <account_id>|github. Never granted '
  'for table SELECT; returned only by read_account_git_credential for spawn.';

create trigger account_git_credentials_touch_updated_at
before update on public.account_git_credentials
for each row execute function internal.touch_updated_at();

alter table public.account_git_credentials enable row level security;

create policy account_git_credentials_self_select on public.account_git_credentials
  for select using (account_id = internal.current_account_id());

grant select (id, account_id, provider, login, created_at, updated_at)
  on public.account_git_credentials to tm8_app;
-- No table-level grant and no INSERT/UPDATE/DELETE grant.

-- Store or replace the calling human's sealed token. The account is derived;
-- there is no parameter with which a caller could name another account.
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
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is distinct from 'github' then
    raise exception 'unsupported git credential provider' using errcode = '22023';
  end if;
  if p_login is null or btrim(p_login) = '' then
    raise exception 'git credential login is required' using errcode = '22023';
  end if;

  insert into public.account_git_credentials(
    account_id, provider, login, token_ciphertext, token_nonce
  ) values (
    v_account_id, p_provider, nullif(btrim(p_login), ''),
    p_token_ciphertext, p_token_nonce
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

-- Idempotent disconnect. A missing row and a deleted row both end disconnected;
-- `deleted` remains available to diagnostics without changing that outcome.
create or replace function public.delete_account_git_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  removed integer;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is distinct from 'github' then
    raise exception 'unsupported git credential provider' using errcode = '22023';
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

-- The only tm8_app door to the sealed bytes. It returns the calling identity's
-- own row or null and never accepts an account id.
create or replace function public.read_account_git_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_git_credentials;
begin
  perform internal.require_identity();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    return null;
  end if;
  if p_provider is distinct from 'github' then
    raise exception 'unsupported git credential provider' using errcode = '22023';
  end if;

  select * into stored
    from public.account_git_credentials c
   where c.account_id = v_account_id
     and c.provider = p_provider;
  if stored.id is null then
    return null;
  end if;

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
