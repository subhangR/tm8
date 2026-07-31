-- 059 — Memories, Artifacts and Worktrees in the server-owned default menu.
--
-- Same shape and same reasoning as 045 (graph): the kinds shipped (055/056/
-- 057) with registry rows, list panels and slugs, but no menu named them, so
-- three finished features were unreachable from the rail. Upgrade only
-- byte-equivalent legacy defaults (the 045 payload); an administrator's
-- customized menu remains untouched.
--
-- Menu VISIBILITY only. A worktree is still born exclusively from the
-- provisioning saga and an artifact from its publish RPC — generic create for
-- both stays refused server-side, which is the same visible-but-not-creatable
-- posture `project` has always had. (The contract's MenuKindRef dropped its
-- `worktree` exclusion in lockstep, 2026-07-31; the 029 validator checks
-- `entity_kinds`, where all three kinds already exist as core rows.)

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
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 045 default, verbatim — jsonb equality is structural, so whitespace
  -- differences between here and 045 cannot cause a false miss.
  legacy_default constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
  -- 045 upgraded only rows still matching the PRE-045 default, so a Space
  -- created before 045 whose menu was never touched again sits on the
  -- pre-graph payload to this day. Recognize both generations of "never
  -- customized" — upgrading either loses nothing an administrator authored.
  pre_045_default constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"}]}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and (payload = legacy_default or payload = pre_045_default);
end
$$;

reset role;
