-- =============================================================================
-- 992 (PLACEHOLDER ordinal — set at the merge position as main + own delta;
-- no placeholder survives into the READY head) — W7p, link provenance
-- (plan 01a0d9eb W7; lead plan (a); coordinator brief 01a0ddc6-ae07).
--
-- THE PROBLEM. A `link` session (250/251) acts in the target space as the
-- member. Anything it spawns is minted by 226's issuers as an ordinary `agent`
-- session of the same human, so the child carried no trace of the link: it
-- could read the human's own git credential (093) and pick any space
-- credential (206), and nothing that ends the link ended it.
--
-- WHAT THIS FILE DOES
--
--   1. `auth_sessions.via_link_id` — the space link a session descends from.
--      Set on the link session itself and on every agent session minted under
--      it, grandchildren and resume re-mints included. Null everywhere else.
--   2. The claim `tm8.via_link` (bound by db/client.ts from the session row,
--      like `tm8.auth_kind`) and `internal.link_bound()`: kind `link` OR a
--      via_link claim. `resolve_auth_session` returns `viaLinkId`.
--   3. Both 226 issuers stamp `via_link_id`, point `parent_session_id` at the
--      link's CURRENT session (flat: a grandchild's parent is the link session
--      too, so one child's re-mint never ends a sibling) and cap `expires_at`
--      at that session's. 249's cascade trigger then ends every descendant
--      when the link session is revoked: logout, remove, the link row deleted,
--      target membership ended, relogin, stale `signed_out`. Expiry is the cap.
--      A link that is not signed in mints nothing (42501), and neither does
--      one with spawning switched off — a child's spawn and a resume alike
--      (lead ruling Q-a (A)); what is already running keeps running.
--   4. A new trigger ends the descendants when the row LEAVES `signed_in`
--      without revoking the link session (stale `unreachable`).
--      (As 250's header says, 083's `require_human_auth_kind()` is on the
--      credential MANAGEMENT RPCs only. The two spawn-time reads below admit
--      agent kinds by design and never called it, which is why kind `link`
--      needs the explicit refusals in 5.)
--   5. 093 `read_account_git_credential` refuses a link-bound caller (42501,
--      never null). 206 `read_space_credential_for_spawn` admits a link-bound
--      caller only for the target's DEFAULT credential (no pinned id), and only
--      while the caller's own row for that link and target is signed in with
--      spawning allowed; anything else 42501. Other kinds are unchanged.
--   6. `open_space_link_token` and `mark_space_link_stale` refuse a via_link
--      caller (no link chaining; a descendant never changes a link's state).
--   7. A RESTRICTIVE select policy hides `account_agent_credentials` from a
--      link-bound caller, so the member's model key is never offered to a
--      link spawn (ruling (i)); the spawn layer refuses by name as well.
--
-- ADDS ONLY — per top-level statement:
--   * alter table add column via_link_id: nullable, no default. No row changes.
--   * add constraint auth_sessions_via_link_kind: CHECK only, validated against
--     rows that are all null. No backfill.
--   * create index: new partial index.
--   * create policy (restrictive): new policy; narrows, never widens.
--   * create trigger: new trigger on 251's table.
--   * create or replace function: 4 new internal helpers; 8 redefinitions,
--     each the latest definer's body plus the stamp or guard (listed at each).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The column. ON DELETE CASCADE: a session outlives nothing it descends
--    from (249's parent_session_id precedent); SET NULL would un-stamp it.
-- -----------------------------------------------------------------------------
alter table public.auth_sessions
  add column via_link_id uuid references public.space_links(entity_id) on delete cascade;

alter table public.auth_sessions
  add constraint auth_sessions_via_link_kind
  check (via_link_id is null or kind in ('link', 'agent'));

create index auth_sessions_via_link_idx
  on public.auth_sessions(via_link_id)
  where via_link_id is not null;

comment on column public.auth_sessions.via_link_id is
  'W7p (992): the space link this session descends from — the link session '
  'itself and every agent session minted under it. Bound as tm8.via_link.';

-- -----------------------------------------------------------------------------
-- 2. Helpers.
-- -----------------------------------------------------------------------------

-- Kind `link`, or any session carrying a via_link claim. Invoker rights: it
-- reads the caller's own claims and is used inside an RLS policy (§10).
create or replace function internal.link_bound()
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
      or internal.claim_text('tm8.via_link') is not null
$$;

-- Default (PUBLIC) execute, like internal.claim_text: an RLS policy calls it
-- as whichever role the transaction runs under.

-- The live link session of `p_identity`'s own row on `p_link_id`: the row is
-- signed in with spawning allowed, the link entity is not deleted, the member
-- is active and the session is neither revoked nor expired. Anything else is
-- 42501. Every caller is a MINT (link_provenance_for), so allow_spawn = false
-- stops a running via_link child minting a grandchild — and stops a resume
-- under the link — without ending anything already running. FOR SHARE
-- on the row and the session: a concurrent revoke or status change waits for
-- this transaction, so its cascade sees the child this call is about to mint.
create or replace function internal.live_link_session(p_link_id uuid, p_identity text)
returns public.auth_sessions language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  s public.auth_sessions;
begin
  select s0.* into s
    from public.space_link_tokens t
    join public.members m on m.entity_id = t.member_id
    join public.entities e on e.id = t.link_id
    join public.auth_sessions s0 on s0.id = t.auth_session_id
   where t.link_id = p_link_id
     and m.identity_id = p_identity
     and m.status = 'active'
     and e.deleted_at is null
     and t.status = 'signed_in'
     and t.allow_spawn
     and s0.revoked_at is null
     and s0.expires_at > now()
   for share of t, s0;
  if s.id is null then
    raise exception 'the space link this session runs under is not signed in' using errcode = '42501';
  end if;
  return s;
end
$$;

revoke all on function internal.live_link_session(uuid, text) from public;

-- What an issuer stamps on an agent session for `p_work_session_id`:
--   * a link-bound caller: its own via_link claim (required) and its own row;
--   * otherwise, a work session that already ran under a link (a resume by
--     anyone) keeps that link, through the identity it ran as;
--   * otherwise nulls.
-- Read BEFORE the issuer revokes the work session's earlier tokens.
create or replace function internal.link_provenance_for(
  p_work_session_id uuid,
  out via_link_id uuid,
  out parent_session_id uuid,
  out parent_expires_at timestamptz
) language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  link uuid;
  who text;
  parent public.auth_sessions;
begin
  if internal.link_bound() then
    link := internal.claim_text('tm8.via_link')::uuid;
    if link is null then
      raise exception 'a link session without its link cannot mint a session' using errcode = '42501';
    end if;
    who := internal.identity_id();
  else
    select s.via_link_id, a.identity_id into link, who
      from public.auth_sessions s
      join public.accounts a on a.id = s.account_id
     where s.work_session_id = p_work_session_id
       and s.via_link_id is not null
     order by s.created_at desc
     limit 1;
    if link is null then
      return;
    end if;
  end if;
  parent := internal.live_link_session(link, who);
  via_link_id := link;
  parent_session_id := parent.id;
  parent_expires_at := parent.expires_at;
end
$$;

revoke all on function internal.link_provenance_for(uuid) from public;

-- -----------------------------------------------------------------------------
-- 3. resolve_auth_session — 226's body plus 'viaLinkId'.
-- -----------------------------------------------------------------------------
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
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

-- -----------------------------------------------------------------------------
-- 4. issue_agent_auth_session — 226's body plus the mint backstop and the
--    provenance stamp.
-- -----------------------------------------------------------------------------
create or replace function public.issue_agent_auth_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  target_space uuid;
  account public.accounts;
  issued public.auth_sessions;
  prov record;
begin
  -- W7p mint backstop (deny-by-default ruling, Q4): this mint refuses a `link`
  -- session as its first statement, like issue_work_session_agent_session.
  -- 226 resolved the identity in the declare block, which runs before any
  -- statement; it moves below the refusal. #884 admits its invoke by its
  -- marker, and nothing else.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot mint an agent session' using errcode = '42501';
  end if;
  identity := internal.require_identity();
  if p_expires_at <= now() then
    raise exception 'agent auth session expiry must be in the future' using errcode = '22023';
  end if;

  select e.space_id into target_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null
   for update of ws;
  if target_space is null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;

  if not internal.can_act_as(p_team_member_id, target_space)
     or not exists (
       select 1 from public.edges edge
        where edge.src_id = p_team_member_id
          and edge.dst_id = p_work_session_id
          and edge.type = 'participates_in'
     ) then
    raise exception 'agent credential persona does not participate in this work session'
      using errcode = '42501';
  end if;

  select * into account
    from public.accounts a
   where a.identity_id = identity and a.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  -- W7p: the link this session descends from, before the revoke below.
  select * into prov from internal.link_provenance_for(p_work_session_id);

  -- Serialize on the work_session above, then retire every earlier run token
  -- before inserting the replacement. Plaintext is never persisted here.
  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id
     and kind = 'agent'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id,
    via_link_id, parent_session_id
  ) values (
    account.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, least(p_expires_at, prov.parent_expires_at), target_space,
    prov.via_link_id, prov.parent_session_id
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

-- -----------------------------------------------------------------------------
-- 5. read_account_git_credential — 093's body plus the link refusal.
-- -----------------------------------------------------------------------------
create or replace function public.read_account_git_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_git_credentials;
begin
  perform internal.require_identity();
  -- W7p: a link session and everything minted under it never reads the
  -- linking human's own git credential. Refused, never null: null is the
  -- ordinary no-login answer and would read as "use another source".
  if internal.link_bound() then
    raise exception 'a space link session cannot read an account git credential' using errcode = '42501';
  end if;
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

-- -----------------------------------------------------------------------------
-- 6. read_space_credential_for_spawn — 239's body (the latest definer; 206's
--    plus the private-owner gate) plus the link admission, as additions only.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_launcher uuid;
begin
  -- W7p (ruling A'): a link session's own claims read no spawn credential at
  -- all. Its children (auth kind 'agent', via_link set) take the link
  -- admission below. #884's spaceLinks.invoke owns the only exception.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot read a spawn credential' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_launch_space_id);
  v_launcher := internal.current_account_id();

  -- W7p: a link-bound caller gets the target's DEFAULT credential only, and
  -- only while its own row for this link and target is signed in with
  -- spawning allowed. A pinned id, a missing row or a switched-off link: 42501.
  if internal.link_bound() then
    if p_credential_id is not null or not exists (
      select 1
        from public.space_link_tokens t
        join public.members m on m.entity_id = t.member_id
        join public.entities e on e.id = t.link_id
       where t.link_id = internal.claim_text('tm8.via_link')::uuid
         and m.identity_id = internal.identity_id()
         and m.status = 'active'
         and e.deleted_at is null
         and t.target_space_id = p_launch_space_id
         and t.status = 'signed_in'
         and t.allow_spawn
    ) then
      raise exception 'a space link spawn uses only this space''s default credential, while the link is signed in with spawning allowed'
        using errcode = '42501';
    end if;
  end if;

  if p_credential_id is null then
    select * into stored from public.space_credentials
     where space_id = p_launch_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then
      raise exception 'this space has no default % credential', p_provider using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'no_default', 'provider', p_provider)::text;
    end if;
  else
    select * into stored from public.space_credentials
     where id = p_credential_id and space_id = p_launch_space_id;
    if stored.id is null or stored.provider is distinct from p_provider then
      raise exception 'space credential not found in this space' using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'not_found', 'provider', p_provider)::text;
    end if;
    if stored.status <> 'active' then
      raise exception 'space credential "%" is %', stored.label, stored.status using errcode = '23514',
        detail = jsonb_build_object('reason', stored.status, 'provider', p_provider)::text;
    end if;
  end if;

  -- The space default is public by constraint, so this only ever refuses a
  -- pinned id; it is checked for both anyway.
  if not (stored.visibility = 'public' or stored.owner_account_id is null
          or stored.owner_account_id = v_launcher) then
    raise exception 'space credential "%" is private to its owner', stored.label using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', stored.display_login,
    'secretCiphertext', case when stored.shape = 'login' then null else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case when stored.shape = 'login' then null else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

