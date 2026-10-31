-- =============================================================================
-- 427 — Bridges: one progress reaction on an inbound WhatsApp message,
-- advancing 📨 delivered -> 👀 seen -> ✅ replied.
-- (Provisional number: 425 is #1479's and 426 is #1481's; the bridges merger
-- assigns the final one.)
--
-- Task 01a19326-bd0c-7517-bd06-55f4f266f786. Builds on 398 (B1b-2: the outbox,
-- its `react` kind and the watchdog's ⚠️), 413 (B1b-8: session deliveries) and
-- 419 (*Reply here only*). 398 is immutable once applied; the one 398 object
-- this file replaces, internal.bridge_outbox_take, is restated from 398's body
-- (no later file redefines it) with one more refusal, marked `427`.
--
-- THE CONSTRAINT. WhatsApp keeps ONE reaction per sender per message, and a
-- new one replaces the old. Progress is therefore one reaction that advances,
-- never three side by side, and it never steps back: each stage is its own
-- outbox row (bridge_outbox_one_react stays one row per key), and every
-- reaction key has a rank:
--
--     tm8:delivered  📨  1    it reached tm8
--     tm8:seen       👀  2    the target took it in
--     watchdog       ⚠️  3    398's watchdog: the turn failed or stalled
--     tm8:replied    ✅  4    a reply crossed back out
--     anything else      100  an explicit reaction (bridge_react_message)
--
-- (bridge_outbox.reaction is at most 16 characters, hence the short keys.)
--
-- A stage is enqueued only above the highest rank the message already has (in
-- any status), and dispatch drops a reaction row while a higher-ranked one
-- exists for the same message (`superseded`), so a late or retried 📨 never
-- lands after 👀 or ✅. A stage not yet dispatched is rewritten in place to the
-- next one, so a burst costs one row against the §2.7 buckets, not three. An
-- explicit reaction ends progress on that message: it is someone's answer and
-- tm8 does not paint over it.
--
-- WHICH EVENT IS WHICH STAGE (written on the task too):
--   DELIVERED  the inbound transaction commits a stored, non-command message
--              that tm8 acts on (below). Chat and work_session targets.
--   SEEN       chat target:   the routed copy's chat turn is claimed
--                             (chat_turns.state queued -> running).
--              work_session:  a session_message_deliveries row for the routed
--                             copy (or, for a directed worker, the log message)
--                             settles `delivered`: the prompt reached the PTY.
--              channel:       the log copy IS the channel post, so the inbound
--                             commit is already SEEN; it starts at 👀.
--   REPLIED    a `send` outbox row quoting the message (external_reply_to) is
--              settled `sent` by the runtime: the reply is on WhatsApp. A chat
--              turn's answer, a member's or worker's tm8 reply all qualify.
--
-- WHICH MESSAGES CARRY PROGRESS ("tm8 acts on it"): routed (trigger fired and
-- whoMayTrigger allowed the author, 398/406/413), or directed at a live worker
-- (an @handle, a reply to its post, its /work thread: 399's audience, reason
-- `directed`), or on a channel target whose trigger fires for an allowed
-- author (`every`; `mention` by @tm8 in the text or a quote of our message;
-- the default `none` is a silent mirror). Group chatter tm8 only logs gets no
-- reaction. Commands get none (their answer is a notice).
--
-- GATES RESPECTED: every row goes through internal.bridge_outbox_enqueue, so
-- an ended, paused, muted or direction:in bridge, a connection off the
-- allowlist and the buckets refuse a reaction exactly as they refuse a send,
-- and bridge_outbox_take re-checks them at dispatch. A paused or ended bridge
-- stores no inbound at all (398). A guest's message carries progress only
-- where whoMayTrigger lets a guest trigger. *Reply here only* (419) posts no
-- outbox row, so it never sends and never reaches ✅.
--
-- Nothing here may fail its host transaction: every hook calls
-- internal.bridge_progress_try, which swallows an error into a WARNING. A lost
-- reaction is cosmetic; a lost inbound message or chat turn is not.
-- WhatsApp only: other providers' reaction semantics differ.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Ranks and stages.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_reaction_rank(p_key text) returns integer
language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_key
    when 'tm8:delivered' then 1
    when 'tm8:seen' then 2
    when 'watchdog' then 3
    when 'tm8:replied' then 4
    else 100 end
$$;
revoke all on function internal.bridge_reaction_rank(text) from public;

-- Does tm8 act on this inbound message (the header's list)?
create or replace function internal.bridge_progress_addressed(o public.message_origins, b public.bridges) returns boolean
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare body text; author_kind text;
begin
  if o.routed then return true; end if;
  if exists (select 1 from public.bridge_inbound_deliveries d
              where d.message_id = o.message_id and d.reason = 'directed') then
    return true;
  end if;
  select m.body, e.kind into body, author_kind
    from public.messages m join public.entities e on e.id = m.author_id
   where m.entity_id = o.message_id;
  if b.target_kind = 'channel' then
    if not (b.policy ->> 'whoMayTrigger' = 'anyone' or author_kind = 'member') then return false; end if;
    return case b.policy ->> 'trigger'
      when 'every' then true
      when 'mention' then
           coalesce(body, '') ~* '(^|[^[:alnum:]_])@tm8([^[:alnum:]_]|$)'
        or (o.external_reply_to_id is not null and exists (
              select 1 from public.message_origins x
               where x.bridge_id = b.entity_id and x.external_message_id = o.external_reply_to_id
                 and x.direction = 'out'))
      else false end;
  end if;
  -- Directed at a worker, decided now (the delivery itself runs after commit).
  return exists (select 1 from public.bridge_message_audience(b.entity_id, o.message_id) a
                  where a.reason = 'directed');
end
$$;
revoke all on function internal.bridge_progress_addressed(public.message_origins, public.bridges) from public;

-- -----------------------------------------------------------------------------
-- §2. THE one writer of progress: advance an inbound message to p_stage, or
--     answer why not. p_message is the log copy (the `in` origin's message).
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_progress_advance(p_message uuid, p_stage text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins; b public.bridges;
  v_key text := 'tm8:' || p_stage;
  v_emoji text := case p_stage when 'delivered' then '📨' when 'seen' then '👀' when 'replied' then '✅' end;
  v_top integer; v_started boolean; v_row uuid;
begin
  if v_emoji is null then raise exception 'progress is delivered, seen or replied' using errcode = '22023'; end if;
  select * into o from public.message_origins where message_id = p_message and direction = 'in';
  if o.message_id is null or o.command_state is not null then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_inbound');
  end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  if b.entity_id is null or b.provider <> 'whatsapp' then
    return jsonb_build_object('status', 'ignored', 'reason', 'provider');
  end if;

  -- One stage decision per message at a time.
  perform pg_advisory_xact_lock(hashtextextended('bridge-progress:' || p_message, 0));
  select max(internal.bridge_reaction_rank(reaction)), coalesce(bool_or(reaction like 'tm8:%'), false)
    into v_top, v_started
    from public.bridge_outbox where message_id = p_message and kind = 'react';
  if v_top >= 100 then
    return jsonb_build_object('status', 'ignored', 'reason', 'explicit_reaction');
  end if;
  if coalesce(v_top, 0) >= internal.bridge_reaction_rank(v_key) then
    return jsonb_build_object('status', 'ignored', 'reason', 'behind');
  end if;
  if not v_started and not internal.bridge_progress_addressed(o, b) then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_addressed');
  end if;

  -- A stage still waiting to go is rewritten to this one: WhatsApp would
  -- replace it anyway, and the buckets count rows. A row a dispatch holds is
  -- no longer pending once its lock is released, and gets a new row below.
  update public.bridge_outbox
     set reaction = v_key, payload = jsonb_set(payload, '{emoji}', to_jsonb(v_emoji))
   where message_id = p_message and kind = 'react' and status = 'pending' and reaction like 'tm8:%'
  returning id into v_row;
  if v_row is not null then
    return jsonb_build_object('status', 'pending', 'outboxId', v_row, 'stage', p_stage, 'coalesced', true);
  end if;
  return internal.bridge_outbox_enqueue(b.entity_id, p_message, 'react',
           jsonb_build_object('target', internal.bridge_quote_ref(p_message), 'emoji', v_emoji),
           jsonb_build_object('poster', 'system', 'reaction', v_key))
         || jsonb_build_object('stage', p_stage);
end
$$;
revoke all on function internal.bridge_progress_advance(uuid, text) from public;

-- The hooks' door: never fails the transaction it rides.
create or replace function internal.bridge_progress_try(p_message uuid, p_stage text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  return internal.bridge_progress_advance(p_message, p_stage);
exception when others then
  raise warning 'bridge progress % on % skipped: % (%)', p_stage, p_message, sqlerrm, sqlstate;
  return jsonb_build_object('status', 'ignored', 'reason', 'error');
end
$$;
revoke all on function internal.bridge_progress_try(uuid, text) from public;

-- -----------------------------------------------------------------------------
-- §3. The events.
-- -----------------------------------------------------------------------------

-- DELIVERED (SEEN on a channel target), at the inbound commit: by then 398's
-- `routed` flag is set and the copies are in place.
create or replace function internal.bridge_progress_on_inbound() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare kind text;
begin
  select b.target_kind into kind from public.bridges b where b.entity_id = new.bridge_id;
  perform internal.bridge_progress_try(new.message_id, case when kind = 'channel' then 'seen' else 'delivered' end);
  return null;
end
$$;
revoke all on function internal.bridge_progress_on_inbound() from public;
create constraint trigger message_origins_bridge_progress after insert on public.message_origins
  deferrable initially deferred for each row
  when (new.direction = 'in' and new.command_state is null)
  execute function internal.bridge_progress_on_inbound();

-- SEEN, chat target: the routed copy's turn is picked up.
create or replace function internal.bridge_progress_on_turn() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins;
begin
  o := internal.bridge_origin_of(new.user_message_id);
  if o.message_id is null or o.direction <> 'in' then return null; end if;
  if not exists (select 1 from public.bridges b
                  where b.entity_id = o.bridge_id and b.target_kind = 'chat' and b.target_id = new.chat_id) then
    return null;
  end if;
  perform internal.bridge_progress_try(o.message_id, 'seen');
  return null;
end
$$;
revoke all on function internal.bridge_progress_on_turn() from public;
create trigger chat_turns_bridge_progress after update of state on public.chat_turns
  for each row when (new.state = 'running' and old.state = 'queued')
  execute function internal.bridge_progress_on_turn();

-- REPLIED: a send quoting the message is on WhatsApp.
create or replace function internal.bridge_progress_on_sent() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare msg uuid;
begin
  select o.message_id into msg from public.message_origins o
   where o.bridge_id = new.bridge_id and o.external_message_id = new.external_reply_to and o.direction = 'in';
  if msg is not null then perform internal.bridge_progress_try(msg, 'replied'); end if;
  return null;
end
$$;
revoke all on function internal.bridge_progress_on_sent() from public;
create trigger bridge_outbox_progress_replied after update of status on public.bridge_outbox
  for each row when (new.kind = 'send' and new.status = 'sent' and old.status is distinct from 'sent'
                     and new.external_reply_to is not null)
  execute function internal.bridge_progress_on_sent();

-- -----------------------------------------------------------------------------
-- §4. Dispatch (398's internal.bridge_outbox_take), dropping a reaction that a
--     higher-ranked one on the same message has overtaken.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_outbox_take(p_runtime_ids text[], p_limit integer) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; frames jsonb := '[]'::jsonb; reason text;
begin
  perform internal.require_bridges_worker();
  for r in
    select ob.*, c.runtime_id, c.status as conn_status, b.paused_at, b.ended_at, b.muted_until,
           b.policy ->> 'direction' as direction, b.external_conversation_id as conv
      from public.bridge_outbox ob
      join public.bridge_connections c on c.id = ob.connection_id
      join public.bridges b on b.entity_id = ob.bridge_id
     where (ob.status = 'pending' or (ob.status = 'failed_retryable' and coalesce(ob.next_attempt_at, now()) <= now()))
       and c.runtime_id = any(p_runtime_ids) and c.status = 'linked'
     order by ob.created_at
     limit greatest(least(p_limit, 100), 1)
     for update of ob skip locked
  loop
    reason := case
      when r.ended_at is not null then 'bridge_ended'
      when r.paused_at is not null or r.muted_until > now() then 'bridge_paused'
      when r.direction = 'in' then 'direction_in'
      when not (r.conv = any(internal.bridge_allowlist_ids(r.connection_id))) then 'not_connected'
      -- 427: WhatsApp keeps one reaction per sender; a lower one sent now would replace a higher one.
      when r.kind = 'react' and internal.bridge_reaction_rank(r.reaction) < 100 and exists (
             select 1 from public.bridge_outbox x
              where x.message_id = r.message_id and x.kind = 'react' and x.id <> r.id
                and internal.bridge_reaction_rank(x.reaction) > internal.bridge_reaction_rank(r.reaction))
        then 'superseded' end;
    if reason is not null then
      update public.bridge_outbox set status = 'failed_permanent', settled_at = now(), last_error = reason where id = r.id;
      continue;
    end if;
    update public.bridge_outbox set status = 'dispatching', attempts = attempts + 1, dispatched_at = now() where id = r.id;
    frames := frames || jsonb_build_array(jsonb_build_object('runtimeId', r.runtime_id, 'frame',
      case r.kind
        when 'send' then jsonb_strip_nulls(jsonb_build_object('type', 'send', 'outboxId', r.id,
          'connectionId', r.connection_id, 'conversationId', r.conv, 'text', r.payload ->> 'text',
          'replyTo', r.payload -> 'replyTo'))
        else jsonb_build_object('type', 'react', 'outboxId', r.id, 'connectionId', r.connection_id,
          'conversationId', r.conv, 'target', r.payload -> 'target', 'emoji', r.payload ->> 'emoji') end));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_outbox_take(text[], integer) from public;
grant execute on function internal.bridge_outbox_take(text[], integer) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- §5. SEEN, work_session target and directed workers: the prompt reached the
--     session. session_message_deliveries (015) belongs to the migration owner,
--     so its trigger and function are created here, after `reset role`, as
--     413 §5 did for session_message_reply_routes. A `listening` delivery
--     (thread/all) is not one tm8 was asked for and does not count.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_progress_on_session_delivery() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins;
begin
  o := internal.bridge_origin_of(new.message_id);
  if o.message_id is null or o.direction <> 'in' then return null; end if;
  if exists (select 1 from public.bridge_inbound_deliveries d
              where d.message_id = o.message_id and d.session_id = new.target_work_session_id
                and d.reason in ('routed', 'directed'))
     -- 406 (L): a reply routed to a live loop session, as its anchored copy.
     or (o.routed and exists (select 1 from public.messages m
                               where m.entity_id = new.message_id and m.anchor_id = new.target_work_session_id)) then
    perform internal.bridge_progress_try(o.message_id, 'seen');
  end if;
  return null;
end
$$;
revoke all on function internal.bridge_progress_on_session_delivery() from public;
create trigger session_message_deliveries_bridge_progress after insert or update of status on public.session_message_deliveries
  for each row when (new.status = 'delivered')
  execute function internal.bridge_progress_on_session_delivery();
