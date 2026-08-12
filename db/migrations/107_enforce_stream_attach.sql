-- =============================================================================
-- 107 — enforce the byte paths (2026-08-12).
--
-- This is the first migration that REFUSES anybody. It closes the hole 105
-- documented: today every member of a space can inject keystrokes into any
-- other member's running agent.
--
-- ── THE HOLE, PRECISELY ───────────────────────────────────────────────────
--
-- `grant_stream_attach` (087:63-70) decides both view and drive with
-- `can_act_as(e.created_by, …)`. For an AGENT-launched session `created_by` is
-- a `team_members` row, and 075 widened `can_act_as` so any member of the space
-- may act as any teammate in it — so the drive gate is true for everyone. On the
-- production node 49 of 311 sessions were created by a teammate.
--
-- Which of the two happens is decided by whether the spawner passed an actorId,
-- a distinction no surface exposes, sets deliberately, or documents. Nobody
-- chose this behaviour.
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ──────────────────────────
--
-- `internal.can_act_as` is NOT narrowed. 075 was right for its purpose: about
-- thirty call sites ask it an AUTHORING/ATTRIBUTION/LAUNCH question ("may this
-- identity write as that persona"), and the widening is correct for all of
-- them. Only TWO sites use it as a CONTROL predicate, and only those two move.
-- Narrowing the function itself would touch thirty sites and eight migrations
-- for no security gain and considerable risk.
--
--   087 grant_stream_attach   view arm  → require_session_capability(…, 'watch')
--   087 grant_stream_attach   drive arm → require_session_capability(…, 'drive')
--   074 revoke_agent_auth_session       → require_session_capability(…, 'manage')
--
-- ── THREE FIXES THAT RIDE ALONG ───────────────────────────────────────────
--
--   · `granted_by` recorded `e.created_by` regardless of who actually called,
--     so the column described the session rather than the issuer. It now
--     records the caller, which is what an audit needs.
--   · `share_mode = 'explicit'` is removed from the constraint. It is a footgun:
--     the only guard tested `= 'none'`, so the first writer to set 'explicit'
--     would have silently opened the session to the whole space. Zero rows hold
--     it. The TS union may keep the value — a wire type permitting something the
--     database never emits is harmless.
--   · `stream_grants` had a table-wide select grant to `tm8_app` and a policy
--     arm letting ANY space member read the live `token_hash` of any grant on
--     any session in their space. There is exactly one `stream_grants` mention
--     in TypeScript and it is a comment, so the grant is revoked outright rather
--     than narrowed — a revoked grant cannot be re-opened by a policy edit.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.grant_stream_attach(
  p_session_id uuid, p_mode text default 'view', p_token_hash text default null,
  p_ttl interval default interval '30 seconds', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  identity text;
  issuer uuid;
  grant_row public.stream_grants;
  effective_ttl interval;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid stream grant credential' using errcode = '22023';
  end if;

  effective_ttl := least(
    greatest(coalesce(p_ttl, interval '30 seconds'), interval '1 second'),
    interval '60 seconds'
  );

  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.streams.attach');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{grant,work_session_id}', p_session_id::text, 'work session');
    perform internal.require_replay_subject(
      replay #>> '{grant,mode}', coalesce(p_mode, 'view'), 'stream mode');
    return replay;
  end if;

  e := internal.live_entity(p_session_id, 'work_session');
  identity := internal.identity_id();

  if p_mode not in ('view','drive') then
    raise exception 'invalid stream mode' using errcode = '22023';
  end if;

  -- THE CHANGE. The ladder decides, and it already accounts for the owner,
  -- space admins, delegations and the `share_mode = 'space'` broadcast floor —
  -- so the three separate conditions this replaces collapse into one question
  -- asked in one place.
  --
  -- Note there is no `require_space_member` here any more: it would refuse a
  -- cross-space delegate, who is deliberately NOT a member. `session_capability`
  -- is the complete answer, and returning null for a caller with no standing is
  -- what makes dropping the outer gate safe.
  if p_mode = 'view' then
    perform internal.require_session_capability(p_session_id, 'watch');
  else
    perform internal.require_session_capability(p_session_id, 'drive');
  end if;

  -- Whoever actually asked, not whoever spawned the session.
  issuer := internal.current_member_id(e.space_id);

  insert into public.stream_grants(
    work_session_id, subject_identity, mode, granted_by, token_hash, expires_at
  ) values (
    p_session_id, identity, p_mode, coalesce(issuer, e.created_by), p_token_hash, now() + effective_ttl
  )
  on conflict (work_session_id, subject_identity, mode) where revoked_at is null
  do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at
  returning * into grant_row;

  return internal.ledger_record(
    p_client_mutation_id,
    'execution.streams.attach',
    jsonb_build_object('grant', to_jsonb(grant_row) - 'token_hash', 'patches', '[]'::jsonb)
  );
end
$$;

-- The second control-predicate call site.
create or replace function public.revoke_agent_auth_session(p_work_session_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not exists (select 1 from public.auth_sessions s
                  where s.work_session_id = p_work_session_id and s.kind = 'agent') then
    return;
  end if;
  perform internal.require_session_capability(p_work_session_id, 'manage');
  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id
     and kind = 'agent'
     and revoked_at is null;
end
$$;

-- -----------------------------------------------------------------------------
-- The three ride-alongs.
-- -----------------------------------------------------------------------------
alter table public.work_sessions drop constraint if exists work_sessions_share_mode_check;
alter table public.work_sessions
  add constraint work_sessions_share_mode_check check (share_mode in ('none','space'));

drop policy if exists stream_grants_select on public.stream_grants;
revoke select on public.stream_grants from tm8_app;

comment on table public.stream_grants is
  'Single-use, <=60s WebSocket attach capabilities. NOT readable by tm8_app: the '
  'row carries a live token_hash and had a policy letting any space member read '
  'any grant in their space. If a "who is watching" surface is ever wanted it is '
  'a definer read that never selects token_hash, not a re-opened grant.';

-- -----------------------------------------------------------------------------
-- What the UI needs in order to be honest BEFORE it is refused.
--
-- `LiveTerminal.readOnly` currently derives from LIVENESS alone. Enforcing the
-- ladder without giving the client a way to know its level produces the one
-- genuinely bad outcome available here: a locally writable terminal whose
-- keystrokes are silently dropped at the socket. This read is what lets the
-- client grey the input out instead.
-- -----------------------------------------------------------------------------
create or replace function public.session_access(p_session_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  lvl text;
  e public.entities;
  ws public.work_sessions;
  via text;
begin
  perform internal.require_identity();
  lvl := internal.session_capability(p_session_id);
  if lvl is null then
    return jsonb_build_object('level', null, 'via', null);
  end if;
  select * into e from public.entities where id = p_session_id;
  select * into ws from public.work_sessions where entity_id = p_session_id;

  -- Provenance, so a reader can tell WHY they may act — an audit surface and a
  -- UI affordance, not an authorization input.
  if internal.current_member_id(e.space_id) is not distinct from ws.owner_member_id then
    via := 'owner';
  elsif internal.is_space_admin(e.space_id) then
    via := 'space_admin';
  elsif exists (select 1 from public.session_delegations d
                 where d.grantor_member_id = ws.owner_member_id
                   and d.revoked_at is null
                   and (d.expires_at is null or d.expires_at > now())
                   and d.subject_identity_id = internal.identity_id()) then
    via := 'delegation';
  else
    via := 'share_mode';
  end if;
  return jsonb_build_object('level', lvl, 'via', via);
end
$$;

revoke all on function public.session_access(uuid) from public;
grant execute on function public.session_access(uuid) to tm8_app;

reset role;