-- -----------------------------------------------------------------------------
-- 7. store_space_link_session — 251's body; the link session is stamped.
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

  insert into public.auth_sessions(id, account_id, kind, space_id, token_hash, label, expires_at, via_link_id)
  values (p_session_id, account, 'link', row.target_space_id, p_token_hash,
          'Space link from ' || coalesce((select name from public.spaces where id = row.home_space_id), 'another space'),
          p_expires_at, p_link_id);

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
-- 8. open_space_link_token — 251's body plus the via_link refusal.
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
  -- W7p: an agent minted under a link never opens a link (no chaining).
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
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

-- -----------------------------------------------------------------------------
-- 8b. mark_space_link_stale — 251's body plus the same via_link refusal as
--     open_space_link_token: a link-descended session reports nothing about a
--     link (it never opened one), so it cannot sign one out or strand it.
-- -----------------------------------------------------------------------------
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
  -- W7p: a session minted under a link never changes a link's state — the
  -- same refusal as open_space_link_token.
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
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
-- 9. A row leaving `signed_in` ends the descendants of its session, including
--    the one path that keeps the link session alive (stale `unreachable`).
--    Every other exit revokes the link session and 249's cascade already ran.
-- -----------------------------------------------------------------------------
create or replace function internal.space_link_tokens_end_descendants()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if old.auth_session_id is not null then
    update public.auth_sessions set revoked_at = now()
     where parent_session_id = old.auth_session_id
       and via_link_id is not null
       and revoked_at is null;
  end if;
  return new;
