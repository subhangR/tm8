-- =============================================================================
-- 063 — per-kind live counters for the menu rail.
--
-- The rail has always been able to draw a number (MenuRail's `RefPresentation`
-- carries both `badge` and `live`), but only ONE kind ever supplied one:
-- work_session, whose green `● n` is the live/running count from the liveness
-- snapshot. Every other row — tasks, docs, teammates, memories, artifacts,
-- projects, pull requests — drew nothing, because nothing in the read surface
-- returns a COUNT.
--
-- WHY A DEDICATED RPC RATHER THAN `Page.total`. `Page` already carries an
-- optional `total` that `collections.query` never populates, and filling it in
-- would look like the cheaper route. It is not: the client hydrates only four
-- kinds at boot (useGateData.ts), so a `total`-driven rail would leave most
-- rows blank until the user visited each section — a counter that appears only
-- after you have already looked is not a counter. One grouped scan answers all
-- kinds at once, in one round trip, before any list has been fetched.
--
-- WHAT "UNSEEN" MEANS, AND WHY IT IS NOT `attention_requests`.
-- `public.attention_requests` (050) is the obvious-looking candidate and the
-- wrong one. It is SPACE-WIDE: `resolve_entity_attention` carries no member
-- predicate, so one teammate opening an entity clears its flag for everybody.
-- It therefore cannot express "new to ME". It is also a CURATED escalation
-- queue — every row is a deliberate, scored, reasoned request feeding the
-- attention inbox, and it has zero automatic writers on purpose. Minting one
-- per created entity would need a synthetic reason and score for every row and
-- would bury real escalations. Attention is left untouched by this migration.
--
-- `public.read_marks` (003) is the right primitive and was already general:
--
--     anchor_id uuid not null references public.entities(id) on delete cascade
--
-- ANY entity, with no channel constraint — the whole stack (the `mark_read`
-- RPC, the `readMarks.upsert` operation, its server handler, the browser
-- client and a CLI verb) has always accepted an arbitrary entity id. It has
-- simply only ever been CALLED for channels. So "unseen" needs no new state
-- and, unlike a `now() - interval '24 hours'` recency window, no arbitrary
-- constant and no cliff edge: a row is unseen until YOU open it, and goes
-- unseen again when it changes after you last looked.
--
-- COUNTED SEPARATELY, NOT FILTERED. `total` is every live readable entity of
-- the kind; `unseen` is the subset. The rail draws them in different slots, so
-- collapsing them into one number would lose the distinction it renders.
-- =============================================================================
set role tm8_graph_owner;

-- Supports the anti-join below: for one member, every anchor they have read.
-- `read_marks_anchor_idx` (003) indexes the other direction only.
create index if not exists read_marks_member_anchor_idx
  on public.read_marks(member_id, anchor_id) include (last_read_at);

create or replace function public.space_kind_counts(p_space_id uuid)
returns table(kind text, total integer, unseen integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (select internal.current_member_id(p_space_id) as member_id)
  select e.kind,
         count(*)::integer as total,
         -- NULL mark = never opened. A mark older than the entity's last
         -- activity = opened, then changed since. `activity_at` is the same
         -- column the default list ordering uses, so "changed" means here
         -- exactly what it means everywhere else in the product.
         count(*) filter (
           where mark_row.last_read_at is null
              or e.activity_at > mark_row.last_read_at
         )::integer as unseen
    from public.entities e
    left join public.read_marks mark_row
      on mark_row.anchor_id = e.id
     and mark_row.member_id = (select member_id from me)
   where e.space_id = p_space_id
     and e.deleted_at is null
     -- Membership is checked once for the whole call; `entity_readable` then
     -- removes the restricted rows this caller may not see, so a counter can
     -- never disclose the existence of something the list would hide.
     and internal.is_space_member(p_space_id)
     and internal.entity_readable(e.id)
   group by e.kind
$$;

revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;

reset role;
