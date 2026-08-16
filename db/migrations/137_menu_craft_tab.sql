-- 137 — the Craft tab: the blueprint studio as its own top-level tab (Craft
-- P1, task 01a00a31, 2026-08-16). Server twin of tm8-ui SHIPPED_DEFAULT_MENU
-- revision 18 (shared truth: the contract's DEFAULT_MENU_GROUP_SPINE, which
-- gains {serverId:'craft', clientId:'craft'}; menu-seeder-parity.pg.test.ts
-- pins this file's payload against it).
--
-- NUMBERED 137: measured 2026-08-16 against ALL remote refs — the union's
-- max is 134, and this lane took 135 (graph kind) and 136 (craft chat mode).
-- Re-measured at merge time as always (the chain has raced twice; the union
-- plus reservations is the measure, never previous+1).
--
-- WHAT CHANGED, in one line: a CRAFT group joins between Board and Graph —
--   chats(Home) | board | craft | graph | files | settings
--
-- `craft` is a VIEW, not a kind move: the tab is a full-screen split pane —
-- a craft-mode chat thread anchored to a `graph` entity (135's kind) beside
-- a canvas rendering that entity's ROW — while the `graph` kind row stays an
-- ordinary collection kind, the same two-doors posture R9 set for files and
-- 130 kept for board. The group owns exactly one childless view item, so
-- tm8-ui's `isRaillessGroup` answers true and the screen renders full-bleed
-- ('craft' joined RAILLESS_VIEW_REFS in the same change): the canvas and the
-- thread are the navigation, and a rail beside them could only repeat the
-- tab's name.
--
-- Follows the 045/096/102/117/130 four-step pattern for a NEW view ref:
-- widen the registry's closed ref constraint, register the implemented view,
-- redefine the default payload, then upgrade byte-equivalent legacy DEFAULTS
-- only. Drafted against the CURRENT chain head (134): the constraint keeps
-- every widening that landed since 130 (none — 131-134 touch no registry)
-- and the payload carries 134's unified-Home tab shell — re-authoring from
-- an older migration would silently revoke refs that already shipped.
--
-- Caps hold: 6 groups (<=8), 1 item in the new group (<=12), no children,
-- depth 0, global ref uniqueness ('craft' appears nowhere else), settings
-- present.

set role tm8_graph_owner;

-- The validator introduced by 029 accepts a view only when both its closed
-- ref constraint and registry row know about it (045's wording — same move).
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings','git','messages','board','craft')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('craft', '#/s/{s}/craft', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 134 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. Comparison is jsonb-structural, so the
  -- formatting here is free; what must match is the shape 134 seeded. A
  -- space whose menu was hand-edited does not match and keeps its own
  -- arrangement, the craft view still offerable to it through the menu
  -- editor's freed view refs.
  payload_134 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_134;
end
$$;

reset role;
