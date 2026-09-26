-- =============================================================================
-- 251 — space links, part 2: sealed per-member token rows, the spaceLinks.*
-- RPCs and stale handling (plan 01a0d9eb §3 W6; decisions 31, 33, 38).
--
-- Ordinal 251 set at the merge position (reserved as 244; re-stacked onto main f54f9ffd); 250 is part 1.
--
-- POSTURE — 206's, applied to one member's row instead of a space's:
--
--   * RLS: a row is visible to ITS MEMBER only (the identity behind
--     member_id, active, inside the session pin). There is no node-admin
--     bypass and no space-admin one either.
--   * tm8_app gets a COLUMN-LEVEL select grant that omits ciphertext and
--     nonce, and no insert, update or delete privilege. Every write is a
--     SECURITY DEFINER RPC below.
--   * ciphertext is AES-256-GCM ciphertext||tag under the node key
--     (credentials/credential-key.ts, the key 206 uses), sealed and opened in
--     the TS store only, AAD-bound to
--         home_space_id|link_id|member_id|target_space_id
--     The `aad` column stores that string and a CHECK holds it equal to the
--     row's own columns, but the opener RECOMPUTES it from the columns: a
--     ciphertext copied to another row, member or target does not open (T19).
--   * The plaintext is a `link` auth session (250) minted here for the target
--     space: 90 days (identity/service.ts DEFAULT_SESSION_TTL_MS.link, K10),
--     pinned, and seen and revocable on the target's Sessions page (W4).
--     There is no target-consent setting (decision 33, K5 rejected).
--   * allow_spawn defaults to TRUE and spawn_budget to 3 (decision 38, K11 as
--     changed). The per-link switch is spaceLinks.setSpawn.
--
-- Management RPCs (add/login/relogin/logout/remove/setSpawn) call the STRICT
-- internal.require_human_auth_kind(): human sessions only, so an agent and a
-- link session are both refused. list_space_links has no gate: agents may
-- list, and it returns no secret. open_space_link_token returns the sealed
-- bytes to the server process only (no operation exposes it), for the row's
-- own member, and admits only an allow-list of session kinds (browser, cli,
-- agent); link, agent_runtime, null and any later kind refuse.
--
-- STALE (no retry anywhere): a 401 on use → mark_space_link_stale('signed_out');
-- the member leaving or being removed from the TARGET → the members trigger
-- below sets 'left'. Both clear the sealed bytes, revoke the session and raise
-- attention on the link for the member. Leaving or being removed from the HOME
-- deletes the member's rows (232's end_membership step 5); the delete trigger
-- revokes each row's session.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------
create table public.space_link_tokens (
  id               uuid primary key default internal.new_id(),
  link_id          uuid not null references public.space_links(entity_id) on delete cascade,
  home_space_id    uuid not null references public.spaces(id) on delete cascade,
  member_id        uuid not null references public.members(entity_id) on delete cascade,
  target_space_id  uuid not null,
  auth_session_id  uuid references public.auth_sessions(id) on delete set null,
  ciphertext       bytea,
  nonce            bytea,
  aad              text not null,
  status           text not null default 'signed_out'
    check (status in ('signed_in', 'signed_out', 'left', 'unreachable')),
  allow_spawn      boolean not null default true,
  spawn_budget     integer not null default 3 check (spawn_budget between 0 and 100),
  alias            text check (alias is null or alias ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (link_id, member_id),
  constraint space_link_tokens_aad_binds_row check (
    aad = home_space_id::text || '|' || link_id::text || '|' || member_id::text || '|' || target_space_id::text),
  constraint space_link_tokens_sealed_shape check (
    (ciphertext is null and nonce is null)
    or (ciphertext is not null and nonce is not null
        and octet_length(nonce) = 12 and octet_length(ciphertext) between 17 and 4096)),
  constraint space_link_tokens_signed_in_has_token check (
    status <> 'signed_in' or (ciphertext is not null and auth_session_id is not null))
);

create unique index space_link_tokens_alias_per_member
  on public.space_link_tokens(member_id, alias) where alias is not null;
create index space_link_tokens_member_idx on public.space_link_tokens(member_id);
create index space_link_tokens_target_idx on public.space_link_tokens(target_space_id);
create index space_link_tokens_session_idx on public.space_link_tokens(auth_session_id)
  where auth_session_id is not null;

create trigger space_link_tokens_touch_updated_at
before update on public.space_link_tokens
for each row execute function internal.touch_updated_at();

alter table public.space_link_tokens enable row level security;

-- The row's member only: no node-admin arm, no space-admin arm.
create policy space_link_tokens_select on public.space_link_tokens for select to tm8_app
  using (exists (
    select 1 from public.members m
     where m.entity_id = space_link_tokens.member_id
       and m.identity_id = internal.identity_id()
       and m.status = 'active'
       and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
            or m.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)));

