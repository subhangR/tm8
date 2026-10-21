-- =============================================================================
-- 354 — A CHANGED CHAT SELECTION REACHES THE NEXT TURN (§5.3, §7.3), and B57.
--
-- 345 made a live thread's connectors CHANGEABLE: `update_chat_mcp_selections`
-- upserts where `save_chat_mcp_selections` did `on conflict do nothing`. The
-- row was then right and nothing downstream acted on it, for two separate
-- reasons. This migration fixes the one that is SQL's; the other is the
-- orchestrator's and is fixed in the same PR.
--
-- -----------------------------------------------------------------------------
-- 1. A CHAT'S DEFAULTS WERE PINNED BY ITS OWN FIRST BIND (S21a).
--
-- `McpSessionBindings.bind` runs with `resume: true` on every chat turn, so it
-- reads `internal.mcp_launch_selections` back and treats a stored list as an
-- explicit selection. That is exactly right for a WORKER SESSION, where the row
-- is the pin that keeps a session's connectors stable for its whole life
-- (§7.3, "resume keeps the selection"). For a CHAT it inverted the rule:
-- `bind_mcp_session` wrote the RESOLVED DEFAULT list into that row on the first
-- turn, and every later turn read it back as a human's choice.
--
-- Three consequences, all of them things the plan says must not happen: a
-- connector switched `defaultOn` later never reached an existing thread; a
-- newly connected account never reached one; and §10.4's composer could not
-- tell "Using: Space defaults" from "Custom", because the stored row looked
-- identical either way. 345's own header already described the intended rule —
-- null means "back to defaults, resolved fresh at each turn" — so the write was
-- the bug and the comment was right.
--
-- The fix is one branch: `bind_mcp_session` leaves the row alone for a CHAT
-- key. The absence of a row becomes the answer ("defaults"), and the only
-- writers of a chat's row are then the two human doors. The function is
-- otherwise 351's body verbatim — three additive hunks, no guard touched, with
-- the two-way diff in the PR body (B38).
--
-- `internal.mcp_session_bindings` is UNCONDITIONAL and unchanged: it keeps the
-- root, the chain and the resolved selections for a chat exactly as before,
-- because `authorize` re-checks the pinned account from that row on every proxy
-- call and §5.6's audit takes provenance from it. Nothing that AUTHORISES a
-- call reads `mcp_launch_selections`.
--
-- NOT BACKFILLED, deliberately. A chat row written before this migration stays
-- where it is. There is no way to tell a bind-written row from a human's choice
-- after the fact once a bind has stamped the chain over it, so deleting the
-- ambiguous ones could silently WIDEN a thread that had been set to `[]` back
-- to the Space defaults. An existing thread therefore keeps its stored list
-- until a human touches the picker, which rewrites it through the door below;
-- new threads get the ruled behaviour from their first turn.
--
-- -----------------------------------------------------------------------------
-- 2. B57 — THE PROVENANCE COLUMNS ARE THE BIND'S, NOT THE SELECTION WRITE'S.
--
-- `internal.mcp_launch_selections` carries 343's `root_member_id`,
-- `root_identity_id`, `chain` and `chain_space_ids`. 345's upsert did not
-- mention them, so its `do update` LEFT THEM AS THEY WERE: a thread that had
-- bound once kept the root and chain of that earlier bind sitting beside a
-- selection list the human has since replaced. Nothing reads them as authority
-- — `authorize` reads `mcp_session_bindings`, and `bind` re-derives — but
-- `mcp_session_provenance` reports this very row to §10.6, so the row could
-- answer "recorded: true" with a root that belongs to a previous selection.
--
-- They are now set to NULL on the update arm, which is already what the insert
-- arm produces (it names neither column, so both default to NULL). Provenance
-- on this row is therefore only ever what a BIND wrote.
-- `mcp_launch_selections_chain_shape` (343) admits a null chain, so clearing
-- the pair together stays inside the constraint.
--
-- Combined with part 1 this makes the row's shape legible: on a CHAT row the
-- four columns are now always NULL, because the only writers are the human
-- doors and neither sets them.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. 351's `bind_mcp_session`, plus the chat-key branch on the launch record.
-- -----------------------------------------------------------------------------
create or replace function public.bind_mcp_session(p_session uuid, p_token_hash text, p_selections jsonb,
  p_source_session uuid default null, p_source_auth_session uuid default null,
  p_root_member uuid default null,
  p_chain uuid[] default null, p_chain_spaces uuid[] default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.auth_sessions; runtime_identity text; target_space uuid; pick jsonb; definition jsonb;
  launcher text := internal.identity_id(); provenance jsonb; v_root uuid; v_chain uuid[]; v_spaces uuid[];
  v_root_identity text; v_source_chain uuid[]; v_source_root uuid; v_hop uuid; v_index integer;
  v_source_found boolean;
  v_bound_via text;
  v_chat_key boolean;
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
  -- 354. IS THIS KEY A CHAT? Read off the very auth-session fact the guard
  -- above matched on, so the two can never disagree: an `agent_runtime` bearer
  -- whose `runtime_chat_id` is this id is a chat thread, an `agent` bearer
  -- whose `work_session_id` is this id is a worker session.
  v_chat_key := (s.kind = 'agent_runtime' and s.runtime_chat_id = p_session);
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
   * CORRECTED HERE (B35/B37). 343 said the consequence was "a loud refusal
   * below, not a silent widening: nothing is bound". THAT IS FALSE, and 350
   * carried the sentence forward unchanged, so it is fixed at the first chance
   * — the next reader must not inherit it.
   *
   * What actually happens: when the walk is not ready, `v_root` is left null
   * and the equality check is skipped (there is no else). The `p_chain` branch
   * below then sets `v_root := coalesce(p_root_member, v_root)`, the B28
   * identity anchor passes by construction because this transaction runs AS
   * the root, and the per-pick `v_root is null` refusal therefore cannot fire.
   * So a delegated child of a schedule-rooted session BINDS, through
   * INHERITANCE, and for that shape this re-derivation contributes nothing.
   *
   * THAT IS THE CORRECT OUTCOME, not a hole (B35). For a delegated hop the
   * authority was always the FIRST derivation — `mcp_provenance_for_bind`,
   * under the SOURCE's own agent bearer, where `read_mcp_session_binding`
   * proved the caller really is that session's runtime. This walk is a
   * consistency check that can only converge for a HUMAN-bearer root, because
   * only a human root has a replayed bearer kind to reproduce; a schedule root
   * carries none by construction (B21).
   *
   * Teaching the no-bearer branch to follow the source instead was considered
   * and REFUSED twice over: it would be the self-report B17 forbids, and it is
   * mechanically impossible anyway, because reaching the source's binding means
   * `read_mcp_session_binding` under the root's claims, which raises when
   * `runtime_identity_id` is not `internal.identity_id()` — and for a firing
   * those differ. The only way to make it work is to loosen the check that
   * proves the caller IS that session's runtime.
   *
   * What inheritance must NOT do is lean on checks that fall open. 350 closed
   * the first (a source with no binding row at all); the second is closed
   * below.
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

  /*
   * F1 / B27. THE CHAIN IS INHERITED, NOT RE-DERIVED.
   *
   * The derivation above runs under the ROOT's claims, which is right for the
   * ROOT (the root's own replayed kind reproduces the human terminal and lands
   * on the same member) but WRONG for the CHAIN: the hop branch of
   * `internal.mcp_provenance` is only taken for an agent or agent_runtime
   * caller, and by this point the caller is the root. So it collapsed every
   * chain to `[self]`, the depth cap was unreachable, §6.2 only ever saw the
   * target Space, and the recorded chain an audit row would quote was wrong.
   *
   * `bind` therefore passes the chain it derived EARLIER, under the spawning
   * bearer's own claims, where `mcp_provenance_for_bind` proved the hop through
   * `read_mcp_session_binding`. That is a caller argument, so it is VERIFIED
   * here against facts this function can read for itself rather than trusted:
   * the head is this session, every hop's Space is the one its entity actually
   * carries, the tail is exactly the source binding's own stored chain, and the
   * depth cap applies to the inherited length.
   */
  if p_chain is not null then
    if array_length(p_chain, 1) is null or array_length(p_chain, 1) > 8
       or array_length(p_chain, 1) is distinct from array_length(p_chain_spaces, 1) then
      raise exception 'MCP provenance chain is malformed or exceeds the depth cap' using errcode = '22023';
    end if;
    if p_chain[1] <> p_session then
      raise exception 'MCP provenance chain must start at this session' using errcode = '42501';
    end if;
    -- Every hop's Space is read back from its own entity row, so a caller
    -- cannot understate a Space and dodge §6.2's membership check on it.
    for v_index in 1 .. array_length(p_chain, 1) loop
      select e.space_id into v_hop from public.entities e where e.id = p_chain[v_index];
      if v_hop is null or v_hop <> p_chain_spaces[v_index] then
        raise exception 'MCP provenance chain names a space the hop does not belong to' using errcode = '42501';
      end if;
    end loop;
    -- The tail must be the source's OWN recorded chain. Read straight from the
    -- internal table: authority for the hop was established before the claims
    -- switched (read_mcp_session_binding, under the spawner's claims), and this
    -- is a shape check on the same (session, auth session) pair.
    if p_source_session is not null then
      select true, b.chain, b.root_member_id
        into v_source_found, v_source_chain, v_source_root
        from internal.mcp_session_bindings b
       where b.session_id = p_source_session and b.auth_session_id = p_source_auth_session;
      /*
       * 350 (B35 tightening 1, B36). THE SOURCE BINDING ROW MUST EXIST.
       *
       * Without this the two checks below BOTH fall open for a source that was
       * never bound at all: `coalesce(v_source_chain, array[p_source_session])`
       * invents the very tail it is supposed to verify, so a two-hop chain
       * [child, source] matches; and `v_source_root` is null, so the B28 root
       * anchor under it is skipped. A caller could then name any live session
       * as its source and pass every chain check this branch performs.
       *
       * Not a live exploit today (B36): `bind_mcp_session` is called only by
       * server code, and the TypeScript derivation that runs first takes
       * `read_mcp_session_binding` under the SOURCE's own bearer, which answers
       * `source_unavailable` when there is no row — so no API path arrives here
       * with a bindingless source. It is closed anyway because this function is
       * meant to stand on its own facts (B28), not on its caller's diligence.
       *
       * A source written BEFORE 343 still has a row (with a null `chain` and a
       * null `root_member_id`), so it is unaffected: the existence of the row is
       * what is required here, not its contents.
       */
      if not coalesce(v_source_found, false) then
        raise exception 'MCP provenance chain names a source with no binding'
          using errcode = '42501';
      end if;
      if p_chain[2] is distinct from p_source_session
         or p_chain[2:array_length(p_chain, 1)] is distinct from coalesce(v_source_chain, array[p_source_session]) then
        raise exception 'MCP provenance chain does not match its source binding' using errcode = '42501';
      end if;
      -- B28. The ROOT is inherited too, not just the chain: a delegated launch
      -- roots exactly where its source rooted. A source written before 343
      -- recorded none, and then the identity check below is the whole authority.
      if v_source_root is not null and p_root_member is distinct from v_source_root then
        raise exception 'MCP provenance root does not match its source binding' using errcode = '42501';
      end if;
      /*
       * 351 (B35 tightening 2). A NON-CONVERGING RE-DERIVATION NEEDS SOMETHING
       * TO INHERIT.
       *
       * When the walk above did not converge, the root is NOT anchored by this
       * function's own derivation — it comes from the caller, checked only
       * against the source binding. The check above is skipped entirely when
       * the source recorded no root, which would leave a multi-hop inherited
       * root resting on nothing but the identity anchor.
       *
       * So: not ready, and more than one hop, requires the source to carry a
       * RECORDED root.
       *
       * WHY THIS CANNOT REFUSE A LEGITIMATE LAUNCH (the #1319 owner's argument,
       * kept verbatim because it is the whole safety case): the only
       * non-converging shape is a SCHEDULE root — a human-bearer root replays
       * its own kind, takes the human terminal and converges — and schedule
       * roots did not exist before 343, which is also when `root_member_id`
       * started being recorded. So no pre-343 binding can ever be the source of
       * a non-converging child. Pre-343 sources appear only under CONVERGING
       * chains, where this requirement does not apply.
       */
      if provenance ->> 'reason' <> 'ready'
         and array_length(p_chain, 1) > 1
         and v_source_root is null then
        raise exception 'MCP provenance root cannot be inherited from a source that recorded none'
          using errcode = '42501';
      end if;
    elsif array_length(p_chain, 1) <> 1 then
      raise exception 'MCP provenance chain has no source to justify its hops' using errcode = '42501';
    end if;
    v_chain := p_chain;
    v_spaces := p_chain_spaces;
    -- 351 (B35 tightening 3). An INHERITED root — the re-derivation did not
    -- converge, so what stands behind it is the chain and root anchors above,
    -- not this function's own walk. Reported so an audit can tell a delegated
    -- schedule child from a converged chain instead of guessing.
    if provenance ->> 'reason' <> 'ready' and p_root_member is not null then
      v_bound_via := 'inherited';
    end if;
    v_root := coalesce(p_root_member, v_root);
    v_root_identity := internal.mcp_provenance_root_identity(v_root, target_space);
    -- §6.2 over the FULL array, now that it has more than one hop in it.
    if v_root_identity is null or not internal.mcp_root_in_every_space(v_root_identity, v_spaces) then
      raise exception 'MCP provenance root is not a member of every space in the chain' using errcode = '42501';
    end if;
  end if;

  /*
   * B28. THE STORED ROOT IS BOUND TO A FACT THIS FUNCTION READS ITSELF.
   *
   * `p_root_member` is a caller argument, and the ready-path equality check
   * above does not fire when the in-SQL walk returns a NON-ready reason — so
   * without this a caller could hand in another member as the root, have it
   * stored, and have `authorize` resolve that member's connections under it
   * forever after.
   *
   * The binding fact is B3's rule, moved into SQL: `bind` always resolves
   * accounts under the ROOT's own claims, so the root's identity must be the
   * identity THIS TRANSACTION is running as. A forged member therefore has to
   * belong to the caller already, which makes the forgery worthless. It holds
   * for every shape: a human bearer is its own root, a delegated launch runs
   * under the inherited root's claims, and a schedule firing runs under the
   * armer's.
   */
  if v_root is not null then
    v_root_identity := coalesce(v_root_identity,
      internal.mcp_provenance_root_identity(v_root, target_space));
    if v_root_identity is null or v_root_identity is distinct from launcher then
      raise exception 'MCP provenance root must be the identity this launch resolves as'
        using errcode = '42501';
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
            v_root, coalesce(v_root_identity, provenance ->> 'rootIdentityId'), v_chain, v_spaces)
    on conflict (session_id) do update set auth_session_id = excluded.auth_session_id,
      runtime_identity_id = excluded.runtime_identity_id,
      launcher_identity_id = excluded.launcher_identity_id,
      launcher_auth_kind = excluded.launcher_auth_kind, selections = excluded.selections,
      root_member_id = excluded.root_member_id, root_identity_id = excluded.root_identity_id,
      chain = excluded.chain, chain_space_ids = excluded.chain_space_ids;
  -- 354 (S21a). THE LAUNCH RECORD IS FOR SESSION KEYS ONLY.
  --
  -- For a worker session this row is the PIN a resume reads back, which is what
  -- keeps a session's connectors stable for its whole life. For a CHAT it was
  -- the opposite of that: every turn is a resume, so the first turn's RESOLVED
  -- DEFAULTS were written here and every later turn read them back as an
  -- explicit selection. A connector switched `defaultOn` afterwards never
  -- reached an existing thread, a newly connected account never reached one,
  -- and the composer could no longer tell "Space defaults" from "Custom"
  -- (§10.4) because the stored row looked identical either way.
  --
  -- So for a chat key the row is left alone, and the absence of a row IS the
  -- answer: no row means defaults, re-resolved on every turn. The only writers
  -- of a chat's row are then the two human doors, `save_chat_mcp_selections`
  -- and `update_chat_mcp_selections` — a chat's stored row means "a human chose
  -- this", and nothing else can put one there.
  --
  -- `internal.mcp_session_bindings` above is UNCONDITIONAL and keeps every
  -- column it had, chat or session (the backend advisor's condition on this
  -- change): `authorize` re-checks the pinned account from that row on every
  -- proxy call, and §5.6's audit takes the root and chain from it. Nothing that
  -- authorises a call reads `mcp_launch_selections`.
  --
  -- WHAT A CHAT GIVES UP is `mcp_session_provenance`, §10.6's debug read, which
  -- reports this row: for a chat on defaults it now answers `recorded: false`
  -- rather than quoting the last bind. Said plainly rather than papered over —
  -- the authoritative copy is on the binding, and a launch RECORD that drifts
  -- into being a launch PIN is the defect being removed here.
  if not v_chat_key then
    insert into internal.mcp_launch_selections
      (session_id, selections, launcher_identity_id, launcher_auth_kind,
       root_member_id, root_identity_id, chain, chain_space_ids)
      values (p_session, p_selections, launcher, coalesce(internal.claim_text('tm8.auth_kind'), ''),
              v_root, coalesce(v_root_identity, provenance ->> 'rootIdentityId'), v_chain, v_spaces)
      on conflict (session_id) do update set selections = excluded.selections,
        launcher_identity_id = excluded.launcher_identity_id,
        launcher_auth_kind = excluded.launcher_auth_kind,
        root_member_id = excluded.root_member_id, root_identity_id = excluded.root_identity_id,
        chain = excluded.chain, chain_space_ids = excluded.chain_space_ids;
  end if;
  /*
   * 351 (B35 tightening 3). The caller used to DISCARD this, so there was no
   * way to tell a converged bind from an inherited one after the fact.
   *
   * `reason` keeps exactly its old meaning — what the RE-DERIVATION said — and
   * `bound` is added beside it to say what was actually recorded. Separate keys
   * on purpose: collapsing them would make a non-ready `reason` look like a
   * failure to every existing reader, when the launch in fact succeeded.
   */
  return provenance || jsonb_build_object('bound', jsonb_build_object(
    'rootMemberId', v_root, 'rootIdentityId', v_root_identity,
    'via', coalesce(v_bound_via, provenance ->> 'via')));
end
$$;
revoke all on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid, uuid[], uuid[]) from public;
grant execute on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid, uuid[], uuid[]) to tm8_app;

