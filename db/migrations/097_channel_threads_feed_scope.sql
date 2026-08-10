-- =============================================================================
-- 097 — `channel_threads_v1`: read a channel as THREAD ROOTS.
--
-- This is one half of a two-sided registry. 030 established that the scope →
-- predicate map lives BOTH in `internal.w2_feed_scope_predicates()` and in
-- `FEED_SCOPE_PREDICATES` in the Server facade, and that the G13 PG suite
-- asserts the two agree in BOTH directions — a scope either side gains alone is
-- exactly the drift that hurts. So a new scope is never a one-file change, and
-- this migration exists only because its TypeScript twin does.
--
-- WHAT THE SCOPE MEANS: `direct_v1` minus `replies`.
--
-- `direct_v1` is `['anchored','replies','subject']`, and `anchored`/`replies`
-- partition a channel's messages on `root_message_id is null`. Unioning them
-- and ordering by time is what makes a channel read FLAT: a reply is drawn
-- wherever it happens to land in the timeline rather than under the message it
-- answers. Dropping the one predicate is the whole of the change.
--
-- NOTHING IS HIDDEN AND NOTHING IS LOST. A reply is still stored, still
-- covered by `messages_select` RLS, still readable, and still reachable through
-- `messages.list?rootMessageId=`, which has returned roots-with-reply-counts
-- and a keyset-paginated branch since it was written (its own docblock: "A flat
-- list of every message would make a 500-message channel unusable and would
-- lose the reply structure the UI renders"). The reply simply stops being
-- rendered as a PEER of the message it replies to, which is the entire ticket.
--
-- WHY A NEW SCOPE RATHER THAN NARROWING `direct_v1` IN PLACE. `direct_v1` is
-- the default for every non-session anchor — the task Discussion tab, docs,
-- every hub — and those surfaces want replies inline. Editing it would silently
-- restructure surfaces this work never examined. The two scopes disagree
-- deliberately; the disagreement IS the feature.
--
-- APPLICABILITY IS NARROW ON PURPOSE. `channel_threads_v1` answers only for a
-- `channel` anchor. Asking for it on a task is not "an empty feed" — it is a
-- caller asking for something that does not exist, and 030's frozen answer is
-- `invalid_input` with `details.reason = 'feed_scope_not_applicable'`. Widening
-- applicability to `true` would let a client ship a broken query and never find
-- out.
--
-- NOTE this migration does NOT decide what `default` resolves to for a channel.
-- That mapping is `defaultScopeFor()` in the facade and has no SQL mirror in
-- 030 — only the predicate map and the applicability rule are two-sided.
--
-- REPLACE, NOT ALTER: both functions are `language sql immutable` lookup
-- tables, so the honest edit is to restate them whole. `create or replace`
-- keeps the grants and the dependent objects that 030 established.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Scope → predicates.
--
-- Returned SORTED, matching the Server's canonical (deduped + sorted) spelling.
-- Canonical order is not cosmetic: the same array feeds both the keyset cursor
-- fingerprint and the SQL assembly, so an unsorted spelling would let those two
-- disagree about what "this filter" means.
--
-- An unknown scope still returns NULL rather than an empty array, for 030's
-- reason: empty would be indistinguishable from "a real scope that selects
-- nothing", and a feed that silently selects nothing is a broken client nobody
-- finds out about.
-- -----------------------------------------------------------------------------
create or replace function internal.w2_feed_scope_predicates(p_scope text)
returns text[]
language sql immutable as $$
  select case p_scope
    when 'direct_v1'          then array['anchored','replies','subject']
    when 'session_chat_v1'    then array['anchored','authored','caused','replies']
    when 'channel_threads_v1' then array['anchored','subject']
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
-- `false` for an unknown scope: an unrecognised name is never applicable.
-- -----------------------------------------------------------------------------
create or replace function internal.w2_feed_scope_applicable(p_scope text, p_anchor_kind text)
returns boolean
language sql immutable as $$
  select case p_scope
    when 'direct_v1'          then true
    when 'session_chat_v1'    then p_anchor_kind = 'work_session'
    when 'channel_threads_v1' then p_anchor_kind = 'channel'
    else false
  end
$$;

reset role;
