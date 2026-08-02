-- Durable session I/O routing and session-bound agent credentials.
--
-- A delivered message copy is the context handle shown to the receiving
-- session.  Its route is recorded in the same transaction as messages.post so
-- a later reply never has to guess from the session's most recent activity.

alter table public.auth_sessions
  add column if not exists work_session_id uuid
    references public.work_sessions(entity_id) on delete cascade;

create unique index if not exists auth_sessions_work_session_live_idx
  on public.auth_sessions(work_session_id)
  where work_session_id is not null and revoked_at is null;

create table if not exists public.session_message_reply_routes (
  target_message_id       uuid primary key references public.messages(entity_id) on delete cascade,
  target_work_session_id  uuid not null references public.work_sessions(entity_id) on delete cascade,
  source_anchor_id        uuid not null references public.entities(id) on delete cascade,
  source_message_id       uuid not null references public.messages(entity_id) on delete cascade,
  addressing_kind         text not null
    check (addressing_kind in ('channel_mention','direct_message','anchored_message')),
  created_at              timestamptz not null default now()
);

create index if not exists session_message_reply_routes_target_session_idx
  on public.session_message_reply_routes(target_work_session_id, created_at desc);

alter table public.session_message_reply_routes enable row level security;

comment on table public.session_message_reply_routes is
  'Immutable origin for a message copy delivered to a work session. Retained independently of the prunable delivery-attempt ledger.';

-- The bearer-token bootstrap remains claim-free, but a work-session token is
-- valid only while that exact session is live. Terminal sessions therefore
-- lose authority immediately without relying on a cleanup job.
create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
     and (
       s.work_session_id is null
       or exists (
         select 1 from public.work_sessions ws
          where ws.entity_id = s.work_session_id
            and ws.status in ('spawning','running','idle')
       )
     )
$$;

create or replace function public.issue_work_session_agent_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  account_row public.accounts;
  session_row public.auth_sessions;
  session_space uuid;
begin
  perform internal.require_identity();
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    raise exception 'invalid work-session credential' using errcode = '22023';
  end if;

  select a.* into account_row
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if account_row.id is null then
    raise exception 'active account not found' using errcode = 'P0002';
  end if;

  select e.space_id into session_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
    join public.edges relation on relation.src_id = e.id
      and relation.dst_id = p_team_member_id and relation.type = 'relates_to'
   where e.id = p_work_session_id
     and e.deleted_at is null
     and ws.status in ('spawning','running','idle')
   for update of ws;
  if session_space is null then
    raise exception 'live work session/persona relationship not found' using errcode = 'P0002';
  end if;
  if not internal.can_act_as(p_team_member_id, session_space) then
    raise exception 'cannot issue a credential for this session persona' using errcode = '42501';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at
  ) values (
    account_row.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, p_expires_at
  ) returning * into session_row;

  return to_jsonb(session_row) - 'token_hash';
end
$$;

