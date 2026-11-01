-- Keep a split/fork's community in its replay record. This is the community
-- reported by WhatsApp at creation, not a stored community roster or picker.
set local lock_timeout = '5s';
set role tm8_graph_owner;

alter table public.bridge_splits add column community jsonb;

create or replace function public.bridge_split_of(p_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  return (select jsonb_build_object('conversationId', s.conversation_id, 'title', s.title,
                                   'bridgeId', s.bridge_id, 'community', s.community)
            from public.bridge_splits s where s.message_id = p_message_id);
end
$$;

create or replace function public.bridge_split_record(
  p_message_id uuid, p_from_bridge_id uuid, p_conversation_id text, p_title text, p_community jsonb
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  insert into public.bridge_splits(message_id, from_bridge_id, conversation_id, title, community)
  values (p_message_id, p_from_bridge_id, p_conversation_id, left(btrim(p_title), 200), nullif(p_community, 'null'::jsonb))
  on conflict (message_id) do nothing;
end
$$;
revoke all on function public.bridge_split_record(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.bridge_split_record(uuid, uuid, text, text, jsonb) to tm8_app;

-- Preserve the old door for callers that record a standalone group.
create or replace function public.bridge_split_record(
  p_message_id uuid, p_from_bridge_id uuid, p_conversation_id text, p_title text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform public.bridge_split_record(p_message_id, p_from_bridge_id, p_conversation_id, p_title, null);
end
$$;

reset role;
