-- =============================================================================
-- 431 — Bridges: an image posted in tm8 reaches the WhatsApp group.
-- (431: main holds up to 429; #1481 holds 430.)
--
-- Phase-1's wa-bridge sent attachments (9415617). The bridges runtime can too:
-- the protocol's `send` frame has `media` and the runtime turns it into an image
-- or document message. But the server never filled it in. The outbound rule
-- (419) queued only the text, and dispatch (427) built the frame from `text`
-- and `replyTo`. So a message posted with an image went to the group as its
-- caption alone, or as just the signature when the body was empty. Reported
-- by Subhang, 2026-11-01.
--
-- internal.bridge_outbound_after_message is restated from 419 (its latest
-- definition). The one change: the outbox payload carries the message's
-- attachments (`files`). messages.attachments is written in the same
-- transaction as the message, and this trigger runs at commit.
--
-- internal.bridge_outbox_take is restated from 427 (its latest definition).
-- The one change: a send frame carries `files`, each attached file's storage
-- path, space, name, mime and size, read now so a deleted file is left out.
-- The database cannot read blob bytes, so BridgeRuntimeHub reads them, sets
-- `media` and removes `files` before the frame goes out (bridges/runtime/hub.ts).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.bridge_outbound_after_message() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  m public.messages; self public.entities; author public.entities; b public.bridges; o public.message_origins;
  parent uuid; source uuid; source_kind text; poster text; teammate uuid; session uuid; directed boolean := false;
  text_out text;
begin
  select * into m from public.messages where entity_id = new.entity_id;
  select * into self from public.entities where id = new.entity_id;
  if m.entity_id is null or self.deleted_at is not null then return null; end if;
  if exists (select 1 from public.message_origins where message_id = m.entity_id) then return null; end if;
  if exists (select 1 from public.bridge_outbox where message_id = m.entity_id and kind = 'send')
     or exists (select 1 from public.bridge_delivery_refusals where message_id = m.entity_id) then return null; end if;
  select * into author from public.entities where id = m.author_id;
  if author.kind = 'bridge' then return null; end if;
  -- 419 (D76): *Reply here only* — the message, or any copy of its batch,
  -- stays in tm8: no outbox row and no refusal.
  if exists (select 1 from public.bridge_here_only h
              where h.message_id = m.entity_id
                 or (m.message_batch_id is not null and h.message_id in (
                       select t.entity_id from public.messages t where t.message_batch_id = m.message_batch_id))) then
    return null;
  end if;
  if m.message_batch_id is not null and exists (
       select 1 from public.messages twin
        where twin.message_batch_id = m.message_batch_id and twin.entity_id <> m.entity_id
          and (exists (select 1 from public.bridge_outbox ob where ob.message_id = twin.entity_id and ob.kind = 'send')
               or exists (select 1 from public.bridge_delivery_refusals r where r.message_id = twin.entity_id)
               or exists (select 1 from public.message_origins oo where oo.message_id = twin.entity_id))) then
    return null;
  end if;

  select e.dst_id, de.kind into source, source_kind
    from public.edges e join public.entities de on de.id = e.dst_id
   where e.src_id = m.entity_id and e.type = 'authored_from' and de.kind in ('work_session', 'chat')
   limit 1;

  parent := self.parent_id;
  if parent is not null then
    o := internal.bridge_origin_of(parent);
    if o.message_id is not null then select * into b from public.bridges where entity_id = o.bridge_id; end if;
  end if;
  if b.entity_id is null then
    select br.* into b from public.bridges br
     where br.ended_at is null
       and ((br.target_kind <> 'channel' and br.entity_id = m.anchor_id)
            or (br.target_kind = 'channel' and br.target_id = m.anchor_id))
     limit 1;
  end if;
  if b.entity_id is null then
    -- outbound: all, on the target; a chat's own turn output crosses by the turn rule.
    select br.* into b from public.bridges br
     where br.ended_at is null and br.target_id = m.anchor_id and br.policy ->> 'outbound' = 'all'
       and source is distinct from br.target_id
     limit 1;
  end if;
  if b.entity_id is null then return null; end if;

  if author.kind = 'member' then
    poster := 'member';
  elsif source_kind = 'chat' then
    poster := 'chat'; teammate := author.id;
  else
    poster := 'worker'; teammate := author.id; session := case when source_kind = 'work_session' then source end;
  end if;
  if poster <> 'member' then
    directed := coalesce((internal.bridge_try('public.bridge_post_is_directed', 'uuid', m.entity_id::text))::text::boolean, false);
  end if;
  text_out := internal.bridge_signed(b, m.author_id, session, poster, m.body);
  perform internal.bridge_outbox_enqueue(b.entity_id, m.entity_id, 'send',
    jsonb_strip_nulls(jsonb_build_object('text', text_out,
      -- 431: the message's attachments ({fileEntityId, name, mime}), read when dispatched.
      'files', nullif(coalesce(m.attachments, '[]'::jsonb), '[]'::jsonb),
      'replyTo', case when o.message_id is not null and o.bridge_id = b.entity_id then internal.bridge_quote_ref(parent) end)),
    jsonb_strip_nulls(jsonb_build_object('poster', poster, 'teammateId', teammate, 'sessionId', session,
      'directed', directed,
      'replyToExternalId', case when o.bridge_id = b.entity_id then o.external_message_id end)));
  return null;
end
$$;
revoke all on function internal.bridge_outbound_after_message() from public;

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
          'replyTo', r.payload -> 'replyTo',
          -- 431: SERVER-ONLY. Where each attached file's bytes are; the hub reads
          -- them, sends `media` and strips this key before the frame leaves.
          'files', (select jsonb_agg(jsonb_build_object('fileEntityId', f.entity_id, 'spaceId', e.space_id,
                        'storagePath', f.storage_path, 'name', f.name, 'mime', f.mime_type, 'size', f.size_bytes)
                        order by a.ord)
                      from jsonb_array_elements(r.payload -> 'files') with ordinality a(item, ord)
                      join public.files f on f.entity_id = (a.item ->> 'fileEntityId')::uuid
                      join public.entities e on e.id = f.entity_id and e.deleted_at is null)))
        else jsonb_build_object('type', 'react', 'outboxId', r.id, 'connectionId', r.connection_id,
          'conversationId', r.conv, 'target', r.payload -> 'target', 'emoji', r.payload ->> 'emoji') end));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_outbox_take(text[], integer) from public;
grant execute on function internal.bridge_outbox_take(text[], integer) to tm8_app;

reset role;
