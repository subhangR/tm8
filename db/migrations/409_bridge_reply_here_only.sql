-- =============================================================================
-- 409 — Bridges B2-ticks follow-up: the badge read's pre-filter, and
-- *Reply here only* (§4.5).
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §2.3, §4.5,
-- D65, D75, D76. Task 01a18bb9-eca7-76fa-80ce-e8d40afb261f. Builds on 398
-- (B1b-2) and 406 (B2-ticks, PR #1434).
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_message_badges(ids): 406's body at f6bac5160, with one
--       statement in front that keeps only the ids whose message or batch twin
--       has an origin, a send row or a refusal. The event mapper calls this on
--       every message event, so a page no bridge touched now costs that one
--       statement instead of about five per id (D75).
--   §2  public.bridge_here_only: the messages their author posted with
--       *Reply here only*. public.mark_bridge_here_only(ids) writes it, from
--       the posting transaction only (the 328 set_chat_turn_team rule).
--   §3  internal.bridge_outbound_after_message(): 398's body, with one more
--       skip: a message, or a batch twin of one, marked here-only never
--       reaches internal.bridge_outbox_enqueue, so it neither queues nor
--       records a refusal (D76). The trigger is deferred to commit, so the
--       mark, written after the post in the same transaction, is always seen.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The badge read, pre-filtered.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_message_badges(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  out jsonb := '[]'::jsonb;
  id uuid;
  o public.message_origins;
  b public.bridges;
  author_kind text;
  sender_ids text[];
  link_scope uuid;
  linked boolean;
  twins uuid[];
  delivery jsonb;
  trust text;
  participant text;
  bridged uuid[];
begin
  if p_ids is null or cardinality(p_ids) = 0 then return out; end if;
  -- THE PRE-FILTER (D75): one statement keeps the ids a bridge touched, by
  -- the message itself or its batch twin, the same reach as the loop below
  -- (bridge_origin_of's twins, and the twins whose delivery it reads). Every
  -- lookup is an index probe: message_origins and bridge_delivery_refusals
  -- on their keys, bridge_outbox on bridge_outbox_one_send, twins on
  -- messages_batch_idx.
  with asked as (select distinct x as id from unnest(p_ids) x where x is not null),
  copies as (
    select a.id, a.id as copy from asked a
    union all
    select a.id, tw.entity_id
      from asked a
      join public.messages am on am.entity_id = a.id and am.message_batch_id is not null
      join public.messages tw on tw.message_batch_id = am.message_batch_id and tw.entity_id <> am.entity_id)
  select array_agg(distinct c.id) into bridged
    from copies c
   where exists (select 1 from public.message_origins mo where mo.message_id = c.copy)
      or exists (select 1 from public.bridge_outbox obx where obx.message_id = c.copy and obx.kind = 'send')
      or exists (select 1 from public.bridge_delivery_refusals rf where rf.message_id = c.copy);
  if bridged is null then return out; end if;
  foreach id in array bridged loop
    continue when not internal.entity_readable(id);
    o := internal.bridge_origin_of(id);

    -- The message and its batch twins: the delivery badge rides whichever copy
    -- the outbox row is on, and is read for both.
    select array_agg(t.entity_id order by (t.entity_id = id) desc, t.entity_id) into twins
      from public.messages m
      join public.messages t on t.entity_id = m.entity_id
        or (m.message_batch_id is not null and t.message_batch_id = m.message_batch_id)
     where m.entity_id = id;
    select d into delivery
      from jsonb_array_elements(internal.bridge_message_delivery(coalesce(twins, array[id]))) d
     order by (d ->> 'messageId')::uuid = id desc
     limit 1;

    continue when o.message_id is null and delivery is null;
    select * into b from public.bridges
     where entity_id = coalesce(o.bridge_id, (delivery ->> 'bridgeId')::uuid);
    continue when b.entity_id is null;

    trust := null; participant := null;
    if o.direction = 'in' then
      select e.kind into author_kind
        from public.messages m join public.entities e on e.id = m.author_id
       where m.entity_id = o.message_id;
      select coalesce(nullif(btrim(o.sender_display), ''), p.display_name),
             array[o.external_sender_id] || coalesce(p.alt_external_ids, '{}')
        into participant, sender_ids
        from (select 1) one
        left join public.bridge_participants p
          on p.bridge_id = b.entity_id and p.external_id = o.external_sender_id;
      if author_kind = 'bridge' then
        trust := 'guest';
      else
        -- The resolver's order (395 bridge_resolve_author): a verified link
        -- first, then this space's admin assertion.
        select l.space_id, true into link_scope, linked
          from public.bridge_identity_links l
         where l.provider = b.provider and l.external_id = any(sender_ids) and l.revoked_at is null
           and (l.space_id is null or l.space_id = b.space_id)
         order by l.space_id nulls first, l.verified_at
         limit 1;
        trust := case when linked is null then 'linked' when link_scope is null then 'linked' else 'asserted' end;
        linked := null; link_scope := null;
      end if;
    end if;

    out := out || jsonb_build_array(jsonb_build_object(
      'messageId', id,
      'bridgeId', b.entity_id,
      'provider', b.provider,
      'conversation', case when internal.entity_readable(b.entity_id) then nullif(btrim(b.conversation ->> 'title'), '') end,
      'direction', coalesce(o.direction, 'out'),
      'participant', participant,
      'trust', trust,
      'delivery', case when coalesce(o.direction, 'out') = 'out' and delivery is not null
                       then delivery end));
  end loop;
  return out;
end
$$;
revoke all on function internal.bridge_message_badges(uuid[]) from public;
grant execute on function internal.bridge_message_badges(uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. Reply here only: the mark.
-- -----------------------------------------------------------------------------
create table public.bridge_here_only (
  message_id uuid primary key references public.messages(entity_id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.bridge_here_only enable row level security;

-- Marks the caller's just-posted messages here-only. Only a message created
-- in THIS transaction (created_at = now(), as 328's set_chat_turn_team) is
-- marked: by commit the outbound rule has run, so a later mark could change
-- nothing, and it must never read as if it had. Returns how many it marked.
create or replace function public.mark_bridge_here_only(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare marked integer;
begin
  perform internal.require_identity();
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  insert into public.bridge_here_only(message_id)
  select m.entity_id from public.messages m
   where m.entity_id = any(p_ids) and m.created_at = now() and internal.entity_readable(m.entity_id)
  on conflict (message_id) do nothing;
  get diagnostics marked = row_count;
  return marked;
end
$$;
revoke all on function public.mark_bridge_here_only(uuid[]) from public;
grant execute on function public.mark_bridge_here_only(uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. The outbound rule (398), skipping a here-only message.
-- -----------------------------------------------------------------------------
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
  -- 409 (D76): *Reply here only* — the message, or any copy of its batch,
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
      'replyTo', case when o.message_id is not null and o.bridge_id = b.entity_id then internal.bridge_quote_ref(parent) end)),
    jsonb_strip_nulls(jsonb_build_object('poster', poster, 'teammateId', teammate, 'sessionId', session,
      'directed', directed,
      'replyToExternalId', case when o.bridge_id = b.entity_id then o.external_message_id end)));
  return null;
end
$$;
revoke all on function internal.bridge_outbound_after_message() from public;

reset role;

analyze public.bridge_here_only;
