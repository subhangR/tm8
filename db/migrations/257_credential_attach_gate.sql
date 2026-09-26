-- =============================================================================
-- 257 (set at the merge position after #898's 256; was placeholder 997) — the private-credential attach
-- gate, W10c (task 01a0da8c, doc 13 01a0da24 §3h / §6a T4, threat review
-- 01a0db1c R2, R9, R16).
--
-- Runs after 239_credential_entities (W10a) and reads its columns, and after
-- 233_space_enter_and_pin, whose consume_stream_attach body §3 carries verbatim.
--
-- THE HOLE (doc 13 §3h). Every agent session belongs to a teammate persona,
-- and 075 lets every active member act as a teammate, so 202's owner right —
-- "may act as the creator" while sharing_set_at is null — let any member of
-- the space view AND drive an agent running on someone else's PRIVATE
-- credential: attach, run `env`, read the key or steer the agent. W3-audit
-- recorded it as "current behaviour (closed by W10c)".
--
-- THE RULE. A session is ON A PRIVATE CREDENTIAL when any row of
-- session_space_credentials for it joins a space_credentials row whose
-- visibility is 'private' (read live, so a switch to private applies on the
-- next check). For such a session the caller must be the credential's owner:
-- the active account whose identity_id is the caller's tm8.identity_id claim.
-- Two private credentials with different owners admit nobody. Creator, act-as
-- (075), share_mode/drive_mode and space admin are NOT consulted.
--
-- Every predicate reads the claim INLINE as a current_setting literal and
-- joins session_space_credentials to space_credentials in the same predicate;
-- no nested SQL function decides it.
--
-- WHAT LANDS.
--   1. grant_stream_attach (202 §2's body): the private-credential gate runs
--      before the view and drive dials, for both modes, and replaces them.
--   2. set_work_session_sharing (202 §3's body): the credential owner may set
--      either dial; creator, act-as and admin keep 202's authority but may only
--      narrow — any write that would store 'space' where it was not is refused.
--      A private-credential session never materialises 075's posture on its
--      first write (075's hold never applied to it).
--   3. consume_stream_attach (233's body: 087's plus the session-space pin):
--      a grant is consumed only if its SUBJECT still passes the rule. A grant minted while the card was public
--      dies at the socket-open step once it goes private (R9's unconsumed half).
--   4. public.session_stream_credential_allowed(session): the rule as a boolean
--      for the CALLER, used by the two filesystem read paths (execution.journal,
--      execution.transcript) and by the PTY server's recheck of already-open
--      sockets (R9's open half). Both run as the reader's own claims.
--
-- WHAT DOES NOT CHANGE. RLS (entity metadata stays space-wide, as 187 and
-- doc 13 §3a say); public and space-owned credential sessions (every dial
-- behaves exactly as 202 left it); the grant shape, clamp, replay binding and
-- revocation rule. Graph messages and assignments to the owner's agent stay
-- open by design (doc 13 §3h, §6b).
--
-- ADDITIVE ONLY: function bodies, no row is written by this migration.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. THE ATTACH GATE. 202's body; the private-credential gate is added before
--    the dials, and the two dial branches are skipped for such a session.
-- -----------------------------------------------------------------------------
create or replace function public.grant_stream_attach(
  p_session_id uuid, p_mode text default 'view', p_token_hash text default null,
  p_ttl interval default interval '30 seconds', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  session public.work_sessions;
  identity text;
  grant_row public.stream_grants;
  effective_ttl interval;
  is_creator boolean;
  may_act_as_creator boolean;
  holds_owner_right boolean;
  on_private_credential boolean;
  refused_by_credential boolean;
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
  perform internal.require_space_member(e.space_id);
  identity := internal.identity_id();
  select * into session from public.work_sessions where entity_id = p_session_id;

  if p_mode not in ('view','drive') then
    raise exception 'invalid stream mode' using errcode = '22023';
  end if;

  -- Computed once: it decides BOTH branches and calling it twice invites the two
  -- answers to drift apart the next time one of them is edited.
  is_creator := e.created_by is not distinct from internal.current_member_id(e.space_id);
  may_act_as_creator := is_creator or internal.can_act_as(e.created_by, e.space_id);

  -- THE OWNER RIGHT (202). The creator always holds it. Acting as the creator
  -- under 075 holds it only while no human has configured this session: that
  -- arm is DEFAULT visibility, and a deliberate narrowing outranks a default.
  holds_owner_right := is_creator
                       or (may_act_as_creator and session.sharing_set_at is null);

  -- THE PRIVATE-CREDENTIAL GATE (257, doc 13 §3h). A session that records a
  -- PRIVATE credential is watched and driven by that credential's owner and by
  -- nobody else: "may act as the creator", the share and drive dials and the
  -- admin bit are all ignored for it. Read live from space_credentials, so a
  -- switch to private closes the door on the next dial. Both predicates are
  -- inline, with the identity claim read as a literal current_setting.
  on_private_credential := exists (
      select 1
        from public.session_space_credentials ssc
        join public.space_credentials sc
          on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
       where ssc.work_session_id = p_session_id
         and sc.visibility = 'private');
  if on_private_credential then
    refused_by_credential := exists (
        select 1
          from public.session_space_credentials ssc
          join public.space_credentials sc
            on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
         where ssc.work_session_id = p_session_id
           and sc.visibility = 'private'
           and not exists (
             select 1 from public.accounts a
              where a.id = sc.owner_account_id
                and a.status = 'active'
                and a.identity_id = nullif(btrim(current_setting('tm8.identity_id', true)), '')));
    if refused_by_credential then
      raise exception 'this session runs on a private credential; only its owner may attach'
        using errcode = '42501';
    end if;
  end if;

  -- THE VIEW GATE, which drive must also pass. A session you may not watch is
  -- not one you may type into, so this is checked for both modes and first.
  if not on_private_credential
     and session.share_mode = 'none' and not holds_owner_right then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;

  -- THE DRIVE GATE. Two independent ways in: the owner right above, and
  -- `drive_mode = 'space'`, the explicit grant.
  if p_mode = 'drive'
     and not on_private_credential
     and not holds_owner_right
     and session.drive_mode is distinct from 'space' then
    raise exception 'this session is view-only for you' using errcode = '42501';
  end if;

  insert into public.stream_grants(
    work_session_id, subject_identity, mode, granted_by, token_hash, expires_at
  ) values (
    p_session_id, identity, p_mode, e.created_by, p_token_hash, now() + effective_ttl
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

-- -----------------------------------------------------------------------------
-- 2. The single writer. 202's body plus the owner arm and the no-widening rule.
-- -----------------------------------------------------------------------------
create or replace function public.set_work_session_sharing(
  p_session_id uuid, p_expected_version integer default null,
  p_share_mode text default null, p_drive_mode text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  creator_identity text;
  first_write_via_075 boolean;
  on_private_credential boolean;
  caller_owns_credential boolean;
  old_share text;
  old_drive text;
  new_share text;
  new_drive text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.sessions.share');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_session_id::text, 'entity');
    return replay;
  end if;

  if p_share_mode is null and p_drive_mode is null then
    raise exception 'nothing to change: name share_mode, drive_mode, or both'
      using errcode = '22023';
  end if;
  -- 'explicit' stays unwritable — see 187 §5.
  if p_share_mode is not null and p_share_mode not in ('none','space') then
    raise exception 'unknown share_mode: %', p_share_mode using errcode = '22023';
  end if;
  if p_drive_mode is not null and p_drive_mode not in ('owner','space') then
    raise exception 'unknown drive_mode: %', p_drive_mode using errcode = '22023';
  end if;

  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  -- 257 (doc 13 §3h). On a session recording a PRIVATE credential the
  -- credential's owner may change either dial, and holds that right even
  -- without 202's creator / act-as / admin arms. Everyone else keeps exactly
  -- the authority 202 gave them, but may only NARROW: a widening by the
  -- creator, anyone acting as the creator, or a space admin is refused below,
  -- once the resulting dials are known.
  on_private_credential := exists (
      select 1
        from public.session_space_credentials ssc
        join public.space_credentials sc
          on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
       where ssc.work_session_id = p_session_id
         and sc.visibility = 'private');
  caller_owns_credential := on_private_credential and not exists (
      select 1
        from public.session_space_credentials ssc
        join public.space_credentials sc
          on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
       where ssc.work_session_id = p_session_id
         and sc.visibility = 'private'
         and not exists (
           select 1 from public.accounts a
            where a.id = sc.owner_account_id
              and a.status = 'active'
              and a.identity_id = nullif(btrim(current_setting('tm8.identity_id', true)), '')));

  if not caller_owns_credential
     and e.created_by is distinct from internal.current_member_id(e.space_id)
     and not internal.can_act_as(e.created_by, e.space_id)
     and not internal.is_space_admin(e.space_id) then
    raise exception 'only the session owner or a space admin may change its sharing'
      using errcode = '42501';
  end if;

  if p_expected_version is not null then
    perform internal.assert_version(p_session_id, p_expected_version);
  end if;

  -- Is this the write that ends 075's hold on the session? True exactly when
  -- the row is unconfigured AND its creator is a live teammate of this space —
  -- the teammate arm of `internal.can_act_as`, stated about the session rather
  -- than about a viewer. (Every caller who reaches this line is an active
  -- member, which is that arm's other half.) A deleted persona is excluded
  -- because 075 excludes it: its 'none' already meant nobody, and treating it
  -- as 'space' here would be the widening this migration must not do.
  -- 075's hold never applied to a private-credential session (the gate
  -- ignores act-as there), so there is no effective posture to materialise:
  -- the dial not named stays as stored.
  select ws.sharing_set_at is null
         and not on_private_credential
         and exists (
           select 1
             from public.team_members t
             join public.entities te on te.id = t.entity_id
            where t.entity_id = e.created_by
              and te.space_id = e.space_id
              and te.deleted_at is null
         )
         , ws.share_mode, ws.drive_mode
    into first_write_via_075, old_share, old_drive
    from public.work_sessions ws
   where ws.entity_id = p_session_id
     for update;

  new_share := coalesce(p_share_mode,
                        case when first_write_via_075 then 'space' else old_share end);
  new_drive := coalesce(p_drive_mode,
                        case when first_write_via_075 then 'space' else old_drive end);

  -- NO WIDENING BUT THE OWNER'S. Evaluated after the row lock, against the
  -- dials this write would store. No creator, act-as or admin override.
  if on_private_credential and not caller_owns_credential
     and ((new_share = 'space' and old_share is distinct from 'space')
          or (new_drive = 'space' and old_drive is distinct from 'space')) then
    raise exception 'this session runs on a private credential; only its owner may widen its sharing'
      using errcode = '42501';
  end if;

  perform set_config('tm8.work_session_sharing_write', 'on', true);
  update public.work_sessions
     set share_mode = new_share,
         drive_mode = new_drive,
         sharing_set_at = now(),
         updated_at = now()
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_sharing_write', 'off', true);

  -- THE ENVELOPE, NOT JUST THE DETAIL ROW — 187 §5, unchanged: `entity.upsert`
  -- has one source (`entities_capture_event`, 003:385), and a version that
  -- cannot advance makes `p_expected_version` inert. 107:88-90's idiom.
  update public.entities
     set version = version + 1, updated_at = now()
   where id = p_session_id;

  -- REVOKE LIVE GRANTS ON NARROWING — 187 §5's rule, unchanged: the CREATOR'S
  -- grants survive and nobody else's do. A teammate-created session resolves to
  -- no identity here, so every grant is revoked.
  --
  -- Until 202 that was churn on a teammate session: every member re-minted on
  -- the next dial through 075. It is now the close it looks like, because the
  -- stamp above ends 075's hold and `grant_stream_attach` refuses the re-mint.
  if p_share_mode = 'none' or p_drive_mode = 'owner' then
    select m.identity_id into creator_identity
      from public.members m where m.entity_id = e.created_by;

    update public.stream_grants g
       set revoked_at = now()
     where g.work_session_id = p_session_id
       and g.revoked_at is null
       and (p_share_mode = 'none' or g.mode = 'drive')
       and (creator_identity is null
            or g.subject_identity is distinct from creator_identity);
  end if;

  return internal.ledger_record(p_client_mutation_id, 'execution.sessions.share',
           internal.command_result(p_session_id, null,
             internal.record_activity(e.space_id, p_session_id, actor, 'updated',
               null, jsonb_build_object('kind', 'work_session')),
             array[p_session_id]));
end
$$;

comment on function public.set_work_session_sharing(uuid, integer, text, text, uuid, text) is
  'Sets one work session''s share_mode/drive_mode and stamps sharing_set_at, its sole '
  'writer. Owner, an actor who can_act_as the owner, or a space admin; on a session '
  'recording a private credential only that credential''s owner may widen (257). '
  'Narrowing revokes other identities'' live grants.';

-- -----------------------------------------------------------------------------
-- 3. Consuming a grant. 233's body VERBATIM (087's plus the session-space
--    pin); the UPDATE also requires the grant's SUBJECT to pass the rule, so every failure still converges on one refusal.
--    The subject, not the claim: the CLI consumes with no identity claim.
--    087 created it as the MIGRATION role, not tm8_graph_owner, so it is
--    replaced under that role and keeps its owner and 087's grants.
-- -----------------------------------------------------------------------------
reset role;

create or replace function public.consume_stream_attach(
  p_session_id uuid,
  p_mode text,
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  claim_identity text := nullif(current_setting('tm8.identity_id', true), '');
  consumed public.stream_grants;
begin
  -- All credential failures deliberately converge on the same branch. In
  -- particular, do not report whether a session, mode, hash, identity, expiry,
  -- pin, already-consumed row or private credential was the part that failed
  -- to match.
  if p_mode not in ('view','drive')
     or p_token_hash is null
     or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  update public.stream_grants
     set revoked_at = now()
   where work_session_id = p_session_id
     and mode = p_mode
     and token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (claim_identity is null or subject_identity = claim_identity)
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or exists (select 1 from public.entities e
                      where e.id = p_session_id
                        and e.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid))
     -- 257: a PRIVATE credential admits only its active owner. The grant's
     -- SUBJECT is checked, not the claim (the CLI consumes with no claim), and
     -- the refusal converges on the same 'stream attach refused' as above.
     and not exists (
       select 1
         from public.session_space_credentials ssc
         join public.space_credentials sc
           on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
        where ssc.work_session_id = p_session_id
          and sc.visibility = 'private'
          and not exists (
            select 1 from public.accounts a
             where a.id = sc.owner_account_id
               and a.status = 'active'
               and a.identity_id = stream_grants.subject_identity))
  returning * into consumed;

  if consumed.id is null then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'subjectIdentity', consumed.subject_identity,
    'mode', consumed.mode,
    'grantId', consumed.id
  );
end
$$;

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 4. The rule as a boolean, for the CALLER. True unless the session records a
--    private credential the caller does not own, AND false for a caller who
--    is not an active member of the session's space (pin honoured, 232's
--    is_space_member). SECURITY DEFINER reads session_space_credentials past
--    RLS, so without the member gate any authenticated caller could probe one
--    deny-only bit per session uuid (review L1). The gate is a boolean, not
--    require_space_member: the PTY recheck logs a RAISE and leaves the socket
--    OPEN (a transient-error path), so raising would fail open there. False
--    fails closed at every caller. It says nothing about the dials.
-- -----------------------------------------------------------------------------
create or replace function public.session_stream_credential_allowed(p_session_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(internal.is_space_member(
           (select e.space_id from public.entities e where e.id = p_session_id)), false)
     and not exists (
    select 1
      from public.session_space_credentials ssc
      join public.space_credentials sc
        on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
     where ssc.work_session_id = p_session_id
       and sc.visibility = 'private'
       and not exists (
         select 1 from public.accounts a
          where a.id = sc.owner_account_id
            and a.status = 'active'
            and a.identity_id = nullif(btrim(current_setting('tm8.identity_id', true)), '')))
$$;

revoke all on function public.session_stream_credential_allowed(uuid) from public;
grant execute on function public.session_stream_credential_allowed(uuid) to tm8_app;

comment on function public.session_stream_credential_allowed(uuid) is
  'False if the caller is not an active member of the session''s space, or if the '
  'session records a private space credential whose owner is not the caller''s '
  'account (257, doc 13 §3h). Read paths outside grant_stream_attach use it.';

reset role;
