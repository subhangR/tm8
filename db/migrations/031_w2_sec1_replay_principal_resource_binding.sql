-- =============================================================================
-- 031 W2.SEC-1 — a command-ledger replay may not be returned to the wrong
--                PRINCIPAL, nor to a request that addresses a different
--                RESOURCE.
--
-- THE LAW THIS MIGRATION STATES AND ENFORCES
--
--   A stored replay may be returned only when BOTH hold:
--     1. the requesting principal is the one that recorded it, and
--     2. the replay's stored subject is the resource the current request
--        ADDRESSES.
--
-- WHAT THIS FILE SUPERSEDES (forward-only; the originals are left byte-identical
-- because db/migrate.mjs checksums every applied migration and hard-fails on
-- drift — "A migration is immutable once applied. Add a new file"):
--
--   * public.w2_update_space      supersedes 016_w2_identity_spaces.sql:72
--   * public.join_public_space    supersedes 007_rpc_catalog.sql:541
--   * public.redeem_invite        supersedes 007_rpc_catalog.sql:617
--   * public.grant_stream_attach  supersedes 007_rpc_catalog.sql:2183
--   * public.set_space_default_channel
--                                 supersedes 029_w2_menu_default_channel.sql:550
--   * public.update_space_menu    supersedes 029_w2_menu_default_channel.sql:408
--
-- Read those six sites together with this file: the text still in 016, 007 and
-- 029 is the VULNERABLE version and is no longer live once this migration is
-- applied.
--
-- THE DEFECT
--
--   internal.ledger_replay (live definition 016_w2_identity_spaces.sql:17)
--   resolves a replay with
--
--       select * into ledger_row from public.command_ledger
--        where client_mutation_id = p_cmid;
--
--   There is NO identity, actor, Space, or input predicate. The only guard is an
--   operation-label comparison. Each of the six RPCs above returned that stored
--   projection BEFORE running its authorization, which produced two independent
--   failures:
--
--     (a) CROSS-PRINCIPAL DISCLOSURE. A caller supplying another principal's
--         clientMutationId received that principal's stored result. For
--         w2_update_space that is the whole Space projection — name,
--         description, github_repo, visibility, created_by_identity,
--         default_channel_id, settings_revision and the viewer-relative
--         unread_total — with no Space membership required at all. For
--         join_public_space / redeem_invite it is another user's member entity,
--         including their identity_id and display_name.
--
--     (b) RESOURCE CONFUSION, which principal-pinning alone does NOT catch
--         because the principals match. The W3 gate proved this through the real
--         HTTP boundary: PATCH /v2/spaces/{B} replaying Space A's
--         clientMutationId returned Space A's id and projection with status 200
--         and error null. The operation label cannot see it — both calls are
--         'spaces.update'.
--
--   A third shape, independent of both: public.join_public_space and
--   public.redeem_invite SHARE the operation string 'spaces.invites.redeem', so
--   a cmid recorded by one replays through the OTHER without tripping the
--   operation-label mismatch check at all. Binding (2) is what closes that.
--
-- WHY THIS CANNOT BE SOLVED BY MAKING cmids SECRET
--
--   clientMutationId is a correlation identifier, NOT a capability: the frozen
--   dossier mandates message_batch_id = clientMutationId and handoffId =
--   clientMutationId and publishes both in read DTOs. No authorization decision
--   may depend on a cmid's secrecy, so neither binding below does.
--
-- PRIOR ART THIS FOLLOWS RATHER THAN INVENTS
--
--   023_w2_inbox.sql:102-107 and :189-194 already do exactly this, as a
--   PRE-CHECK that reads public.command_ledger directly BEFORE calling
--   internal.ledger_replay, raising 23514 'clientMutationId belongs to another
--   principal'; and inside the replay branch they additionally compare the
--   stored subject ('clientMutationId belongs to another read anchor' /
--   'another notification recipient'). 019_w2_messages_handoffs.sql:388-397
--   compares an identity-salted _stableHash, which is the same idea. This
--   migration promotes that pattern to a shared helper and applies it to the
--   six sites above. No new error code and no new DTO field is introduced:
--   23514 with a 'belongs to another <subject>' message is the existing frozen
--   shape.
--
-- ONE DELIBERATE DEPARTURE FROM 023
--
--   023 compares actor_id EXACTLY as well as identity_id. This migration pins on
--   identity_id ONLY. Adopting the actor half everywhere would raise 23514
--   instead of replaying in legitimate cases — a retry with a different Teammate
--   selected, or a background retry with no tm8.actor_id bound. None of the six
--   sites needs an actor component to be safe: each one's resource binding
--   already constrains what a same-identity replay can reach, and sites 5 and 6
--   are additionally covered by 029's own refusal of non-human principals. Where an actor
--   component is genuinely wanted in future, the safe form is actor match OR
--   internal.can_act_as(ledger_actor, space) — never exact equality.
--
-- ⚠ WHY THE PRINCIPAL PIN IS CALLED TWICE — A TOCTOU RACE, PROVED NOT ARGUED
--
--   internal.ledger_replay (016:17) takes pg_advisory_xact_lock on the cmid at
--   its OWN line 10 and selects the ledger row at line 12. So a principal check
--   placed BEFORE the ledger_replay call runs with NO LOCK HELD:
--
--     1. victim A is mid-transaction on cmid X; its ledger row is written but
--        NOT COMMITTED, and A holds the advisory lock;
--     2. attacker B's pre-check selects, finds nothing, and concludes "first use
--        of this cmid: nothing to pin" — NO PIN IS APPLIED;
--     3. B blocks inside ledger_replay on A's advisory lock;
--     4. A commits; B acquires the lock, re-selects, NOW finds A's row, and the
--        operation label matches;
--     5. B is handed A's stored result. The identity comparison never ran.
--
--   The resource binding does not rescue this — it asserts only that the caller
--   ADDRESSED the same resource, and an attacker simply names the victim's
--   resource. On the replay path require_space_admin is never reached, so under
--   the race the principal pin is the ONLY barrier and it is the one skipped.
--
--   Measured, not reasoned: a non-member racing a victim's uncommitted row
--   received the victim's entire Space projection while every sequential test
--   still passed.
--
--   THE FIX IS THE ORDERING. The pin is called in BOTH places. The call INSIDE
--   the replay branch is the security boundary: it runs after ledger_replay has
--   taken the lock, so the check and the read are under the same lock and there
--   is no check-then-act window. The call before ledger_replay is retained only
--   as a fast path that fails the common sequential case early.
--
--   THIS SHAPE WAS INHERITED. 023:102-109 and 023:189-196 — the reference this
--   migration was asked to follow — place their pin before the lock in exactly
--   the same way, as does 019:1136. Fixing it here does not fix it there; the
--   durable remedy is to move the principal comparison inside ledger_replay
--   itself, where the lock is already held, which is tracked separately as 032.
--
-- WHY THE GUARD CANNOT MISFIRE ON A CONCURRENT FIRST ATTEMPT
--
--   016:17 replaced 012's reserve-by-INSERT with an advisory lock plus a SELECT,
--   so a command_ledger row exists ONLY after internal.ledger_record runs at the
--   bottom of a successful call. Any row this guard finds is therefore a
--   COMPLETED command with a recorded principal — there are no in-flight
--   reservations to false-positive on.
--
-- OBJECTS: creates two new internal.* functions and replaces six existing
-- public.* functions in place. It ALTERS, CONSTRAINS and SHADOWS nothing that
-- 001-030 define or write through: no table, column, index, trigger, policy,
-- type, grant or revoke. create-or-replace preserves the six functions'
-- existing ACLs, including 016's revoke-from-public / grant-to-tm8_app on
-- w2_update_space and 029:679-680's revokes on the two Space-settings RPCs.
--
-- IDEMPOTENCY IS PRESERVED, NOT TRADED AWAY: the original recorder replaying its
-- own cmid against the same addressed resource still receives the identical
-- stored result and still causes no second effect.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- The law, part 1: a replay belongs to the principal that recorded it.
--
-- A PRE-CHECK, called BEFORE internal.ledger_replay, so it composes ahead of an
-- existing function body without having to reason about where that body's early
-- returns are. This is the structure 023 uses.
--
-- SECURITY INVOKER on purpose, matching internal.ledger_replay: every caller is
-- already a SECURITY DEFINER RPC owned by tm8_graph_owner, so the read of
-- command_ledger happens as the owner. Making it DEFINER would add a privileged
-- entry point for no benefit.
--
-- A blank or absent cmid means "no idempotency was requested", which is the
-- contract at 016:22 and 012:126, so there is nothing to pin.
-- -----------------------------------------------------------------------------
-- VOLATILE (the default), matching internal.ledger_replay rather than the STABLE
-- authorization guards: this reads a table that mutates within the transaction,
-- so it must not be given a stale snapshot.
create or replace function internal.require_replay_principal(p_cmid text)
returns void language plpgsql
set search_path = public, internal, pg_temp as $$
declare ledger_identity text;
begin
  if p_cmid is null or btrim(p_cmid) = '' then
    return;
  end if;

  select identity_id into ledger_identity
    from public.command_ledger
   where client_mutation_id = p_cmid;
  if not found then
    return;                              -- first use of this cmid: nothing to pin
  end if;

  if ledger_identity is distinct from internal.identity_id() then
    raise exception 'clientMutationId belongs to another principal'
      using errcode = '23514',
            detail = 'a replay may not be returned to a principal other than the one that recorded it (W2.SEC-1)';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The law, part 2: a replay belongs to the resource it was recorded against.
