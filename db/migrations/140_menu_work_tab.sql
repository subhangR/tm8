-- 140 — the Work tab returns: the three-panel workspace as its own top-level
-- tab (user ruling, task 01a00b46, 2026-08-16). Server twin of tm8-ui
-- SHIPPED_DEFAULT_MENU revision 19 (shared truth: the contract's
-- DEFAULT_MENU_GROUP_SPINE, which gains {serverId:'work', clientId:'work'};
-- menu-seeder-parity.pg.test.ts pins this file's payload against it).
--
-- NUMBERED 140: measured 2026-08-16 against ALL refs, remote and local — the
-- union's max is 139 (delivery pair/budget repair). Re-measure at merge time
-- as always; the chain has raced before, and the measure is the union plus
-- reservations, never previous+1.
--
-- WHAT CHANGED, in one line: a WORK group joins between Home and Board —
--   chats(Home) | work | board | craft | graph | files | settings
--
-- WHY THIS IS NOT A REVERT OF 134. 134 retired the Work group on the
-- reasoning that Home's root column already lists every collection kind, so
-- Work was a second door to the same lists. That was true of 134's Work
-- group, which was a RAIL OF ROWS — the Workspace caret with its eight
-- kinds, the three dev kinds, and the git view. It is not true of this one.
-- This group holds ONE childless `workspace` view item, so the tab is the
-- three-panel workspace ITSELF: side panel · center stage · side panel. That
-- is a LAYOUT, and Home offers no equivalent — the duplicated doors 134
-- removed are not being restored, only the split pane they were attached to.
--
-- NO REGISTRY WORK. `workspace` is not a new view ref: 029 created its
-- registry row (`'#/s/{s}/workspace'`, menu_eligible, implemented) and
-- nothing has touched it since — the ref survived 122/126/134 exactly as
-- those migrations promised ("nothing was deleted: `workspace`, `git`,
-- `messages` keep their routes"). The closed ref constraint 137 last widened
-- already lists it. So this migration is the payload half alone: redefine
-- the default, then upgrade byte-equivalent legacy DEFAULTS only.
--
-- RAILLESS BY SHAPE, and that matters for the OLD group. tm8-ui's
-- `isRaillessGroup` tests childless-single-item FIRST and only then consults
-- RAILLESS_VIEW_REFS (which gains 'workspace' in this same change). A
-- pre-134 space that still carries the old Work group has a `workspace` item
-- with eight caret children, so it fails the shape test and keeps drawing
-- its rail — correct, because an operator with rows in a group must see
-- them. Only a lone childless `workspace` goes full-bleed.
--
-- The group id is `work` on BOTH sides. The historical `work`/`workspace`
-- server/client divergence belongs to the pre-134 group; nothing persists
-- under the old client id, so a group being minted fresh does not inherit
-- the asymmetry.
--
-- Caps hold: 7 groups (<=8), 1 item in the new group (<=12), no children,
-- depth 0, global ref uniqueness ('workspace' appears nowhere else in the
-- new default — 134 removed its only other seat), settings present.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 137 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. Comparison is jsonb-structural, so the
  -- formatting here is free; what must match is the shape 137 seeded. A
  -- space whose menu was hand-edited does not match and keeps its own
  -- arrangement, the workspace view still offerable to it through the menu
  -- editor (its registry row never left).
  payload_137 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_137;
end
$$;

reset role;
