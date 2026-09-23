-- 202 — sharing provenance: a deliberate narrowing narrows, even on a teammate's session.
--
-- THE HOLE 187 LEFT OPEN, AND SAID SO. Both gates in `grant_stream_attach` open
-- on `may_act_as_creator`, and 075 makes `internal.can_act_as` TRUE for every
-- active member whenever `created_by` is a team_member entity — 464 of ~997
-- sessions on the live node. So on an agent-launched session `share_mode =
-- 'none'` revoked the outstanding grants and did NOT close the door they came
-- through: the next dial re-minted. 187 pinned that as a KNOWN LIMIT test and
-- printed a note on every CLI narrowing. It was honest; it was not correct.
--
-- WHY THIS IS NOT A RE-LITIGATION OF 075. The act-as arm is load-bearing for
-- DEFAULT visibility only — it is how a human watches an agent's terminal
-- today, and the only callers of `execution.streams.attach` are the UI terminal
-- and `tm8 session attach`, both human-driven. Before 187 zero rows had
-- `share_mode <> 'none'`: 'none' was never CHOSEN, it was only what the column
-- happened to say. After 187 a row at 'none' is one of two distinguishable
-- things — pre-187 and untouched, or deliberately narrowed by a human — and
-- the schema could not tell them apart. This column is what tells them apart.
--
-- THE SHAPE.
--   1. `work_sessions.sharing_set_at`, nullable, written ONLY by
--      `public.set_work_session_sharing` — enforced by a guard trigger, not by
--      a comment (the R29 idiom, 001:727).
--   2. Both gates keep 075's arm only while `sharing_set_at is null`. Legacy and
--      untouched sessions behave exactly as before BY CONSTRUCTION; a session a
--      human has configured means what its dials say.
--   3. `grant_stream_attach` stays the single place that decides.
--
-- ONE CORRECTION TO THE SHAPE AS FILED. The task wrote the clause as
--     not (may_act_as_creator and sharing_set_at is null)
-- but `may_act_as_creator` is two things OR'd — being the creator, and acting
-- as it under 075 — and only the second is the arm in question. Taken
-- literally the clause would lock a member out of their OWN session the moment
-- they narrowed it (187's `share_mode=none: the owner attaches` test is the
-- counter-example). So the creator arm is split out and stays unconditional.
--
-- WHAT "OWNER" MEANS ON A TEAMMATE'S SESSION, stated because it is the part a
-- caller will not guess. `entities.created_by` records the PERSONA, and no
-- column anywhere records which human pressed launch (execution_spawn 178
-- binds the persona as the actor for the envelope, the edges and the activity
-- row). So on a teammate-created session that a human has configured,
-- `share_mode='none'` closes it to EVERY member, the one who narrowed it
-- included, until someone opens it again — and `drive_mode='owner'` means
-- nobody types. That is what "deliberately narrowed" can mean when the owner
-- is not a person. Re-opening stays available to anyone 075 lets act as the
-- teammate (set_work_session_sharing's authority is unchanged here), so it is
-- a recorded act rather than a silent re-mint.
--
-- THE FIRST WRITE WRITES DOWN WHAT THE OTHER DIAL WAS DOING. One column covers
-- both dials, so stamping it on a write that names ONE dial arms the other.
-- On an unconfigured teammate session the effective posture is "every member"
-- for both dials, whatever the columns say — post-187 sessions are stamped
-- 'space'/'owner' and 075 makes 'owner' mean everyone. Without this, the
-- ordinary sequence "Make private" then "Share with space" would leave the
-- session's drive_mode at 'owner', now enforced, and nobody — its launcher
-- included — could type into an agent terminal again. So the first write on a
-- session reachable through 075 materialises the dial it does NOT name at
-- 'space', the value that was already in force. That is the coalesce rule
-- ("omitting a dial leaves it alone") read about the EFFECTIVE posture rather
-- than the stored string; nobody gains an access they did not already have.
--
-- WHAT DOES NOT CHANGE: RLS, the credential exemption, the 60-second clamp, the
-- replay binding, the grant upsert, who may call set_work_session_sharing, and
-- the revocation rule. Nothing is widened.

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The provenance column, and its single writer.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  add column if not exists sharing_set_at timestamptz;

comment on column public.work_sessions.sharing_set_at is
  'When a human last set this session''s sharing through set_work_session_sharing. '
  'NULL = never configured (pre-187 or untouched): grant_stream_attach then keeps '
  'the 075 act-as arm. Non-null = the dials are enforced as written. Single writer.';

-- R29's shape, for the same reason: a well-meaning future RPC or a bulk UPDATE
-- that nulls this column silently re-opens every narrowed teammate session, and
-- one that stamps it silently closes every legacy one. Refused unless the one
-- writer has raised the transaction-local flag.
create or replace function internal.guard_work_session_sharing_set_at() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if (tg_op = 'INSERT' and new.sharing_set_at is not null
      or tg_op = 'UPDATE' and new.sharing_set_at is distinct from old.sharing_set_at)
     and coalesce(internal.claim_text('tm8.work_session_sharing_write'), '') <> 'on' then
    raise exception 'work_session.sharing_set_at has a single writer: set_work_session_sharing'
      using errcode = '23514',
            detail = 'call public.set_work_session_sharing(...) — 202';
  end if;
  return new;
end
$$;

drop trigger if exists work_sessions_guard_sharing_set_at on public.work_sessions;
create trigger work_sessions_guard_sharing_set_at
before insert or update of sharing_set_at on public.work_sessions
for each row execute function internal.guard_work_session_sharing_set_at();

-- -----------------------------------------------------------------------------
-- 2. THE GATE. 187's body; only the two policy clauses move.
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

  -- THE VIEW GATE, which drive must also pass. A session you may not watch is
  -- not one you may type into, so this is checked for both modes and first.
  if session.share_mode = 'none' and not holds_owner_right then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;

  -- THE DRIVE GATE. Two independent ways in: the owner right above, and
  -- `drive_mode = 'space'`, the explicit grant.
  if p_mode = 'drive'
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
-- 3. The single writer. 187's body plus the stamp and the first-write rule.
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

  if e.created_by is distinct from internal.current_member_id(e.space_id)
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
  select ws.sharing_set_at is null
         and exists (
           select 1
             from public.team_members t
             join public.entities te on te.id = t.entity_id
            where t.entity_id = e.created_by
              and te.space_id = e.space_id
              and te.deleted_at is null
         )
    into first_write_via_075
    from public.work_sessions ws
   where ws.entity_id = p_session_id
     for update;

  perform set_config('tm8.work_session_sharing_write', 'on', true);
  update public.work_sessions
     set share_mode = coalesce(p_share_mode,
                               case when first_write_via_075 then 'space' else share_mode end),
         drive_mode = coalesce(p_drive_mode,
                               case when first_write_via_075 then 'space' else drive_mode end),
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
  'writer. Owner, an actor who can_act_as the owner, or a space admin. Narrowing '
  'revokes other identities'' live grants.';

reset role;
