-- A REPLY MUST WAKE THE SESSION IT IS ANSWERING.
--
-- THE DEFECT. 072 computes a message's delivery targets as "the ANCHORS of this
-- batch that are work_session entities". `message send` works because the caller
-- names the recipient session as `--to`, so the recipient IS an anchor. A reply
-- derives its anchor instead, and the derived anchor is never the recipient:
--
--   * DIRECT MESSAGE. A single `--to` leaves `conversationAnchorId` null, so 072
--     defaults it to the message's only anchor — the RECIPIENT's own session.
--     Every `direct_message` route row is therefore a self-loop
--     (`target_message_id = source_message_id`, `target_work_session_id =
--     source_anchor_id`), `w2_resolve_session_message_reply` hands the replier
--     back its OWN session as the anchor, and the Server's dispatch loop then
--     correctly refuses to inject a session's message into itself.
--
--   * CHANNEL / TASK. The reply is anchored on the channel, so the batch holds
--     no work_session anchor at all and route recording takes its early exit.
--     Zero routes, zero deliveries.
--
-- Measured before this migration: every reply in the database had ZERO delivery
-- rows while every send had one. Three replies, three silent drops. They were
-- stored correctly and readable — they simply never reached anyone.
--
-- A THIRD FACE, unreported until now: a HUMAN replying in the browser to an
-- agent's channel message is silenced by the identical early exit. That is why
-- the rule below keys on the graph `parent_id` and NOT on the `replyToMessageId`
-- INPUT — the input is refused without a work-session-bound credential, so a
-- human can only ever reply by passing `parentMessageId`, and a rule written
-- against the input would leave the human half broken forever.
--
-- WHY THE OBVIOUS FIX IS IMPOSSIBLE. "Add the sender's session as a second
-- anchor and let the existing fan-out deliver it" cannot be done:
-- `w2_post_message_batch` (019:415-425) requires a threaded reply to have
-- EXACTLY ONE anchor, equal to its parent's. That rule is right — a thread lives
-- in one place — so the coupling has to break on the other side.
--
-- THE RULE. Storage location and wake target stop being the same set. A message
-- copy owes a live copy to the union of:
--     ANCHOR TARGET — its anchor, when that anchor is a work_session (072's
--                     rule, unchanged), and
--     REPLY TARGET  — `authored_from(parent_id)`: the session that wrote the
--                     message being answered.
-- The reply is DELIVERED TO that session; it is not ANCHORED IN it. Anchoring it
-- there would violate "reply anchor must equal parent anchor" for every channel
-- and task thread.
--
-- `authored_from` is the right discriminator and it is exact. Measured over the
-- whole message table: members hold 541 messages and ZERO `authored_from` edges;
-- team members hold 129 and 127. The two exceptions are `--as` impersonation
-- posted from a HUMAN's token, which sharpens rather than weakens the rule —
-- `authored_from` means A SESSION-BOUND CREDENTIAL AUTHORED THIS, and the
-- discriminator is the credential, not the author's kind. When there is no
-- origin session there is no live terminal waiting on an answer, so there is
-- correctly nothing to wake. `edges_authored_from_source_idx` is UNIQUE on
-- `src_id`, so "the origin session of a message" is single-valued and cannot
-- silently resolve to one of several.

-- ---------------------------------------------------------------------------
-- 1. One copy can owe a wake to more than one session.
-- ---------------------------------------------------------------------------
-- A reply anchored on a session carries BOTH an anchor target (that session)
-- and a reply target (whoever it answers). The old primary key admitted one row
-- per copy and would have rejected the second. The row's meaning is unchanged
-- and is exactly what the table comment already claimed: one message copy
-- delivered to one work session.
alter table public.session_message_reply_routes
  drop constraint if exists session_message_reply_routes_pkey;
alter table public.session_message_reply_routes
  add primary key (target_message_id, target_work_session_id);

comment on table public.session_message_reply_routes is
  'Immutable origin for a message copy delivered to a work session. One copy may be delivered to several sessions — its anchor session and the session it answers are different facts. Retained independently of the prunable delivery-attempt ledger.';

