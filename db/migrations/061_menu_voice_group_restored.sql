-- 061 — restore the Voice group 059's seeder failed to carry forward.
--
-- THE DEFECT (caught by the stable-build packager on 7777/7778): 059 rewrote
-- internal.w1_default_menu_payload() from the 045 payload — which predates
-- voice — so the server default has six groups while the client shipped
-- default (tm8-ui menu.ts revision 3+) carries a seventh:
--
--     {"id":"voice","label":"Voice","items":[]}
--
-- The group is items-EMPTY on purpose: it is the label GateApp's dynamic
-- group hangs the space's live voice_channel rows beneath
-- (MenuRail renders dynamicGroups[group.id] INSIDE the config's own groups —
-- no `voice` group in the served config, nowhere for voice rooms to render).
-- A served menu comes from space_menu_configs, not from the client default,
-- so after 059 the Voice section vanished for every space with a server row.
-- Classic whole-collection rewrite where an append was meant.
--
-- Empty `items` is legal at every layer, verified: the 029 validator refuses
-- only jsonb_array_length > 12, contract zod is .max(12) with no min, and the
-- rail's isRenderableMenu checks only the upper bound. No new refs are named,
-- so no registry or kind-union change rides along.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 059 payload verbatim: the only "un-customized current default" that
  -- can exist once the chain has run in order (059 already converted the 045
  -- and pre-045 generations). jsonb equality is structural, so formatting
  -- differences cannot cause a false miss.
  payload_059 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_059;
end
$$;

reset role;