-- Column grant WITHOUT ciphertext and nonce.
grant select (id, link_id, home_space_id, member_id, target_space_id, auth_session_id,
              aad, status, allow_spawn, spawn_budget, alias, expires_at, last_used_at,
              created_at, updated_at)
  on public.space_link_tokens to tm8_app;

comment on table public.space_link_tokens is
  'W6 (251): one member''s sealed link session for a space_link. ciphertext is '
  'AES-256-GCM under the node key, AAD home_space_id|link_id|member_id|target_space_id. '
  'tm8_app cannot select ciphertext or nonce; RLS shows a row to its member only.';

-- -----------------------------------------------------------------------------
-- 2. Helpers.
-- -----------------------------------------------------------------------------

-- The caller's own row for a link, locked. Resolves the caller's ACTIVE member
-- in the link's home space through current_member_id, so the session pin holds.
create or replace function internal.space_link_own_row(p_link_id uuid)
returns public.space_link_tokens language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  link public.space_links;
  me uuid;
  row public.space_link_tokens;
begin
  select * into link from public.space_links where entity_id = p_link_id;
  if link.entity_id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  me := internal.current_member_id(link.home_space_id);
  if me is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select * into row from public.space_link_tokens
   where link_id = p_link_id and member_id = me
   for update;
  if row.id is null then
    raise exception 'you have no token row on this space link' using errcode = 'P0002';
  end if;
  return row;
end
$$;

revoke all on function internal.space_link_own_row(uuid) from public;

-- What a caller may see of a token row: never ciphertext, nonce or aad.
create or replace function internal.space_link_row_json(p_row public.space_link_tokens)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select case when p_row.id is null then null else jsonb_build_object(
    'memberId', p_row.member_id,
    'status', p_row.status,
    'allowSpawn', p_row.allow_spawn,
    'spawnBudget', p_row.spawn_budget,
    'alias', p_row.alias,
    'sessionId', p_row.auth_session_id,
    'expiresAt', p_row.expires_at,
    'lastUsedAt', p_row.last_used_at) end
$$;

revoke all on function internal.space_link_row_json(public.space_link_tokens) from public;

-- One link as the caller sees it. The target's name only when the caller is a
-- member of the target (P8: other members see THAT a link exists, not what
-- the target is called).
create or replace function internal.space_link_json(p_link_id uuid, p_member_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', l.entity_id,
    'homeSpaceId', l.home_space_id,
    'targetSpaceId', l.target_space_id,
    'targetServerId', l.target_server_id,
    'targetSpaceName', (select s.name from public.spaces s
                         where s.id = l.target_space_id
                           and l.target_server_id is null
                           and exists (select 1 from public.members m
                                        where m.space_id = s.id
                                          and m.identity_id = internal.identity_id()
                                          and m.status = 'active')),
    'createdAt', l.created_at,
    'statusSummary', jsonb_build_object(
      'signedIn',    (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'signed_in'),
      'signedOut',   (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'signed_out'),
      'left',        (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'left'),
      'unreachable', (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'unreachable')),
    'mine', (select internal.space_link_row_json(t) from public.space_link_tokens t
              where t.link_id = l.entity_id and t.member_id = p_member_id))
    from public.space_links l
   where l.entity_id = p_link_id
$$;

revoke all on function internal.space_link_json(uuid, uuid) from public;

-- Attention on the link, for the member whose row went stale. One open request
-- per link at a time, like forms (211).
create or replace function internal.space_link_raise_attention(p_row public.space_link_tokens, p_reason text)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if exists (select 1 from public.attention_requests
              where entity_id = p_row.link_id and status in ('open', 'acknowledged')) then
    return;
  end if;
  insert into public.attention_requests(space_id, entity_id, reason, points, requested_by)
  values (p_row.home_space_id, p_row.link_id, left(p_reason, 500), 50, p_row.member_id);
  update public.entities set activity_at = now(), updated_at = now() where id = p_row.link_id;
