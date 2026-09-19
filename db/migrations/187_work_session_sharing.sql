-- 187 — terminal sharing becomes configurable, with view and drive as SEPARATE dials.
--
-- THE PROBLEM THIS SOLVES. Two different questions were answered by two
-- different rules that never agreed:
--
--   * WHO SEES THE SESSION — `entities_select` (008:73) is `visibility='space'
--     AND is_space_member`. Every member reads every work_session row. Metadata
--     has always been space-wide.
--   * WHO SEES THE BYTES — `grant_stream_attach` (087:64) refuses unless
--     `share_mode <> 'none'`, the caller created the session, or the caller may
--     `can_act_as` its creator.
--
-- `work_sessions.share_mode` has existed since 001:710 and NOTHING HAS EVER
-- WRITTEN IT for a work session: every insert site omits the column, so all 986
-- rows on the live node carry the 'none' default. The dial was built and never
-- connected. Measured on that node, the observable consequence was a clean
-- split by WHO LAUNCHED the session, not by any setting:
--
--     created_by kind    sessions    ever attached by >1 identity
--     member                  524                               0
--     team_member             462                              35
--
-- because 075 ruled that any active member may act as any teammate, so a
-- teammate-launched session is reachable through the `can_act_as` branch while a
-- human-launched one is reachable by exactly one person, forever, with no way to
-- say otherwise.
--
-- WHAT CHANGES.
--   1. `spaces` gains the DEFAULT posture for sessions spawned into it.
--      `session_share_default` ships as 'space': new terminals are visible to
--      the space. Existing sessions are NOT touched — their own `share_mode`
--      stays 'none', so nobody's past terminal is retroactively exposed.
--   2. `work_sessions` gains `drive_mode`, because watching a terminal and
--      TYPING INTO IT are different permissions and one flag cannot hold both.
--      Existing rows default to 'owner', which is exactly today's rule.
--   3. `grant_stream_attach` reads both dials.
--   4. Two RPCs can write them: the session's owner (or a space admin) for one
--      session, and a space admin for the space default.
--
-- WHAT DELIBERATELY DOES NOT CHANGE.
--   * RLS. Metadata stays space-wide; this migration gates BYTES only. Making a
--     session invisible would mean editing `entity_readable`, the predicate every
--     detail table in the schema depends on, and that is not this change.
--   * The `can_act_as` drive path. A teammate persona is shared by 075's ruling,
--     and a member acting as that persona keeps the drive right they have today.
--     `drive_mode = 'space'` ADDS a way to grant drive; it removes none.
--   * Credential sessions. 083:490 pins them `share_mode = 'none'` because the
--     terminal streams a device code, and §3's trigger skips them BY KIND so a
--     space default can never widen an OAuth flow. This is the one exception and
--     it is enforced, not documented.
--
-- A NOTE ON 'explicit'. The vocabulary is unchanged ('none','space','explicit')
-- and `explicit` REMAINS INERT: the gate below tests `= 'none'`, so 'explicit'
-- still behaves exactly like 'space' with no per-person list consulted anywhere.
-- That was true before this migration and is called out here rather than quietly
-- carried forward, because a future per-person share must BUILD the list check —
-- setting the value is not enough and would silently grant the whole space.

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The space-level default posture.
--
-- Two columns rather than one, mirroring the per-session pair, so a space can
-- say "everyone may watch, only the owner may type" — the posture we expect most
-- teams to want and the one a single flag cannot express.
-- -----------------------------------------------------------------------------
alter table public.spaces
  add column if not exists session_share_default text not null default 'space'
    check (session_share_default in ('none','space')),
  add column if not exists session_drive_default text not null default 'owner'
    check (session_drive_default in ('owner','space'));

comment on column public.spaces.session_share_default is
  'Default work_sessions.share_mode for sessions spawned into this space. '
  'Applied at insert by internal.apply_space_session_sharing_default; changing '
  'it never moves an existing session.';
comment on column public.spaces.session_drive_default is
  'Default work_sessions.drive_mode for sessions spawned into this space.';

