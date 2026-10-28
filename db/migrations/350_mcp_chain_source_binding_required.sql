-- =============================================================================
-- 350 — B35/B36: a provenance chain may not name a source that was never bound.
--
-- 343's `bind_mcp_session` verifies an INHERITED chain rather than trusting it
-- (F1/B27): the head must be this session, every hop's Space is read back from
-- its own entity row, and the tail must equal the source binding's OWN recorded
-- chain. B28 added the root anchor beneath it — a delegated launch roots exactly
-- where its source rooted.
--
-- Both of those fall open when the named source has NO binding row at all:
--
--   * `coalesce(v_source_chain, array[p_source_session])` INVENTS the tail it
--     is meant to check against, so a two-hop chain [child, source] matches a
--     source that was never bound; and
--   * `v_source_root` is null, so `if v_source_root is not null and ...` skips
--     the root anchor entirely.
--
-- So a caller naming any live session as its source passed every chain check in
-- that branch. This migration refuses it: inside the `p_chain` branch, with
-- `p_source_session` set, the (session_id, auth_session_id) row must exist.
--
-- SEVERITY, so the record is honest (advisor B36): this is DEFENCE IN DEPTH,
-- not a live exploit. `bind_mcp_session` is reachable only from server code,
-- and the TypeScript derivation that runs first calls
-- `read_mcp_session_binding` under the SOURCE's own bearer, which answers
-- `source_unavailable` when there is no row — so no API path arrives here with
-- a bindingless source. It is closed because this function is specified to
-- stand on facts it reads itself (B28), not on its caller having checked first.
--
-- A source written before 343 still HAS a row, carrying a null `chain` and a
-- null `root_member_id`. Only the row's EXISTENCE is required here, so those
-- keep working exactly as they do today.
--
-- Found while deriving the loop-firing ordering fix (task 01a15cf6-127b); split
-- out ahead of it because it is a gap on main today and independent of it.
-- =============================================================================

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
    elsif array_length(p_chain, 1) <> 1 then
      raise exception 'MCP provenance chain has no source to justify its hops' using errcode = '42501';
    end if;
    v_chain := p_chain;
    v_spaces := p_chain_spaces;
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
  return provenance;
end
$$;
revoke all on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid, uuid[], uuid[]) from public;
grant execute on function public.bind_mcp_session(uuid, text, jsonb, uuid, uuid, uuid, uuid[], uuid[]) to tm8_app;
