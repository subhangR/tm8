-- 117 — PERMISSIONS YOU CAN ACTUALLY CHANGE: member roles, invite roles, and a
-- pre-membership invite preview.
--
-- `public.members.role` has carried 'owner'|'admin'|'member' since 002:97 and
-- every authorization primitive reads it (`internal.is_space_admin`), but
-- NOTHING HAS EVER WRITTEN IT after the row was created. `attach_member`
-- (007:515) takes a role argument, both callers pass the literal 'member', and
-- there is no RPC, no operation and no CLI verb that changes one afterwards.
-- The consequence is not subtle: a space's second human is a 'member' forever,
-- the settings UI draws its role control disabled-with-reason
-- (`settings-space/reasons.ts` ROLE_CHANGE_UNAVAILABLE, whose stated mechanism
-- is "the seam has no membership verb at all"), and the only way to make
-- somebody an admin is a hand-written UPDATE against the table.
--
-- This migration adds the missing writer and the missing invite half:
--
--   1. `space_invites.role`         — an invite says what you are joining AS.
--   2. `public.create_invite`       — extended to carry it (defaulted, so every
--                                     existing caller keeps its exact meaning).
--   3. `public.redeem_invite`       — attaches with the invite's role, not the
--                                     hardcoded 'member'.
--   4. `public.set_member_role`     — the writer, with the four rules below.
--   5. `public.preview_invite`      — claim-free: what does this code let me
--                                     join, BEFORE I am a member of anything.
--
-- WHAT IS DELIBERATELY NOT HERE: removing a member. A member row is the
-- attribution target of everything that human ever authored —
-- `entities.created_by` references `entities(id)` with NO on-delete clause
-- (001:338), so Postgres already REFUSES to delete the member row of anyone who
-- has created a single entity, and it refuses with a bare 23503. The correct
-- shape is a soft removal (`members.removed_at`) that keeps attribution and
-- revokes access, and that means auditing all 57 `from public.members`
-- predicates across 23 migrations — six of them RLS policies — because every
-- one of them currently means "is a member" by the row's mere existence. That
-- is its own change with its own gate; doing half of it here would leave a
-- removed member still reading the space. The UI keeps its honest refusal and
-- names this file as the reason.
--
-- THE FOUR RULES, and why each one exists.
--
--   R1 · Only a space admin may change any role.
--        `internal.require_space_admin` — the same guard `create_invite` uses.
--
--   R2 · Only an OWNER may grant or revoke the owner role.
--        An admin who could mint an owner could mint themselves a superior and
--        then be promoted by it; an admin who could revoke one could evict the
--        person who appointed them. Ownership moves only by an owner's hand.
--        Transfer is therefore explicit and two-step: the owner promotes the
--        successor (two owners), then demotes themselves (one). Both steps are
--        legal, auditable and individually recoverable — which a single
--        "transfer" verb that does both atomically would not be.
--
--   R3 · The last owner cannot be demoted.
--        A space with zero owners is unrecoverable through this operation: R2
--        says only an owner may grant the owner role, and there is nobody left
--        to be one. Enforced under a row lock over the space's owner rows, so
--        two concurrent demotions cannot both read "there are two of us".
--
--   R4 · An invite cannot mint an owner.
--        A code that travels out of band is a bearer capability — it is worth
--        exactly as much as the channel it was sent over. Ownership is not
--        something a forwarded link may confer, so the column's check admits
--        'admin' and 'member' only. Making somebody an owner requires an
--        owner's deliberate act against a member who is already here (R2).
--
-- Idempotency follows the sec1 pattern established by 031/033 and applied at
-- every write site in 036: principal pin BEFORE the replay read, principal pin
-- AGAIN inside the replay branch (where `ledger_replay`'s advisory lock is
-- held — that second call is the boundary, the first is a fast path), and a
-- subject binding so a stolen cmid cannot be replayed against a different
-- space.

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The invite carries the role it grants.
-- -----------------------------------------------------------------------------
--
-- `default 'member'` is doing real work on the existing rows: every invite
-- issued before this migration was redeemed into a 'member' by the hardcoded
-- literal in `redeem_invite`, so the default is not a guess — it is the value
-- those rows already meant. No backfill is needed and none is honest to write.
alter table public.space_invites
  add column if not exists role text not null default 'member'
    check (role in ('admin','member'));

