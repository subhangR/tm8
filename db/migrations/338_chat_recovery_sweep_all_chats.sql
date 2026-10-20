-- =============================================================================
-- 338: the chat recovery sweep sees every chat, not only the node owner's.
--
-- The server's boot reconcile and its 60s recovery sweep found stale turns and
-- queued work with two SELECTs over public.chats/chat_turns, run as the node
-- owner. Both tables are under RLS (entity_readable), so the sweep saw only the
-- chats in spaces the owner belongs to. A chat in any other space whose owner
-- died or stopped renewing its lease stayed stuck forever, and every message
-- behind it queued silently (prod 2026-10-20: chat dd0bbd03, turn frozen in
-- 'prepared' with an expired lease and four turns queued behind it; the sweep
-- saw 124 of 240 chats). A restart did not help: boot runs the same query.
--
-- This lists the same rows as the definer, gated by require_node_admin. It
-- returns only ids, the attempt number and the configuring identity, never chat
-- content, and skips deleted chats as RLS did. The server still recovers and
-- drains each chat as that chat's configuring identity (recover_chat_attempt
-- and claim_next_chat_turn check it), so this function grants nothing beyond
-- knowing which chats need a look.
--
--   kind 'stale'  — a running turn (or a closing owner) whose lease expired, or
--                   one this node owned under a previous boot. Same predicate
--                   recover_chat_attempt applies, so listing never steals.
--   kind 'queued' — a chat with queued turns and no live owner elsewhere.
-- =============================================================================
set role tm8_graph_owner;

create function public.list_recoverable_chats(p_node_id text, p_boot_id text)
returns table(kind text, chat_id uuid, configured_by_identity_id text, turn_id uuid,
  attempt_no integer, turn_ordinal bigint)
language plpgsql stable security definer set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_node_admin();
  return query
    select 'stale'::text, c.entity_id, c.configured_by_identity_id, t.turn_id, t.attempt_no, t.turn_ordinal
      from public.chats c join public.chat_turns t on t.chat_id=c.entity_id
      join public.entities e on e.id=c.entity_id and e.deleted_at is null
     where (t.state='running' or (c.runtime_phase='closing' and c.active_execution_snapshot_id=t.execution_snapshot_id))
       and ((c.node_id=p_node_id and c.runtime_owner_boot_id is distinct from p_boot_id)
         or coalesce(c.runtime_lease_expires_at,t.lease_expires_at)<=now())
     order by t.turn_ordinal;
  return query
    select distinct 'queued'::text, c.entity_id, c.configured_by_identity_id, null::uuid, null::integer, null::bigint
      from public.chats c join public.chat_turns t on t.chat_id=c.entity_id
      join public.entities e on e.id=c.entity_id and e.deleted_at is null
     where t.state='queued' and (c.node_id=p_node_id or c.node_id is null or c.runtime_lease_expires_at is null
       or c.runtime_lease_expires_at<=now());
end $$;

revoke all on function public.list_recoverable_chats(text,text) from public;
grant execute on function public.list_recoverable_chats(text,text) to tm8_app;