end
$$;

revoke all on function internal.space_link_raise_attention(public.space_link_tokens, text) from public;

-- -----------------------------------------------------------------------------
-- 3. spaceLinks.add — create (or join) the shared link entity for a target,
--    and the caller's token row (signed_out until login).
-- -----------------------------------------------------------------------------
create or replace function public.add_space_link(
  p_space_id uuid,
  p_target_space_id uuid,
  p_alias text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  me uuid;
  v_link_id uuid;
  activity_id uuid;
  row public.space_link_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.add');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'homeSpaceId', p_space_id::text, 'space');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  perform internal.bind_actor(me);

  if p_target_space_id is null or p_target_space_id = p_space_id then
    raise exception 'a space link needs a target space other than its home' using errcode = '22023';
  end if;
  -- Same server: the caller must be an active member of the target. The same
  -- answer for "no such space" and "not a member", so add does not probe.
  if not exists (select 1 from public.members m
                  where m.space_id = p_target_space_id
                    and m.identity_id = internal.identity_id()
                    and m.status = 'active') then
    raise exception 'target space not found' using errcode = 'P0002';
  end if;

  select entity_id into v_link_id from public.space_links
   where home_space_id = p_space_id and target_space_id = p_target_space_id
     and target_server_id is null
   for update;
  if v_link_id is null then
    v_link_id := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
    values (v_link_id, p_space_id, 'space_link', null, null, me, 'space');
    insert into public.space_links(entity_id, home_space_id, target_space_id, target_server_id)
    values (v_link_id, p_space_id, p_target_space_id, null);
    perform internal.record_initial_version(v_link_id, me);
    activity_id := internal.record_activity(p_space_id, v_link_id, me, 'created', null,
                     jsonb_build_object('kind', 'space_link'));
  end if;

  insert into public.space_link_tokens(link_id, home_space_id, member_id, target_space_id, aad, alias)
  values (v_link_id, p_space_id, me, p_target_space_id,
          p_space_id::text || '|' || v_link_id::text || '|' || me::text || '|' || p_target_space_id::text,
          nullif(btrim(p_alias), ''))
  on conflict (link_id, member_id) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.add',
           internal.space_link_json(v_link_id, me));
end
$$;

