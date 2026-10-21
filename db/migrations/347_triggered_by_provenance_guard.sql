-- =============================================================================
-- 347 — SECURITY: a `triggered_by` edge is run history, not an authority.
--
-- 343 made `loops.armed_by_member_id` the §6 provenance root of a schedule
-- firing, and had `internal.mcp_provenance` find the loop by joining ANY
-- `triggered_by` edge from the session. That is a cross-member privilege
-- escalation, LIVE on main since #1319. Two facts make it so:
--
--   1. ANY MEMBER CAN WRITE THAT EDGE. `public.write_edge` authorizes with
--      nothing but `internal.require_space_member(src.space_id)`
--      (129:98) — no ownership check on the session or the loop — and
--      `triggered_by` has NO writer guard: 091:138 registers the type with no
--      equivalent of `launched_by`'s `guard_launched_by_writer` (330:55). The
--      only other constraint is the registered kind pair (work_session -> loop),
--      which a forged edge satisfies by construction.
--
--   2. THERE IS A NO-BEARER BIND PATH THAT IS NOT THE FIRING. `mcp_provenance`
--      takes its no-bearer branch when `tm8.auth_kind` is empty. The forms
--      delivery drain's claims are exactly that shape —
--      `{ identityId, nodeAdmin, requestId: 'forms-delivery' }`, no authKind
--      (packages/server/src/main.ts:482) — and it RESUMES sessions
--      (form-delivery-spawn.ts:108 -> SpawnService.resume -> `bind`, which
--      always re-derives provenance, SpawnService.ts:2632).
--
-- So: a member writes `triggered_by` from a session of theirs to a loop armed
-- by SOMEONE ELSE; the drain later resumes that session under server no-bearer
-- claims; bind roots it at the armer; resolution then runs under the armer's
-- claims and lends the armer's personal connections. Cross-human credential
-- escalation, which is the exact thing §6 exists to prevent.
--
-- The same mechanism needs no forgery at all for the DISPATCHER: the loop
-- executor writes a best-effort `triggered_by` edge onto the REUSED,
-- Space-wide dispatcher session, so any no-bearer bind of that dispatcher roots
-- it at that loop's armer.
--
-- THE FIX, in three parts.
--
--   1. A MARKER THE SERVER ALONE CAN SET. `triggered_by.props.provenance`,
--      registered in the type's `props_schema`, and a BEFORE INSERT OR UPDATE
--      trigger that refuses to let anyone but the spawn writer set or change
--      it (`internal.w1_writer() = 'spawn'`, the `launched_by` pattern).
--      Unmarked writes stay allowed, because run history is a legitimate thing
--      for clients and for the executor to record.
--
--   2. THE READ IS NARROWED to marked edges only. `internal.mcp_provenance` is
--      replaced on 343's body with exactly one predicate added — see the diff
--      note on the function below.
--
--      ON MAIN THIS MATCHES NOTHING. No edge carries the marker yet, because
--      the only writer of a marked edge is migration 348 (PR #1325), which is
--      not merged. So the schedule branch fails closed and a loop firing is
--      lent no connector that needs an account — #1316's behaviour, and the
--      behaviour main has had all along, since the first-firing path was
--      unreachable anyway (that unreachability is what #1325 fixes). Nothing
--      legitimate is withdrawn by this migration.
--
--   3. REMEDIATION OF BINDINGS ALREADY WRITTEN THROUGH THE HOLE (advisor B49
--      item 3). Narrowing the read is not enough on its own: `authorize`
--      trusts the RECORDED root on the binding row, so a session already rooted
--      at an armer through a forged or run-history edge would keep that human's
--      connections after the fix. Every binding whose session has a
--      `triggered_by` edge to a loop AND whose recorded root is that loop's
--      armer is therefore stripped: the root is NULLed and the selections are
--      cut to the auth-free subset, in both `internal.mcp_session_bindings` and
--      `internal.mcp_launch_selections`.
--
--      This removes nothing legitimate, for the same reason as above: on main
--      no legitimate schedule root can exist yet. Any row it matches was
--      rooted through the hole. The affected sessions keep their connectors
--      that need no account and lose the rest until a human relaunches them.
--      The counts are RAISEd as NOTICEs so the deploy log records whether the
--      hole was ever used.
--
-- NUMBERING. 347 sits above 343 and below #1325's 348/350/351, and is the LAST
-- writer of `internal.mcp_provenance` (verified: no file numbered 344-352 on
-- any branch, local or remote, replaces that function; #1325's 351 replaces
-- `bind_mcp_session` only). #1325 then adds only the marked edge in 348.
--
-- TESTS are not in this migration's PR, per the standing policy in force when
-- it was written; the proving cells follow separately. The PR body names them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The marker is a registered property, so the schema validator admits it.
--    `additionalProperties` stays false: this widens the type by exactly one
--    field, it does not open it.
-- -----------------------------------------------------------------------------
update public.edge_types
   set props_schema = jsonb_build_object(
         'type', 'object',
         'properties', jsonb_build_object(
           'firedAt', jsonb_build_object('type', 'string'),
           'provenance', jsonb_build_object('type', 'boolean')),
         'additionalProperties', false)
 where type = 'triggered_by';

-- -----------------------------------------------------------------------------
-- 2. Only the spawn writer may set or change the marker.
--
--    Modelled on `internal.guard_launched_by_writer` (330:55), and for the same
--    reason: a fact that decides WHOSE credentials a session may use cannot be
--    client-assertable. The guard is on the MARKER, not on the edge, so an
--    ordinary run-history `triggered_by` write is unaffected.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_triggered_by_provenance() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- A change in either direction counts: setting it is the escalation, and
  -- clearing or rewriting someone else's marker is tampering with the record.
  if (tg_op = 'INSERT' and coalesce(new.props, '{}'::jsonb) ? 'provenance')
     or (tg_op = 'UPDATE'
         and (coalesce(new.props, '{}'::jsonb) -> 'provenance')
             is distinct from (coalesce(old.props, '{}'::jsonb) -> 'provenance')) then
    if coalesce(internal.w1_writer(), '') <> 'spawn' then
      raise exception 'triggered_by provenance is recorded by the server when a session is launched'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
revoke all on function internal.guard_triggered_by_provenance() from public;

drop trigger if exists edges_triggered_by_provenance on public.edges;
create trigger edges_triggered_by_provenance before insert or update on public.edges
for each row when (new.type = 'triggered_by')
execute function internal.guard_triggered_by_provenance();

-- -----------------------------------------------------------------------------
-- 3. The read. 343's body verbatim, plus ONE predicate — `and e.props ->>
--    'provenance' = 'true'` in the schedule branch. Diff-proved against 343
--    before committing: that line is the only change.
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
    /*
     * 347 (B46/B49). ONLY A SERVER-WRITTEN PROVENANCE EDGE COUNTS.
     *
     * 343 joined ANY `triggered_by` edge, and that was a privilege escalation:
     * `public.write_edge` authorizes on Space MEMBERSHIP alone (129:98) and
     * `triggered_by` has no writer guard (091:138, unlike `launched_by`'s
     * 330:55), so any member could attach their own session to a loop ARMED BY
     * SOMEONE ELSE and have this branch root them at that human. The marker,
     * and the trigger above that only `w1_writer() = 'spawn'` may set it, are
     * what make the edge an authority rather than a claim.
     *
     * Run history keeps working: the executor's unmarked task and dispatcher
     * edges are still written and still read as history — they simply no
     * longer root anything.
     */
    select l.* into v_loop from public.loops l
      join public.edges e on e.src_id = p_session and e.type = 'triggered_by' and e.dst_id = l.entity_id
      join public.entities le on le.id = l.entity_id
     where le.space_id = v_target and le.deleted_at is null
       and e.props ->> 'provenance' = 'true'
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
-- 4. Remediation: strip every root that could only have come through the hole.
-- -----------------------------------------------------------------------------
do $$
declare
  v_bindings integer := 0;
  v_launches integer := 0;
begin
  -- The auth-free subset is kept rather than emptied: a connector that needs no
  -- ACCOUNT lends nobody's credentials, so withdrawing it would break sessions
  -- for no security gain. §6 withholds connections, not connectors (#1316).
  with suspect as (
    select b.session_id
      from internal.mcp_session_bindings b
     where b.root_member_id is not null
       and exists (
         select 1
           from public.edges e
           join public.loops l on l.entity_id = e.dst_id
          where e.src_id = b.session_id
            and e.type = 'triggered_by'
            and l.armed_by_member_id = b.root_member_id))
  update internal.mcp_session_bindings b
     set root_member_id = null,
         root_identity_id = null,
         selections = coalesce((
           select jsonb_agg(pick.value)
             from jsonb_array_elements(
                    case when jsonb_typeof(b.selections) = 'array'
                         then b.selections else '[]'::jsonb end) as pick(value)
             join public.mcp_servers m on m.entity_id = (pick.value ->> 'serverId')::uuid
            where m.definition -> 'auth' ->> 'type' = 'none'), '[]'::jsonb)
   where b.session_id in (select session_id from suspect);
  get diagnostics v_bindings = row_count;

  with suspect as (
    select s.session_id
      from internal.mcp_launch_selections s
     where s.root_member_id is not null
       and exists (
         select 1
           from public.edges e
           join public.loops l on l.entity_id = e.dst_id
          where e.src_id = s.session_id
            and e.type = 'triggered_by'
            and l.armed_by_member_id = s.root_member_id))
  update internal.mcp_launch_selections s
     set root_member_id = null,
         root_identity_id = null,
         selections = coalesce((
           select jsonb_agg(pick.value)
             from jsonb_array_elements(
                    case when jsonb_typeof(s.selections) = 'array'
                         then s.selections else '[]'::jsonb end) as pick(value)
             join public.mcp_servers m on m.entity_id = (pick.value ->> 'serverId')::uuid
            where m.definition -> 'auth' ->> 'type' = 'none'), '[]'::jsonb)
   where s.session_id in (select session_id from suspect);
  get diagnostics v_launches = row_count;

  -- Recorded in the deploy log on purpose: a non-zero count here is evidence
  -- that the hole was actually used, which is worth knowing even though the
  -- rows are now harmless. Zero is the expected reading.
  raise notice '347 provenance remediation: % binding row(s) and % launch-selection row(s) stripped of an armer root',
    v_bindings, v_launches;
end
$$;