end
$$;

revoke all on function internal.space_link_tokens_end_descendants() from public;

create trigger space_link_tokens_end_descendants
after update of status on public.space_link_tokens
for each row
when (old.status = 'signed_in' and new.status <> 'signed_in')
execute function internal.space_link_tokens_end_descendants();

-- -----------------------------------------------------------------------------
-- 10. The member's model key is not offered to a link-bound caller (ruling
--     (i)). RESTRICTIVE: ANDed with 083's self-select, so it only narrows.
-- -----------------------------------------------------------------------------
create policy account_agent_credentials_no_link on public.account_agent_credentials
  as restrictive for select using (not internal.link_bound());

-- -----------------------------------------------------------------------------
-- Grants — unchanged signatures; restated for the redefinitions.
-- -----------------------------------------------------------------------------
revoke all on function public.resolve_auth_session(text) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;
revoke all on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) to tm8_app;
revoke all on function public.read_account_git_credential(text) from public;
grant execute on function public.read_account_git_credential(text) to tm8_app;
revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;
revoke all on function public.store_space_link_session(uuid, uuid, text, timestamptz, bytea, bytea, text, text) from public;
grant execute on function public.store_space_link_session(uuid, uuid, text, timestamptz, bytea, bytea, text, text) to tm8_app;
revoke all on function public.open_space_link_token(uuid) from public;
grant execute on function public.open_space_link_token(uuid) to tm8_app;
revoke all on function public.mark_space_link_stale(uuid, text) from public;
grant execute on function public.mark_space_link_stale(uuid, text) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- 11. issue_work_session_agent_session — 226's body plus the provenance stamp.
--     Replaced after `reset role`, like 226: it is owned by the migrating role.
-- -----------------------------------------------------------------------------
create or replace function public.issue_work_session_agent_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  account_row public.accounts;
  session_row public.auth_sessions;
  session_space uuid;
  prov record;
