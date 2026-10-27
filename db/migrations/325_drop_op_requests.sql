-- =============================================================================
-- 325 — REMOVE the `op_request` kind entirely (task 01a1357d, owner ruling on
-- task 01a12c59, 2026-10-13: "remove the op_request ... nuke it entirely").
--
-- 280 (L5) added it: an agent filed a typed request for a human-only op, and a
-- human approved (it ran as them) or denied. The contract, server, CLI
-- (`tm8 request`) and UI no longer know the kind, so this file takes away
-- everything 280 put in the database, with no compatibility shim:
--
--   1. Leftover rows. Every `op_request` entity, soft-deleted or not, goes, and
--      with it every message anchored on one (280 posted each outcome as a
--      message on the request). Their detail rows, attention items and edges
--      cascade from the entity.
--   2. The doors and helpers: create/claim/settle/deny/get/list_op_request(s)
--      and the five internal.op_request_* helpers.
--   3. public.op_requests, with its trigger, policy, indexes and grants.
--   4. internal.entity_content loses the `op_request` arm (287 kept it across
--      the main sync; 296, 304, 318 and 322 re-issued it).
--   5. The core `op_request` row in public.entity_kinds.
--
-- SHARED-OBJECT NOTICE: §4 REPLACES `internal.entity_content` (latest definer
-- was 322_design_to_craft). This body is 322's VERBATIM minus the
-- `op_request` arm; the `craft` and `tool` arms are kept (craft-kind.pg.test.ts
-- pins both non-null). A later re-issuer must start from THIS body.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Leftover rows. Messages anchored on a request first: messages.anchor_id
--    references the entity with no cascade.
-- -----------------------------------------------------------------------------
delete from public.entities m
 using public.messages msg, public.entities req
 where msg.entity_id = m.id
   and msg.anchor_id = req.id
   and req.kind = 'op_request';

delete from public.entities where kind = 'op_request';

-- -----------------------------------------------------------------------------
-- 2. The doors and helpers. The helpers taking a public.op_requests row must go
--    before the table.
-- -----------------------------------------------------------------------------
drop function if exists public.create_op_request(uuid, text, text, text, jsonb, jsonb, text, text, uuid, uuid, text);
drop function if exists public.claim_op_request(uuid, text);
drop function if exists public.settle_op_request(uuid, boolean, jsonb, jsonb);
drop function if exists public.deny_op_request(uuid, text);
drop function if exists public.get_op_request(uuid);
drop function if exists public.list_op_requests(uuid, text, integer);
drop function if exists internal.op_request_for_decision(uuid);
drop function if exists internal.op_request_resolve_attention(uuid, uuid, text);
drop function if exists internal.op_request_touch(uuid);
drop function if exists internal.op_request_json(public.op_requests);
drop function if exists internal.op_request_can_decide(public.op_requests);

-- -----------------------------------------------------------------------------
-- 3. The detail table. Dropping it takes its trigger, RLS policy, indexes,
--    constraints and grants.
-- -----------------------------------------------------------------------------
drop table if exists public.op_requests;

-- -----------------------------------------------------------------------------
-- 4. internal.entity_content: 322's body without the `op_request` arm.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 283: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      -- 284: a space style's detail row. The row holds nothing secret (the
      -- document, tags and attribution), so the house form applies; the
      -- contract's camelCase shape is the read facade's job (`contentOf`).
      when 'style' then select to_jsonb(sty) - 'entity_id' into content from public.styles sty where sty.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      -- 304/322: the craft's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'craft' then select to_jsonb(dsg) - 'entity_id' into content from public.crafts dsg where dsg.entity_id = target;
      when 'tool' then select to_jsonb(tl) - 'entity_id'
        || jsonb_build_object('config', coalesce((select jsonb_object_agg(c.input_name,c.value) from public.tool_config c where c.tool_id=target),'{}'::jsonb),
          'secretBindings', coalesce((select jsonb_agg(jsonb_build_object('inputName',b.input_name,'credentialId',b.credential_id,'boundBy',b.bound_by,'boundAt',b.bound_at)) from public.tool_secret_bindings b where b.tool_id=target),'[]'::jsonb))
        into content from public.tools tl where tl.entity_id=target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. The registry row. A core row is immutable by trigger (as in 322 §1).
-- -----------------------------------------------------------------------------
alter table public.entity_kinds disable trigger entity_kinds_guard_core;
delete from public.entity_kinds where kind = 'op_request' and space_id is null;
alter table public.entity_kinds enable trigger entity_kinds_guard_core;

reset role;
