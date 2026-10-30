-- =============================================================================
-- 405  ANY SPACE MEMBER ADDS A CONNECTOR, AND IT IS LIVE (task 01a18d91-53a3).
--
-- Until now registering, editing and deleting an MCP connector was admin-only
-- (296), a member could only REQUEST one (345), and a connector stayed
-- "Awaiting approval" until an admin flipped `approved`. Product decision: there
-- is no approval step. Any member of the Space may add any connector — remote,
-- private-network or a local (stdio) command — and it is approved the moment it
-- is added.
--
-- What changes:
--   * create_mcp_server_entity / update_mcp_server_entity: member, not admin.
--   * guard_mcp_definition: a non-request write needs a member, and every
--     INSERT that is not a request is stored `approved: true`, whatever the
--     caller sent. That covers every door that inserts a connector (the create
--     RPC, the generic entity create, `.mcp.json` import), not only the UI.
--   * guard_mcp_entity: any member may delete or restore a connector.
--
-- What does NOT change:
--   * The request door (345) still works and still stores an unapproved row,
--     so nothing that already reads a request breaks. The UI stops using it,
--     because the server now reports every member as able to register.
--   * A Space-scoped credential (shared with the whole Space) stays admin-only
--     (341): that is about whose key everyone else's calls run on, not about
--     approving a connector.
--   * Every definition check (validate_mcp_definition, the server key and name
--     uniqueness, the restore re-check) is 345's, verbatim.
-- =============================================================================

create or replace function public.create_mcp_server_entity(p_space_id uuid,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; target uuid;
begin
 perform internal.require_space_member(p_space_id);
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'mcp.servers.create');
 if replay is not null then
   perform internal.require_replay_principal(p_client_mutation_id);
   perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space'); return replay;
 end if;
 actor:=internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
 perform internal.validate_mcp_definition(p_definition);
 target:=internal.create_envelope(p_space_id,'mcp_server',actor,null,null);
 insert into public.mcp_servers(entity_id,space_id,title,definition) values(target,p_space_id,p_definition->>'name',p_definition);
 perform internal.record_initial_version(target,actor);
 return internal.ledger_record(p_client_mutation_id,'mcp.servers.create',internal.command_result(target,null,
 internal.record_activity(p_space_id,target,actor,'created',null,jsonb_build_object('kind','mcp_server')),array[target]));
end $$;

create or replace function public.update_mcp_server_entity(p_entity_id uuid,p_expected_version integer,p_definition jsonb,p_actor_id uuid default null,p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; e public.entities;
begin
 e:=internal.live_entity(p_entity_id,'mcp_server'); perform internal.require_space_member(e.space_id);
 perform internal.require_replay_principal(p_client_mutation_id);
 replay:=internal.ledger_replay(p_client_mutation_id,'mcp.servers.update');
 if replay is not null then
   perform internal.require_replay_principal(p_client_mutation_id);
   perform internal.require_replay_subject(replay#>>'{entity,id}',p_entity_id::text,'entity'); return replay;
 end if;
 actor:=internal.resolve_actor(p_actor_id,e.space_id); perform internal.bind_actor(actor);
 perform internal.assert_version(p_entity_id,p_expected_version);
 perform internal.validate_mcp_definition(p_definition);
 update public.mcp_servers set definition=p_definition where entity_id=p_entity_id;
 return internal.ledger_record(p_client_mutation_id,'mcp.servers.update',internal.command_result(p_entity_id,null,
 internal.record_activity(e.space_id,p_entity_id,actor,'updated',null,jsonb_build_object('kind','mcp_server')),array[p_entity_id]));
end $$;

-- 345's body: the request branch is unchanged; the other branch needs a member
-- instead of an admin and approves on INSERT.
create or replace function internal.guard_mcp_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 if TG_OP='INSERT' and new.requested_by is not null then
   perform internal.require_space_member(new.space_id);
   if new.requested_by is distinct from internal.current_member_id(new.space_id) then
     raise exception 'a connector request records the requesting member' using errcode='42501';
   end if;
   if not internal.mcp_definition_is_request(new.definition) then
     raise exception 'a connector request must be an unapproved https connector with no administrator-only settings' using errcode='22023';
   end if;
 else
   perform internal.require_space_member(new.space_id);
   -- No approval step: a connector a member adds is live.
   if TG_OP='INSERT' then new.definition:=jsonb_set(new.definition,'{approved}','true'::jsonb); end if;
 end if;
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then raise exception 'MCP space mismatch' using errcode='22023'; end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 if (new.definition->>'approved')='true' and new.approved_at is null then
   new.approved_at:=now();
 end if;
 if TG_OP='INSERT' or internal.mcp_effective_server_key(new.definition)
                      is distinct from internal.mcp_effective_server_key(OLD.definition) then
   perform internal.assert_mcp_server_key_free(new.space_id,new.entity_id,new.definition);
 end if;
 if TG_OP='INSERT' or lower(new.definition->>'name') is distinct from lower(OLD.definition->>'name') then
   perform internal.assert_mcp_server_name_free(new.space_id,new.entity_id,new.definition);
 end if;
 return new;
end $$;

-- 345's body with one rule: any member may delete or restore a connector (a
-- request's withdrawal is now just a member's delete).
create or replace function internal.guard_mcp_entity() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare m public.mcp_servers;
begin
 select * into m from public.mcp_servers where entity_id=new.id;
 perform internal.require_space_member(old.space_id);
 if new.space_id<>old.space_id then raise exception 'MCP servers cannot move between spaces' using errcode='42501'; end if;
 if old.deleted_at is not null and new.deleted_at is null then
   perform internal.assert_mcp_server_key_free(new.space_id,new.id,m.definition);
   perform internal.assert_mcp_server_name_free(new.space_id,new.id,m.definition);
 end if;
 return new;
end $$;
