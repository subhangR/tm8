-- 173 — CodeBrain becomes a shipped tab, seated after Graph (2026-09-01).
-- Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 21 and of the contract's
-- DEFAULT_MENU_GROUP_SPINE, which both parity tests read.
--
-- The resulting SERVER payload is:
--   Home | Work | Craft | Graph | CodeBrain | Settings | Help
-- tm8-ui inserts the route-only Board v2 seat after Work, labelled exactly
-- "Board", producing the visible eight-tab row.
--
-- WHY A VIEW AND NOT A RAIL KIND. A CodeBrain run spans three kinds at once —
-- the team_member roster that names the phases, the task it is delivering, and
-- the work_session each phase runs in. R4 keeps the rail entities-only and
-- §15.2 makes a kind literal outside `domain/` a build failure, so the module
-- is a named view like `graph` and `craft`, whose screens are likewise reads
-- ACROSS kinds rather than lists of one.
--
-- Compatibility is byte/structure guarded, exactly as 164 did it. Only a saved
-- payload equal to migration 164's untouched default moves. An operator-authored
-- label, order, row or group makes the payload unequal and it is left alone —
-- so this migration can never overwrite a customized menu.

set role tm8_graph_owner;

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
  payload_164 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_164;
end
$$;

reset role;
