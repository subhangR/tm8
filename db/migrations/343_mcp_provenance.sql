-- =============================================================================
-- 343 — MCP PROVENANCE: the §6 access rule, recorded and re-checked (D7, G3).
--
-- §6 is one rule: find the HUMAN behind a launch, check that human against the
-- Space the call runs in, and re-check it on every tools/list and tools/call.
-- 298 built half of it (the launcher identity carried hop by hop, and the
-- membership re-read on every call). This migration builds the other half: the
-- whole chain, written down; a depth cap; the schedule and teammate roots that
-- were refused outright (G3); and the per-hop Space check of §6.2.
--
-- WHAT THE AUTHORITY IS, AND WHAT IT IS NOT (advisor ruling B17).
--
-- Plan §6.1 said "follow `launched_by`". That is wrong on mechanism and the
-- plan text is amended (v3). `launched_by` is written by `execution_spawn`
-- (330:204) from `p_parent_session_id`, and that argument is CLIENT-ASSERTED
-- for every bearer but a chat runtime: `chat/scope.ts resolveSpawnParentId`
-- constrains only that one shape, and `execution_spawn` checks merely that the
-- parent is a live chat or session IN THE SAME SPACE. So a member can spawn a
-- worker naming ANOTHER member's chat as its parent, and a walk of that edge
-- would hand their worker the other member's personal connections. The edge
-- records report routing. It authorises nothing, and nothing here reads it as
-- authority.
--
-- The authority at each hop is the SPAWNING BEARER, which is a server fact off
-- the verified token row:
--
--   * a human bearer (`tm8.auth_kind` in browser|cli) is a TERMINAL root: that
--     human, through `internal.current_member_id`, which is itself pinned (227);
--   * an agent or agent_runtime bearer hops to ITS OWN session — never to a
--     named one — and that session's binding already holds its root and its
--     chain, so one hop reads the whole ancestry;
--   * anything else has no bearer, and only the two terminal rules below can
--     give it a root.
--
-- THE NEW TERMINAL (G3; B19 as amended by B21). It was refused before.
--
--   * A SCHEDULE firing. The loop executor spawns under the node's loopback
--     owner, so there is no bearer at all. The root is the human who ARMED the
--     loop, recorded on `public.loops` by a trigger that fires only for a human
--     bearer — never inferred afterwards from `entities.created_by`, which an
--     agent persona can own. No armed-by, no connectors.
--   * A TEAMMATE-AUTONOMOUS terminal (the persona's `owner_member_id`) does NOT
--     exist (ruling B21). See the long comment at that branch in
--     `internal.mcp_provenance` for the three verified reasons it fails OPEN,
--     the first of which is that a loop firing has no `triggered_by` edge yet at
--     bind time, so EVERY firing would land on it.
--
-- Everything else fails closed, as `reason`, and `bind_mcp_session` refuses a
-- NON-EMPTY selection without a root while still binding `[]` — asking for no
-- connectors must never refuse a spawn (the lesson of 298's delegated path).
--
-- WHERE THE CHAIN LIVES. On the binding and the launch record, as
-- `chain`/`chain_space_ids` (nearest hop first) plus `root_member_id` and
-- `root_identity_id`. `read_mcp_session_binding` — which the proxy already
-- calls before EVERY upstream send — returns them and re-checks §6.2 against
-- them. t-audit-log reads the same columns for the audit row; this migration
-- deliberately does not touch `mcp_call_audit`, which that task owns.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The armed-by fact on a loop.
--
-- A `loop` is the only launcher in tm8 with no bearer behind its firings, so the
-- human has to be recorded when they configure it, not reconstructed later.
-- `entities.created_by` is NOT that fact: it names an actor, which is a
-- team_member whenever an agent created the loop, and B19 is explicit that we
-- do not guess a human through a persona.
--
-- A TRIGGER rather than new `create_loop`/`update_loop` bodies: those two doors
-- are large, and re-creating them here to add one assignment each is how a door
-- comes to differ from its original by an edit nobody meant. The trigger also
-- cannot be bypassed by a future third writer.
--
-- It stamps on INSERT and on any later human write, so the fact is "the human
-- who last configured this schedule" — which is who the firings act for. The
-- executor's own `update_loop` (it advances `next_run_at` through the same door)
-- is not a human bearer, so it passes through without touching the stamp, and
-- nothing here ever CLEARS one.
-- -----------------------------------------------------------------------------
alter table public.loops
  add column if not exists armed_by_member_id uuid references public.members(entity_id) on delete set null,
  add column if not exists armed_by_identity_id text references public.user_profiles(identity_id);

comment on column public.loops.armed_by_member_id is
  'The member who last configured this schedule from a HUMAN bearer (343, §6). '
  'The provenance root of every firing; null means this loop lends no '
  'connection. Never written from an agent, link or in-process caller, and '
  'never cleared.';
comment on column public.loops.armed_by_identity_id is
  'The identity behind armed_by_member_id, kept beside it so a firing''s root '
  'survives the member row being re-created in another Space (343).';

create or replace function internal.stamp_loop_armed_by() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_member uuid;
begin
  -- Fails closed on every non-human shape: an agent or agent_runtime bearer, a
  -- link session, the in-process scheduler (no claim at all), and an
  -- unrecognised kind all leave the stamp exactly as it was.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli')
     or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    return new;
  end if;
  select space_id into v_space from public.entities where id = new.entity_id;
  if v_space is null then return new; end if;
  -- Pinned (227): a space-pinned session resolves a member only for its pin, so
  -- this can never stamp a member of a Space the caller is not acting in.
  v_member := internal.current_member_id(v_space);
  if v_member is null then return new; end if;
  new.armed_by_member_id := v_member;
  new.armed_by_identity_id := internal.identity_id();
  return new;
end
$$;
revoke all on function internal.stamp_loop_armed_by() from public;

drop trigger if exists loops_stamp_armed_by on public.loops;
create trigger loops_stamp_armed_by before insert or update on public.loops
for each row execute function internal.stamp_loop_armed_by();

-- -----------------------------------------------------------------------------
-- 2. The chain, on the binding and on the launch record.
--
-- `chain` is session ids, NEAREST HOP FIRST, so `chain[1]` is always the
-- session itself. `chain_space_ids` is positionally parallel: §6.2 checks the
-- root against EVERY Space in it, so a chain that crossed Spaces cannot launder
-- access through a hop in a Space the root has since left.
-- -----------------------------------------------------------------------------
alter table internal.mcp_session_bindings
  add column if not exists root_member_id uuid,
  add column if not exists root_identity_id text,
  add column if not exists chain uuid[],
  add column if not exists chain_space_ids uuid[];

alter table internal.mcp_launch_selections
  add column if not exists root_member_id uuid,
  add column if not exists root_identity_id text,
  add column if not exists chain uuid[],
  add column if not exists chain_space_ids uuid[];

alter table internal.mcp_session_bindings
  add constraint mcp_session_bindings_chain_shape
    check (chain is null or (array_length(chain, 1) between 1 and 8
           and array_length(chain, 1) = array_length(chain_space_ids, 1)));

comment on column internal.mcp_session_bindings.chain is
  'The §6 provenance chain as session ids, nearest hop first; chain[1] is this '
  'session. Derived from BEARER facts, never from launched_by (343, B17). '
  'Capped at 8 hops.';
comment on column internal.mcp_session_bindings.chain_space_ids is
  'The Space of each hop in `chain`, positionally parallel. §6.2 re-checks the '
  'root against every one of them on every call (343).';

-- -----------------------------------------------------------------------------
-- 3. internal.mcp_provenance_root_identity — one member entity to its human.
-- -----------------------------------------------------------------------------
create or replace function internal.mcp_provenance_root_identity(p_member uuid, p_space uuid)
returns text language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.identity_id from public.members m
    join public.accounts a on a.identity_id = m.identity_id and a.status = 'active'
   where m.entity_id = p_member and m.space_id = p_space and m.status = 'active'
$$;
revoke all on function internal.mcp_provenance_root_identity(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- 4. internal.mcp_root_member_in — the same human's member row in one Space.
--
-- `resolve_mcp_account(p_server, p_root_member)` takes a member ENTITY of the
-- connector's Space, so a chain that crossed Spaces has to re-find the root
-- there. Active rows only: a removed member's running workers lose access on
-- the next call (§6, last line).
-- -----------------------------------------------------------------------------
create or replace function internal.mcp_root_member_in(p_identity text, p_space uuid)
returns uuid language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.entity_id from public.members m
    join public.accounts a on a.identity_id = m.identity_id and a.status = 'active'
   where m.identity_id = p_identity and m.space_id = p_space and m.status = 'active'
$$;
revoke all on function internal.mcp_root_member_in(text, uuid) from public;

-- -----------------------------------------------------------------------------
-- 5. internal.mcp_root_in_every_space — §6.2, one query.
--
-- "Each hop is checked against its own Space, so a chain like A -> B -> A can't
-- launder access." The root must be a CURRENT member of every Space the chain
-- passed through, and the first miss refuses (advisor ruling B18). Re-run on
-- every call, so losing a membership anywhere in the chain withdraws access at
-- the next tool use rather than at the next launch.
-- -----------------------------------------------------------------------------
create or replace function internal.mcp_root_in_every_space(p_identity text, p_spaces uuid[])
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  select p_identity is not null and not exists (
    select 1 from unnest(coalesce(p_spaces, '{}'::uuid[])) as hop(space_id)
     where not exists (
       select 1 from public.members m
         join public.accounts a on a.identity_id = m.identity_id and a.status = 'active'
        where m.space_id = hop.space_id and m.identity_id = p_identity and m.status = 'active'))
$$;
revoke all on function internal.mcp_root_in_every_space(text, uuid[]) from public;

-- -----------------------------------------------------------------------------
-- 6. internal.mcp_provenance — THE §6 walk.
--
-- Returns, always, a jsonb with `reason`; `ready` additionally carries
-- rootMemberId, rootIdentityId, chain, chainSpaceIds and depth. It never
-- raises for a provenance refusal, because the caller has to be able to tell
-- "skip this default" from "this launch is broken" — and because a raise inside
-- `Querier.rpc` (a bare client.query, no savepoint) poisons the whole bind
-- transaction, which is the lesson `mcp_credential_readiness` was built on.
--
-- `p_source_session` / `p_source_auth_session` are the SPAWNING BEARER's own
-- session and token row, supplied by the server execution handlers off the
-- verified bearer (`mcpSource`), never off a request body. They are not
-- trusted here either: the hop goes through `public.read_mcp_session_binding`,
-- which proves the caller IS that session's runtime, that its token is live and
-- unrevoked, that its launcher is still an active member, and that the session
-- itself is still live. One call reads the whole ancestry, because that
-- session's binding already holds its own chain.
-- -----------------------------------------------------------------------------
create or replace function internal.mcp_provenance(
  p_session uuid, p_source_session uuid default null, p_source_auth_session uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  MAX_DEPTH constant integer := 8;   -- §6.1
  v_entity public.entities;
  v_target uuid;
  v_kind text;
  v_root_member uuid;
  v_root_identity text;
  v_chain uuid[];
  v_spaces uuid[];
  v_source jsonb;
  v_source_entity public.entities;
  v_loop public.loops;
  v_loop_entity uuid;
  v_via text;
  v_root_kind text;
  v_source_space uuid;
begin
  select * into v_entity from public.entities
   where id = p_session and deleted_at is null and kind in ('work_session', 'chat');
  if v_entity.id is null then
    return jsonb_build_object('reason', 'session_unavailable');
  end if;
  v_target := v_entity.space_id;
  v_chain := array[p_session];
  v_spaces := array[v_target];
  v_kind := coalesce(internal.claim_text('tm8.auth_kind'), '');

  -- §6.5. A session started through a space link gets NO connectors, and the
  -- rule is stated here too so no caller of this function has to remember it.
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' or v_kind = 'link' then
    return jsonb_build_object('reason', 'link_session');
  end if;

  if p_source_session is not null and p_source_auth_session is not null
     and v_kind in ('agent', 'agent_runtime') then
    -- HOP: the spawning bearer's own session. Every liveness and membership
    -- check lives in read_mcp_session_binding; a refusal there means the
    -- delegated launch has no verifiable human behind it any more.
    begin
      v_source := public.read_mcp_session_binding(p_source_session, p_source_auth_session);
    exception when others then
      v_source := null;
    end;
    if v_source is null then
      return jsonb_build_object('reason', 'source_unavailable');
    end if;
    v_via := 'bearer_source';
    if v_source ? 'chain' and jsonb_array_length(v_source -> 'chain') > 0 then
      v_chain := v_chain || array(select (value #>> '{}')::uuid from jsonb_array_elements(v_source -> 'chain'));
      v_spaces := v_spaces || array(select (value #>> '{}')::uuid from jsonb_array_elements(v_source -> 'chainSpaceIds'));
      v_root_identity := v_source ->> 'rootIdentityId';
      v_root_kind := nullif(v_source ->> 'rootAuthKind', '');
    else
      -- A binding written before 343 records no chain. Its launcher identity
      -- WAS checked against the human auth kinds when it was written, and that
      -- kind is stored, so it is still a sound one-hop root — but a stored kind
      -- that is not human is exactly a binding written with no root, and it
      -- must not become one now.
      if not (coalesce(v_source ->> 'launcherAuthKind', '') in ('browser', 'cli')) then
        return jsonb_build_object('reason', 'no_human_provenance');
      end if;
      v_chain := v_chain || array[p_source_session];
      -- Into a scalar, then appended: `select into` an array SUBSCRIPT would
      -- leave the slot silently null if the row were missing, and a null hop
      -- Space is a hop §6.2 then cannot check.
      select e.space_id into v_source_space from public.entities e where e.id = p_source_session;
      if v_source_space is null then
        return jsonb_build_object('reason', 'source_unavailable');
      end if;
      v_spaces := v_spaces || array[v_source_space];
      v_root_identity := v_source ->> 'launcherIdentityId';
      v_root_kind := v_source ->> 'launcherAuthKind';
      v_via := 'bearer_source_legacy';
    end if;
    if array_length(v_chain, 1) > MAX_DEPTH then
      return jsonb_build_object('reason', 'depth_exceeded', 'depth', array_length(v_chain, 1));
    end if;
    if v_root_identity is null then
      -- B19's chat terminal: a chat's requester is a server fact written at the
      -- human-gated `start_chat`, so a chat hop still has a root even when its
      -- own binding predates this migration and carried none.
      select * into v_source_entity from public.entities where id = p_source_session;
      if v_source_entity.kind = 'chat' then
        select internal.mcp_provenance_root_identity(c.configured_by_member_id, v_source_entity.space_id)
          into v_root_identity from public.chats c where c.entity_id = p_source_session;
        v_via := 'chat_requester';
      end if;
    end if;
    if v_root_identity is null then
      return jsonb_build_object('reason', 'no_human_provenance');
    end if;

  elsif v_kind in ('browser', 'cli') then
    -- TERMINAL: a human bearer is the root. `current_member_id` is pinned
    -- (227), so a space-pinned human session can only ever be the root of a
    -- launch in its own pinned Space.
    v_root_member := internal.current_member_id(v_target);
    v_root_identity := internal.mcp_provenance_root_identity(v_root_member, v_target);
    v_root_kind := v_kind;
    v_via := 'human_bearer';
    if v_root_identity is null then
      return jsonb_build_object('reason', 'root_not_in_space');
    end if;

  elsif v_kind in ('agent', 'agent_runtime') then
    -- An agent bearer that cannot name its own session has nothing to hop to.
    return jsonb_build_object('reason', 'source_unavailable');

  else
    -- NO BEARER AT ALL: the in-process shapes. Only §6's two new terminals can
    -- give one a root, and the order matters — see the header on why a schedule
    -- firing must never fall through to the persona's owner.
    select l.* into v_loop from public.loops l
      join public.edges e on e.src_id = p_session and e.type = 'triggered_by' and e.dst_id = l.entity_id
      join public.entities le on le.id = l.entity_id
     where le.space_id = v_target and le.deleted_at is null
     order by l.entity_id limit 1;
    if v_loop.entity_id is not null then
      v_loop_entity := v_loop.entity_id;
      v_root_identity := internal.mcp_provenance_root_identity(v_loop.armed_by_member_id, v_target);
      v_via := 'schedule_armed_by';
      if v_root_identity is null then
        -- An unarmed loop, or one armed by a member who has since left. Fails
        -- closed: `entities.created_by` is NOT consulted (B19).
        return jsonb_build_object('reason', 'no_human_provenance', 'loopId', v_loop_entity);
      end if;
    else
      /*
       * THERE IS NO TEAMMATE-AUTONOMOUS TERMINAL (ruling B21, which overrules
       * B19's persona-owner clause). A no-bearer session whose only facts are
       * about a persona gets no root and no connection that needs an account.
       * Three verified facts decided it, any one of which makes a persona-owner
       * tier fail OPEN:
       *
       *  1. It would be the fallback for EVERY loop firing, not a rare
       *     residual. `createLoopExecutorPort.fire` writes the session's
       *     `triggered_by` edge AFTER `spawnService.spawn` returns
       *     (execution-handlers.ts:3063 vs :3020), and `bind` runs INSIDE that
       *     spawn — so at bind time a firing has no edge to its loop and the
       *     schedule branch above cannot see it. Every firing would land here.
       *  2. That edge write is best-effort and its failure is swallowed
       *     (`writeTriggeredBy` catches everything), so even once the ordering
       *     is fixed, a failed edge write would silently fall through to this
       *     branch instead of refusing.
       *  3. `create_loop` requires only that the persona be live in the Space
       *     (091:196) — not `can_act_as` — so a member can arm a loop on a
       *     persona owned by SOMEONE ELSE. The persona's owner is therefore not
       *     a safe stand-in for "who armed this", and lending their connections
       *     to a prompt another member wrote is exactly the laundering §6 is
       *     for. It would also re-open the node-owner defect #1316 closed, by a
       *     second door.
       *
       * So a schedule roots ONLY through `armed_by`, with no second tier. If a
       * real teammate-autonomous path appears, it needs its own armed-by-style
       * human fact, written at the moment a human authorised it (B21).
       *
       * Making the schedule branch REACHABLE on a FIRST firing is an ordering
       * fix in the loop executor, filed as follow-up work rather than papered
       * over here: the loop id must reach bind as a server fact, the session's
       * `triggered_by` edge must be written inside `execution_spawn`'s own
       * transaction like `launched_by`, and a failed write must abort a firing
       * rather than be swallowed. Until then a firing simply gets no auth
       * connectors, which is #1316's behaviour and fails closed.
       */
      return jsonb_build_object('reason', 'no_human_provenance');
    end if;
  end if;

  -- §6.2, every hop. Also covers the target Space, which is always chain[1]'s.
  if not internal.mcp_root_in_every_space(v_root_identity, v_spaces) then
    return jsonb_build_object('reason', 'root_not_in_space');
  end if;
  -- §6.3/§6.4 need the root as a member ENTITY of the connector's Space, which
  -- is the target Space for every selection bind accepts.
  v_root_member := internal.mcp_root_member_in(v_root_identity, v_target);
  if v_root_member is null then
    return jsonb_build_object('reason', 'root_not_in_space');
  end if;
  return jsonb_build_object('reason', 'ready', 'rootMemberId', v_root_member,
    'rootIdentityId', v_root_identity, 'chain', to_jsonb(v_chain),
    'chainSpaceIds', to_jsonb(v_spaces), 'depth', array_length(v_chain, 1), 'via', v_via,
    -- The HUMAN auth kind of the root, when the root came from a bearer at all.
    -- `bind` replays it on the synthesized root claims so a door that gates on
    -- `tm8.auth_kind` sees the kind the human actually held — never a fabricated
    -- one: a schedule or teammate root has no bearer, so this is null and every
    -- human gate refuses, which is the intended answer for those two.
    'rootAuthKind', case when v_root_kind in ('browser', 'cli') then v_root_kind else null end)
    || case when v_loop_entity is null then '{}'::jsonb
            else jsonb_build_object('loopId', v_loop_entity) end;
end
$$;
revoke all on function internal.mcp_provenance(uuid, uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- 7. public.mcp_provenance_for_bind — what `bind` reads BEFORE it resolves.
--
-- `bind` has to know the root before it resolves accounts, because 341's
-- `resolve_mcp_account` takes the root member and refuses one that is not the
-- claims in force (B3) — so `bind` opens its resolution transaction UNDER the
-- root's claims. That ordering is why this is a separate door from
-- `bind_mcp_session`, which runs last.
--
-- AUTHENTICATION IS THE FRESHLY MINTED AGENT TOKEN, exactly as
-- `bind_mcp_session` does it: only the spawner of this session holds it, and
-- the claims in force at bind time are not yet the root's. That also makes the
-- door work for the loop executor, whose claims are the node owner's and who
-- may not be able to read the session as an entity at all.
-- -----------------------------------------------------------------------------
create function public.mcp_provenance_for_bind(
  p_session uuid, p_token_hash text,
  p_source_session uuid default null, p_source_auth_session uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare s public.auth_sessions; v_space uuid;
begin
  select * into s from public.auth_sessions
   where token_hash = p_token_hash and revoked_at is null and expires_at > now() and via_link_id is null;
  if s.id is null or not ((s.kind = 'agent' and s.work_session_id = p_session)
                       or (s.kind = 'agent_runtime' and s.runtime_chat_id = p_session)) then
    raise exception 'MCP runtime unavailable' using errcode = '42501';
  end if;
  select space_id into v_space from public.entities where id = p_session and deleted_at is null;
  if v_space is null or s.space_id is distinct from v_space then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  return internal.mcp_provenance(p_session, p_source_session, p_source_auth_session);
end
$$;
revoke all on function public.mcp_provenance_for_bind(uuid, text, uuid, uuid) from public;
grant execute on function public.mcp_provenance_for_bind(uuid, text, uuid, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 8. bind_mcp_session — 298's body, plus the chain written down.
--
-- The signature gains the source bearer and the root `bind` actually resolved
-- under. 298's three-argument form is DROPPED rather than kept beside this one:
-- two overloads reachable by three arguments is `function is not unique`, and a
-- caller that still passes three now lands here with the provenance arguments
-- null — which derives a root from the bearer alone and refuses a non-empty
-- selection if there is none. That is the fail-closed direction.
--
-- `p_root_member` is a CONSISTENCY CHECK, not an input: this function derives
-- provenance itself and refuses if the caller resolved under a different root.
-- A disagreement means the chain moved between `bind`'s two statements, and
-- silently storing one root while accounts were opened under another is exactly
-- the confusion §6 exists to prevent.
-- -----------------------------------------------------------------------------
drop function public.bind_mcp_session(uuid, text, jsonb);

create function public.bind_mcp_session(p_session uuid, p_token_hash text, p_selections jsonb,
  p_source_session uuid default null, p_source_auth_session uuid default null,
  p_root_member uuid default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.auth_sessions; runtime_identity text; target_space uuid; pick jsonb; definition jsonb;
  launcher text := internal.identity_id(); provenance jsonb; v_root uuid; v_chain uuid[]; v_spaces uuid[];
begin
  if launcher is null or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  select * into s from public.auth_sessions
   where token_hash = p_token_hash and revoked_at is null and expires_at > now() and via_link_id is null;
  if s.id is null or not ((s.kind = 'agent' and s.work_session_id = p_session)
                       or (s.kind = 'agent_runtime' and s.runtime_chat_id = p_session)) then
    raise exception 'MCP runtime unavailable' using errcode = '42501';
  end if;
  select identity_id into runtime_identity from public.accounts where id = s.account_id and status = 'active';
  select space_id into target_space from public.entities where id = p_session and deleted_at is null;
  perform internal.require_space_member(target_space);
  if runtime_identity is null or s.space_id is distinct from target_space
     or not internal.entity_readable(p_session) then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) > 32 then
    raise exception 'Invalid MCP selections' using errcode = '22023';
  end if;

  /*
   * §6 again, independently of whatever the caller believed.
   *
   * THIS RUNS UNDER THE ROOT'S CLAIMS, because that is the transaction `bind`
   * resolves accounts in. For a human-bearer chain the two derivations converge
   * by construction: the root's replayed kind is browser|cli, so the walk takes
   * the human terminal and lands on the same member it started from. For a
   * SCHEDULE root they do not converge — the root carries no bearer kind, so the
   * walk reaches the no-bearer branch and looks for THIS session's own loop,
   * which a delegated CHILD of a schedule-rooted session does not have.
   *
   * The consequence is a loud refusal below, not a silent widening: nothing is
   * bound and nothing is lent. It is unreachable today, because a schedule root
   * needs the loop-executor ordering fix first (see the header), and it is
   * recorded on that follow-up task so the shape and its fix land together.
   */
  provenance := internal.mcp_provenance(p_session, p_source_session, p_source_auth_session);
  if provenance ->> 'reason' = 'ready' then
    v_root := (provenance ->> 'rootMemberId')::uuid;
    v_chain := array(select (value #>> '{}')::uuid from jsonb_array_elements(provenance -> 'chain'));
    v_spaces := array(select (value #>> '{}')::uuid from jsonb_array_elements(provenance -> 'chainSpaceIds'));
    if p_root_member is not null and p_root_member <> v_root then
      raise exception 'MCP provenance root changed during launch' using errcode = '42501';
    end if;
  end if;
  -- NO BLANKET REFUSAL on a rootless launch. #1316 settled the shape of this:
  -- a connector that needs no ACCOUNT is still bound, because the rule withholds
  -- connections and not connectors, and a schedule firing must still run. The
  -- refusal is therefore per-pick, in the `auth.type <> 'none'` arm below —
  -- which is also what keeps "asking for no connectors must never refuse the
  -- spawn" true for every caller, the lesson of 298's delegated path.

  for pick in select value from jsonb_array_elements(p_selections) loop
    select m.definition into definition from public.mcp_servers m join public.entities e on e.id = m.entity_id
      where e.id = (pick ->> 'serverId')::uuid and e.space_id = target_space and e.deleted_at is null;
    if definition is null or definition ->> 'approved' <> 'true' or definition ->> 'enabled' = 'false'
      or (definition ->> 'transport' = 'stdio' and coalesce(definition ->> 'stdioTrusted', 'false') <> 'true') then
      raise exception 'MCP connector unavailable' using errcode = '42501';
    end if;
    if definition -> 'auth' ->> 'type' <> 'none' then
      if pick ->> 'credentialId' is null then raise exception 'Select an MCP account' using errcode = '42501'; end if;
      -- A connector that needs an ACCOUNT needs a root: without one there is
      -- nobody whose connection this could be.
      if v_root is null then
        raise exception 'MCP launch has no human provenance (%)', provenance ->> 'reason'
          using errcode = '42501';
      end if;
      perform public.read_mcp_credential(target_space, (pick ->> 'serverId')::uuid, (pick ->> 'credentialId')::uuid);
    elsif pick ->> 'credentialId' is not null then
      raise exception 'Unexpected MCP account' using errcode = '42501';
    end if;
  end loop;

  -- Columns NAMED, not positional: 298's insert relied on column order and this
  -- migration appends four columns to both tables.
  insert into internal.mcp_session_bindings
    (session_id, space_id, auth_session_id, runtime_identity_id, launcher_identity_id,
     launcher_auth_kind, selections, root_member_id, root_identity_id, chain, chain_space_ids)
    values (p_session, target_space, s.id, runtime_identity, launcher,
            coalesce(internal.claim_text('tm8.auth_kind'), ''), p_selections,
            v_root, provenance ->> 'rootIdentityId', v_chain, v_spaces)
    on conflict (session_id) do update set auth_session_id = excluded.auth_session_id,
      runtime_identity_id = excluded.runtime_identity_id,
      launcher_identity_id = excluded.launcher_identity_id,
      launcher_auth_kind = excluded.launcher_auth_kind, selections = excluded.selections,
      root_member_id = excluded.root_member_id, root_identity_id = excluded.root_identity_id,
      chain = excluded.chain, chain_space_ids = excluded.chain_space_ids;
  insert into internal.mcp_launch_selections
    (session_id, selections, launcher_identity_id, launcher_auth_kind,
     root_member_id, root_identity_id, chain, chain_space_ids)
    values (p_session, p_selections, launcher, coalesce(internal.claim_text('tm8.auth_kind'), ''),
            v_root, provenance ->> 'rootIdentityId', v_chain, v_spaces)
    on conflict (session_id) do update set selections = excluded.selections,
      launcher_identity_id = excluded.launcher_identity_id,
      launcher_auth_kind = excluded.launcher_auth_kind,
      root_member_id = excluded.root_member_id, root_identity_id = excluded.root_identity_id,
      chain = excluded.chain, chain_space_ids = excluded.chain_space_ids;
  return provenance;
end
$$;
revoke all on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid) from public;
grant execute on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 9. read_mcp_session_binding — 332's body, plus §6 RE-CHECKED ON EVERY CALL.
--
-- This is the function the proxy already calls through `authorize` before every
-- single upstream send (`proxy.ts` re-authorizes at `rpc`, after a refresh and
-- after a 401 retry), so it is where §6's "re-checked on every tools/list and
-- tools/call" actually lands. Two things are added to 332's checks:
--
--   * §6.2 — the root must still be a current member of EVERY Space in the
--     recorded chain, not merely of this session's own (B18); and
--   * the root must still resolve to a member row in this Space, which is what
--     withdraws access from a member removed mid-session.
--
-- A binding written before 343 has a null chain and keeps exactly 332's
-- behaviour, which is the launcher membership check it already had — nothing
-- gains access by being old, and `authorize` separately refuses a stored
-- launcher kind that is not human.
-- -----------------------------------------------------------------------------
create or replace function public.read_mcp_session_binding(p_session uuid, p_auth_session uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b internal.mcp_session_bindings; generation_read boolean := false; v_root uuid;
begin
  if internal.claim_text('tm8.auth_kind') = 'agent_runtime' then
    if p_auth_session::text is distinct from internal.claim_text('tm8.auth_session_id')
      or not exists(select 1 from public.auth_sessions where id = p_auth_session and runtime_chat_id = p_session) then
      raise exception 'MCP session unavailable' using errcode = '42501';
    end if;
    perform internal.assert_chat_generation(true);
    generation_read := true;
  end if;
  select * into b from internal.mcp_session_bindings where session_id = p_session and auth_session_id = p_auth_session;
  if b.session_id is null or b.runtime_identity_id is distinct from
      (case when generation_read then internal.claim_text('tm8.identity_id') else internal.identity_id() end)
    or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  if generation_read then
    if (internal.session_space_id() is not null and b.space_id <> internal.session_space_id())
      or not exists(select 1 from public.members member join public.entities entity on entity.id = member.entity_id
        where member.identity_id = b.runtime_identity_id and member.space_id = b.space_id
          and member.status = 'active' and entity.deleted_at is null) then
      raise exception 'MCP session unavailable' using errcode = '42501';
    end if;
  else perform internal.require_space_member(b.space_id); end if;
  if not exists(select 1 from public.auth_sessions session join public.accounts account on account.id = session.account_id
      where session.id = b.auth_session_id and session.revoked_at is null and session.expires_at > clock_timestamp()
        and session.via_link_id is null and account.status = 'active')
    or not exists(select 1 from public.members member join public.accounts account on account.identity_id = member.identity_id
      where member.space_id = b.space_id and member.identity_id = b.launcher_identity_id and member.status = 'active' and account.status = 'active')
    or not exists(select 1 from public.entities entity where entity.id = p_session and entity.space_id = b.space_id and entity.deleted_at is null
      and (generation_read or exists(select 1 from public.work_sessions work where work.entity_id = entity.id and work.status in ('spawning', 'running', 'idle'))
        or exists(select 1 from public.chats chat where chat.entity_id = entity.id and chat.runtime_state = 'live'))) then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  -- 343 / §6.2. Only for a binding that recorded a chain; see the header.
  if b.root_identity_id is not null then
    if not internal.mcp_root_in_every_space(b.root_identity_id, b.chain_space_ids) then
      raise exception 'MCP provenance root is no longer a member of every space in the chain'
        using errcode = '42501';
    end if;
    v_root := internal.mcp_root_member_in(b.root_identity_id, b.space_id);
    if v_root is null then
      raise exception 'MCP provenance root is no longer a member of this space' using errcode = '42501';
    end if;
  end if;
  return jsonb_build_object('sessionId', b.session_id, 'spaceId', b.space_id, 'identityId', b.runtime_identity_id,
    'launcherIdentityId', b.launcher_identity_id, 'launcherAuthKind', b.launcher_auth_kind, 'selections', b.selections,
    'rootMemberId', v_root, 'rootIdentityId', b.root_identity_id,
    -- Carried so a chain deeper than one hop keeps replaying the human's own
    -- kind rather than losing it at the first hop (343).
    'rootAuthKind', case when b.launcher_auth_kind in ('browser', 'cli') then b.launcher_auth_kind else null end,
    'chain', to_jsonb(coalesce(b.chain, '{}'::uuid[])),
    'chainSpaceIds', to_jsonb(coalesce(b.chain_space_ids, '{}'::uuid[])),
    'depth', coalesce(array_length(b.chain, 1), 0));
end
$$;
revoke all on function public.read_mcp_session_binding(uuid, uuid) from public;
grant execute on function public.read_mcp_session_binding(uuid, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 10. public.mcp_session_provenance — the exposed reader (§6.1 "record the
--     chain"; §10.6's session debug view; t-audit-log's source).
--
-- Returns what was RECORDED at bind, never a fresh walk: an audit row has to
-- say what the launch actually ran under, and a later walk would answer about
-- the graph as it is now. t-audit-log owns `mcp_call_audit`'s columns and reads
-- this; nothing here touches that table.
--
-- Gated like `read_mcp_launch_selections` (298): the session must be readable to
-- the caller, and a link caller is refused outright because this function sits
-- off the human-auth gate and would otherwise tell a link session which members
-- are behind a Space's running agents.
-- -----------------------------------------------------------------------------
create function public.mcp_session_provenance(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare r record;
begin
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' or coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'linked MCP provenance is unavailable' using errcode = '42501';
  end if;
  if not internal.entity_readable(p_session) then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  select l.root_member_id, l.root_identity_id, l.chain, l.chain_space_ids,
         l.launcher_identity_id, l.launcher_auth_kind
    into r from internal.mcp_launch_selections l where l.session_id = p_session;
  if r.chain is null and r.launcher_identity_id is null then
    return jsonb_build_object('sessionId', p_session, 'recorded', false);
  end if;
  return jsonb_build_object('sessionId', p_session, 'recorded', true,
    'rootMemberId', r.root_member_id, 'rootIdentityId', r.root_identity_id,
    'chain', to_jsonb(coalesce(r.chain, '{}'::uuid[])),
    'chainSpaceIds', to_jsonb(coalesce(r.chain_space_ids, '{}'::uuid[])),
    'depth', coalesce(array_length(r.chain, 1), 0),
    'launcherIdentityId', r.launcher_identity_id, 'launcherAuthKind', r.launcher_auth_kind,
    'rootStillAdmitted', coalesce(internal.mcp_root_in_every_space(r.root_identity_id, r.chain_space_ids), false));
end
$$;
revoke all on function public.mcp_session_provenance(uuid) from public;
grant execute on function public.mcp_session_provenance(uuid) to tm8_app;

grant execute on function internal.mcp_provenance(uuid, uuid, uuid) to tm8_app;
grant execute on function internal.mcp_root_in_every_space(text, uuid[]) to tm8_app;
grant execute on function internal.mcp_root_member_in(text, uuid) to tm8_app;
grant execute on function internal.mcp_provenance_root_identity(uuid, uuid) to tm8_app;

analyze internal.mcp_session_bindings, internal.mcp_launch_selections, public.loops;
reset role;

-- -----------------------------------------------------------------------------
-- VERIFY. Structural only: the behaviour is pinned by
-- packages/server/test/db/mcp-provenance.pg.test.ts (the §6 deny matrix).
-- -----------------------------------------------------------------------------
do $verify$
begin
  -- By catalog and by ARITY, not by `::regprocedure`: that cast RAISES when the
  -- signature is absent, which is the very thing being asserted, and
  -- `pg_get_function_identity_arguments` prints parameter NAMES, so matching its
  -- text is a pin on names rather than on the shape. 298's form took three
  -- arguments; this one takes six, and leaving both reachable by three
  -- arguments would be `function is not unique` at every call.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'bind_mcp_session' and p.pronargs = 3) then
    raise exception 'VERIFY 343: the three-argument bind_mcp_session still exists';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'bind_mcp_session' and p.pronargs = 6) then
    raise exception 'VERIFY 343: the six-argument bind_mcp_session is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'loops_stamp_armed_by' and not tgisinternal) then
    raise exception 'VERIFY 343: the loop armed-by trigger is missing';
  end if;
  if (select count(*) from pg_attribute
       where attrelid = 'internal.mcp_session_bindings'::regclass
         and attname in ('root_member_id', 'root_identity_id', 'chain', 'chain_space_ids')
         and not attisdropped) <> 4 then
    raise exception 'VERIFY 343: the binding is missing a provenance column';
  end if;
  -- The depth cap is a CHECK, not only a branch, so no future writer can store
  -- a chain longer than §6.1 allows.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'internal.mcp_session_bindings'::regclass
                    and conname = 'mcp_session_bindings_chain_shape' and convalidated) then
    raise exception 'VERIFY 343: the chain shape check is missing or not validated';
  end if;
end
$verify$;