-- ---------------------------------------------------------------------------
-- 2. Route recording computes a TARGET SET, not an anchor set.
-- ---------------------------------------------------------------------------
create or replace function public.w2_record_session_message_routes(
  p_message_ids uuid[],
  p_conversation_anchor_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
-- `author_id` is BOTH a local below and a real column of public.messages, and
-- the batch guard compares them in one predicate over that table. Without this
-- option that reference is ambiguous and every call dies with SQLSTATE 42702 —
-- which is every messages.post. See 072 and the repair in PR #8.
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

  -- DOES THIS BATCH OWE ANYONE A LIVE COPY? 072 asked only the first half of
  -- this question — "is any anchor a work_session" — and a channel-anchored
  -- reply answers no, which is the exit that silenced every channel reply. The
  -- second disjunct is the whole fix: a reply owes a copy to the session it
  -- answers even when nothing in the batch is anchored on a session. The guard
  -- is still needed, though: a batch that owes nothing at all must return an
  -- empty set here rather than fall through to the conversation-anchor
  -- resolution below, which raises on a multi-anchor batch with no
  -- conversationAnchorId.
  if not exists (
       select 1 from public.messages m join public.entities e on e.id = m.anchor_id
        where m.entity_id = any(p_message_ids) and e.kind = 'work_session'
     )
     and not exists (
       select 1
         from public.messages m
         join public.entities me on me.id = m.entity_id
         join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
        where m.entity_id = any(p_message_ids) and me.parent_id is not null
     )
  then
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
    -- ANCHOR TARGETS: 072's rule, byte-for-byte in meaning. The copy's own
    -- anchor is a session, so that session receives it, and a reply to it goes
    -- back to the conversation the batch named.
    with anchor_targets as (
      select m.entity_id               as target_message_id,
             m.anchor_id               as target_work_session_id,
             p_conversation_anchor_id  as src_anchor_id,
             source_message_id         as src_message_id
        from public.messages m
        join public.entities anchor on anchor.id = m.anchor_id
       where m.entity_id = any(p_message_ids) and anchor.kind = 'work_session'
    ),
    -- REPLY TARGETS: the session that authored the message this copy answers.
    -- `src_anchor_id` is the copy's OWN anchor — the thread's home — and
    -- `src_message_id` is the copy itself, so the recipient's reply resolves
    -- back to the same anchor with this copy as its parent. That is exactly
    -- what `reply anchor must equal parent anchor` demands, which is what makes
    -- the exchange stable for any number of rounds rather than only the first.
    reply_targets as (
      select m.entity_id    as target_message_id,
             origin.dst_id  as target_work_session_id,
             m.anchor_id    as src_anchor_id,
             m.entity_id    as src_message_id
        from public.messages m
        join public.entities me on me.id = m.entity_id
        join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
        join public.work_sessions ws on ws.entity_id = origin.dst_id
       where m.entity_id = any(p_message_ids) and me.parent_id is not null
    )
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from anchor_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from reply_targets
  loop
    insert into public.session_message_reply_routes(
      target_message_id, target_work_session_id, source_anchor_id,
      source_message_id, addressing_kind
    ) values (
      route_row.target_message_id,
      route_row.target_work_session_id,
      route_row.src_anchor_id,
      route_row.src_message_id,
      internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    )
    on conflict (target_message_id, target_work_session_id) do update
      set target_message_id = excluded.target_message_id
      where session_message_reply_routes.source_anchor_id = excluded.source_anchor_id
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
      'sourceAnchorId', route_row.src_anchor_id,
      'sourceAnchorKind', (select e.kind from public.entities e where e.id = route_row.src_anchor_id),
      'sourceMessageId', route_row.src_message_id,
      'threadParentMessageId', (select e.parent_id from public.entities e where e.id = route_row.src_message_id),
      'threadRootMessageId', (select coalesce(m.root_message_id, m.entity_id)
        from public.messages m where m.entity_id = route_row.src_message_id),
      'body', (select m.body from public.messages m where m.entity_id = route_row.target_message_id),
      'contextAnchors', (
        select coalesce(jsonb_agg(jsonb_build_object('id', sibling.anchor_id, 'kind', sibling_anchor.kind)
          order by sibling.anchor_id), '[]'::jsonb)
          from public.messages sibling
          join public.entities sibling_anchor on sibling_anchor.id = sibling.anchor_id
         where sibling.entity_id = any(p_message_ids)
           and sibling.anchor_id <> route_row.src_anchor_id
           and sibling.anchor_id <> route_row.target_work_session_id
      ),
      -- Read for the TARGET session. A reply target is not the copy's anchor,
      -- so a policy read keyed on the anchor would apply the wrong session's
      -- budget and injection allowlist to it.
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
      'addressingKind',
        internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    ));
  end loop;
  return result;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The addressing kind is a property of the SOURCE ANCHOR.
-- ---------------------------------------------------------------------------
-- 072 read `direct_message` only when the conversation anchor WAS the target
-- session, which is true for a send and false for the reply to it — so a DM
-- reply arrived labelled `anchored_message` and told the receiving agent the
-- wrong thing about what it was reading. What actually makes a message direct
-- is that the conversation lives on a work session at all.
create or replace function internal.w2_addressing_kind(
  p_source_anchor_id uuid,
  p_target_work_session_id uuid
) returns text language sql stable as $$
  select case
    when p_source_anchor_id = p_target_work_session_id then 'direct_message'
    when (select e.kind from public.entities e where e.id = p_source_anchor_id) = 'work_session'
      then 'direct_message'
    when (select e.kind from public.entities e where e.id = p_source_anchor_id) = 'channel'
      then 'channel_mention'
    else 'anchored_message'
  end
$$;

-- ---------------------------------------------------------------------------
-- 4. Reply resolution is keyed on the pair, because the pair is now the key.
-- ---------------------------------------------------------------------------
-- The two failures stay DISTINGUISHABLE. "No route at all" is a message this
-- node never delivered to anyone; "a route, but not to you" is an attempt to
-- answer a conversation the caller was not part of, and that one is the check
-- the whole table exists to make.
create or replace function public.w2_resolve_session_message_reply(
  p_target_message_id uuid,
  p_source_work_session_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare route public.session_message_reply_routes;
declare source_message public.messages;
begin
  select * into route from public.session_message_reply_routes
   where target_message_id = p_target_message_id
     and target_work_session_id = p_source_work_session_id;
  if route.target_message_id is null then
    if exists (
      select 1 from public.session_message_reply_routes
       where target_message_id = p_target_message_id
    ) then
      raise exception 'message was not delivered to the authenticated work session'
        using errcode = '42501';
    end if;
    raise exception 'reply route unavailable for this message'
      using errcode = 'P0002', detail = 'reply_route_unavailable';
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

revoke all on function internal.w2_addressing_kind(uuid,uuid) from public;
revoke all on function public.w2_record_session_message_routes(uuid[],uuid) from public;
revoke all on function public.w2_resolve_session_message_reply(uuid,uuid) from public;

grant execute on function public.w2_record_session_message_routes(uuid[],uuid) to tm8_app;
grant execute on function public.w2_resolve_session_message_reply(uuid,uuid) to tm8_app;