-- -----------------------------------------------------------------------------
-- 4. spaceLinks.login / relogin — store a freshly minted link session.
--
-- The TS store generates the session id and secret, hashes the token, seals it
-- under the node key with the AAD it read from the row, and hands this RPC the
-- hash and the sealed bytes. The plaintext never reaches SQL. Any previous
-- session on the row is revoked in the same transaction ("relogin in place",
-- K10). Target membership is checked through is_space_member, so the session
-- pin holds: a human session pinned elsewhere cannot mint a session for B.
-- -----------------------------------------------------------------------------
create or replace function public.store_space_link_session(
  p_link_id uuid,
  p_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ciphertext bytea,
  p_nonce bytea,
  p_operation text,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.space_link_tokens;
  account uuid;
begin
  if p_operation not in ('spaceLinks.login', 'spaceLinks.relogin') then
    raise exception 'unknown space link operation' using errcode = '22023';
  end if;
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  perform internal.bind_actor(row.member_id);

  if p_operation = 'spaceLinks.relogin' and row.auth_session_id is null and row.status = 'signed_out'
     and row.last_used_at is null and row.expires_at is null then
    raise exception 'this link was never signed in: use login' using errcode = '23514';
  end if;
  if not internal.is_space_member(row.target_space_id) then
    raise exception 'you are not a member of the link''s target space' using errcode = '42501';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days 1 minute' then
    raise exception 'a link session lasts at most 90 days' using errcode = '22023';
  end if;

  account := internal.current_account_id();
  if account is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  if row.auth_session_id is not null then
    update public.auth_sessions set revoked_at = now()
     where id = row.auth_session_id and revoked_at is null;
  end if;

  insert into public.auth_sessions(id, account_id, kind, space_id, token_hash, label, expires_at)
  values (p_session_id, account, 'link', row.target_space_id, p_token_hash,
          'Space link from ' || coalesce((select name from public.spaces where id = row.home_space_id), 'another space'),
          p_expires_at);

  update public.space_link_tokens
     set ciphertext = p_ciphertext,
         nonce = p_nonce,
         auth_session_id = p_session_id,
         status = 'signed_in',
         expires_at = p_expires_at
   where id = row.id;

  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.space_link_json(p_link_id, row.member_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. spaceLinks.logout — revoke the session, forget the sealed bytes.
-- -----------------------------------------------------------------------------
create or replace function public.logout_space_link(p_link_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.space_link_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.logout');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  perform internal.bind_actor(row.member_id);
  if row.auth_session_id is not null then
    update public.auth_sessions set revoked_at = now()
     where id = row.auth_session_id and revoked_at is null;
  end if;
  update public.space_link_tokens
     set ciphertext = null, nonce = null, auth_session_id = null,
         status = case when status = 'left' then 'left' else 'signed_out' end
   where id = row.id;
  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.logout',
           internal.space_link_json(p_link_id, row.member_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. spaceLinks.remove — delete the caller's row. The link entity is shared
--    and stays for the other members; the delete trigger revokes the session.
-- -----------------------------------------------------------------------------
create or replace function public.remove_space_link(p_link_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.space_link_tokens;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.remove');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  perform internal.bind_actor(row.member_id);
  delete from public.space_link_tokens where id = row.id;
  result := internal.space_link_json(p_link_id, row.member_id);
  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.remove', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. spaceLinks.setSpawn — the per-link spawn switch and budget (K11 as changed).
-- -----------------------------------------------------------------------------
create or replace function public.set_space_link_spawn(
  p_link_id uuid,
  p_allow_spawn boolean,
  p_spawn_budget integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.space_link_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.setSpawn');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  perform internal.bind_actor(row.member_id);
  update public.space_link_tokens
     set allow_spawn = coalesce(p_allow_spawn, allow_spawn),
         spawn_budget = coalesce(p_spawn_budget, spawn_budget)
   where id = row.id;
  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.setSpawn',
           internal.space_link_json(p_link_id, row.member_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. spaceLinks.list — every link in a space, and the caller's own row. No
--    gate: an agent may list. No secret in the answer.
-- -----------------------------------------------------------------------------
create or replace function public.list_space_links(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
begin
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  return coalesce((
    select jsonb_agg(internal.space_link_json(l.entity_id, me) order by l.created_at, l.entity_id)
      from public.space_links l
      join public.entities e on e.id = l.entity_id
     where l.home_space_id = p_space_id
       and e.deleted_at is null
  ), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. The server's use path (W7's invoke calls it through the TS store). Returns
--    the sealed bytes of the caller's OWN row and the columns the AAD is
--    recomputed from. No operation returns this: it is read by the server
--    process and opened in memory. A link session may not read link tokens.
-- -----------------------------------------------------------------------------
create or replace function public.open_space_link_token(p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  -- ALLOW-list, not a deny-list: the human kinds plus 'agent' (W7's own-row
  -- path). link, agent_runtime, any later kind, null and empty all refuse.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  row := internal.space_link_own_row(p_link_id);
  if row.status <> 'signed_in' or row.ciphertext is null then
    raise exception 'space link is %', row.status using errcode = '23514',
      detail = jsonb_build_object('status', row.status)::text;
  end if;
  update public.space_link_tokens set last_used_at = now() where id = row.id;
  return jsonb_build_object(
    'linkId', row.link_id,
    'homeSpaceId', row.home_space_id,
    'memberId', row.member_id,
    'targetSpaceId', row.target_space_id,
    'sessionId', row.auth_session_id,
    'allowSpawn', row.allow_spawn,
    'spawnBudget', row.spawn_budget,
    'ciphertext', encode(row.ciphertext, 'base64'),
    'nonce', encode(row.nonce, 'base64'));
end
$$;

-- The AAD inputs for sealing, before login: the caller's own row.
create or replace function public.space_link_seal_context(p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  return jsonb_build_object(
    'linkId', row.link_id, 'homeSpaceId', row.home_space_id,
    'memberId', row.member_id, 'targetSpaceId', row.target_space_id);
end
$$;

-- A use found the session dead (401) or the target unreachable. No retry: the
-- row is marked, the bytes forgotten, the session revoked, and the member
-- gets attention on the link. Callable from the use path, so no human gate
-- but the same kind allow-list as open; still the caller's own row only.
create or replace function public.mark_space_link_stale(p_link_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  if p_status not in ('signed_out', 'unreachable') then
    raise exception 'a use can only mark a link signed_out or unreachable' using errcode = '22023';
  end if;
  -- ALLOW-list, not a deny-list: the human kinds plus 'agent' (W7's own-row
  -- path). link, agent_runtime, any later kind, null and empty all refuse.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  row := internal.space_link_own_row(p_link_id);
  if p_status = 'signed_out' then
    if row.auth_session_id is not null then
      update public.auth_sessions set revoked_at = now()
       where id = row.auth_session_id and revoked_at is null;
    end if;
    update public.space_link_tokens
       set status = 'signed_out', ciphertext = null, nonce = null, auth_session_id = null
     where id = row.id
     returning * into row;
    perform internal.space_link_raise_attention(row,
      'Space link signed out: the target refused the stored session. Sign in again.');
  else
    update public.space_link_tokens set status = 'unreachable' where id = row.id returning * into row;
    perform internal.space_link_raise_attention(row, 'Space link unreachable: the target did not answer.');
  end if;
  return internal.space_link_json(p_link_id, row.member_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 10. Triggers.
-- -----------------------------------------------------------------------------

-- A deleted row (remove, the home membership ending, the link deleted) takes
-- its session with it: no live link session outlives its sealed bytes.
create or replace function internal.space_link_tokens_revoke_on_delete()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if old.auth_session_id is not null then
    update public.auth_sessions set revoked_at = now()
     where id = old.auth_session_id and revoked_at is null;
  end if;
  return old;
end
$$;

create trigger space_link_tokens_revoke_on_delete
after delete on public.space_link_tokens
for each row execute function internal.space_link_tokens_revoke_on_delete();

-- The member left or was removed from a link's TARGET (same server): every
-- row of that identity pointing at the space turns `left`, forgets its bytes,
-- revokes its session and raises attention. A trigger, so 232's shared
-- end_membership body is not copied.
create or replace function internal.space_link_target_membership_ended()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  for row in
    select t.* from public.space_link_tokens t
      join public.members m on m.entity_id = t.member_id
     where t.target_space_id = new.space_id
       and m.identity_id = new.identity_id
     for update of t
  loop
    if row.auth_session_id is not null then
      update public.auth_sessions set revoked_at = now()
       where id = row.auth_session_id and revoked_at is null;
    end if;
    update public.space_link_tokens
       set status = 'left', ciphertext = null, nonce = null, auth_session_id = null
     where id = row.id
     returning * into row;
    perform internal.space_link_raise_attention(row,
      'Space link closed: the member is no longer in the target space.');
  end loop;
  return new;
end
$$;

create trigger members_end_space_links
after update of status on public.members
for each row
when (old.status = 'active' and new.status <> 'active')
execute function internal.space_link_target_membership_ended();

-- -----------------------------------------------------------------------------
-- 11. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function internal.space_link_tokens_revoke_on_delete() from public;
revoke all on function internal.space_link_target_membership_ended() from public;

revoke all on function public.add_space_link(uuid, uuid, text, text) from public;
grant execute on function public.add_space_link(uuid, uuid, text, text) to tm8_app;
revoke all on function public.store_space_link_session(uuid, uuid, text, timestamptz, bytea, bytea, text, text) from public;
grant execute on function public.store_space_link_session(uuid, uuid, text, timestamptz, bytea, bytea, text, text) to tm8_app;
revoke all on function public.logout_space_link(uuid, text) from public;
grant execute on function public.logout_space_link(uuid, text) to tm8_app;
revoke all on function public.remove_space_link(uuid, text) from public;
grant execute on function public.remove_space_link(uuid, text) to tm8_app;
revoke all on function public.set_space_link_spawn(uuid, boolean, integer, text) from public;
grant execute on function public.set_space_link_spawn(uuid, boolean, integer, text) to tm8_app;
revoke all on function public.list_space_links(uuid) from public;
grant execute on function public.list_space_links(uuid) to tm8_app;
revoke all on function public.open_space_link_token(uuid) from public;
grant execute on function public.open_space_link_token(uuid) to tm8_app;
revoke all on function public.space_link_seal_context(uuid) from public;
grant execute on function public.space_link_seal_context(uuid) to tm8_app;
revoke all on function public.mark_space_link_stale(uuid, text) from public;
grant execute on function public.mark_space_link_stale(uuid, text) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.space_link_tokens;