comment on table internal.mcp_launch_selections is
  'The launch record. For a WORK SESSION it is also the pin a resume reads '
  'back, written by bind_mcp_session. For a CHAT only the two human doors '
  'write it (save_chat_mcp_selections, update_chat_mcp_selections), so a row '
  'means "a human chose this" and no row means "Space defaults, resolved '
  'fresh on every turn" (354).';

-- -----------------------------------------------------------------------------
-- 2. B57. Identical to 345 apart from the four cleared columns on `do update`.
-- -----------------------------------------------------------------------------
create or replace function public.update_chat_mcp_selections(p_chat uuid, p_selections jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare target_space uuid; picks integer;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'') = 'link' then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  -- The CONFIGURER, exactly as save_chat_mcp_selections has it: connectors ride
  -- the human who owns the thread's configuration, never any member who can
  -- read it.
  select c.space_id into target_space from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat and c.configured_by_identity_id=internal.identity_id() and e.deleted_at is null;
  if target_space is null then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  perform internal.require_space_member(target_space);
  if p_selections is null then
    delete from internal.mcp_launch_selections where session_id=p_chat;
    return jsonb_build_object('chatId',p_chat,'mcpSelections',null);
  end if;
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) > 32 then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  picks := jsonb_array_length(p_selections);
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where jsonb_typeof(s.value) <> 'object'
                or not (s.value ? 'serverId')
                or exists(select 1 from jsonb_object_keys(s.value) k where k not in ('serverId','credentialId'))
                or (s.value->>'serverId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or ((s.value ? 'credentialId')
                    and (s.value->>'credentialId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  if (select count(distinct s.value->>'serverId') from jsonb_array_elements(p_selections) s) <> picks then
    raise exception 'duplicate MCP server selection' using errcode='22023';
  end if;
  -- Structure only (B14): the connector must exist, be live and belong to THIS
  -- chat's Space. Approval, readiness and credential usability are re-checked
  -- by compose and bind on every turn, where a pin that went bad must refuse
  -- loudly rather than be quietly dropped here.
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where not exists(select 1 from public.mcp_servers m join public.entities e on e.id=m.entity_id
                               where m.entity_id=(s.value->>'serverId')::uuid and m.space_id=target_space
                                 and e.kind='mcp_server' and e.deleted_at is null)) then
    raise exception 'MCP connector unavailable' using errcode='42501';
  end if;
  insert into internal.mcp_launch_selections(session_id,selections,launcher_identity_id,launcher_auth_kind,updated_at)
    values(p_chat,p_selections,internal.identity_id(),internal.claim_text('tm8.auth_kind'),now())
  on conflict (session_id) do update
    set selections=excluded.selections, launcher_identity_id=excluded.launcher_identity_id,
        launcher_auth_kind=excluded.launcher_auth_kind, updated_at=now(),
        -- B57. The insert arm names none of these, so NULL is what a first
        -- write already produces; the update arm used to carry the previous
        -- bind's root and chain forward beside a selection the human has just
        -- replaced. Provenance on this row is the BIND's to record, and for a
        -- chat row 354 leaves no bind to record it — so these four are now
        -- always NULL on a chat's row, which is the honest answer.
        root_member_id=null, root_identity_id=null, chain=null, chain_space_ids=null;
  return jsonb_build_object('chatId',p_chat,'mcpSelections',p_selections);
end $$;

revoke all on function public.update_chat_mcp_selections(uuid,jsonb) from public;
grant execute on function public.update_chat_mcp_selections(uuid,jsonb) to tm8_app;

analyze internal.mcp_launch_selections;

reset role;
