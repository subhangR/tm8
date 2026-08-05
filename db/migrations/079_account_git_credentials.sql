-- =============================================================================
-- 079 — per-account GitHub credentials. THE FIRST THIRD-PARTY SECRET tm8 STORES.
--
-- WHY THIS REVERSES 044's RULING, AND WHAT CHANGED.
--
-- 044 deliberately removed the password column from `server_connections` with
-- the reasoning: "a credential that is stored but never used would only create
-- secret exposure". That reasoning stands, and it is precisely what makes this
-- table admissible: this credential IS used, on every spawn, by exactly one
-- consumer. Agent sessions already run in a real PTY with `git` on PATH; what
-- they lack is a credential that is THEIRS. Without this table every agent on a
-- node pushes as whatever machine-wide login the operator happened to leave in
-- `~/.gitconfig` — one shared identity, no attribution, and no way for a member
-- to revoke their own access without breaking everyone else's. So the exposure
-- 044 refused to create for nothing is created here for something, and the
-- rest of this header states what pays for it.
--
-- WHAT PROTECTS THE TOKEN.
--
--  1. IT IS NOT IN THIS DATABASE. `token_ciphertext` is AES-256-GCM output. The
--     key is a 32-byte random file at `<dataDir>/.git-credential.key`, mode
--     0600, created O_CREAT|O_EXCL — the same construction as the file-upload
--     grant key (`packages/server/src/files/w2-blob-store.ts`). A dump, a
--     replica, a backup or a `select *` yields ciphertext and nothing else.
--     The AAD is `<account_id>|<provider>`, so a ciphertext lifted from one row
--     cannot be replayed into another account's row: it will not authenticate.
--
--  2. `tm8_app` CANNOT SELECT THE SECRET COLUMNS. The grant to the application
--     role is COLUMN-LEVEL and omits `token_ciphertext` and `token_nonce`
--     entirely. This is not a policy that could be widened by a future `using
--     (true)` — the privilege does not exist. A SQL injection through the app
--     role cannot read the ciphertext, let alone the token.
--
--  3. RLS PINS EVERY ROW TO ITS OWNER. The one SELECT policy admits only rows
--     whose `account_id` is the caller's own account, resolved from
--     `internal.identity_id()` through `public.accounts` — never from a claim
--     the client could supply. There is no node-admin bypass here on purpose:
--     an operator administering the node has no business reading a member's
--     GitHub identity, and a node admin can already read the encrypted row's
--     existence through their own psql if they own the box (see NOT PROTECTED).
--
--  4. WRITES HAVE NO TABLE PRIVILEGE AT ALL. No insert/update/delete grant is
--     issued. Every mutation goes through the SECURITY DEFINER RPCs below,
--     which re-derive the account from the transaction's identity and ignore
--     any caller-supplied account id — there is no parameter for one.
--
--  5. THE CIPHERTEXT READ IS A SEPARATE, NARROW DOOR.
--     `public.read_account_git_credential` is the ONLY path that returns
--     ciphertext, it returns the caller's OWN row only, and its single caller
--     is the server's spawn path. Nothing that answers an HTTP read ever calls
--     it; `gitCredentials.status` is served by the column-limited SELECT above
--     and structurally cannot return a token.
--
-- WHAT IS NOT PROTECTED (state it here, not in a postmortem).
--
--  * The agent process reads its own environment. That is the entire feature —
--    `git` must find the credential — so any code the agent runs can read it.
--    The blast radius is one account's GitHub token, which is why it is per
--    account rather than per node.
--  * Anyone with root, or with the tm8 service account, on this box can read
--    both the key file and the ciphertext, and therefore the token. Postgres
--    encryption defends the DATABASE (dumps, replicas, backups, a compromised
--    `tm8_app`), not the host that legitimately holds the key.
--  * Revocation is GitHub's job. Deleting the row stops future injection; it
--    does not invalidate a token an agent already exported somewhere.
-- =============================================================================
set role tm8_graph_owner;

-- `internal.current_account_id()` — the caller's own account, resolved from the
-- identity bound to the transaction — is DEFINED IN 078 and only depended on
-- here. It was briefly defined in both files with identical bodies, which meant
-- apply order decided which one survived and an edit to either could be undone
-- by the other without anything going red. One function, one definition; 078
-- sorts first, so this file may assume it exists.

create table public.account_git_credentials (
  id               uuid primary key default internal.new_id(),
  account_id       uuid not null references public.accounts(id) on delete cascade,
  provider         text not null,
  -- Display only: the GitHub username this credential belongs to, so the UI can
  -- say "connected as octocat" without anything decrypting anything.
  login            text,
  token_ciphertext bytea not null,
  token_nonce      bytea not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint account_git_credentials_provider_check
    check (provider in ('github')),
  constraint account_git_credentials_login_check
    check (login is null or char_length(btrim(login)) between 1 and 100),
  -- AES-256-GCM: a 12-byte nonce, and ciphertext that is at least the 16-byte
  -- tag plus one byte of secret. The upper bound keeps a mistake (a whole file
  -- posted as a "token") from becoming a storage problem.
  constraint account_git_credentials_nonce_check
    check (octet_length(token_nonce) = 12),
  constraint account_git_credentials_ciphertext_check
    check (octet_length(token_ciphertext) between 17 and 4096),
  constraint account_git_credentials_one_per_provider
    unique (account_id, provider)
);

comment on table public.account_git_credentials is
  'Per-account third-party git credentials, encrypted at rest with a key that '
  'lives on the node filesystem and never in this database. Read the 079 '
  'header before adding a column, a policy, or a grant.';
comment on column public.account_git_credentials.token_ciphertext is
  'AES-256-GCM ciphertext||tag. AAD is <account_id>|<provider>. Never granted '
  'to tm8_app; reachable only through public.read_account_git_credential.';

create trigger account_git_credentials_touch_updated_at
before update on public.account_git_credentials
for each row execute function internal.touch_updated_at();

alter table public.account_git_credentials enable row level security;

-- One policy, one direction. Own row, select only; everything else is an RPC.
create policy account_git_credentials_self_select on public.account_git_credentials
  for select using (account_id = internal.current_account_id());

-- COLUMN-LEVEL, and the omission is the security control: `token_ciphertext`
-- and `token_nonce` are absent, so `select *` as tm8_app raises 42501 rather
-- than returning a secret nobody meant to expose.
grant select (id, account_id, provider, login, created_at, updated_at)
  on public.account_git_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- Upsert. The account is derived, never passed: there is no parameter that
-- could name someone else's row.
-- -----------------------------------------------------------------------------
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

  -- Status only. This function has the plaintext columns in scope and returns
  -- neither, which is the invariant every caller of it depends on.
  return jsonb_build_object(
    'connected', true,
    'provider', stored.provider,
    'login', stored.login,
    'updatedAt', stored.updated_at
  );
end
$$;

-- -----------------------------------------------------------------------------
-- Delete. Idempotent: removing a credential that is not there is a fact, not an
-- error, and answering 404 would leak whether one existed.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- The ONLY path that returns ciphertext, and it returns the CALLER's own row.
--
-- Its single caller is the server's spawn path, which holds the file key and
-- decrypts in-process. It is deliberately NOT wired to any HTTP read: the
-- status operation reads the column-limited view above, so no request handler
-- has a decrypted token in scope at all.
-- -----------------------------------------------------------------------------
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