-- -----------------------------------------------------------------------------
-- 2. The per-session drive dial.
--
-- 'owner' is today's rule stated as a value: the creator, and anyone who may act
-- as the creator. 'space' widens input to every member of the space. There is no
-- 'none' — a session nobody can drive is a session nobody can use, and the way
-- to stop input is to stop sharing it.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  add column if not exists drive_mode text not null default 'owner'
    check (drive_mode in ('owner','space'));

comment on column public.work_sessions.drive_mode is
  'Who may WRITE to this PTY. owner = the creator and anyone who can_act_as it '
  '(the 075 teammate right). space = any member of the space. Independent of '
  'share_mode, which gates watching; drive additionally requires the view gate.';

-- -----------------------------------------------------------------------------
-- 3. Spawn inherits the space default — as a TRIGGER, not by reopening the RPC.
--
-- `public.execution_spawn` is ~150 lines and has been redefined by seven
-- migrations (007, 043, 048, 111, 129, 131, 150, 178). Re-pasting it to touch two
-- columns would copy every line of that history forward for a chance to drift;
-- the insert is the real seam and this sits on it.
--
-- IT STAMPS UNCONDITIONALLY, and it cannot do otherwise. A BEFORE INSERT trigger
-- sees `new.share_mode` already filled by the column default, so it cannot tell
-- an absent column from one the caller set to 'none' — the two are the same row
-- by the time it runs. Selecting by `session_kind` is therefore the mechanism,
-- not a shortcut around one: a kind that must stay private is named here, and a
-- caller that pins 'none' on a kind that is NOT named has its value overwritten.
-- (An earlier draft of this comment claimed the trigger fired "only when the
-- caller did not name a value". It never did. The sentence was wrong, not the
-- body.)
--
-- HENCE AN ALLOW-LIST, not a credential-shaped hole in a deny-list. Only 'agent'
-- and 'shell' inherit the space default, because those are the two kinds the
-- product decision was actually made about. The chain's own idiom runs the other
-- way — 101 §4 replaced `session_kind <> 'agent'` with `= 'credential'` in
-- `space_kind_counts` and 158 carries the note "so a future session kind is
-- COUNTED unless someone writes it in here" — and that is right THERE, where
-- default-include fails by showing a terminal in the rail. Here it fails by
-- publishing a PTY to the whole space, so the polarity has to flip with it:
-- a kind nobody has thought about should be invisible, not broadcast.
--
-- 'credential' is the existence proof. 083:490 had to pin it to 'none' after the
-- fact because it streams an OAuth device code. 'container_exec' is the live
-- one: 177:1649-1653 inserts with no `share_mode`, so under a deny-list every
-- container exec terminal would have become space-readable in this migration,
-- decided by nobody. Under this list it keeps the column default and the kind's
-- owner opts in by adding four characters.
-- -----------------------------------------------------------------------------
create or replace function internal.apply_space_session_sharing_default()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  space_row public.spaces;
begin
  -- Default-deny by kind. 'credential' streams an OAuth device code (083:490);
  -- 'container_exec' (177) was never part of this product decision; a kind added
  -- after this migration has by definition not been considered at all. All three
  -- keep the column defaults ('none'/'owner') until someone names them here.
  if new.session_kind not in ('agent', 'shell') then
    return new;
  end if;

  select s.* into space_row
    from public.spaces s
    join public.entities e on e.space_id = s.id
   where e.id = new.entity_id;

  -- No space row means the envelope is not written yet or has gone; the column
  -- defaults stand rather than this guessing.
  if space_row.id is null then
    return new;
  end if;

  new.share_mode := space_row.session_share_default;
  new.drive_mode := space_row.session_drive_default;
  return new;
end
$$;

comment on function internal.apply_space_session_sharing_default() is
  'Fills a new work_session''s share_mode/drive_mode from its space''s default. '
  'Credential sessions are exempt by kind and stay private.';

