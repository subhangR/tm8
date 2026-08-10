-- =============================================================================
-- 098 — `thread_v1` + `task_discussion_v1`: the DERIVATION reading, both ways.
--
-- This is the SQL half of a two-sided registry (see 030, and 097 for the
-- previous restatement). `internal.w2_feed_scope_predicates()` and
-- `FEED_SCOPE_PREDICATES` in the Server facade are two independent copies of a
-- security-relevant map, and the G13 PG suite asserts they agree in BOTH
-- directions — so a new scope is never a one-file change, and this migration
-- exists only because its TypeScript twin does.
--
-- THE PROBLEM THESE SCOPES SOLVE. An agent spawned on a thread reports on its
-- assignment anchor — a TASK derived from the thread's root (064's
-- `derive_task_for_entity`, which writes `derived_from`: task -> root). The
-- write side cannot join the two surfaces: a threaded reply has exactly one
-- anchor and it must equal its parent's (019:416/:423), so a message cannot be
-- multi-anchored onto both the channel and the task, and duplicating the row
-- would mint two ids and two edit histories for one utterance. The precedent
-- for the fix is `session_chat_v1`'s `authored` predicate: make it a READ that
-- follows an edge, so ONE stored row appears on two feeds. The agent's language
-- stays ubiquitous — it never needs to know threads exist.
--
-- THE FOUR NEW PREDICATES (assembled by the facade; named here in the map):
--   thread          messages whose `root_message_id = $1` — the branch itself.
--   derived_thread  on a TASK: the thread it was derived from — the root and
--                   its branch, through `derived_from` src-side.
--   derived_task    on a thread ROOT: messages anchored on tasks derived from
--                   it — the agent's reports — through `derived_from` dst-side.
--   derived_session on a thread ROOT: activity about-or-caused-by a session
--                   `working_on` a derived task, so a spawn is visible IN the
--                   thread. Two activity routes on purpose: spawn's
--                   `created`/`restored` rows carry the SESSION as entity_id
--                   with `work_session_id` NULL, recorder-stamped rows the
--                   inverse; `execution.transition` writes no activity at all.
--
-- `thread_v1` deliberately omits `anchored`: a reply anchors on the CHANNEL,
-- never on its root (DB-enforced), which is exactly why `direct_v1` on a
-- message anchor reads near-empty and why this scope exists.
--
-- `task_discussion_v1` is `direct_v1` + `derived_thread`, CONFINED TO TASK
-- ANCHORS. A separate scope rather than a widened `direct_v1`, for 097's
-- reason run the other way: a scope's meaning is a versioned artefact, and
-- editing `direct_v1` in place would silently restructure every non-task hub
-- that reads it. `derived_from`'s src is DB-constrained to `task` (064), so
-- only a task could ever gain rows from the extra predicate anyway.
--
-- VISIBLE CONSEQUENCE, stated rather than discovered: a task derived from a
-- thread shows the thread's HUMAN chatter in its Discussion. The task is that
-- conversation's work record; its feed says so.
--
-- APPLICABILITY IS NARROW ON PURPOSE, as always: `thread_v1` answers for a
-- `message` anchor and `task_discussion_v1` for a `task`; anything else is
-- `invalid_input` + `details.reason = 'feed_scope_not_applicable'` (030).
--
-- NOTE this migration does NOT decide what `default` resolves to for a message
-- or task anchor — that mapping is `defaultScopeFor()` in the facade and has no
-- SQL mirror; only the predicate map and the applicability rule are two-sided.
--
-- REPLACE, NOT ALTER: both functions are `language sql immutable` lookup
-- tables, so the honest edit is to restate them whole. `create or replace`
-- keeps the grants and dependent objects 030 established. Nothing else is
-- touched: no table, index, trigger, policy or grant changes here.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Scope → predicates.
--
-- Returned SORTED, matching the Server's canonical (deduped + sorted) spelling
-- — the same array feeds both the keyset cursor fingerprint and the SQL
-- assembly, and an unsorted spelling would let those two disagree.
--
-- An unknown scope still returns NULL rather than an empty array: empty would
-- be indistinguishable from "a real scope that selects nothing".
-- -----------------------------------------------------------------------------
create or replace function internal.w2_feed_scope_predicates(p_scope text)
returns text[]
language sql immutable as $$
  select case p_scope
    when 'direct_v1'          then array['anchored','replies','subject']
    when 'session_chat_v1'    then array['anchored','authored','caused','replies']
    when 'channel_threads_v1' then array['anchored','subject']
    when 'thread_v1'          then array['derived_session','derived_task','subject','thread']
    when 'task_discussion_v1' then array['anchored','derived_thread','replies','subject']
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
    when 'thread_v1'          then p_anchor_kind = 'message'
    when 'task_discussion_v1' then p_anchor_kind = 'task'
    else false
  end
$$;

reset role;
