-- =============================================================================
-- 277  CROSS-SPACE SPAWN THROUGH A SPACE LINK (W7b, lane L4).
--
-- THE DECISION. The owner chose, in form response 01a0fbb4 (decisions D1, D4
-- and D8 of form 01a0fb65): "if link is there spawn for now". While an active
-- link A -> B exists and the caller's own row on it is signed in with
-- allow_spawn on (the default stays on), an agent in A may spawn, resume or
-- dispatch a session in B with `tm8 --space <alias> session spawn ...`. There
-- is NO budget and NO reservation. This deliberately reverses #884's lead
-- tightening ("main must never carry an unbudgeted link spawn").
--
-- HOW IT RUNS. `spaceLinks.invoke` (260) runs `execution.spawn`,
-- `execution.resume` or `execution.dispatch` in B in-process as the member's
-- stored `link` session (authKind 'link', tm8.via_link = the link). Every
-- home-side guard runs first and stays: no explicit credential field, the
-- via-chain hop limit, the per-row rate bucket, and the row's allow_spawn.
-- 256 already built the rest: `internal.link_provenance_for` stamps the child
-- `via_link_id`, parents it on the link session, caps its expiry, and admits
-- the mint only while the row is signed in with spawning allowed; 249's
-- cascade ends it with the link. What 256 and 271 did NOT allow was the LINK
-- SESSION ITSELF calling the two spawn-path reads:
--
--   1. issue_work_session_agent_session (256's body): the unconditional
--      first-statement refusal of kind 'link' becomes "kind 'link' without
--      its via_link claim". Its mint then goes through link_provenance_for
--      (signed in, allow_spawn) like any link-bound caller's, and must land in
--      the link's target space. `issue_agent_auth_session` is NOT redefined:
--      the spawn path never calls it, and it still refuses a link session.
--   2. read_space_credential_for_spawn (271's body): the same narrowing. The
--      link-bound branch below it already hands a link-bound caller the
--      target's DEFAULT credential only, while its row is signed in with
--      spawning allowed; a pinned credential id is 42501.
--   3. public.space_link_spawns: the child's provenance in B — the link, the
--      source space (the link's home, never a parameter) and the source work
--      session in A — written by `record_space_link_spawn` under the link
--      session's own claims, after the op, only for a work session that holds
--      an agent session minted under that very link. The audit row in A
--      (`cross_space_audit`, 260) records the same spawn from the home side:
--      link id, source session, source space, op and the child's session id.
--
-- ADDS ONLY — per top-level statement:
--   * create table / index: new table, no tm8_app privilege (RPC only).
--   * create or replace function: 2 redefinitions (each the latest body with
--     the one narrowed refusal and, in the mint, the target-space check), 2 new
--     functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. issue_work_session_agent_session — 256's body; a link session mints with
--    its link claim, in its target space.
-- -----------------------------------------------------------------------------
set role tm8_graph_owner;

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
  -- 277 (W7b): a `link` session mints here only WITH its link claim, and
  -- only through `internal.link_provenance_for` below, which requires its own
  -- row on that link to be signed in with spawning allowed (256
  -- `live_link_session`). Was 256's unconditional first-statement refusal.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
     and internal.claim_text('tm8.via_link') is null then
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

  -- 277 (W7b): a link session mints only in its link's TARGET space. The pin
  -- already holds it there (can_act_as); this names the rule.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' and not exists (
    select 1 from public.space_links l
     where l.entity_id = prov.via_link_id and l.target_space_id = session_space
  ) then
    raise exception 'a space link session mints only in its link''s target space' using errcode = '42501';
  end if;

  -- 277 (W7b, review of #993): a link session resumes only a session ITS link
  -- started. A work session that already holds agent sessions none of which
  -- descend from this link was started in B by someone else; minting for it
  -- here would stamp it via_link_id and bind every later resume (the owner's
  -- included) to this link for good. A fresh spawn has no prior rows.
  if internal.link_bound() and exists (
    select 1 from public.auth_sessions s where s.work_session_id = p_work_session_id
  ) and not exists (
    select 1 from public.auth_sessions s
     where s.work_session_id = p_work_session_id and s.via_link_id = prov.via_link_id
  ) then
    raise exception 'a space link resumes only sessions it started' using errcode = '42501';
  end if;

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

-- -----------------------------------------------------------------------------
-- 2. read_space_credential_for_spawn — 271's body; a link session reads with
--    its link claim, through the link-bound branch.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_launcher uuid;
begin
  -- gate 8: a server-only provider is never handed to a launch, for any
  -- caller, pinned or default. Refused before anything is read.
  if internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is a server-only credential and never reaches a session', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'server_only', 'provider', p_provider)::text;
  end if;

  -- 277 (W7b): a link session's own claims read a spawn credential only WITH
  -- its link claim, and then take the link admission below like its children
  -- do: the target's DEFAULT credential only, while its own row is signed in
  -- with spawning allowed. Was 256/271's unconditional refusal.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
     and internal.claim_text('tm8.via_link') is null then
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

revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. The child's provenance in B.
-- -----------------------------------------------------------------------------

create table public.space_link_spawns (
  work_session_id    uuid primary key references public.work_sessions(entity_id) on delete cascade,
  -- No FK on the link or the source: provenance outlives the link it records.
  link_id            uuid not null,
  target_space_id    uuid not null references public.spaces(id) on delete cascade,
  source_space_id    uuid not null,
  source_session_id  uuid,
  member_id          uuid not null,
  op                 text not null check (op in ('execution.spawn', 'execution.resume', 'execution.dispatch')),
  created_at         timestamptz not null default now()
);

create index space_link_spawns_link_idx on public.space_link_spawns(link_id, created_at desc);

-- No tm8_app privilege and no policy: every read and write is an RPC below.
alter table public.space_link_spawns enable row level security;

comment on table public.space_link_spawns is
  'W7b (277): a work session started in its space through a space link: the link, the source space and the source work session. First record wins.';

-- Written by spaceLinks.invoke's executor under the LINK session's claims,
-- after the op returned. Refused unless the caller is a link session with its
-- link claim, the work session is in the link's target space, and the work
-- session holds an agent session minted under this link (256 via_link_id): the
-- spawn really ran under it. The source space is the link's home, never a
-- parameter; a source session that is not a work session in that home space
-- is dropped, not trusted (260's audit rule).
create or replace function public.record_space_link_spawn(
  p_work_session_id uuid,
  p_op text,
  p_source_session_id uuid
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_link public.space_links;
  v_space uuid;
  v_member uuid;
  v_inserted integer;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link'
     or internal.claim_text('tm8.via_link') is null then
    raise exception 'only a space link session records a link spawn' using errcode = '42501';
  end if;
  select l.* into v_link from public.space_links l
   where l.entity_id = internal.claim_text('tm8.via_link')::uuid;
  if v_link.entity_id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select e.space_id into v_space from public.entities e
   where e.id = p_work_session_id and e.kind = 'work_session' and e.deleted_at is null;
  if v_space is null or v_space <> v_link.target_space_id then
    raise exception 'work session not found in the link''s target space' using errcode = 'P0002';
  end if;
  v_member := internal.current_member_id(v_space);
  if v_member is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.auth_sessions s
     where s.work_session_id = p_work_session_id and s.kind = 'agent' and s.via_link_id = v_link.entity_id
  ) then
    raise exception 'this work session was not started under this space link' using errcode = '42501';
  end if;
  if p_source_session_id is not null and not exists (
    select 1 from public.entities e
     where e.id = p_source_session_id and e.space_id = v_link.home_space_id and e.kind = 'work_session'
  ) then
    p_source_session_id := null;
  end if;
  insert into public.space_link_spawns(
    work_session_id, link_id, target_space_id, source_space_id, source_session_id, member_id, op)
  values (p_work_session_id, v_link.entity_id, v_space, v_link.home_space_id, p_source_session_id, v_member, p_op)
  on conflict (work_session_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end
$$;

revoke all on function public.record_space_link_spawn(uuid, text, uuid) from public;
grant execute on function public.record_space_link_spawn(uuid, text, uuid) to tm8_app;

-- The provenance of one work session, for a member of its space; null when it
-- was not started through a link.
create or replace function public.space_link_spawn_for(p_work_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  r public.space_link_spawns;
begin
  select * into r from public.space_link_spawns where work_session_id = p_work_session_id;
  if r.work_session_id is null or not internal.is_space_member(r.target_space_id) then
    return null;
  end if;
  return jsonb_build_object(
    'workSessionId', r.work_session_id, 'linkId', r.link_id, 'targetSpaceId', r.target_space_id,
    'sourceSpaceId', r.source_space_id, 'sourceSessionId', r.source_session_id,
    'memberId', r.member_id, 'op', r.op, 'createdAt', r.created_at);
end
$$;

revoke all on function public.space_link_spawn_for(uuid) from public;
grant execute on function public.space_link_spawn_for(uuid) to tm8_app;

-- Never-analyzed tables are estimated at 10 pages (225); 229/260/261 precedent.
analyze public.space_link_spawns;

reset role;