drop trigger if exists work_sessions_apply_sharing_default on public.work_sessions;
create trigger work_sessions_apply_sharing_default
before insert on public.work_sessions
for each row execute function internal.apply_space_session_sharing_default();

-- -----------------------------------------------------------------------------
-- 4. THE GATE. Both dials, read in one place.
--
-- Unchanged from 087 except for the two policy branches: the credential shape,
-- the 60-second clamp, the replay binding, the hash requirement and the
-- single-live-row upsert are all exactly as they were.
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
  may_act_as_creator boolean;
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
  may_act_as_creator := e.created_by is not distinct from internal.current_member_id(e.space_id)
                        or internal.can_act_as(e.created_by, e.space_id);

  -- THE VIEW GATE, which drive must also pass. A session you may not watch is
  -- not one you may type into, so this is checked for both modes and first.
  if session.share_mode = 'none' and not may_act_as_creator then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;

  -- THE DRIVE GATE. Two independent ways in, and the first is the one that
  -- already existed: acting as the creator (a member's own session, or any
  -- teammate persona under 075) carries input rights with it and is NOT a
  -- sharing decision. `drive_mode = 'space'` is the new, explicit grant.
  if p_mode = 'drive'
     and not may_act_as_creator
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
-- 5. Writing ONE session's posture.
--
-- WHO MAY. The creator, anyone who may act as the creator, and a space admin.
-- The admin arm is deliberate and is the one thing 087 had no answer for: an
-- admin could neither open a session nor close one, so a terminal left shared by
-- someone who has gone home could not be shut off by anybody.
--
-- `null` MERGES, the 091/135 patch pattern — passing only p_drive_mode leaves
-- share_mode alone.
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
  -- 'explicit' is NOT accepted here, though the column CHECK still admits it so
  -- any row already carrying it stays legal. The value has no per-person list
  -- behind it anywhere in this schema: the gate below tests `= 'none'`, so a
  -- session set to 'explicit' is open to the entire space while its badge reads
  -- "shared: explicit". Writing it would be a setting that lies. This door is
  -- the first one that could ever have written it, so refusing here costs
  -- nothing and keeps the inert value inert until someone builds the list.
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

  update public.work_sessions
     set share_mode = coalesce(p_share_mode, share_mode),
         drive_mode = coalesce(p_drive_mode, drive_mode),
         updated_at = now()
   where entity_id = p_session_id;

  -- THE ENVELOPE, NOT JUST THE DETAIL ROW. `entity.upsert` has exactly one
  -- source -- `entities_capture_event` on `public.entities` (003:385) -- so a
  -- write that touches only `work_sessions` emits no upsert, and every device
  -- except the one that clicked keeps a stale badge and a stale row verb until
  -- something unrelated bumps the row. That is the "streams on one device, not
  -- on another" bug this whole task was opened to explain, and omitting this
  -- statement would have reintroduced it for the control that fixes it.
  --
  -- It also makes `p_expected_version` mean something: a version that can never
  -- advance always matches a stale expectation, so the guard would admit every
  -- write it exists to refuse. The idiom is 107:88-90's, verbatim.
  update public.entities
     set version = version + 1, updated_at = now()
   where id = p_session_id;

  -- REVOKE LIVE GRANTS ON NARROWING. A grant is a capability that has already
  -- left the server; un-sharing a session that leaves an unconsumed grant alive
  -- is a close button that does not close anything for up to 60 seconds.
  --
  -- WHOSE GRANTS SURVIVE: the CREATOR'S, and only the creator's. Not the
  -- caller's — a space admin who makes somebody else's session private has just
  -- put it behind a gate they themselves no longer pass, and leaving their own
  -- grant alive would hand them a capability `grant_stream_attach` would now
  -- refuse to mint. The two are the same row in the common case (the owner
  -- un-shares their own session) and they are NOT the same row in the case that
  -- matters, which is why this reads the creator rather than `identity_id()`.
  --
  -- A teammate-created session resolves to no identity here (`created_by` is a
  -- team_member entity, which has no `members` row), so every grant is revoked.
  --
  -- READ THAT AS A LIMIT, NOT AS CHURN. 075 lets any active member act as any
  -- teammate, so each of them re-mints on the next dial and succeeds — which
  -- means that on an agent-launched session `share_mode = 'none'` revokes the
  -- outstanding capabilities and does NOT close the door they came through.
  -- The gate below opens on `may_act_as_creator`, and 46% of the sessions on
  -- the live node are created_by a team_member entity, so for those the dial
  -- narrows nothing. This is 087's authority model, not something this
  -- migration introduces, and changing it is a separate decision with a real
  -- blast radius: it is how a human watches an agent's terminal today.
  --
  -- What this migration owes that fact is honesty, and pays it at the surfaces
  -- (`renderShared` prints "not shared" rather than "owner only", plus a note)
  -- and in `session_sharing.test.mjs`, where the case is pinned by name rather
  -- than left as an unexplained green assertion. Special-casing the persona
  -- here would instead make this the second place in the file that decides what
  -- `can_act_as` means.
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
  'Sets one work session''s share_mode/drive_mode. Owner, an actor who can_act_as '
  'the owner, or a space admin. Narrowing revokes other identities'' live grants.';