comment on column public.space_invites.role is
  'The space role this invite confers on redemption (117). Admits admin and '
  'member only — R4: a bearer capability that travels out of band may not '
  'confer ownership. Existing rows default to member, which is what '
  'redeem_invite already gave them.';

-- -----------------------------------------------------------------------------
-- 2. create_invite — one new trailing argument.
-- -----------------------------------------------------------------------------
--
-- THE OLD SIGNATURE IS DROPPED, NOT LEFT BESIDE THE NEW ONE. `create or
-- replace` with an extra parameter does not replace anything — it ADDS an
-- overload, and a 5-argument call then matches both the old exact signature and
-- the new one's defaulted tail. Postgres does not pick; it raises `42725
-- function is not unique`, which would take out every invite creation on the
-- node the moment this migration applied. The drop is the whole reason this
-- section is longer than a one-line ALTER.
--
-- `p_role` lands LAST, after `p_client_mutation_id`, which reads wrong and is
-- correct: the facade calls this positionally as `[spaceId, maxUses, expiresAt,
-- actorId, clientMutationId]`, so putting the new parameter in its natural
-- place beside `p_max_uses` would silently reinterpret the cmid as a role. A
-- trailing defaulted parameter is the only shape that keeps every existing
-- 5-argument caller meaning exactly what it meant.
--
-- The body is 032's, unchanged except for the role. Both of 032's properties
-- are load-bearing and both are kept verbatim: STRIP AT REST (the live code
-- never enters `public.command_ledger`) and REHYDRATE-AFTER-BINDING (the replay
-- branch rebuilds the response from the live row, and only after both guards
-- have passed). Re-deriving either from scratch here would be how they get
-- lost.
drop function if exists public.create_invite(uuid, integer, timestamptz, uuid, text);

create or replace function public.create_invite(
  p_space_id uuid, p_max_uses integer default 1, p_expires_at timestamptz default null,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_role text default 'member'
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  invite public.space_invites;
  invite_fresh public.space_invites;
  role_wanted text;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{invite,space_id}', p_space_id::text, 'space');
    -- REHYDRATE-AFTER-BINDING (032). The live invite code is deliberately NOT in
    -- the stored projection, so the response is rebuilt from the live row. This
    -- is unreachable until BOTH guards above have passed, so a stranger is
    -- refused before any re-read happens.
    select * into invite_fresh from public.space_invites where id = (replay #>> '{invite,id}')::uuid;
    if invite_fresh.id is null then
      raise exception 'invite no longer exists' using errcode = 'P0002',
        detail = 'the replayed invite row is gone; refusing to return a partial projection or fall back to the stripped ledger blob';
    end if;
    return jsonb_build_object('invite', to_jsonb(invite_fresh), 'patches', '[]'::jsonb);
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);

  role_wanted := coalesce(nullif(btrim(p_role), ''), 'member');
  -- R4, stated as a refusal rather than a silent downgrade: a caller who asked
  -- for an owner invite has a wrong model of what an invite is, and quietly
  -- handing them a member invite would leave that model intact.
  if role_wanted not in ('admin','member') then
    raise exception 'an invite may confer admin or member, not %', role_wanted
      using errcode = '22023';
  end if;

  insert into public.space_invites(space_id, code, created_by, max_uses, expires_at, role)
  values (p_space_id, 'inv_' || replace(internal.new_id()::text, '-', ''),
          actor, coalesce(p_max_uses, 1), p_expires_at, role_wanted)
  returning * into invite;
  -- STRIP AT REST (032): the live credential never enters public.command_ledger.
  result := jsonb_build_object('invite', to_jsonb(invite) - 'code', 'patches', '[]'::jsonb);
  perform internal.ledger_record(p_client_mutation_id, 'spaces.invites.create', result);
  return jsonb_build_object('invite', to_jsonb(invite), 'patches', '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. redeem_invite — attach with the invite's role.
-- -----------------------------------------------------------------------------
--
-- Byte-for-byte 031's function except for the `invite.role` in the
-- `attach_member` call and the role in the notification payload. 031's header
-- explains the principal pin and the Space-granular subject binding at length;
-- that reasoning is unchanged and is not restated here. The `existed` branch
-- still does NOT re-role an existing member: redemption is how you JOIN, and
-- letting a code silently promote somebody who is already here would make an
-- admin invite a privilege-escalation primitive against any member who could
-- be talked into clicking it. Changing a standing member's role is
-- `set_member_role`, which requires an admin at the keyboard.
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
    member_id := internal.attach_member(invite.space_id, identity, invite.role);
    update public.space_invites set use_count = use_count + 1 where id = invite.id;
    perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                            jsonb_build_object('inviteId', invite.id, 'role', invite.role));
  end if;
  result := jsonb_build_object('spaceId', invite.space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. set_member_role — the writer.
-- -----------------------------------------------------------------------------
create or replace function public.set_member_role(
  p_space_id uuid, p_member_id uuid, p_role text,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  target public.members;
  caller_role text;
  owner_count integer;
  activity_id uuid;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.members.updateRole');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;

  -- R1.
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if p_role not in ('owner','admin','member') then
    raise exception 'unknown role %', p_role using errcode = '22023';
  end if;

  -- The space is named in the predicate, not just used to authorize: a member
  -- id from another Space must be "not found here", never "found and updated".
  select * into target from public.members
   where entity_id = p_member_id and space_id = p_space_id
   for update;
  if target.entity_id is null then
    raise exception 'member not found in this space' using errcode = 'P0002';
  end if;

  select m.role into caller_role from public.members m
   where m.space_id = p_space_id and m.identity_id = internal.identity_id();

  -- R2. Both directions, in one test: the owner role may not be handed out or
  -- taken away by anyone who does not hold it.
  if (p_role = 'owner' or target.role = 'owner') and caller_role is distinct from 'owner' then
    raise exception 'only an owner may grant or revoke the owner role'
      using errcode = '42501';
  end if;

  -- Already there. Returning the entity rather than raising keeps the
  -- operation idempotent for a client that re-sends a settled state — and
  -- keeps the ledger's record of that cmid truthful about what happened.
  if target.role = p_role then
    result := internal.command_result(p_member_id, null, null, array[p_member_id]);
    return internal.ledger_record(p_client_mutation_id, 'spaces.members.updateRole', result);
  end if;

  -- R3. The lock is over the space's OWNER rows, taken before the count, so
  -- two concurrent demotions serialize on each other instead of both reading
  -- "there are two of us" and both committing. A concurrent PROMOTION is not
  -- covered by this lock and does not need to be: it only ever raises the
  -- count, and the invariant this defends is a floor.
  if target.role = 'owner' and p_role <> 'owner' then
    perform 1 from public.members
     where space_id = p_space_id and role = 'owner' for update;
    select count(*) into owner_count from public.members
     where space_id = p_space_id and role = 'owner';
    if owner_count <= 1 then
      raise exception 'a space must keep at least one owner: promote a successor first'
        using errcode = '42501';
    end if;
  end if;

  update public.members set role = p_role where entity_id = p_member_id;

  -- 'updated' is the activity verb 003:35-38 admits for this; the summary
  -- carries both ends so a reader of the feed learns the direction without
  -- re-reading the row it describes (which by then may have moved again).
  activity_id := internal.record_activity(p_space_id, p_member_id, actor, 'updated',
                   null, jsonb_build_object('role', p_role, 'previousRole', target.role));
  -- The person whose standing changed is told. `internal.notify` already
  -- refuses to notify an actor about their own action, so an admin adjusting
  -- their own row is silent by construction.
  perform internal.notify(p_space_id, p_member_id, 'role.changed', p_member_id, actor,
                          jsonb_build_object('role', p_role, 'previousRole', target.role),
                          activity_id);

  result := internal.command_result(p_member_id, null, activity_id, array[p_member_id]);
  return internal.ledger_record(p_client_mutation_id, 'spaces.members.updateRole', result);
end
$$;

comment on function public.set_member_role(uuid, uuid, text, uuid, text) is
  'Change a member''s space role (117). Space admin required; only an owner may '
  'grant or revoke owner; the last owner cannot be demoted. Idempotent on a '
  'role that is already set.';

-- -----------------------------------------------------------------------------
-- 5. preview_invite — claim-free.
-- -----------------------------------------------------------------------------
--
-- WHY THIS IS CLAIM-FREE, and why that is not a hole. A join link is answered
-- BEFORE the person holding it is anybody on this node: they may have no
-- account, and even with one they are by definition not a member of the space
-- the code names, so every RLS path that could tell them what they are looking
-- at correctly returns zero rows. Without this function a join page can only
-- say "paste your code and hope" — the auth board's own invite frames carry the
-- note "no operation reads an invite before you join", and this is that
-- operation.
--
-- The disclosure is bounded by the code itself. A code is 'inv_' + 32 hex
-- characters from `internal.new_id()` — not guessable, and already a bearer
-- capability: whoever holds it can REDEEM it, which discloses far more than its
-- preview. Nothing here widens what a code is worth.
--
-- WHAT IT REFUSES TO SAY. An unresolvable code returns status 'unknown' and
-- NOTHING ELSE — no space, no inviter, no hint that some other code would have
-- worked. A revoked, expired or exhausted code returns its status and, because
-- the holder was legitimately given it, the space name so they can ask the
-- right person for a fresh one; it never returns the inviter's identity or any
-- membership. This mirrors the dead-invite card's own rule: "no space details
-- leak on a dead link" is kept for the identifying details, and the space's
-- display name is what makes the refusal actionable rather than cryptic.
create or replace function public.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  invite public.space_invites;
  space public.spaces;
  inviter text;
  status text;
begin
  select * into invite from public.space_invites where code = p_code;
  if invite.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into space from public.spaces where id = invite.space_id;
  if space.id is null then
    -- The Space was deleted out from under a live code. Same answer as an
    -- unknown code: there is nothing to join and nothing to name.
    return jsonb_build_object('status', 'unknown');
  end if;

  status := case
    when invite.revoked_at is not null then 'revoked'
    when invite.expires_at is not null and invite.expires_at < now() then 'expired'
    when invite.use_count >= invite.max_uses then 'exhausted'
    else 'valid'
  end;

  if status <> 'valid' then
    return jsonb_build_object('status', status, 'spaceName', space.name);
  end if;

  select coalesce(nullif(btrim(m.display_name), ''), nullif(btrim(p.display_name), ''))
    into inviter
    from public.members m
    left join public.user_profiles p on p.identity_id = m.identity_id
   where m.entity_id = invite.created_by;

  return jsonb_build_object(
    'status',    'valid',
    'spaceId',   space.id,
    'spaceName', space.name,
    'role',      invite.role,
    'invitedBy', inviter,
    'expiresAt', invite.expires_at
  );
end
$$;

comment on function public.preview_invite(text) is
  'What a join code lets you join, answered before the holder is anybody here '
  '(117). Claim-free by necessity — the reader is not a member of the space the '
  'code names. Discloses nothing for an unresolvable code.';

-- -----------------------------------------------------------------------------
-- 6. Grants.
-- -----------------------------------------------------------------------------
--
-- 008:233-234 revoked EXECUTE from PUBLIC and granted it to tm8_app across the
-- whole schema, but 008:251-253 also left default privileges untouched on
-- purpose: a function created after 008 inherits nothing and is unreachable
-- until a migration says otherwise. So every function this file creates — and
-- `create_invite`, which was DROPPED and therefore lost the grant it had — is
-- named explicitly here. `redeem_invite` is absent from this list because
-- `create or replace` preserved its existing grants; it was never dropped.
revoke all on function public.create_invite(uuid,integer,timestamptz,uuid,text,text) from public;
revoke all on function public.set_member_role(uuid,uuid,text,uuid,text) from public;
revoke all on function public.preview_invite(text) from public;

grant execute on function public.create_invite(uuid,integer,timestamptz,uuid,text,text) to tm8_app;
grant execute on function public.set_member_role(uuid,uuid,text,uuid,text) to tm8_app;
grant execute on function public.preview_invite(text) to tm8_app;


-- -----------------------------------------------------------------------------
-- internal.w2_space_settings_view — SUPERSEDES 029.
--
-- WHY THIS IS HERE. This migration makes `role` a REQUIRED field on every
-- invite in `SpaceSettingsView` (contract.ts), but 029's builder — the one
-- `set_space_default_channel` returns through — never emitted it. So the moment
-- a Space had a single invite, `spaces.defaultChannel.set` produced a payload
-- its own frozen schema rejects, and `parseSpaceSettings`
-- (services/w2/menu-default-channel.ts) turned that into
-- `upstream_unavailable: default-channel result violates the frozen
-- SpaceSettingsView contract`.
--
-- MEASURED, not theorised: `packages/cli/test/integration/space.test.ts:543`
-- creates an invite and then sets the default channel, and went red on exactly
-- this. The TypeScript reader (`identity-spaces.ts loadInvites`) was updated
-- with the contract; this SQL projection is the second door onto the same view
-- and was missed.
--
-- The whole function is restated because Postgres has no partial redefinition.
-- The ONLY change from 029 is the `'role', invite_row.role` line.
-- -----------------------------------------------------------------------------
create or replace function internal.w2_space_settings_view(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  space_row public.spaces;
  menu_row public.space_menu_configs;
  menu_result jsonb;
  result jsonb;
begin
  select * into space_row from public.spaces where id = p_space_id;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  select * into menu_row from public.space_menu_configs where space_id = p_space_id;
  menu_result := internal.w2_render_menu(
    p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
  );

  select jsonb_build_object(
    'space', jsonb_build_object(
      'id', space_value.id,
      'name', space_value.name,
      'description', space_value.description,
      'memberCount', (
        select count(*)::integer from public.members member_count_row
         where member_count_row.space_id = space_value.id
      ),
      'unreadTotal', (
        select count(*)::integer
          from public.messages message_row
          join public.entities message_entity
            on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
          join public.entities anchor_entity
            on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = space_value.id
          join public.members viewer
            on viewer.space_id = space_value.id and viewer.identity_id = internal.identity_id()
          left join public.read_marks mark_row
            on mark_row.anchor_id = message_row.anchor_id
           and mark_row.member_id = viewer.entity_id
         where message_row.author_id is distinct from viewer.entity_id
           and (mark_row.last_read_at is null
             or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
      ),
      'githubRepo', space_value.github_repo,
      'createdAt', internal.w2_iso(space_value.created_at)
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'actor', jsonb_build_object(
          'id', member_row.entity_id,
          'kind', 'member',
          'displayName', coalesce(member_row.display_name, profile_row.display_name, 'Member'),
          'avatar', profile_row.avatar,
          'role', member_row.role,
          'isAgent', false
        ),
        'role', member_row.role,
        'joinedAt', internal.w2_iso(member_row.joined_at)
      ) order by member_row.joined_at, member_row.entity_id)
        from public.members member_row
        left join public.user_profiles profile_row
          on profile_row.identity_id = member_row.identity_id
       where member_row.space_id = space_value.id
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', invite_row.id,
        'code', invite_row.code,
        'role', invite_row.role,
        'maxUses', invite_row.max_uses,
        'uses', invite_row.use_count,
        'expiresAt', case when invite_row.expires_at is null then null
                          else internal.w2_iso(invite_row.expires_at) end,
        'revoked', invite_row.revoked_at is not null
      ) order by invite_row.created_at desc, invite_row.id desc)
        from public.space_invites invite_row
       where invite_row.space_id = space_value.id
    ), '[]'::jsonb),
    'taskAxes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', axis_row.id,
        'spaceId', axis_row.space_id,
        'name', axis_row.name,
        'axisValues', axis_row.axis_values,
        'kind', axis_row.kind,
        'position', axis_row.position
      ) order by axis_row.position, axis_row.name, axis_row.id)
        from public.task_axes axis_row
       where axis_row.space_id = space_value.id
    ), '[]'::jsonb),
    'menu', menu_result,
    'defaultChannelId', space_value.default_channel_id,
    'defaultInteractionProfileId', space_value.default_interaction_profile_id,
    'settingsRevision', space_value.settings_revision
  ) into result
    from public.spaces space_value
   where space_value.id = p_space_id;
  return result;
end
$$;

reset role;
