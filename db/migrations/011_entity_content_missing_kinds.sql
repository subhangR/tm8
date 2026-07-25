-- =============================================================================
-- 011 — internal.entity_content returned '{}' for five core kinds, so the command
--       results for post_message and execution_spawn carried NO content at all.
--
-- THE BUG (found by db/test/ledger_replay.test.mjs asserting that a spawn result
-- reports status='spawning'):
--
--   internal.entity_content is the single content resolver. It is declared in 001
--   and extended in 005 (the sanctioned extension point), and every command result
--   goes through it: internal.command_entity builds
--       to_jsonb(entities) || {content: entity_content(id), counters: ...}
--   and internal.snapshot_entity_version stores the same shape in entity_versions.
--
--   Its CASE covers task, doc, spell, skill, team_member, collection, channel, file
--   and the custom c:* branch, and falls through to '{}' for everything else. Five
--   core kinds fall through:
--
--     message       -> messages.post returns an envelope with no body, no anchor_id,
--                      no author_id. This is the loop's "progress lands in the task
--                      thread" step: the facade gets a message it cannot render.
--     work_session  -> execution.spawn returns a session with no status, project_id,
--                      workdir_mode, agent_tool, model or mode. This is the loop's
--                      spawn step: SpawnService cannot read the session it just made.
--     member        -> spaces.create's patches carry a member with no role or
--                      display_name.
--     pull_request, commit  -> same gap, not on the G1A loop.
--
--   Verified before the fix, against the applied 001-010 sequence:
--     select internal.entity_content(id) from entities where kind = 'message'  -> {}
--     ... kind = 'work_session' -> {}    ... kind = 'member' -> {}
--
--   It is silent because '{}' is a perfectly valid jsonb object: nothing raises,
--   the result shape is right, and the content is simply missing.
--
-- Same shape as every existing branch (`to_jsonb(row) - 'entity_id'`), so the
-- content blocks stay consistent with the kinds that already worked.
--
-- Forward-only: 001-008 are applied and checksum-locked elsewhere.
-- =============================================================================
set role tm8_graph_owner;

create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then
    return null;
  end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then
        select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then
        select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then
        select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then
        select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then
        select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then
        select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then
        select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'file' then
        select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      -- --- added in 011 -----------------------------------------------------
      when 'message' then
        select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then
        select to_jsonb(ws) - 'entity_id' into content
          from public.work_sessions ws where ws.entity_id = target;
      when 'member' then
        select to_jsonb(mem) - 'entity_id' into content
          from public.members mem where mem.entity_id = target;
      when 'pull_request' then
        select to_jsonb(pr) - 'entity_id' into content
          from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then
        select to_jsonb(cm) - 'entity_id' into content
          from public.commits cm where cm.entity_id = target;
      -- ----------------------------------------------------------------------
      else
        content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

comment on function internal.entity_content(uuid) is
  'The single content resolver for command results and version snapshots. Covers '
  'every core kind that has a detail table (message/work_session/member/'
  'pull_request/commit added in 011) plus the custom c:* branch. A kind with no '
  'branch silently yields {} — add the branch here, not at the call site.';

-- NOTE for whoever adds the next core kind: entity_content is the ONE place that
-- needs to learn about it. There is no test that can fail generically for a
-- missing branch, because '{}' is a valid content block — so
-- db/test/loop_rpcs.test.mjs asserts the content of each kind the loop touches
-- explicitly. Add yours there too.

reset role;