begin
  -- W7p mint backstop (deny-by-default ruling): the spawn path's mint
  -- (`DbGraphPort.issueWorkSessionAgentToken`) refuses a `link` session as its
  -- first statement. The facade refuses it at the transport, the registry and
  -- the spawn handlers first; this is the database's own refusal. #884 admits
  -- its invoke here, by its marker, and nothing else.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot mint an agent session' using errcode = '42501';
  end if;
  perform internal.require_identity();
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    raise exception 'invalid work-session credential' using errcode = '22023';
  end if;

  select a.* into account_row
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if account_row.id is null then
    raise exception 'active account not found' using errcode = 'P0002';
  end if;

  select e.space_id into session_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
    join public.edges relation on relation.src_id = e.id
      and relation.dst_id = p_team_member_id and relation.type = 'relates_to'
   where e.id = p_work_session_id
     and e.deleted_at is null
     and ws.status in ('spawning','running','idle')
   for update of ws;
  if session_space is null then
    raise exception 'live work session/persona relationship not found' using errcode = 'P0002';
  end if;
  if not internal.can_act_as(p_team_member_id, session_space) then
    raise exception 'cannot issue a credential for this session persona' using errcode = '42501';
  end if;

  -- W7p: the link this session descends from, before the revoke below.
  select * into prov from internal.link_provenance_for(p_work_session_id);

  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id,
    via_link_id, parent_session_id
  ) values (
    account_row.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, least(p_expires_at, prov.parent_expires_at), session_space,
    prov.via_link_id, prov.parent_session_id
  ) returning * into session_row;

  return to_jsonb(session_row) - 'token_hash';
end
$$;

revoke all on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) to tm8_app;
