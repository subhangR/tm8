-- =============================================================================
-- 033 W2.SEC-1b — the command-ledger replay principal pin, moved INSIDE
--                 internal.ledger_replay where the advisory lock is already
--                 held, and the 23514 existence/operation oracle removed.
--
-- OBJECTS: redefines ONE pre-existing function, internal.ledger_replay(text,
-- text), via create or replace. It creates nothing, drops nothing, and alters
-- no table, column, index, trigger, policy, type, grant or revoke. create-or-
-- replace preserves the function's existing ACLs.
--
-- THIS IS NOT A NEW-OBJECTS-ONLY MIGRATION. internal.ledger_replay is called by
-- 114 RPC bodies across 001-031, so every ledgered command in every composed
-- group changes behaviour on its REPLAY path. See "BLAST RADIUS" below.
--
-- -----------------------------------------------------------------------------
-- 1. WHY THE PIN MOVES INSIDE THE FUNCTION: A TOCTOU RACE
-- -----------------------------------------------------------------------------
--
-- 031 states the correct law -- a stored replay may be returned only to the
-- principal that recorded it -- and enforces it with internal.
-- require_replay_principal. 023:106 and 023:193 invented the same comparison
-- locally, and 019:1136 has the same shape.
--
-- 031's FIRST landed revision called that pre-check ONLY ahead of internal.
-- ledger_replay, and that revision was retired because the placement is correct
-- sequentially and BYPASSABLE UNDER CONCURRENCY. The pre-check reads
-- public.command_ledger with NO LOCK HELD, while the lock that orders cmid
-- contention is taken INSIDE the function it precedes:
--
--     016:26   perform pg_advisory_xact_lock(hashtextextended(p_cmid, 0));
--     016:28   select * into ledger_row from public.command_ledger ...
--
-- The interleaving, with the victim's ledger row still UNCOMMITTED:
--
--   A (victim)                             B (attacker, different principal)
--   -----------------------------------    -----------------------------------
--   ledger_replay(X) -> takes adv lock X
--   SELECT: no row -> returns null
--   ...runs the command body...
--   ledger_record(X) INSERTs the row
--   (still in transaction, NOT committed)
--                                          require_replay_principal(X)
--                                            SELECT with NO LOCK
--                                            -> reads A's row as INVISIBLE
--                                            -> `if not found then return`
--                                            -> NOTHING IS PINNED
--                                          ledger_replay(X)
--                                            blocks on advisory lock X
--   COMMIT
--                                            acquires lock, SELECT NOW sees the
--                                            row, operation label matches,
--                                            RETURNS A's STORED RESULT.
--                                          The identity comparison never ran.
--
-- The resource binding of 031 does not rescue this: it asserts only that the
-- caller ADDRESSED the same resource, and an attacker who deliberately names the
-- victim's resource satisfies it. On the replay path the RPC's own authorization
-- (require_space_admin and friends) is never reached -- that is the whole defect
-- class SEC-1 exists to close.
--
-- Placing the comparison after the SELECT INSIDE ledger_replay has no check-then
-- -act window at all: the lock is already held when the SELECT runs, so the row
-- that is checked is by construction the row that is returned -- same statement,
-- same lock, same snapshot. There is no interleaving to reason about, which is a
-- stronger property than "the pre-check is ordered correctly at every call site".
--
-- 031's own header already anticipates this file: "itself, where the lock is
-- already held, which is tracked separately as 032." That file says "032" because
-- that was this work's number when it was written; the shared pin was later
-- renumbered to 033 so the CONFIRMED per-site Stage 1b fixes in 032 could land
-- even if this file stalled on its open gate-coverage question. Same work, new
-- number.
--
-- THE CURRENTLY LANDED 031 (940f9eb1d5d8e259) HAS ALREADY BEEN DE-RACED. It now
-- calls the pin at 12 sites: 6 ahead of internal.ledger_replay as a fast path,
-- and 6 INSIDE the replay branch, where the advisory lock is a held
-- transaction-scoped lock. Those 6 RPCs are therefore already race-free, proved
-- executably by a two-connection test that polls pg_locks for
-- locktype='advisory' and not granted and ASSERTS the attacker is genuinely
-- parked before the victim commits.
--
-- THE REMAINING 108 CALL SITES ARE NOT. They call internal.ledger_replay with no
-- pin at all, and each would need the same two-part ordering applied by hand.
-- That is what this migration replaces: one comparison inside the callee, where
-- the lock already is, rather than a rule 108 more call sites and every future
-- author must remember.
--
-- 031 IS NOT SUPERSEDED AND MUST NOT BE REVERTED. Its resource binding (part 2
-- of the law) is orthogonal and is NOT duplicated here -- ledger_replay cannot
-- know which resource the current request addresses, so it structurally cannot
-- carry that half. THIS FILE DOES NOT MAKE THE PER-SITE RESOURCE BINDING
-- OPTIONAL, and it does not close any same-principal resource confusion -- see
-- "WHAT THIS FILE DOES NOT CLOSE" below, which is the case that matters most.
--
-- -----------------------------------------------------------------------------
-- 2. WHY THE PIN IS GLOBAL RATHER THAN PER-SITE
-- -----------------------------------------------------------------------------
--
-- The principal half of the law is a property of the command ledger, not of any
-- one RPC: "a stored result belongs to whoever stored it" needs no knowledge of
-- the operation. Four groups (020, 022, 023, 024) each reinvented it locally and
-- 023 invented this exact command_ledger.identity_id comparison as a pre-check
-- ahead of the very function that already had the row in hand.
--
-- The alternative -- roughly 85 further per-site edits under frozen, gated
-- groups -- is a strictly LARGER blast radius across more files and more
-- authors, with more opportunity to be inconsistent, and it makes correct
-- ordering a rule every future author has to remember. A check under the lock is
-- instead a property of the system: a new ledgered RPC written next month is
-- principal-pinned the moment it calls ledger_replay, with nothing to remember.
--
-- WHAT THIS FILE DOES *NOT* CLOSE -- STATED PLAINLY BECAUSE IT WAS BRIEFLY
-- OVER-CLAIMED IN THE OTHER DIRECTION.
--
-- This migration closes the CROSS-PRINCIPAL half at all 114 sites. It does NOT
-- close SAME-PRINCIPAL resource confusion at ANY site, and it structurally
-- cannot: internal.ledger_replay receives only a cmid and an operation label, so
-- it cannot know which resource the current request addresses.
--
-- The concrete case that makes this worth spelling out is 007:583
-- public.create_invite. Its stored projection is
-- jsonb_build_object('invite', to_jsonb(invite), ...) over a row from
-- `insert into public.space_invites(space_id, code, ...) ... returning *`, so it
-- carries the `code` column -- a LIVE BEARER CREDENTIAL ('inv_' || ...) that
-- public.redeem_invite consumes to grant membership. The W3 gate measured that
-- leak through production HTTP:
--     POST /v2/spaces/{A}/invites cmid=X -> 201
--     POST /v2/spaces/{B}/invites cmid=X -> 201, body contains A's invite code.
--
-- THE PIN BELOW DOES NOT STOP THAT MEASURED LEAK. Phase-1 runs a single loopback
-- auto-owner, so both of those requests carry the SAME identity: the pin matches,
-- passes, and hands the code over exactly as before. Closing it requires the
-- ADDRESSED-RESOURCE half bound to the Space, per-site, in 031. Do not read this
-- migration as making that work optional -- hardening the CONSUMER
-- (redeem_invite, done in 031) does not help against an attacker who already
-- holds a valid code from the PRODUCER.
--
-- What this file does add at create_invite is the cross-principal half only: a
-- genuinely different identity replaying that cmid is now refused, where before
-- it was not.
--
-- -----------------------------------------------------------------------------
-- 3. IDENTITY ONLY -- actor_id IS DELIBERATELY NOT COMPARED
-- -----------------------------------------------------------------------------
--
-- public.command_ledger carries both identity_id (004:81) and actor_id (004:82),
-- both populated by internal.ledger_record (012:130). Only identity_id is
-- compared here. 023's exact actor equality would raise 23514 on a LEGITIMATE
-- retry -- the same human retrying with a different Teammate selected, or with
-- the tm8.actor_id claim absent under a background retry or a delivery-adapter
-- re-drive -- because internal.actor_id() (001:180) falls back to acting_as and
-- may legitimately be null or may legitimately change between two attempts at
-- the same command. The principal is the identity; the actor is attribution.
--
-- -----------------------------------------------------------------------------
-- 4. FAIL-CLOSED IS DELIBERATE, EXPLICIT, AND NOT AN ARTEFACT OF NULL SEMANTICS
-- -----------------------------------------------------------------------------
--
-- READ THIS BEFORE "SIMPLIFYING" THE THREE-WAY TEST BELOW INTO
-- `is distinct from`. THEY ARE NOT EQUIVALENT, AND `is distinct from` IS THE
-- WEAKER ONE.
--
--   null is distinct from null  =>  FALSE
--
-- so `if stored is distinct from current then raise` PASSES THE GUARD when both
-- sides are null. public.command_ledger.identity_id is NULLABLE (004:81),
-- internal.identity_id() (001:158) is a bare claim read -- `select
-- internal.claim_text('tm8.identity_id')` with no coalesce and no guard -- and
-- internal.ledger_record (012:120-131) calls no guard before its insert. A
-- null-identity ledger row is therefore structurally producible, and under
-- `is distinct from` ANY caller with no identity bound would replay it. That is
-- precisely the anonymous-to-anonymous disclosure the law is supposed to forbid,
-- and it is the case a reader is most likely to assume is already covered.
--
-- The rule this file enforces instead: A REPLAY WHOSE RECORDED PRINCIPAL CANNOT
-- BE ESTABLISHED MAY NOT BE RETURNED TO ANYONE, AND NO CALLER WITHOUT A BOUND
-- IDENTITY MAY RECEIVE A REPLAY. Both null cases are refused EXPLICITLY, by
-- their own named branches, so the behaviour survives a future reader who is
-- reasoning about SQL null semantics rather than about this comment.
--
-- Note carefully that this is a DIFFERENT null from the one that makes nested
-- calls safe. That one is a null CMID (016:22, 012:126); this one is a null
-- STORED IDENTITY. Conflating them is the easy mistake here.
--
-- SCOPE CHECK PERFORMED BEFORE CHOOSING FAIL-CLOSED. Every ledgered RPC in
-- 001-031 was enumerated for a reachable record-then-replay of a null-identity
-- row. Result: no LEGITIMATE path exists, and fail-closed breaks nothing that
-- works today. One structurally-producible site was found and it is a latent
-- defect in its own right, not a caller this guard must accommodate:
--
--   015:1497 public.reset_session_wake_budget_for_member_reply returns
--   internal.ledger_record at 015:1512 on its early "nothing to reset" branch,
--   which is BEFORE its only guard, internal.require_space_member at 015:1515.
--   A claim-free caller passing a non-blank cmid and a p_reply_message_id that
--   is absent, has a null parent, or whose author is not kind='member' therefore
--   writes a row with identity_id NULL and can replay it. No packages/server/src
--   caller reaches this RPC and it has no facade route; the only in-repo caller
--   is a test that binds an identity. Under this migration such a row becomes
--   unreplayable by anyone, which is the intended fail-closed outcome. The
--   record-before-guard ordering at 015:1512 should be fixed on its own merits
--   and is NOT fixed here.
--
-- The other candidates cleared: 015:1909 repair_w1_foundations and 015:1956
-- compensate_w1_foundations both guard (require_space_admin /
-- require_human_space_admin) between replay and record; 019:1136
-- w2_prepare_handoff records a server-minted non-null cmid but guards at
-- 019:1152 before recording; 022 and 027's apparent gaps are closed
-- transitively by internal.w2_file_slot_for_identity (022:93) and
-- internal.w2g12_authorize_profile_draft (027:633).
--
-- -----------------------------------------------------------------------------
-- 5. THE 23514 ORACLE IS REMOVED
-- -----------------------------------------------------------------------------
--
-- 016:35-36 interpolated BOTH the caller-supplied cmid and the TRUE OWNER'S
-- operation label into the exception message:
--
--     raise exception 'client mutation id % already used for operation %',
--       p_cmid, ledger_row.operation
--
-- That text reaches the wire verbatim: packages/server/src/db/errors.ts:82
-- constructs `new CollabError(code, message, ...)` from the driver's message and
-- http/errors.ts:89 emits `err.message` into the response body. (DETAIL rides
-- through too, via parseDetail at db/errors.ts:37-49, so the DETAIL strings
-- below are static prose and interpolate nothing either.) Every one of the 114
-- sites was therefore a free existence-AND-operation-label oracle: a probe told
-- the caller not just that a cmid was taken but what it was taken FOR, which
-- upgrades blind guessing into guided search.
--
-- The 23514 SQLSTATE and the DEV-9 invariant are unchanged; only the two
-- interpolations are gone. The surviving prose still contains the substring
-- 'already used for operation', which existing suites assert on.
--
-- Residual, and accepted: both raises still disclose THAT a cmid is taken. That
-- is inherent to a globally unique cmid namespace and is not fixable here. The
-- program has already ruled that a clientMutationId is a correlation identifier
-- and NOT a capability, so no guard is permitted to lean on cmids being
-- unguessable.
--
-- ORDERING NOTE, and it is a deliberate deviation from a sequential reading of
-- 016: the principal check is placed BEFORE the operation-label check, not
-- after. A caller who is not the recorder then learns NOTHING about the
-- operation, whereas operation-first would leak one bit per probe ("this cmid is
-- not operation Y") to a stranger. It costs nothing: a legitimate recorder
-- reusing its OWN cmid for a different operation passes the principal check and
-- still receives the DEV-9 operation error, so 012's invariant is untouched for
-- every caller it was written to protect.
--
-- -----------------------------------------------------------------------------
-- 6. BLAST RADIUS
-- -----------------------------------------------------------------------------
--
-- internal.ledger_replay is called by 114 RPC bodies. This migration changes the
-- replay path of EVERY ledgered command in G01, G02, G03, G05, G06, G07, G08 and
-- G09 as well as the uncomposed groups. Every composed group requires a real W3
-- rebind; this is NOT a declared no-op.
--
-- DOUBLED CHECKS ARE REDUNDANT, NOT CONTRADICTORY -- DO NOT "DEDUPLICATE" THEM.
-- Several places now pin the principal twice: 031's require_replay_principal
-- runs at 12 call sites (6 ahead of the call as a fast path, 6 inside the replay
-- branch after the reordering), 023:106 and 023:193 compare
-- command_ledger.identity_id inline, 019:1136's site does the same, and 022 (G07)
-- pins on slot.created_by through internal.w2_file_slot_for_identity (022:93).
-- All of those raise the identical 23514 on the identical condition as the pin
-- below. A future reader who finds two checks and removes "the redundant one"
-- may remove the only one that is race-free. The callee pin is the load-bearing
-- one precisely because the lock lives inside the callee.
--
-- What does NOT change, and is asserted by test:
--   * the first use of a cmid (no row) still returns null and runs the body;
--   * a null or blank cmid still returns null before the lock is even taken, so
--     the 13 server-side nested calls in 018 and 020 are untouched;
--   * a legitimate same-principal retry still receives the byte-identical stored
--     result and still causes no second effect. IDEMPOTENCY IS PRESERVED, NOT
--     TRADED AWAY.
--
-- Forward-only: 016 is applied and content-checksummed by db/migrate.mjs
-- (:137, :181, :203-208), which hard-fails on drift, so it is left byte-
-- identical and superseded here rather than edited.
-- =============================================================================

set role tm8_graph_owner;

-- Body is 016:17-42 verbatim, with the principal pin added under the lock and
-- the two oracle interpolations removed. Signature, language, volatility,
-- search_path and the SECURITY INVOKER default are all unchanged: every caller
-- is already a SECURITY DEFINER RPC owned by tm8_graph_owner, so the read of
-- command_ledger happens as the owner, and making this DEFINER would add a
-- privileged entry point for no benefit.
create or replace function internal.ledger_replay(p_cmid text, p_operation text)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ledger_row public.command_ledger;
  caller_identity text;
begin
  perform internal.bind_cmid(p_cmid);
  if p_cmid is null or btrim(p_cmid) = '' then
    return null;                         -- no idempotency requested (012:126)
  end if;

  -- Taken BEFORE the select, which is what makes the pin below race-free.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_cmid, 0));

  select * into ledger_row
    from public.command_ledger
   where client_mutation_id = p_cmid;
  if ledger_row.client_mutation_id is null then
    return null;                         -- first use of this cmid: run the body
  end if;

  -- ---------------------------------------------------------------------------
  -- THE PRINCIPAL PIN (W2.SEC-1). Under the lock, on the row just selected.
  --
  -- Three EXPLICIT branches, deliberately not `is distinct from`. See section 4
  -- of the header: `null is distinct from null` is FALSE, so the compact form
  -- would hand a null-identity replay to any caller with no identity bound.
  -- Each refusal below is fail-closed BY NAME, not by null-semantics accident.
  --
  -- Ordered ahead of the operation-label check so that a caller who is not the
  -- recorder learns nothing about the recorded operation (header section 5).
  -- ---------------------------------------------------------------------------
  caller_identity := internal.identity_id();
  if ledger_row.identity_id is null                    -- recorded principal unknown
     or caller_identity is null                        -- caller has no bound identity
     or ledger_row.identity_id <> caller_identity then -- recorded by someone else
    raise exception 'clientMutationId belongs to another principal'
      using errcode = '23514',
            detail = 'a replay may not be returned to a principal other than the one that recorded it (W2.SEC-1)';
  end if;

  if ledger_row.operation <> p_operation then
    -- Neither the cmid nor the recorded operation label is interpolated: this
    -- message reaches the wire verbatim (db/errors.ts:82 -> http/errors.ts:89).
    raise exception 'client mutation id already used for operation other than the one requested'
      using errcode = '23514',
            detail = 'one clientMutationId belongs to one operation (DEV-9)';
  end if;
  return coalesce(ledger_row.result, '{}'::jsonb);
end
$$;

comment on function internal.ledger_replay(text, text) is
  'Returns the stored CommandResult for a replayed clientMutationId, or NULL when '
  'this caller gets to run the body. Serializes on a transaction-scoped advisory '
  'lock over the cmid, then pins the replay to the recording principal '
  '(command_ledger.identity_id) UNDER THAT LOCK, so there is no check-then-act '
  'window (W2.SEC-1, 033). Fail-closed and explicitly so: a row with no recorded '
  'identity, and a caller with no bound identity, are both refused with 23514. '
  'Identity only -- actor_id is attribution and may legitimately differ between '
  'two attempts at the same command. Raises no cmid or operation label into the '
  'exception message, which reaches the wire verbatim. This carries the PRINCIPAL '
  'half of the law only; the ADDRESSED-RESOURCE half is per-site (031) because '
  'this function cannot know the resource the current request names.';

reset role;
