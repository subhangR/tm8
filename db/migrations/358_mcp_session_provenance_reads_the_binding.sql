-- =============================================================================
-- 358 — `mcp_session_provenance` READS THE BINDING, NOT THE LAUNCH RECORD.
--       (B61, surface S23; §6.1 "record the chain", §10.6's session debug read.)
--
-- 343 pointed the exposed provenance reader at `internal.mcp_launch_selections`
-- because, at the time, that row was written by every bind — chat or session —
-- and so was as good a copy of the recorded root and chain as the binding was.
--
-- 354 ended that. For a CHAT key `bind_mcp_session` no longer writes the launch
-- record at all (the absence of a row is what makes "defaults" re-resolve on
-- every turn, S21a), and B57 nulled the four provenance columns on the update
-- arm of the human doors. Both halves were right, and together they left this
-- reader answering `recorded: false` for every chat on defaults — a chat whose
-- binding carries a perfectly good root, chain and depth. 354's own header said
-- so out loud rather than papering over it: "the authoritative copy is on the
-- binding". This migration is that sentence applied to the reader.
--
-- `internal.mcp_session_bindings` is the right source on its own terms, not
-- merely the surviving one. It is UNCONDITIONAL (354 kept it so deliberately),
-- it is what `authorize` re-checks the pinned account against on every proxy
-- call, and it is what §5.6's audit already quotes — so §10.6's debug view now
-- shows the same root and chain the authorisation path acts on, instead of a
-- second copy that could disagree with it. One row per session (`session_id` is
-- the primary key on both tables), so the shape of the read is unchanged.
--
-- -----------------------------------------------------------------------------
-- WHAT DOES NOT CHANGE — the diff is the FROM clause and nothing else.
--
-- Every gate 343 put on this function stays exactly as it was, verbatim:
--   * the LINK REFUSAL first, before any row is read, because this function
--     sits off the human-auth gate and would otherwise tell a link session
--     which members are behind a Space's running agents;
--   * `internal.entity_readable(p_session)`, with the same error text, so an
--     unreadable session is refused rather than probed;
--   * the "nobody bound this" answer is still a RETURN of `recorded: false`
--     and not a raise, so a debug view can ask about any session it can read.
-- The returned object keeps every key, including `launcherIdentityId` /
-- `launcherAuthKind` (NOT NULL on the binding, as on the launch record) and
-- `rootStillAdmitted`, which still re-checks the recorded root against every
-- Space in the recorded chain through `internal.mcp_root_in_every_space`.
--
-- The `recorded: false` test is left in its 343 wording — `chain is null and
-- launcher_identity_id is null` — because it means the same thing on the new
-- source and keeps this migration to the one change it claims. The launcher
-- columns are NOT NULL on `internal.mcp_session_bindings`, so both being null
-- is exactly "no row for this session", and a pre-343 binding (a row with a
-- launcher but no chain) still reads as recorded with a null chain, which is
-- the behaviour `mcp-provenance.pg.test.ts` already pins.
--
-- For a WORK SESSION nothing observable moves: `bind_mcp_session` writes the
-- same four values to both tables in the same statement pair, so the binding
-- and the launch record agreed for every session key. The only rows whose
-- answer changes are the ones 354 stopped writing — chats — and for those the
-- answer goes from false to the truth.
--
-- KNOWN, AND DELIBERATE: `internal.mcp_session_bindings.auth_session_id` is
-- `on delete cascade`, so `public.prune_auth_sessions` (30-day retain, node
-- admin) takes a long-expired session's binding with it, and this reader then
-- answers `recorded: false` where it used to quote the pruned launch record.
-- That is the honest answer for a reader whose contract is "what was RECORDED"
-- — the record is gone — and it is not a hole in audit, which keeps its own
-- root and chain on `mcp_call_audit` rows at call time (346). Raised with the
-- backend advisor rather than hidden behind a fallback to the launch record: a
-- fallback would have to re-admit exactly the chat rows B57 nulled.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 343's `mcp_session_provenance`, sourced from the binding.
-- -----------------------------------------------------------------------------
create or replace function public.mcp_session_provenance(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare r record;
begin
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' or coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'linked MCP provenance is unavailable' using errcode = '42501';
  end if;
  if not internal.entity_readable(p_session) then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  -- 358 (B61): the BINDING is the source, not the launch record 343 read.
  -- Since 354 a chat on defaults has no launch row, and its provenance lives
  -- here. (The old table is not named even in this comment: VERIFY below reads
  -- `prosrc`, so a mention would defeat the check that the source moved.)
  select b.root_member_id, b.root_identity_id, b.chain, b.chain_space_ids,
         b.launcher_identity_id, b.launcher_auth_kind
    into r from internal.mcp_session_bindings b where b.session_id = p_session;
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
-- Restated rather than relied upon: `create or replace` keeps the existing
-- grants, and naming them here means the surface is readable from this file.
revoke all on function public.mcp_session_provenance(uuid) from public;
grant execute on function public.mcp_session_provenance(uuid) to tm8_app;

comment on function public.mcp_session_provenance(uuid) is
  'What the launch RECORDED, read from internal.mcp_session_bindings — the '
  'authoritative copy, and the only one a chat on defaults has since 354 '
  '(343, 358/B61). Refuses a link caller outright and requires the session to '
  'be readable to the caller; a session nobody bound reads as recorded:false.';

analyze internal.mcp_session_bindings;

reset role;

-- -----------------------------------------------------------------------------
-- VERIFY. Structural only: the behaviour is pinned by
-- packages/server/test/db/mcp-provenance.pg.test.ts.
-- -----------------------------------------------------------------------------
do $verify$
declare src text;
begin
  -- The function's own body is the artefact this migration changes, so verify
  -- the source table BY ITS BODY: a `create or replace` that silently kept
  -- 343's FROM clause would otherwise apply clean and change nothing.
  select p.prosrc into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mcp_session_provenance' and p.pronargs = 1;
  if src is null then
    raise exception 'VERIFY 358: public.mcp_session_provenance(uuid) is missing';
  end if;
  if src not like '%internal.mcp_session_bindings%' then
    raise exception 'VERIFY 358: mcp_session_provenance does not read the binding';
  end if;
  if src like '%mcp_launch_selections%' then
    raise exception 'VERIFY 358: mcp_session_provenance still reads the launch record';
  end if;
  -- The three gates, still in the body. Cheap, and they are the whole reason
  -- this function may be replaced at all rather than rewritten.
  if src not like '%linked MCP provenance is unavailable%'
     or src not like '%entity_readable(p_session)%'
     or src not like '%mcp_root_in_every_space%' then
    raise exception 'VERIFY 358: mcp_session_provenance lost a gate';
  end if;
  -- F3 (343) still holds: the internal helpers stay ungranted.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'internal' and p.proname like 'mcp_provenance%'
                and has_function_privilege('tm8_app', p.oid, 'execute')) then
    raise exception 'VERIFY 358: an internal provenance helper is executable by tm8_app';
  end if;
end
$verify$;
