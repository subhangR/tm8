-- =============================================================================
-- 230 — chat_context: the latest context-window reading of a chat's runtime
-- (Chat Context, task 01a0d9c2 §4).
--
-- WHAT IS HERE
--   1. `public.chats.context` jsonb, null until the first main-thread request
--      of a turn is measured. It holds ONE reading — the latest — in the
--      contract's SessionTranscriptContext shape; it is about the conversation
--      as a whole, so there is never one per request or per turn.
--   2. `public.set_chat_context(chat, context)` — the runtime's write, gated
--      exactly like `mark_chat_runtime_state` (176): the identity that
--      configured the chat, which is the identity the orchestrator runs under.
--
-- WHY A COLUMN: the reading must survive the runtime. A cold or stopped chat
-- shows it as "last known", and the entity read folds it into chat state
-- (entity-read.ts and its projector twin), so a reload needs no live process.
--
-- VALIDATION is shape, not semantics: an object whose `source` is a known
-- request-usage source, and no bigger than a reading can be. The server
-- parses it with SessionTranscriptContextSchema before it gets here.
--
-- NO EVENT: live readers get the `chat.context` WS frame; the column is for
-- the next read.
-- =============================================================================

set role tm8_graph_owner;

alter table public.chats add column context jsonb
  check (context is null or jsonb_typeof(context) = 'object');

comment on column public.chats.context is
  'Latest context-window reading of the chat runtime (SessionTranscriptContext); NULL until measured.';

create function public.set_chat_context(p_chat_id uuid, p_context jsonb)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row public.chats;
begin
  perform internal.require_identity();
  if p_context is null or jsonb_typeof(p_context) <> 'object'
     or coalesce(p_context->>'source', '') not in ('claude_request_usage', 'codex_request_usage')
     or octet_length(p_context::text) > 4096 then
    raise exception 'invalid chat context' using errcode = '22023';
  end if;
  select * into chat_row from public.chats where entity_id = p_chat_id for update;
  if chat_row.entity_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  update public.chats set context = p_context where entity_id = p_chat_id;
end
$$;

revoke all on function public.set_chat_context(uuid, jsonb) from public;
grant execute on function public.set_chat_context(uuid, jsonb) to tm8_app;

reset role;

do $verify$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'chats' and column_name = 'context'
       and data_type = 'jsonb' and is_nullable = 'YES'
  ) then
    raise exception 'VERIFY 230: public.chats.context was not created';
  end if;
  if to_regprocedure('public.set_chat_context(uuid,jsonb)') is null then
    raise exception 'VERIFY 230: public.set_chat_context was not created';
  end if;
  if not has_function_privilege('tm8_app', 'public.set_chat_context(uuid,jsonb)', 'execute') then
    raise exception 'VERIFY 230: tm8_app cannot execute set_chat_context';
  end if;
end
$verify$;