--
-- Called INSIDE the replay branch, because it needs the stored projection.
-- p_subject names the addressed thing in the raised message, following 023's
-- 'clientMutationId belongs to another read anchor' / 'another notification
-- recipient' wording.
--
-- `is distinct from` rather than `<>` so that a stored NULL subject cannot pass
-- the comparison by accident: a replay whose subject cannot be established is
-- refused, not returned.
-- -----------------------------------------------------------------------------
create or replace function internal.require_replay_subject(
  p_stored text, p_addressed text, p_subject text
) returns void language plpgsql immutable as $$
begin
  if p_stored is distinct from p_addressed then
    raise exception 'clientMutationId belongs to another %', p_subject
      using errcode = '23514',
            detail = 'a replay may not be returned to a request that addresses a different resource than the one it was recorded against (W2.SEC-1)';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 1 — public.w2_update_space / spaces.update.
-- Supersedes 016_w2_identity_spaces.sql:72. The bare
-- `if replay is not null then return replay; end if;` at 016:83-84 ran a full 30
-- lines before internal.require_space_admin at 016:113, so membership was not
-- required at all. Body below is 016's verbatim, with the two guards added and
-- nothing else changed.
--
-- Is cross-principal replay ever legitimate here? NO. This is a Space-admin
-- metadata PATCH: it authorizes with internal.require_space_admin and attributes
-- with internal.resolve_actor(internal.actor_id(), ...). There is no delivery
-- adapter, worker role or system principal on this path — tm8_delivery_worker's
-- grants (019:1355-1357) do not include it — and no in-repo caller invokes it
-- nested with another principal's cmid. Pinning it removes no real behaviour.
-- -----------------------------------------------------------------------------
create or replace function public.w2_update_space(
  p_space_id uuid,
  p_patch jsonb,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space_row public.spaces;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{space,id}', p_space_id::text, 'space');
    return replay;
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'Space metadata patch must be a non-empty object'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) patch_key
     where patch_key not in ('name', 'description', 'githubRepo')
  ) then
    raise exception 'Space metadata patch contains an unknown field'
      using errcode = '22023';
  end if;
  if p_patch ? 'name' and (
       jsonb_typeof(p_patch -> 'name') <> 'string'
       or char_length(btrim(p_patch ->> 'name')) not between 1 and 200
  ) then
    raise exception 'Space name must contain 1 to 200 characters'
      using errcode = '22023';
  end if;
  if p_patch ? 'description' and jsonb_typeof(p_patch -> 'description') <> 'string' then
    raise exception 'Space description must be a string'
      using errcode = '22023';
  end if;
  if p_patch ? 'githubRepo'
     and jsonb_typeof(p_patch -> 'githubRepo') not in ('string', 'null') then
    raise exception 'githubRepo must be a string or null'
      using errcode = '22023';
  end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  update public.spaces
     set name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
         description = case
           when p_patch ? 'description' then p_patch ->> 'description'
           else description
         end,
         github_repo = case
           when p_patch ? 'githubRepo' then p_patch ->> 'githubRepo'
           else github_repo
         end
   where id = p_space_id
   returning * into space_row;
  if space_row.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'space', to_jsonb(space_row) || jsonb_build_object(
      'member_count', (select count(*) from public.members where space_id = p_space_id),
      'unread_total', coalesce((
        select sum(unread) from public.unread_counts(p_space_id)
      ), 0)
    ),
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 2 — public.grant_stream_attach / execution.streams.attach.
-- Supersedes 007_rpc_catalog.sql:2183. The replay returned at 007:2195, two
-- lines before internal.require_space_member at 007:2197.
--
-- Two subjects are bound, not one. work_session_id is the addressed resource,
-- and `mode` is part of the grant's own uniqueness key
-- (on conflict (work_session_id, subject_identity, mode)), so a 'view' replay
-- answering a 'drive' request handed back a grant the caller never asked for
-- while reporting success.
--
-- Is cross-principal replay ever legitimate here? NO, and this one got the most
-- care because it is an execution-surface grant. The grant's subject_identity is
-- baked from internal.identity_id() at record time, so the stored row is a
-- capability naming the RECORDER. Returning it to a different identity is not
-- merely disclosure of session and grant metadata — it tells the caller it holds
-- an attach grant that does not exist for it. There is no system or adapter
-- principal that attaches on a user's behalf: the PTY-facing worker role
-- tm8_delivery_worker is granted only the three reserve/claim/settle delivery
-- functions (019:1355-1357), not this one.
--
-- An actor component was considered and deliberately NOT added: this function
-- takes no actor argument and derives nothing from internal.actor_id(), so an
-- exact actor comparison would refuse a legitimate retry that happened to carry
-- a different Teammate claim while adding no protection the identity pin and the
-- two subject bindings do not already give.
-- -----------------------------------------------------------------------------
create or replace function public.grant_stream_attach(
  p_session_id uuid, p_mode text default 'view', p_token_hash text default null,
  p_ttl interval default interval '15 minutes', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  session public.work_sessions;
  identity text;
  grant_row public.stream_grants;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.streams.attach');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
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

  -- view: space share mode or explicit membership in the space.
  if session.share_mode = 'none' and e.created_by is distinct from internal.current_member_id(e.space_id)
     and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;
  -- drive: input into somebody's live shell. v1 grants it to the spawner only.
  if p_mode = 'drive' and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'drive access is limited to the spawning owner in v1' using errcode = '42501';
  end if;

  insert into public.stream_grants(work_session_id, subject_identity, mode, granted_by,
                                   token_hash, expires_at)
  values (p_session_id, identity, p_mode, e.created_by, p_token_hash,
          now() + coalesce(p_ttl, interval '15 minutes'))
  on conflict (work_session_id, subject_identity, mode) where revoked_at is null
  do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at
  returning * into grant_row;

  return internal.ledger_record(p_client_mutation_id, 'execution.streams.attach',
           jsonb_build_object('grant', to_jsonb(grant_row) - 'token_hash', 'patches', '[]'::jsonb));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 3 — public.join_public_space / spaces.invites.redeem.
-- Supersedes 007_rpc_catalog.sql:541; the replay returned at 007:569.
--
-- Is cross-principal replay ever legitimate here? NO. The stored result is the
-- CALLER's own membership — spaceId, memberId, joined, and a member-entity patch
-- carrying that member's identity_id and display_name. Handing it to a second
-- identity both discloses the first user's member record and tells the second it
-- joined a Space it did not join. Nothing joins a Space on another principal's
-- behalf.
-- -----------------------------------------------------------------------------
create or replace function public.join_public_space(p_space_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  target public.spaces;
  member_id uuid;
  existed boolean;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Also closes the shared-operation-string crossing: a redeem_invite cmid
    -- carries the invite's Space, which will not match the Space addressed here
    -- unless it is genuinely the same Space.
    perform internal.require_replay_subject(
      replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  identity := internal.require_identity();
  select * into target from public.spaces where id = p_space_id;
  if target.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select entity_id into member_id from public.members
   where space_id = p_space_id and identity_id = identity;
  existed := member_id is not null;
  if not existed then
    if target.visibility <> 'public' then
      raise exception 'space is not public' using errcode = '42501';
    end if;
    member_id := internal.attach_member(p_space_id, identity, 'member');
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 4 — public.redeem_invite / spaces.invites.redeem.
-- Supersedes 007_rpc_catalog.sql:617; the replay returned at 007:657.
--
-- This one addresses its resource by p_code, and the stored result carries
-- spaceId but NOT the code. Binding exactly on the code would require adding a
-- field to a frozen result DTO, which is out of scope, so the code is resolved to
-- its Space and that is compared instead.
--
-- The lookup is deliberately NON-RAISING and deliberately takes NO row lock. If
-- the invite has since been revoked, expired, exhausted or deleted, a legitimate
-- retry must still replay — a stricter binding would turn a successful
-- idempotent retry into a failure the moment the invite's lifecycle moved on.
-- When the code cannot be resolved at all the binding is skipped and the
-- principal pin is the only guard, which is the same protection the other three
-- sites' cross-principal case gets.
--
-- RESIDUAL, stated plainly: because the binding is Space-granular rather than
-- code-granular, a caller who holds BOTH another principal's cmid AND a valid
-- code for the SAME Space that cmid was recorded against is not stopped by
-- binding (2) — but that caller is stopped by binding (1), the principal pin,
-- which fires first. The two bindings only overlap for the SAME principal, where
-- the remaining case is a caller replaying its own membership result against a
-- second code for a Space it is already a member of. That is effect-equivalent
-- to the real call: redeem_invite's `existed` branch neither increments
-- use_count nor notifies for an existing member, so nothing is consumed and
-- nothing is disclosed that is not already the caller's own.
--
-- Is cross-principal replay ever legitimate here? NO — same reasoning as site 3.
-- Noted for Stage 2 and NOT changed here: spaces.invites.create/revoke store
-- to_jsonb(space_invites), which INCLUDES the invite `code`, and this function
-- consumes exactly that code to grant membership. That makes the invite family a
-- cmid-to-membership escalation path rather than mere disclosure, and it is why
-- the principal pin on this site matters more than its disclosure surface alone
-- suggests.
-- -----------------------------------------------------------------------------
create or replace function public.redeem_invite(p_code text, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  invite public.space_invites;
  member_id uuid;
  existed boolean;
  result jsonb;
  addressed_space uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    select space_id into addressed_space
      from public.space_invites where code = p_code;
    if addressed_space is not null then
      perform internal.require_replay_subject(
        replay ->> 'spaceId', addressed_space::text, 'space');
    end if;
    return replay;
  end if;
  identity := internal.require_identity();
  -- Lock the invite row: max_uses is a real limit, not a hint, so two
  -- simultaneous redemptions of a single-use code cannot both win.
  select * into invite from public.space_invites where code = p_code for update;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if invite.revoked_at is not null then
    raise exception 'invite was revoked' using errcode = '42501';
  end if;
  if invite.expires_at is not null and invite.expires_at < now() then
    raise exception 'invite has expired' using errcode = '42501';
  end if;

  select entity_id into member_id from public.members
   where space_id = invite.space_id and identity_id = identity;
  existed := member_id is not null;
  if not existed then
    if invite.use_count >= invite.max_uses then
      raise exception 'invite is exhausted' using errcode = '53400';
    end if;
    member_id := internal.attach_member(invite.space_id, identity, 'member');
    update public.space_invites set use_count = use_count + 1 where id = invite.id;
    perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                            jsonb_build_object('inviteId', invite.id));
  end if;
  result := jsonb_build_object('spaceId', invite.space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;


-- -----------------------------------------------------------------------------
-- SITE 5 — public.set_space_default_channel / spaces.defaultChannel.set.
-- Supersedes 029_w2_menu_default_channel.sql:550.
--
-- THIS SITE WAS ORIGINALLY SCORED SAFE, AND THAT SCORING WAS WRONG. The shape at
-- 029:564-566 is:
--
--     replay := internal.ledger_replay(p_client_mutation_id, 'spaces.defaultChannel.set');
--     perform internal.w2_require_human_space_admin(p_space_id);
--     if replay is not null then return replay; end if;
--
-- The authorization guard IS before the return, which is exactly why it reads as
-- safe. But internal.w2_require_human_space_admin (029:276) resolves
-- internal.current_member_id(p_space_id) and checks members.role for the
-- CALLER-SUPPLIED ROUTE ARGUMENT. It never looks at the ledger row, the stored
-- jsonb, or the cmid. So a caller who is owner/admin of their OWN Space names
-- that Space, passes the guard honestly, and receives the VICTIM Space's stored
-- settings view — taskAxes, menu, invites (including invite CODES), members,
-- defaultChannelId, defaultInteractionProfileId and settingsRevision.
--
-- Ordering was never the test. WHAT THE GUARD IS BOUND TO is the test, and that
-- is precisely why the law here is two-part.
--
-- The existing route-argument guard is KEPT. It correctly enforces that the
-- caller is a human owner/admin somewhere; it is simply not a replay defence.
--
-- Two subjects are bound: the Space the stored view describes, and the default
-- channel the request asks for (a same-principal replay must not answer "set
-- channel X" with a view showing channel Y). `is distinct from` makes the
-- explicit no-feed null state compare correctly on both sides.
--
-- Is cross-principal replay ever legitimate here? NO. w2_require_human_space_admin
-- explicitly REFUSES a non-human principal (internal.acting_as() is not null
-- raises 42501), so there is no adapter or agent path here by construction.
-- Pinned on identity_id only: that same guard already constrains the actor
-- dimension, so layering 023's exact actor_id equality on top would add nothing
-- and would refuse legitimate retries that carry a different or absent actor
-- claim.
-- -----------------------------------------------------------------------------
create or replace function public.set_space_default_channel(
  p_space_id uuid,
  p_channel_id uuid,
  p_expected_settings_revision integer,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space_row public.spaces;
  channel_entity public.entities;
  result jsonb;
  event_effect jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.defaultChannel.set');
  perform internal.w2_require_human_space_admin(p_space_id);
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{space,id}', p_space_id::text, 'space');
    perform internal.require_replay_subject(
      replay ->> 'defaultChannelId', p_channel_id::text, 'default channel');
    return replay;
  end if;

  if p_client_mutation_id is null or btrim(p_client_mutation_id) = ''
     or p_expected_settings_revision is null or p_expected_settings_revision < 1 then
    raise exception 'invalid default-channel command envelope' using errcode = '22023';
  end if;

  select * into space_row from public.spaces where id = p_space_id for update;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if space_row.settings_revision <> p_expected_settings_revision then
    raise exception 'Space settings revision conflict' using errcode = '40001',
      detail = jsonb_build_object('currentRevision', space_row.settings_revision)::text;
  end if;

  if p_channel_id is not null then
    select * into channel_entity
      from public.entities
     where id = p_channel_id
     for update;
    if channel_entity.id is null
       or channel_entity.kind <> 'channel'
       or channel_entity.space_id <> p_space_id
       or channel_entity.deleted_at is not null
       or not internal.entity_readable(p_channel_id) then
      raise exception 'channel not found' using errcode = 'P0002';
    end if;
  end if;

  if space_row.default_channel_id is distinct from p_channel_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces
       set default_channel_id = p_channel_id,
           settings_revision = settings_revision + 1
     where id = p_space_id
     returning * into space_row;
    perform internal.w1_set_writer(null);
    event_effect := jsonb_build_object(
      'type', 'space.default_channel.updated',
      'channelId', p_channel_id,
      'settingsRevision', space_row.settings_revision
    ) || case when p_client_mutation_id is null then '{}'::jsonb else
      jsonb_build_object('clientMutationId', p_client_mutation_id) end;
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (
      p_space_id,
      internal.next_event_seq(p_space_id),
      'space.default_channel.updated',
      event_effect,
      p_client_mutation_id
    );
  end if;

  result := internal.w2_space_settings_view(p_space_id);
  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.defaultChannel.set',
    result
  );
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 6 — public.update_space_menu / spaces.menu.update.
-- Supersedes 029_w2_menu_default_channel.sql:408. Byte-identical in shape to
-- site 5 at 029:424-426, and leaks the full rendered Space menu.
--
-- ⚠ THE RESOURCE BINDING HERE IS WEAKER THAN THE OTHER FIVE, AND DELIBERATELY SO.
-- This site's stored projection is jsonb_build_object('menu', menu_result), and
-- internal.w2_render_menu (029:205) returns only {schemaVersion, revision,
-- groups}. IT CARRIES NO SPACE IDENTITY AT ALL. There is therefore no stored
-- subject to compare p_space_id against, and the two ways to manufacture one are
-- both worse than the gap:
--
--   * adding a spaceId to the stored result would invent a field in a frozen
--     result DTO, which is out of scope here; and
--   * comparing the stored menu against the addressed Space's CURRENT menu is
--     state-dependent — it would refuse a legitimate replay as soon as that
--     Space's menu moved on, trading a real behaviour away to close a narrow gap.
--
-- What IS bound is exact and stateless: both write branches leave the menu at
-- revision = p_expected_revision + 1 (the insert branch requires expected 0 and
-- writes 1; the update branch writes old + 1 having required old = expected). So
-- the stored revision is a precise function of the request's own declared
-- precondition, and a legitimate retry sends the same p_expected_revision and
-- still replays.
--
-- RESIDUAL, stated rather than hidden: the cross-principal case — the attack
-- described at site 5 — IS closed here, by the principal pin. What remains is a
-- SAME-principal crossing between two Spaces the caller administers that both
-- happen to be transitioning from the same menu revision, where the caller would
-- receive the other Space's menu. This is disclosure of the caller's own other
-- Space, not of a foreign one. Closing it properly needs a spaceId in the stored
-- projection, which is a DTO decision above this migration.
--
-- Is cross-principal replay ever legitimate here? NO — same reasoning as site 5:
-- w2_require_human_space_admin refuses any non-human principal outright.
-- -----------------------------------------------------------------------------
create or replace function public.update_space_menu(
  p_space_id uuid,
  p_payload jsonb,
  p_expected_revision integer,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  menu_row public.space_menu_configs;
  normalized_payload jsonb;
  current_menu jsonb;
  menu_result jsonb;
  ledger_result jsonb;
  event_effect jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.menu.update');
  perform internal.w2_require_human_space_admin(p_space_id);
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{menu,revision}', (p_expected_revision + 1)::text, 'menu revision');
    return replay;
  end if;

  if p_client_mutation_id is null or btrim(p_client_mutation_id) = ''
     or p_expected_revision is null or p_expected_revision < 0
     or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ?& array['schemaVersion','groups'])
     or exists (
       select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
        where key_name not in ('schemaVersion','groups')
     )
     or jsonb_typeof(p_payload -> 'schemaVersion') is distinct from 'number'
     or (p_payload ->> 'schemaVersion')::numeric <> 1 then
    raise exception 'MenuConfigPayload must be strict schemaVersion 1'
      using errcode = '22023';
  end if;
  normalized_payload := internal.w2_normalize_menu_payload(
    p_space_id,
    jsonb_build_object('groups', p_payload -> 'groups')
  );

  perform 1 from public.spaces where id = p_space_id for update;
  if not found then raise exception 'Space not found' using errcode = 'P0002'; end if;
  select * into menu_row
    from public.space_menu_configs
   where space_id = p_space_id
   for update;

  if menu_row.space_id is not null and menu_row.schema_version > 1 then
    raise exception 'Menu schema requires a newer client' using errcode = '40001',
      detail = jsonb_build_object('reason', 'menu_upgrade_required')::text;
  end if;

  if menu_row.space_id is null then
    if p_expected_revision <> 0 then
      current_menu := internal.w2_render_menu(p_space_id, null, null, null);
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object(
          'reason', 'menu_revision_conflict',
          'currentRevision', 0,
          'currentMenu', current_menu
        )::text;
    end if;
    insert into public.space_menu_configs(space_id, schema_version, revision, payload)
    values (p_space_id, 1, 1, normalized_payload)
    returning * into menu_row;
  else
    if menu_row.revision <> p_expected_revision then
      current_menu := internal.w2_render_menu(
        p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
      );
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object(
          'reason', 'menu_revision_conflict',
          'currentRevision', menu_row.revision,
          'currentMenu', current_menu
        )::text;
    end if;
    update public.space_menu_configs
       set schema_version = 1,
           revision = revision + 1,
           payload = normalized_payload
     where space_id = p_space_id
     returning * into menu_row;
  end if;

  menu_result := internal.w2_render_menu(
    p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
  );
  event_effect := jsonb_strip_nulls(jsonb_build_object(
    'type', 'menu.updated',
    'menu', menu_result,
    'clientMutationId', p_client_mutation_id
  ));
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (
    p_space_id,
    internal.next_event_seq(p_space_id),
    'menu.updated',
    event_effect,
    p_client_mutation_id
  );
  ledger_result := jsonb_build_object('menu', menu_result);
  perform internal.ledger_record(
    p_client_mutation_id,
    'spaces.menu.update',
    ledger_result
  );
  -- Only a committing first attempt carries the integration publication
  -- effect. A ledger replay returns ledger_result verbatim and cannot emit it
  -- twice; the durable workspace_events row remains the publication authority.
  return ledger_result || jsonb_build_object('eventEffect', event_effect);
end
$$;

comment on function internal.require_replay_principal(text) is
  'W2.SEC-1 law, part 1: a command-ledger replay may not be returned to a '
  'principal other than the one that recorded it. Called as a PRE-CHECK before '
  'internal.ledger_replay. Pins identity_id only, never actor_id — see 031''s '
  'header for why an exact actor comparison would break legitimate replay.';

comment on function internal.require_replay_subject(text, text, text) is
  'W2.SEC-1 law, part 2: a command-ledger replay may not be returned to a '
  'request that addresses a different resource than the one it was recorded '
  'against. Called inside the replay branch, because it needs the stored '
  'projection. Necessary because internal.ledger_replay keys on the '
  'clientMutationId alone and the operation label cannot distinguish two calls '
  'to the same operation against different resources.';

reset role;
