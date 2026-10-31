-- =============================================================================
-- 415 — Bridges S follow-up: one log-anchor derivation.
-- (Authored as 405; renumbered to 415 at merge by the bridges merger: main's 405 is MCP's.)
--
-- Task 01a18bb5-2d6f-7de5-8cce-179de721d1be, from the #1438 review and B1b-2's
-- note. 400 carried its own internal.bridge_summary_log_anchor until 398's
-- helper reached main (400's TODO). Both are on main now, so the summary store
-- calls 399's uuid form, internal.bridge_log_anchor(<bridge id>::uuid) (the
-- explicit cast picks it over 398's public.bridges row overload), and S's copy
-- is dropped. tm8_app may execute the uuid form: the server's bridgeOf
-- (packages/server/src/bridges/summary.ts) derives the anchor through it
-- instead of restating the CASE.
--
-- store_bridge_chat_summary is 400's body, the latest on main, with only the
-- anchor call changed.
-- =============================================================================

set role tm8_graph_owner;

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
     where m.entity_id = p_through and m.anchor_id = internal.bridge_log_anchor(p_bridge_id::uuid);
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

grant execute on function internal.bridge_log_anchor(uuid) to tm8_app;

drop function internal.bridge_summary_log_anchor(public.bridges);

reset role;