create or replace function public.w2_record_session_message_routes(
  p_message_ids uuid[],
  p_conversation_anchor_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
-- `author_id` is BOTH a local below and a real column of public.messages, and
-- the batch guard compares them in one predicate over that table:
--   m.author_id is distinct from author_id
-- Without this option that reference is ambiguous and every call dies with
-- SQLSTATE 42702 — which is every messages.post, because the Server calls this
-- function unconditionally inside the post transaction. Resolving to the
-- variable is the intended reading everywhere here: every column reference in
-- this body is table-qualified, so nothing else changes meaning.
#variable_conflict use_variable
declare
  message_count integer;
  batch_id text;
  author_id uuid;
  message_space uuid;
  source_message_id uuid;
  source_anchor_kind text;
  route_row record;
  result jsonb := '[]'::jsonb;
begin
  if cardinality(coalesce(p_message_ids, '{}'::uuid[])) < 1 then
    raise exception 'message route recording requires a message batch' using errcode = '22023';
  end if;
  if cardinality(p_message_ids) <> cardinality(array(select distinct unnest(p_message_ids))) then
    raise exception 'message route ids must be unique' using errcode = '22023';
  end if;

  select m.message_batch_id, m.author_id, e.space_id into batch_id, author_id, message_space
    from public.messages m join public.entities e on e.id = m.entity_id
   where m.entity_id = p_message_ids[1];
  select count(*) into message_count
    from public.messages m
   where m.entity_id = any(p_message_ids);
  if message_count <> cardinality(p_message_ids)
     or exists (
       select 1 from public.messages m
        where m.entity_id = any(p_message_ids)
          and (m.message_batch_id is distinct from batch_id or m.author_id is distinct from author_id)
     )
     or author_id is distinct from coalesce(internal.actor_id(), internal.current_member_id(message_space)) then
    raise exception 'message route batch does not match the current authored command' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.messages m join public.entities e on e.id = m.anchor_id
     where m.entity_id = any(p_message_ids) and e.kind = 'work_session'
  ) then
    return result;
  end if;

  if p_conversation_anchor_id is null then
    if cardinality(p_message_ids) <> 1 then
      raise exception 'multi-anchor session delivery requires conversationAnchorId' using errcode = '22023';
    end if;
    select m.anchor_id into p_conversation_anchor_id
      from public.messages m where m.entity_id = p_message_ids[1];
  end if;

  select m.entity_id, e.kind into source_message_id, source_anchor_kind
    from public.messages m
    join public.entities e on e.id = m.anchor_id and e.deleted_at is null
   where m.entity_id = any(p_message_ids)
     and m.anchor_id = p_conversation_anchor_id;
  if source_message_id is null then
    raise exception 'conversationAnchorId must identify one message-batch anchor' using errcode = '22023';
  end if;

  for route_row in
    select m.entity_id as target_message_id, m.anchor_id as target_work_session_id
      from public.messages m
      join public.entities anchor on anchor.id = m.anchor_id
     where m.entity_id = any(p_message_ids) and anchor.kind = 'work_session'
  loop
    insert into public.session_message_reply_routes(
      target_message_id, target_work_session_id, source_anchor_id,
      source_message_id, addressing_kind
    ) values (
      route_row.target_message_id,
      route_row.target_work_session_id,
      p_conversation_anchor_id,
      source_message_id,
      case
        when p_conversation_anchor_id = route_row.target_work_session_id then 'direct_message'
        when source_anchor_kind = 'channel' then 'channel_mention'
        else 'anchored_message'
      end
    )
    on conflict (target_message_id) do update
      set target_message_id = excluded.target_message_id
      where session_message_reply_routes.target_work_session_id = excluded.target_work_session_id
        and session_message_reply_routes.source_anchor_id = excluded.source_anchor_id
        and session_message_reply_routes.source_message_id = excluded.source_message_id
        and session_message_reply_routes.addressing_kind = excluded.addressing_kind;
    if not found then
      raise exception 'message reply route conflicts with its recorded origin' using errcode = '23514';
    end if;

    result := result || jsonb_build_array(jsonb_build_object(
      'targetMessageId', route_row.target_message_id,
      'targetWorkSessionId', route_row.target_work_session_id,
      'messageBatchId', batch_id,
      'senderActorId', author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = author_id),
      'sourceAnchorId', p_conversation_anchor_id,
      'sourceAnchorKind', source_anchor_kind,
      'sourceMessageId', source_message_id,
      'threadParentMessageId', (select e.parent_id from public.entities e where e.id = source_message_id),
      'threadRootMessageId', (select coalesce(m.root_message_id, m.entity_id)
        from public.messages m where m.entity_id = source_message_id),
      'body', (select m.body from public.messages m where m.entity_id = route_row.target_message_id),
      'contextAnchors', (
        select coalesce(jsonb_agg(jsonb_build_object('id', sibling.anchor_id, 'kind', sibling_anchor.kind)
          order by sibling.anchor_id), '[]'::jsonb)
          from public.messages sibling
          join public.entities sibling_anchor on sibling_anchor.id = sibling.anchor_id
         where sibling.entity_id = any(p_message_ids)
           and sibling.anchor_id <> p_conversation_anchor_id
           and sibling.anchor_id <> route_row.target_work_session_id
      ),
      'rollingControlMaxBytes', coalesce((
        select (pin.resolved_snapshot #>> '{agentProjection,promptPolicy,rollingControlMaxBytes}')::integer
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), 16384),
      'sessionInputAllowed', coalesce((
        select case
          when jsonb_array_length(coalesce(
            pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}', '[]'::jsonb
          )) = 0 then true
          else coalesce(
            (pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}')
              ? 'tm8.session-input',
            false
          )
        end
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), true),
      'addressingKind', case
        when p_conversation_anchor_id = route_row.target_work_session_id then 'direct_message'
        when source_anchor_kind = 'channel' then 'channel_mention'
        else 'anchored_message'
      end
    ));
  end loop;
  return result;
