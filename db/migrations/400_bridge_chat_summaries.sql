-- =============================================================================
-- 400 (authored as 410, provisional; renumbered to 400 at merge by the bridges merger) — Bridges S: one
-- rolling summary per group chat.
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §7.2 step S,
-- D25, D73, D74. Task 01a189d7-98f6-7241-ad14-fa5b7191c5fc.
--
-- A group's conversation is stored on the bridge's log anchor; only routed
-- messages become chat turns. The chat's context therefore carries the log as
-- a bounded summary of everything older than the verbatim tail. The server
-- folds it (packages/server/src/bridges/summary.ts, a deterministic extractive
-- reducer, no model call) at turn assembly once the unsummarized part passes a
-- message or byte threshold, and stores it here. Members read it on
-- `bridges.get` (`summary`).
--
-- One row per bridge: a bridge has one chat (D25), so this is also one row per
-- group chat. The row is derived data. Its `state` is untrusted text from the
-- group; it grants nothing.
-- =============================================================================

set role tm8_graph_owner;

create table public.bridge_chat_summaries (
  bridge_id          uuid primary key references public.bridges(entity_id) on delete cascade,
  chat_id            uuid not null references public.entities(id) on delete cascade,
  policy_version     text not null check (char_length(policy_version) between 1 and 64),
  -- The newest log message the summary covers; null before the first fold.
  through_message_id uuid references public.messages(entity_id) on delete set null,
  through_created_at timestamptz,
  covered_messages   integer not null default 0 check (covered_messages >= 0),
  state              jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
  source_digest      text not null check (char_length(source_digest) = 64),
  refreshed_at       timestamptz not null default now()
);
create index bridge_chat_summaries_chat_idx on public.bridge_chat_summaries(chat_id);

-- Readable wherever the bridge is: the same exists-over-entities_select shape
-- as every table hung on a bridge (395).
alter table public.bridge_chat_summaries enable row level security;
create policy bridge_chat_summaries_select on public.bridge_chat_summaries for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_chat_summaries.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_chat_summaries to tm8_app;

-- The one write: the turn assembly stores what it folded. Compare-and-set on
-- the previous cursor, so a fold computed from a stale row never moves the
-- summary backwards (a row under another policy is refolded from the start
-- and replaced); a lost race answers false and the caller uses its own
-- fold for this turn only. The caller must be able to read the bridge (the
-- fold was read under the same claims).
create or replace function public.store_bridge_chat_summary(
  p_bridge_id uuid, p_previous_through uuid, p_through uuid, p_covered integer,
  p_policy text, p_state jsonb, p_digest text)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  e public.entities;
  through_at timestamptz;
  current_through uuid;
  current_policy text;
  found_row boolean;
begin
  e := internal.live_entity(p_bridge_id, 'bridge');
  if not internal.entity_readable(e.id) then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.target_kind <> 'chat' then
    raise exception 'only a chat-target bridge keeps a rolling summary' using errcode = '22023';
  end if;
  if p_through is not null then
    select m.created_at into through_at from public.messages m
     where m.entity_id = p_through and m.anchor_id = internal.bridge_summary_log_anchor(b);
    if through_at is null then
      raise exception 'the summary cursor must be a message on the bridge log' using errcode = '22023';
    end if;
  end if;
  select true, s.through_message_id, s.policy_version into found_row, current_through, current_policy
    from public.bridge_chat_summaries s where s.bridge_id = p_bridge_id for update;
  -- A row folded under another policy counts as absent: the caller folded from the start.
  if found_row and current_policy = p_policy and current_through is distinct from p_previous_through then
    return false;
  end if;
  insert into public.bridge_chat_summaries(bridge_id, chat_id, policy_version, through_message_id,
    through_created_at, covered_messages, state, source_digest, refreshed_at)
  values (p_bridge_id, b.target_id, p_policy, p_through, through_at, p_covered, p_state, p_digest, now())
  on conflict (bridge_id) do update
    set chat_id = excluded.chat_id, policy_version = excluded.policy_version,
        through_message_id = excluded.through_message_id, through_created_at = excluded.through_created_at,
        covered_messages = excluded.covered_messages, state = excluded.state,
        source_digest = excluded.source_digest, refreshed_at = excluded.refreshed_at;
  return true;
end
$$;
revoke all on function public.store_bridge_chat_summary(uuid, uuid, uuid, integer, text, jsonb, text) from public;
grant execute on function public.store_bridge_chat_summary(uuid, uuid, uuid, integer, text, jsonb, text) to tm8_app;

-- The log anchor (§2.2): the channel for a channel target, else the bridge.
-- TODO(bridges S, coordinator ruling 2026-10-30): B1b-2 (#1428, migration 398)
-- adds internal.bridge_log_anchor with the same body. Two derivations drift:
-- once 398 is on main, drop this function and call internal.bridge_log_anchor.
create or replace function internal.bridge_summary_log_anchor(b public.bridges) returns uuid
language sql immutable set search_path = public, internal, pg_temp as $$
  select case when b.target_kind = 'channel' then b.target_id else b.entity_id end
$$;
revoke all on function internal.bridge_summary_log_anchor(public.bridges) from public;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.bridge_chat_summaries;
