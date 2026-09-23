-- =============================================================================
-- 203 — per-account SERVICE KEYS: keys tm8 uses server-side for a member.
--
-- The first and only provider is `typesafe`, the TypeSafe key behind Jev. A
-- member pastes it in Settings → agent credentials, and `launch.suggest` uses
-- it when THAT member presses ✦ Ask Jev (falling back to the node's
-- `TYPESAFE_API_KEY` when they have none).
--
-- WHY A TABLE OF ITS OWN, AND NOT A ROW IN EITHER CREDENTIAL STORE.
--
--   * `account_agent_credentials` (083) indexes FILE-shaped agent credentials
--     that live in the member's per-identity credential home — the directory a
--     spawned agent is pointed at. A TypeSafe key must never be reachable from
--     a spawned session (Lane K, hard rule), so it cannot live beside them.
--   * `account_git_credentials` (093) is read by the SPAWN path
--     (`read_account_git_credential`) and injected as `GH_TOKEN`. 196's header
--     already refused a second consumer of that table, and a service key is the
--     opposite of what spawn reads there.
--
-- So nothing on the spawn path can read this table by accident: no spawn code
-- names it, and `read_account_service_key` below is called from exactly one
-- place, `launch.suggest`'s advisor resolution.
--
-- SECURITY POSTURE — 093's, unchanged:
--
--   * RLS exposes only the transaction identity's own account. There is no
--     node-admin bypass. One member's key is unreadable to every other member.
--   * tm8_app receives a COLUMN-LEVEL SELECT grant that omits ciphertext and
--     nonce, and no INSERT, UPDATE or DELETE privilege.
--   * set/delete are SECURITY DEFINER RPCs that derive the account themselves,
--     accept no account parameter, and require browser|cli auth in SQL as well
--     as at the facade guard.
--   * key_ciphertext is AES-256-GCM ciphertext||tag under the node key at
--     <dataDir>/.git-credential.key (0600, outside Postgres), AAD-bound to
--     <account_id>|<provider>, so ciphertext moved between rows — or between
--     this table and 093's — will not open.
--   * key_hint is the key's last four characters and nothing more, so the
--     screen can say which key is stored without ever holding it.
-- =============================================================================

set role tm8_graph_owner;

create table public.account_service_keys (
  id             uuid primary key default internal.new_id(),
  account_id     uuid not null references public.accounts(id) on delete cascade,
  provider       text not null,
  key_hint       text not null,
  key_ciphertext bytea not null,
  key_nonce      bytea not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint account_service_keys_provider_check
    check (provider in ('typesafe')),
  constraint account_service_keys_hint_check
    check (char_length(key_hint) between 1 and 4),
  constraint account_service_keys_nonce_check
    check (octet_length(key_nonce) = 12),
  constraint account_service_keys_ciphertext_check
    check (octet_length(key_ciphertext) between 17 and 4096),
  constraint account_service_keys_one_per_provider
    unique (account_id, provider)
);

comment on table public.account_service_keys is
  'Per-account keys tm8 uses SERVER-SIDE for a member (typesafe: Ask Jev). Never '
  'agent credentials and never read by spawn. Secret columns are AES-256-GCM '
  'sealed with a node-filesystem key and are never granted to tm8_app. Read the '
  '203 header before changing a column, policy, grant, or RPC.';

create trigger account_service_keys_touch_updated_at
before update on public.account_service_keys
for each row execute function internal.touch_updated_at();

alter table public.account_service_keys enable row level security;

create policy account_service_keys_self_select on public.account_service_keys
  for select using (account_id = internal.current_account_id());

grant select (id, account_id, provider, key_hint, created_at, updated_at)
  on public.account_service_keys to tm8_app;

create or replace function public.set_account_service_key(
  p_provider text,
  p_key_hint text,
  p_key_ciphertext bytea,
  p_key_nonce bytea
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_service_keys;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is distinct from 'typesafe' then
    raise exception 'unsupported service key provider' using errcode = '22023';
  end if;

  insert into public.account_service_keys(
    account_id, provider, key_hint, key_ciphertext, key_nonce
  ) values (
    v_account_id, p_provider, p_key_hint, p_key_ciphertext, p_key_nonce
  )
  on conflict (account_id, provider) do update
     set key_hint       = excluded.key_hint,
         key_ciphertext = excluded.key_ciphertext,
         key_nonce      = excluded.key_nonce
  returning * into stored;

  return jsonb_build_object(
    'provider', stored.provider,
    'keyHint', stored.key_hint,
    'updatedAt', stored.updated_at
  );
end
$$;

-- Idempotent: a missing row and a deleted row both end with no key.
create or replace function public.delete_account_service_key(p_provider text)
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
  if p_provider is distinct from 'typesafe' then
    raise exception 'unsupported service key provider' using errcode = '22023';
  end if;

  delete from public.account_service_keys
   where account_id = v_account_id
     and provider = p_provider;
  get diagnostics removed = row_count;

  return jsonb_build_object('provider', p_provider, 'deleted', removed > 0);
end
$$;

-- The only tm8_app door to the sealed bytes: the calling identity's own row or
-- null, never another account's. Human-only like the other two — Ask Jev is a
-- button a person presses, and an agent token carries its owner's identity.
create or replace function public.read_account_service_key(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_service_keys;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    return null;
  end if;
  if p_provider is distinct from 'typesafe' then
    raise exception 'unsupported service key provider' using errcode = '22023';
  end if;

  select * into stored
    from public.account_service_keys k
   where k.account_id = v_account_id
     and k.provider = p_provider;
  if stored.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'accountId', stored.account_id,
    'provider', stored.provider,
    'keyCiphertext', encode(stored.key_ciphertext, 'base64'),
    'keyNonce', encode(stored.key_nonce, 'base64')
  );
end
$$;

revoke all on function public.set_account_service_key(text, text, bytea, bytea) from public;
revoke all on function public.delete_account_service_key(text) from public;
revoke all on function public.read_account_service_key(text) from public;
grant execute on function public.set_account_service_key(text, text, bytea, bytea) to tm8_app;
grant execute on function public.delete_account_service_key(text) to tm8_app;
grant execute on function public.read_account_service_key(text) to tm8_app;

reset role;
