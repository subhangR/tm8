-- =============================================================================
-- 030 — W2.G13 versioned named feed scope: the database-side registry.
--
-- WHY 030 AND NOT 025/026/028. The repository chain is 001–024, 027, 029; the
-- gaps at 025, 026 and 028 are unused. They are NOT backfilled. The official
-- runner (`db/migrate.mjs:127`) applies migrations in LEXICAL order, so a file
-- numbered 025 would sort BEFORE the already-shipped 027 and 029. That is
-- harmless applying from empty and an out-of-order insert against any ledger
-- that has already applied them — and the runner must keep working from empty
-- AND from the current supported state. Numbering above the highest existing
-- file is the only safe choice.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO, and why it matters more than
-- what it does.
--
-- An earlier draft of G13 added `public.activity.logical_operation_id` plus a
-- recorder-owned BEFORE INSERT trigger to stamp it. That was withdrawn.
-- `public.activity` is not an isolated table: it is a shared read model sitting
-- under `entities.activity` (G02, composed and live), under `activityAt` on the
-- entity envelope which `entities.get`/`entities.children` render, and under
-- `collections.query`'s `activityAt_desc` sort (G05, which additionally holds
-- an independent public PASS). Its writers date from 003. A trigger there would
-- have intercepted every one of them.
--
-- The lesson it was withdrawn under is worth writing down, because it cost a
-- user's message elsewhere in this wave: COMPOSITION GOVERNS WHICH HTTP ROUTES
-- ARE MOUNTED; IT DOES NOT GOVERN WHAT THE DATABASE ENFORCES. "G13 is not
-- composed yet, so a G13 migration is safe" is false whenever the enforcement
-- lands under a route that is already mounted. And "additive" is precisely the
-- word that hid this wave's confirmed defect — widening a CHECK on
-- `undo_tokens` was additive too, and it destroyed a posted message by firing
-- inside an unrelated caller's transaction.
--
-- So: this migration creates TWO NEW FUNCTIONS AND NOTHING ELSE. No `alter
-- table`, no `create index`, no `create trigger`, no `create policy`, no
-- `grant`, no `drop`, no `create or replace` over anything that already exists.
-- No pre-existing table, column, function, policy, index or migration is
-- modified or shadowed. `public.activity` is untouched. The consequence is
-- visible in the contract: `FeedItemBase.logicalOperationId` is `null` for
-- activity items, because the recorder never wrote one, and an honest null
-- beats invented provenance.
--
-- WHAT THESE FUNCTIONS ARE FOR. Dossier closure item M1/M3 requires that a
-- feed be selected by a VERSIONED NAMED SCOPE and never by a raw predicate
-- array. The Server owns that map in
-- `packages/server/src/facade/services/w2/feed-context.ts`
-- (`FEED_SCOPE_PREDICATES`), and assembles its SQL from it — no caller-supplied
-- string reaches SQL text on any path. These functions are the DATABASE-SIDE
-- MIRROR of the same map, and `test/db/w2-feed-context.pg.test.ts` asserts the
-- two agree in BOTH DIRECTIONS: not merely that a shared scope's predicates
-- match, but that neither side has a scope the other lacks. A new unmirrored
-- scope is the drift that would actually hurt, and two independent copies of a
-- security-relevant map is exactly the thing that drifts in silence.
--
-- They are `immutable` and read no table, so they can be reasoned about — and
-- enumerated — without a transaction.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Scope → predicates.
--
-- The `_v1` suffix in the wire name is the point: a scope's MEANING is a
-- server-owned versioned artefact. It can be superseded by a `…_v2` without a
-- caller ever having been able to depend on its internals, because a caller can
-- only ever name the scope.
--
-- Returned SORTED, matching the Server's canonical (deduped + sorted) spelling.
-- Canonical order is not cosmetic: the same array feeds both the keyset cursor
-- fingerprint and the SQL assembly, so an unsorted spelling would let those two
-- disagree about what "this filter" means — the bug `handoffs.list` shipped in
-- the other direction, rejecting cursors across a reordered identical request.
--
-- An unknown scope returns NULL rather than an empty array. Empty would be
-- indistinguishable from "a real scope that selects nothing", and a feed that
-- silently selects nothing is a broken client nobody finds out about.
-- -----------------------------------------------------------------------------
create function internal.w2_feed_scope_predicates(p_scope text)
returns text[]
language sql immutable as $$
  select case p_scope
    when 'direct_v1'       then array['anchored','replies','subject']
    when 'session_chat_v1' then array['anchored','authored','caused','replies']
    else null
  end
$$;

comment on function internal.w2_feed_scope_predicates(text) is
  'W2.G13 dossier M1/M3: the closed, versioned scope->predicate registry. '
  'Mirrors FEED_SCOPE_PREDICATES in the Server facade; the G13 PG suite asserts '
  'both directions of agreement. NULL for an unknown scope, never an empty array.';

-- -----------------------------------------------------------------------------
-- 2. Scope → applicable anchor kinds.
--
-- `session_chat_v1` on a task is not "an empty feed". It is a caller asking for
-- something that does not exist, and the frozen answer (dossier :228) is
-- `invalid_input` with `details.reason = 'feed_scope_not_applicable'` — a
-- `reason`, not a bare DETAIL string, because a reason that arrives as
-- `details.detail` is a reason no client can switch on.
--
-- `false` for an unknown scope: an unrecognised name is never applicable.
-- -----------------------------------------------------------------------------
create function internal.w2_feed_scope_applicable(p_scope text, p_anchor_kind text)
returns boolean
language sql immutable as $$
  select case p_scope
    when 'direct_v1'       then true
    when 'session_chat_v1' then p_anchor_kind = 'work_session'
    else false
  end
$$;

comment on function internal.w2_feed_scope_applicable(text, text) is
  'W2.G13: whether a named feed scope means anything for an anchor kind. '
  'A known-but-inapplicable scope is invalid_input + '
  'details.reason = feed_scope_not_applicable (dossier :228); an unknown scope '
  'is never applicable.';

reset role;
