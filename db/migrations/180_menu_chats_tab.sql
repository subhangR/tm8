-- 180 — Chats becomes a tab of its own, seated after Home (2026-09-03).
--
-- Migration 176 made a chat an ENTITY with the core kind `chat`. Wave 1
-- deliberately left the menu alone and said why: since 134 the group whose id
-- is `chats` IS the Home tab (it holds the single `dashboard` view), so the
-- obvious "swap the Chats group" edit would have deleted Home. This seats the
-- new tab instead of moving the old one.
--
-- The resulting SERVER payload is:
--   Home | Chats | Work | Craft | Graph | CodeBrain | Settings | Help
-- tm8-ui inserts the route-only Board v2 seat after Work, producing the
-- visible nine-tab row.
--
-- Server twin of tm8-ui `SHIPPED_DEFAULT_MENU` revision 21 and of the
-- contract's `DEFAULT_MENU_GROUP_SPINE`, which both parity tests read.
--
-- THE GROUP ID IS `conversations`, NOT `chats`. Ids are wire-stable and
-- `chats` is taken — by Home, for the historical reason above. `chat` was
-- rejected as a neighbour of `chats`: two groups one letter apart, one of them
-- named Home, is a payload a human reads wrong. `conversations` is unambiguous
-- and the LABEL is what a viewer sees.
--
-- A KIND ITEM, NOT A VIEW. `w2_normalize_menu_payload` (071:161-174) validates
-- a kind ref against `public.entity_kinds` — `chat` is a core kind with
-- `space_id is null` since 176, so it resolves in every space and needs no
-- `menu_view_registry` row and no `menu_view_registry_ref_check` edit. That is
-- also why the group draws a RAIL: tm8-ui's `isRaillessGroup` keys on a lone
-- childless VIEW item, and this group's one item is a kind, so the tab renders
-- the chat list with the rail's own counter beside it.
--
-- THE GROUP CAP IS NOW FULL. `w2_normalize_menu_payload` refuses a payload
-- with more than 8 groups (071:61). This is the eighth. A ninth shipped tab
-- needs that limit raised, and this comment is where the next author finds
-- out before writing the migration rather than after.
--
-- Compatibility is byte/structure guarded, exactly as 164 and 173 did it. Only
-- a saved payload equal to migration 173's untouched default moves. An
-- operator-authored label, order, row or group makes the payload unequal and
-- it is left alone — so this migration can never overwrite a customized menu.

set role tm8_graph_owner;

-- THIS FILE IS THE HIGHER NUMBER, SO IT CARRIES EVERY ARM. `migrate.mjs`
-- applies by FILENAME order, so whichever redefinition of
-- `internal.w1_default_menu_payload` has the greater prefix is the one
-- Postgres ends up holding — merge order is irrelevant. 173's body is
-- reproduced below in full with one group inserted; nothing of it is dropped.
create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"conversations","label":"Chats","items":[{"type":"kind","ref":"chat"}]},
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
  payload_173 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
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
     and payload = payload_173;
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
    'chats','conversations','work','craft','graph','codebrain','settings','help'
  ] then
    raise exception 'VERIFY 180: default menu group spine is %', group_ids;
  end if;

  if payload #> '{groups,1,items}' is distinct from '[{"type":"kind","ref":"chat"}]'::jsonb then
    raise exception 'VERIFY 180: the Chats group does not hold the chat kind item';
  end if;

  -- The seeder's own payload must survive the guard every WRITE runs it
  -- through. A default the guard would refuse is a default no space can be
  -- created with, and 071 is the migration that learned this the hard way.
  perform internal.w2_normalize_menu_payload(null::uuid, payload);
end
$$;

reset role;