-- -----------------------------------------------------------------------------
-- 6. Writing the SPACE default, through the door that is actually bound.
--
-- `public.update_space` (036:542) is NOT it. 036's own header records why both
-- exist: 031 bound `spaces.update` to `public.w2_update_space`, and 036 hardened
-- the granted sibling `public.update_space` so the shipped claim would be true
-- of every door rather than one. The server calls `w2_update_space`
-- (identity-spaces.ts:469) and nothing in this repository calls the sibling, so
-- extending the sibling would add a setting no product path can write.
--
-- The sibling is left alone for a second reason: its parameters are positional,
-- and `create or replace` CANNOT add a defaulted parameter — it would define a
-- second, eight-argument function beside the six-argument one, and every
-- existing six-argument call would then match both candidates and fail to
-- resolve. A jsonb patch has no such edge, which is why the bound door uses one.
--
-- So: two new keys on the allow-list. The rest of this function is 161's
-- definition unchanged, re-stated in full because that is how a `create or
-- replace` works.
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
    -- uncommitted row. See the TOCTOU note in 031's header.
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
     where patch_key not in ('name', 'description', 'githubRepo',
                             'sessionShareDefault', 'sessionDriveDefault')
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
  -- Checked here rather than left to the column CHECK so a bad value is a 400
  -- naming the field, not a 500 naming a constraint.
  if p_patch ? 'sessionShareDefault'
     and (jsonb_typeof(p_patch -> 'sessionShareDefault') <> 'string'
          or p_patch ->> 'sessionShareDefault' not in ('none','space')) then
    raise exception 'sessionShareDefault must be "none" or "space"'
      using errcode = '22023';
  end if;
  if p_patch ? 'sessionDriveDefault'
     and (jsonb_typeof(p_patch -> 'sessionDriveDefault') <> 'string'
          or p_patch ->> 'sessionDriveDefault' not in ('owner','space')) then
    raise exception 'sessionDriveDefault must be "owner" or "space"'
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
         end,
         session_share_default = case
           when p_patch ? 'sessionShareDefault' then p_patch ->> 'sessionShareDefault'
           else session_share_default
         end,
         session_drive_default = case
           when p_patch ? 'sessionDriveDefault' then p_patch ->> 'sessionDriveDefault'
           else session_drive_default
         end
   where id = p_space_id
   returning * into space_row;
  if space_row.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'space', to_jsonb(space_row) || jsonb_build_object(
      'member_count', (select count(*) from public.members where space_id = p_space_id)
      -- no 'unread_total' — see 161's header
    ),
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Grants. `tm8_app` is the only role that reaches the new door.
-- -----------------------------------------------------------------------------
revoke all on function public.set_work_session_sharing(uuid, integer, text, text, uuid, text) from public;
grant execute on function public.set_work_session_sharing(uuid, integer, text, text, uuid, text) to tm8_app;

reset role;
