-- 184 — the Chats TAB leaves the top row; the chat list's door is Home's icon
-- rail (2026-09-05).
--
-- Migration 180 seated a CHATS group after Home, one day ago, and its
-- reasoning was right about the ARRANGEMENT and wrong about the ADDRESS.
--
-- RIGHT: the chat entity LIST is not Home's chats root. Home's chats root is
-- the two-pane CONVERSATION surface — a thread column beside a transcript.
-- The list is tiles carrying the turn state, the lifecycle tabs, sort,
-- in-panel search and the row-action cluster, opening a panel whose body is
-- that same conversation. Two arrangements over the same rows genuinely earn
-- two doors; it is the posture the Board tab has always taken toward `task`.
--
-- WRONG: the place this product addresses a collection kind's list is Home's
-- ICON RAIL (tm8-ui `domain/home-rail.ts`), and `chat` has been eligible for
-- that rail since migration 176 made it a collection kind — it was already
-- rendering there, under "More", while this tab claimed to be its door. The
-- rail now LEADS with `chat`, so the tab is the duplicate and it goes.
--
-- The resulting SERVER payload is 173's again, exactly:
--   Home | Work | Craft | Graph | CodeBrain | Settings | Help
-- tm8-ui inserts the route-only Board v2 seat after Work.
--
-- Server twin of tm8-ui `SHIPPED_DEFAULT_MENU` revision 23 and of the
-- contract's `DEFAULT_MENU_GROUP_SPINE`, which both parity tests read.
--
-- THE GROUP CAP IS EIGHT AND THE EIGHTH SEAT IS FREE AGAIN.
-- `w2_normalize_menu_payload` refuses a payload with more than 8 groups
-- (071:61). 180's comment told the next author the cap was full; this is where
-- they find out it is not.
--
-- NOTHING IS DELETED. `chat` is a core kind with `space_id is null` since 176,
-- so `w2_normalize_menu_payload` still accepts a kind ref of `chat` and a
-- space can put this group back through the menu editor. A rail edit, not a
-- feature removal — the posture of 125/126/127.
--
-- Compatibility is byte/structure guarded, exactly as 180 and 173 did it. Only
-- a saved payload equal to migration 180's untouched default moves. An
-- operator-authored label, order, row or group makes the payload unequal and
-- it is left alone — so this migration can never overwrite a customized menu.
-- In particular a space that DELIBERATELY kept the Chats tab by editing
-- anything else about its menu keeps it.

set role tm8_graph_owner;

-- THIS FILE IS THE HIGHER NUMBER, SO IT CARRIES EVERY ARM. `migrate.mjs`
-- applies by FILENAME order, so whichever redefinition of
-- `internal.w1_default_menu_payload` has the greater prefix is the one
-- Postgres ends up holding — merge order is irrelevant. 180's body is
-- reproduced below in full with the `conversations` group removed; nothing
-- else of it is dropped, and what remains is byte-identical to 173's.
create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"codebrain","label":"CodeBrain","items":[{"type":"view","ref":"codebrain"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb
$$;

do $$
declare
  payload_180 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"conversations","label":"Chats","items":[{"type":"kind","ref":"chat"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"codebrain","label":"CodeBrain","items":[{"type":"view","ref":"codebrain"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_180;
end
$$;

-- VERIFY — only what THIS file creates. A tranche suite replays this migration
-- mid-chain, so an assertion about anything else here would fail on a position
-- that is not this file's to defend.
do $$
declare
  payload constant jsonb := internal.w1_default_menu_payload();
  group_ids text[];
begin
  select array_agg(value ->> 'id' order by ordinality)
    into group_ids
    from jsonb_array_elements(payload -> 'groups') with ordinality;

  if group_ids is distinct from array[
    'chats','work','craft','graph','codebrain','settings','help'
  ] then
    raise exception 'VERIFY 184: default menu group spine is %', group_ids;
  end if;

  -- The whole point of the file: no group in the default names a KIND. 17's
  -- law, restored. An `items` array is small, so this reads every one of them
  -- rather than trusting the id list above.
  if exists (
    select 1
      from jsonb_array_elements(payload -> 'groups') g,
           jsonb_array_elements(g.value -> 'items') i
     where i.value ->> 'type' = 'kind'
  ) then
    raise exception 'VERIFY 184: the default menu still names a kind row';
  end if;

  -- The seeder's own payload must survive the guard every WRITE runs it
  -- through. A default the guard would refuse is a default no space can be
  -- created with, and 071 is the migration that learned this the hard way.
  perform internal.w2_normalize_menu_payload(null::uuid, payload);
end
$$;

reset role;
