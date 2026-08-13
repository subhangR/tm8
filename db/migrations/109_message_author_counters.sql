-- 109 — split message tile counts by human and agent author.
--
-- `messages` remains the compatibility total used by existing feed hydration.
-- Tiles consume the two additive counters below so they never need to fetch an
-- entire feed merely to discover its author mix.

alter table public.entity_counters
  add column human_messages integer not null default 0,
  add column agent_messages integer not null default 0;

comment on column public.entity_counters.human_messages is
  'Trigger-maintained count of anchored messages authored by member entities.';
comment on column public.entity_counters.agent_messages is
  'Trigger-maintained count of anchored messages authored by team_member entities.';

-- Replace 001's total-only trigger with the author-aware version. Message
-- authors are immutable and constrained to these two kinds by validate_message.
create or replace function internal.maintain_message_counter() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  anchor uuid;
  author uuid;
  author_kind text;
  delta integer;
begin
  if tg_op = 'DELETE' then
    anchor := old.anchor_id;
    author := old.author_id;
    delta := -1;
  else
    anchor := new.anchor_id;
    author := new.author_id;
    delta := 1;
  end if;

  select kind into author_kind from public.entities where id = author;

  update public.entity_counters
     set messages = greatest(messages + delta, 0),
         human_messages = greatest(human_messages + case when author_kind = 'member' then delta else 0 end, 0),
         agent_messages = greatest(agent_messages + case when author_kind = 'team_member' then delta else 0 end, 0),
         updated_at = now()
   where entity_id = anchor;
  update public.entities set activity_at = now() where id = anchor and deleted_at is null;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- Existing rows predate the split counters. Rebuild all three together so the
-- invariant is explicit and deploys cannot expose a transient false split.
update public.entity_counters ec
   set messages = counts.total,
       human_messages = counts.human,
       agent_messages = counts.agent,
       updated_at = now()
  from (
    select anchor.id,
           count(message.entity_id)::integer as total,
           count(message.entity_id) filter (where author.kind = 'member')::integer as human,
           count(message.entity_id) filter (where author.kind = 'team_member')::integer as agent
      from public.entities anchor
      left join public.messages message on message.anchor_id = anchor.id
      left join public.entities author on author.id = message.author_id
     group by anchor.id
  ) counts
 where ec.entity_id = counts.id;
