-- =============================================================================
-- 077 — a message on a work anchor reaches the people who watch that anchor.
--
-- THE OBSERVED DEFECT. An agent's final report is `tm8 message send --to
-- <task-id>` on its assignment anchor — that is exactly what the agent worker
-- system prompt mandates. Measured: message 019fcfe9-4842-7ac0-8218-29a82d5ef179
-- anchored to task 019fcfe2-6d97-71ba-bf84-f0af2d435475 produced
-- `deliveries: []` AND zero notification rows. Nobody learned the agent had
-- finished. Two independent gates in 019 produce that silence:
--
--   * GATE 1 (019:461, inside w2_post_message_batch): a delivery intent is
--     created ONLY when the anchor is a `work_session`. That is CORRECT and this
--     file does not touch it — "delivery" means PTY injection into a live agent
--     process, and a task is not a process.
--   * GATE 2, the hole: `internal.w2_notify_actor` has exactly three call sites
--     in the whole of db/migrations — the `mention` fan-out (019:264, which only
--     fires for actors NAMED in `mentions`), `w2_delivery_fallback` (019:318,
--     which only fires when a PTY delivery FAILED), and the `message_reply` arm
--     (019:484, which only fires when the message has a parent). A TOP-LEVEL
--     message, on a non-work_session anchor, with no `--mention`, therefore
--     reaches the inbox of nobody at all.
--
-- WHAT THIS FILE ADDS. One new trigger function and one new trigger on
-- `public.messages` — a sibling of `messages_fan_out_mentions`, built the same
-- way and for the same reason. Nothing existing is replaced.
--
-- ⚠ DELIBERATELY *NOT* A `create or replace` OF ANY SHARED BODY. Several lanes
-- carry uncommitted arms of `public.w2_post_message_batch`,
-- `internal.w2_notify_actor` and `internal.fan_out_message_mentions`; replacing
-- any of them here would silently drop those arms and pass every static check
-- (the 052/053/055/056/057/065/066/073 rule). The whole fix is additive.
--
-- WHO COUNTS AS A WATCHER — A JUDGEMENT CALL, STATED PLAINLY. Two sources, and
-- only two: the anchor entity's `entities.created_by`, and its assignees (the
-- `assigned_to` edges, whose src is the anchor and whose dst is a member or
-- team_member — 001:902). "The person who opened this work item, and the people
-- who own it" is the smallest set that makes an agent's report land somewhere a
-- human looks. REJECTED ALTERNATIVES, and why:
--   * every `participates_in` actor (what `w2_delivery_fallback` uses): that
--     edge is a SESSION participation relation, not a work-item subscription;
--     on a task anchor it is empty, so it would have fixed nothing.
--   * everyone who has previously posted on the anchor (a thread-participant
--     model): unbounded, retroactive, and it turns one long thread into an
--     inbox row per participant per message. That is a subscription feature
--     with an opt-out, not a defect fix, and it needs a `muted` surface first.
--
-- TWO ANCHOR KINDS ARE EXCLUDED, ALSO A JUDGEMENT CALL.
--   * `channel` — a channel already has an unread model (`public.read_marks`,
--     023) and channel traffic is the highest-volume message class in the
--     system. Notifying the channel's creator on every line posted to it would
--     turn one person's inbox into a firehose, which is the exact failure 003's
--     header calls out ("notifications are TARGETED, not broadcast").
--   * `work_session` — that anchor is the one Gate 1 already serves: the message
--     is injected into the agent's PTY, and `w2_delivery_fallback` already
--     raises `session_delivery_failed` for the session's spawning actor when
--     that injection does not land. A second, always-on row per session line
--     would duplicate a channel that already works.
-- Everything else (task, doc, file, collection, pull_request, custom kinds, …)
-- is in scope. The exclusion is by anchor kind and nothing else, so a new work
-- kind is covered the day it is registered.
--
-- SUPPRESSIONS. Two, both required for this not to be noise:
--   * the message's own author is never notified. `w2_notify_actor` already
--     refuses `p_recipient_actor = p_actor` for every kind except the two it
--     names, and `anchor_message` is not one of them — but the rule is asserted
--     HERE as well, so the intent is local and does not depend on a shared body
--     another lane may edit.
--   * anyone the message NAMED in `mentions` is skipped, because
--     `messages_fan_out_mentions` is notifying them for this same message. The
--     test is against `new.mentions` rather than against rows already in
--     `public.notifications`, so it does not depend on trigger firing order
--     (which is alphabetical by trigger name and would be a silent coupling).
--   KNOWN, ACCEPTED OVERLAP: a REPLY whose anchor creator is also the parent
--   message's author gets both this row and 019:484's `message_reply` row. It
--   is not suppressed because the two paths disagree about when the reply
--   notification exists at all (`public.w2_post_message_batch` raises it,
--   `public.post_message` never has), so a suppression here would be right on
--   one door and wrong on the other. Two rows for one event is a cosmetic
--   duplicate; a swallowed report is the defect this file exists for.
--
-- THE `kind` IS NEW AND NEEDS NO REGISTRATION. `public.notifications.kind` is
-- `text not null` with NO check constraint (003:79, whose own comment says
-- "Open by contract"); `NotificationItem.kind` in packages/contract is
-- `… | string`; `NotificationItemSchema` validates `z.string()`; the server's
-- event mapper reads it as a free string (events/mapper.ts:635); the tm8-ui
-- inbox routes an unrecognised kind to the `other` group rather than dropping
-- it (inbox/inbox-model.ts:74-80); and the legacy oracle's kind table falls back
-- to a de-underscored label (collab-v2/screens/inbox/kinds.ts:24-26). So
-- `anchor_message` is legal everywhere and renders, unstyled, today.
--
-- FAILURE IS SWALLOWED, ON PURPOSE AND WITH PRECEDENT. Like
-- `internal.fan_out_message_mentions` (019:270), this trigger ends with
-- `exception when others then return new`: a notification is a courtesy and a
-- broken courtesy must never refuse a message write. The cost is that a bug in
-- here is silent, which is why the landing evidence for this file is a POSITIVE
-- observation of rows appearing, never an absence of errors.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.w2_notify_anchor_watchers() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  anchor_row  public.entities;
  watcher_row record;
begin
  select * into anchor_row from public.entities where id = new.anchor_id;
  if anchor_row.id is null or anchor_row.deleted_at is not null then
    return new;
  end if;
  -- See the header: channels have read_marks, sessions have delivery.
  if anchor_row.kind in ('channel', 'work_session') then
    return new;
  end if;

  for watcher_row in
    select candidate.actor_id,
           string_agg(distinct candidate.reason, ',' order by candidate.reason) as reasons
      from (
        select anchor_row.created_by as actor_id, 'anchor_creator'::text as reason
        union all
        select edge.dst_id, 'anchor_assignee'::text
          from public.edges edge
         where edge.src_id = anchor_row.id
           and edge.type = 'assigned_to'
      ) candidate
     where candidate.actor_id is not null
       -- Never notify yourself about your own message.
       and candidate.actor_id <> new.author_id
       -- The mention fan-out owns everyone this message named. Compared as
       -- text so a malformed mention cannot raise on a uuid cast.
       and not exists (
         select 1
           from jsonb_array_elements(
                  case when jsonb_typeof(new.mentions) = 'array'
                       then new.mentions else '[]'::jsonb end) mentioned
          where mentioned.value ->> 'entityId' = candidate.actor_id::text
       )
     group by candidate.actor_id
     order by candidate.actor_id
  loop
    -- w2_notify_actor is the ONLY writer: it re-checks that the recipient is a
    -- live member/team_member of this exact space and routes a teammate row to
    -- its owning member, so this trigger never has to know those rules.
    perform internal.w2_notify_actor(
      anchor_row.space_id,
      watcher_row.actor_id,
      'anchor_message',
      anchor_row.id,
      new.author_id,
      jsonb_build_object(
        'messageId', new.entity_id,
        'anchorId', anchor_row.id,
        'anchorKind', anchor_row.kind,
        'watchReason', watcher_row.reasons,
        'excerpt', left(new.body, 280)));
  end loop;
  return new;
exception when others then
  -- A courtesy row must never refuse the message it is about.
  return new;
end
$$;

comment on function internal.w2_notify_anchor_watchers() is
  'After-insert fan-out for public.messages: notifies the anchor entity''s creator '
  'and assignees with kind ''anchor_message''. Skips channel/work_session anchors, '
  'the message author, and anyone already covered by messages_fan_out_mentions.';

create trigger messages_notify_anchor_watchers
after insert on public.messages
for each row execute function internal.w2_notify_anchor_watchers();

-- 019 closed the internal schema with `revoke all on all functions in schema
-- internal from public`. A function created afterwards is granted to PUBLIC by
-- default, so the surface is re-closed explicitly here rather than left to the
-- next blanket revoke. A trigger function's EXECUTE privilege is checked when
-- the trigger is CREATED (by the owner, who has it), not on every firing, so
-- this does not stop the trigger — same as fan_out_message_mentions, which has
-- lived under that revoke since 019.
revoke all on function internal.w2_notify_anchor_watchers() from public;

reset role;
