-- =============================================================================
-- 406 — Bridges B2-ticks: the bridged-message read and live delivery ticks.
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §4.5, §2.3,
-- D4, D64, D65. Task 01a189db-3067-74cf-9944-0d26f620a8dd. Builds on 398 (B1b-2).
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_message_badges(ids): for each readable message, the
--       bridge it crossed (its own origin or its batch twin's, so a routed
--       message's chat copy and log copy read the same), the participant and
--       trust of an inbound one, and the delivery badge of an outbound one.
--       The badge is 398's internal.bridge_message_delivery, not a second
--       derivation (D65). Trust needs bridge_identity_links, which tm8_app
--       cannot list, hence the definer.
--   Live ticks are 398's: its outbox and refusal triggers touch the message
--   row and its batch twins, so `message.updated` carries the new tick, and
--   the event mapper reads this function again for it.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The read.
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
begin
  if p_ids is null or cardinality(p_ids) = 0 then return out; end if;
  foreach id in array (select array_agg(distinct x) from unnest(p_ids) x) loop
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
                       then delivery - 'messageId' - 'bridgeId' - 'externalMessageId' end));
  end loop;
  return out;
end
$$;
revoke all on function internal.bridge_message_badges(uuid[]) from public;
grant execute on function internal.bridge_message_badges(uuid[]) to tm8_app;

reset role;
