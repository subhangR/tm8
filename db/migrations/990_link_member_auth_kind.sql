-- =============================================================================
-- 990 (PLACEHOLDER ordinal; set at the merge position, next free after main's
-- highest) — auth kind `link` passes the human check on three non-credential
-- ops (task 01a0db78-f1ab, W7b's prerequisite).
--
-- DECISION 31 (final design 01a0da94, K1 rejected): "Phase 1 agents through a
-- link act as the full member, except for credential operations (E2)". Phases
-- 01a0d9fb §3 (phases.md:132): "On B, kind `link` passes the human check
-- except for credential ops, which B refuses for that kind in SQL."
--
-- W6 (250/251) left the strict gate internal.require_human_auth_kind() (083)
-- unchanged: browser and cli only. Six non-credential functions call it and
-- so refused `link` as a known gap. This file classifies them (lead's
-- sanctioned mechanism, coordinator ruling 2026-09-28):
--
--   ADMIT link — moved to the ONE permissive variant below:
--     start_chat          (176)  a plain member op
--     leave_space         (232)  ends the caller's own membership; by W6 a4
--                                that deletes their link rows, so the link
--                                session stops resolving on its next use
--     remove_space_member (232)  still require_space_admin as the member:
--                                a link session holds the member's authority
--                                in B, never more
--   KEEP refused — stay on the strict gate:
--     internal.disable_account_core (239)  identity-wide, not a space act
--     read_account_service_key      (203)  a credential read (E2), account-level
--     issue_agent_runtime_session / revoke_agent_runtime_session (176)
--       OWNER DECISION PENDING. A link-started or link-driven chat's turn would
--       mint a 24h agent_runtime token that outlives revoking the link session.
--       Until the owner answers, the chat launcher refuses such a turn by name
--       (chat/compose.ts, LINK_RUNTIME_REFUSED_CODE). Flipping it is one more
--       signature in the list below plus one cell.
--
-- Credential USE (read_space_credential_for_spawn and the other readers) never
-- called either gate and is untouched here.
--
-- HOW THE THREE MOVE: each body is re-created from its own pg_get_functiondef
-- with exactly one line changed, `perform internal.require_human_auth_kind();`
-- -> `perform internal.require_human_or_link_auth_kind();`. The block asserts
-- that line occurs exactly once first, so a body that drifted aborts the
-- migration instead of being half-rewritten. CREATE OR REPLACE keeps each
-- function's owner and EXECUTE grants. Both gates' caller sets are pinned in
-- packages/server/test/db/space-links.pg.test.ts.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- The strict gate's twin, and the only difference is `link` in the list. Same
-- search_path and security as 083's, and the same fail-closed reading: a
-- missing, empty or unrecognised kind refuses. `agent` and `agent_runtime`
-- still refuse; a link session is the member, an agent token is not.
create function internal.require_human_or_link_auth_kind() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare kind text;
begin
  kind := internal.claim_text('tm8.auth_kind');
  if kind is null or kind not in ('browser', 'cli', 'link') then
    raise exception 'only a person, or a space link acting as the member, may do this' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(kind, 'none'))::text;
  end if;
end
$$;

-- Granted to NOBODY, as 083 does for the strict gate: the only callers are
-- security-definer RPCs, which run as the definer.
revoke all on function internal.require_human_or_link_auth_kind() from public;

comment on function internal.require_human_or_link_auth_kind() is
  'Admits browser, cli and link (decision 31: a link session acts as the member '
  'in its target space). Never for credential operations (E2): those stay on '
  'internal.require_human_auth_kind(). Callers are pinned in space-links.pg.test.ts.';

do $repoint$
declare
  signature text;
  body text;
  strict_call constant text := 'perform internal.require_human_auth_kind();';
  permissive_call constant text := 'perform internal.require_human_or_link_auth_kind();';
  occurrences integer;
begin
  foreach signature in array array[
    'public.start_chat(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text)',
    'public.leave_space(uuid,text)',
    'public.remove_space_member(uuid,uuid,text)'
  ] loop
    body := pg_get_functiondef(signature::regprocedure);
    occurrences := (char_length(body) - char_length(replace(body, strict_call, ''))) / char_length(strict_call);
    if occurrences <> 1 then
      raise exception '990: % calls the strict gate % times, expected exactly 1', signature, occurrences;
    end if;
    execute replace(body, strict_call, permissive_call);
  end loop;
end
$repoint$;

reset role;