end
$$;

create or replace function public.w2_resolve_session_message_reply(
  p_target_message_id uuid,
  p_source_work_session_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare route public.session_message_reply_routes;
declare source_message public.messages;
begin
  select * into route from public.session_message_reply_routes
   where target_message_id = p_target_message_id;
  if route.target_message_id is null then
    raise exception 'reply route unavailable for this message' using errcode = 'P0002', detail = 'reply_route_unavailable';
  end if;
  if route.target_work_session_id is distinct from p_source_work_session_id then
    raise exception 'message was not delivered to the authenticated work session' using errcode = '42501';
  end if;
  select * into source_message from public.messages where entity_id = route.source_message_id;
  if source_message.entity_id is null or source_message.anchor_id is distinct from route.source_anchor_id
     or not internal.entity_readable(source_message.entity_id) then
    raise exception 'reply destination is no longer readable' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'anchorId', route.source_anchor_id,
    'parentMessageId', route.source_message_id,
    'addressingKind', route.addressing_kind
  );
end
$$;

-- Future core-default pins accept the unified inbound envelope. Existing pins
-- remain immutable; an empty legacy allowlist is treated by the Server as the
-- pre-allowlist compatibility posture.
create or replace function internal.w2g12_core_draft() returns jsonb
language sql immutable parallel safe as $$
  select '{
    "name":"Core default",
    "description":"Built-in fallback profile",
    "templateKey":"tm8.chat.core",
    "templateVersion":1,
    "promptPolicy":{
      "kernelTemplate":"tm8.core.v1",
      "initialContextMaxBytes":32768,
      "rollingControlMaxBytes":32768,
      "allowedInjectionKinds":["tm8.session-input"],
      "untrustedEncoding":"escaped-xml"
    },
    "toolDiscoveryPolicy":{
      "rootHelpRef":"tm8://help",
      "preloadNouns":["entities","messages"],
      "semanticSearchEnabled":true,
      "semanticMaxMatches":5,
      "nounShardMaxBytes":8192,
      "commandShardMaxBytes":16384,
      "entityContextDefaultBytes":16384,
      "providerToolRegistrationAllowlist":["entities.get","messages.post"]
    },
    "feedPolicy":{"scope":"session_chat_v1","pageSize":50,"bodyExcerptBytes":1024},
    "providerCaptureMode":"explicit-only",
    "composerPolicy":{
      "schemaRef":"tm8.composer.v1",
      "supportsReply":true,
      "supportsAttachments":true,
      "allowedAttachmentKinds":["file"],
      "operationBindings":["messages.post","messages.attachments.add"]
    }
  }'::jsonb
$$;

revoke all on table public.session_message_reply_routes from public;
revoke all on function public.issue_work_session_agent_session(uuid,uuid,text,timestamptz,text) from public;
revoke all on function public.w2_record_session_message_routes(uuid[],uuid) from public;
revoke all on function public.w2_resolve_session_message_reply(uuid,uuid) from public;

grant execute on function public.issue_work_session_agent_session(uuid,uuid,text,timestamptz,text) to tm8_app;
grant execute on function public.w2_record_session_message_routes(uuid[],uuid) to tm8_app;
grant execute on function public.w2_resolve_session_message_reply(uuid,uuid) to tm8_app;
