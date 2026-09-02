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

-- REGISTER THE REF BEFORE ANY PAYLOAD CARRIES IT. `w2_normalize_menu_payload`
-- (071:101-112) rejects a view item whose ref is not a `menu_eligible` AND
-- `implemented` row in `public.menu_view_registry`, and `w2_guard_menu_config`
-- runs it on every write to `space_menu_configs`. Without this insert the update
-- below raises 22023 'unknown or unavailable MenuConfig view ref'.
--
-- THIS WAS INVISIBLE TO CI. `migrations apply clean` builds a FRESH database,
-- where no `space_menu_configs` row equals `payload_164`, so the guarded update
-- below matches ZERO rows, the trigger never fires, and the missing registry row
-- is never exercised. It fails only against a database that has real menu rows —
-- i.e. only on a deployed node. Confirmed on prod 2026-09-02: the migration
-- aborted mid-deploy and left the services stopped.
--
-- Every prior tab migration does this first — 045 (graph), 130 (board),
-- 137 (craft), 160 (help). 173 was the one that skipped it.
--
-- `menu_eligible` true, `required` false: an operator MAY seat CodeBrain and no
-- space is forced to carry it. `implemented` true because the view exists —
-- `codebrain` is in the contract's `MenuViewRef` union and `menu-resolve.ts`
-- resolves it with a label, icon and art.
insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('codebrain', '#/s/{s}/codebrain', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

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
