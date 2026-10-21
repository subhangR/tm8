-- =============================================================================
-- 345: MCP contract surface — connector REQUESTS from members, and changing a
-- LIVE chat's connectors. Plan §11, §10.1, §5.3; gaps G4 and the request half
-- of §10.1. Backend rulings B13 (requests) and B14 (chat selections).
--
-- WHAT CHANGES, AND THE RULE BEHIND EACH
--
-- 1. CONNECTOR REQUESTS (§11 `mcp.servers.request`, §10.1 "members get
--    Request"). Only admins could register a connector (296), so a member who
--    needed Figma had nothing to click. A request is now the SAME mcp_server
--    entity an admin would create, created UNAPPROVED, plus an attention
--    request on it. That is deliberately not a second table:
--      * §10.1's Yours tab already lists "connectors you requested", and the
--        §10.0 status vocabulary already has not_approved -> "Awaiting
--        approval", so the row the member sees afterwards is the real one;
--      * approving is the EXISTING `mcp.servers.update` with approved=true, and
--        rejecting is a delete — no accept path to write, and no second shape
--        of the truth to keep in step;
--      * an unapproved connector is INERT. resolve and bind refuse it, and
--        `mcp.servers.test` and `mcp.oauth.begin` both pass through the
--        handler's `approved()` check first, so nothing in tm8 fetches a
--        requested URL before an admin says yes.
--
--    The relaxation is confined by the DATA, not by a flag. 296's triggers
--    demanded a space admin for any write to mcp_servers; they now demand one
--    unless the row IS a request — `internal.mcp_definition_is_request`: HTTPS
--    http-transport, approved=false, no OAuth clientSecretEnv (a member must not
--    name a server env secret for an admin to approve by eye), and none of the
--    trust/reach flags or tool gates. There is no claim to forge and no window
--    where a looser rule applies to an ordinary write: any insert that satisfies
--    the predicate is exactly the inert shape, and tm8_app has only SELECT on
--    mcp_servers, so every write still arrives through a function here.
--
--    Caps: 10 open requests per member per Space and 50 per Space, taken under
--    an advisory lock so two concurrent requests cannot both see 9.
--
--    The requester may WITHDRAW their own request while it is still unapproved
--    (the generic `delete_entity`, which needs only space membership); update
--    stays admin-only, so a request cannot be edited into something else after
--    an admin has looked at it.
--
-- 2. CHANGING A LIVE CHAT'S CONNECTORS (G4, §5.3). 298's
--    `save_chat_mcp_selections` is insert-`on conflict do nothing`, so the list
--    stored when the thread was created always won and a thread's connectors
--    could never be changed. `update_chat_mcp_selections` upserts, and NULL
--    deletes the row — "back to defaults", resolved fresh at each turn.
--
--    It validates STRUCTURE at the write (each serverId a live connector in the
--    chat's own Space, no duplicates) so a typo fails here with a clear error,
--    and deliberately does NOT check approval, readiness or credential
--    usability: those change over time, compose and bind re-check them on every
--    turn, and an explicit pin that stops being usable must refuse loudly there
--    rather than be silently dropped at write time (B9's rule).
--
--    `updated_at` is added to the row so the next compose can tell "changed
--    since the last bind" and rebind instead of resuming the stored list. Both
--    existing inserts into this table pass a positional VALUES list shorter
--    than the column count, which Postgres fills from the defaults, so the
--    column is appended LAST and neither function needs rewriting here.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The request shape: what a non-admin may put in front of an admin.
-- -----------------------------------------------------------------------------
-- Mirrors `McpRequestedServerDefinitionSchema` (contract/mcp.ts). The contract
-- gives the member a readable message per rule; this is the authority.
create or replace function internal.mcp_definition_is_request(d jsonb) returns boolean
language sql immutable set search_path=public,internal,pg_temp as $$
  select jsonb_typeof(d)='object'
     and d->>'transport'='http'
     and (d->>'approved')='false'
     and d->>'url' like 'https://%'
     -- Only an administrator arms a connector: trust, reach, default-on,
     -- external clients, first-party hosting and tool gates are all theirs.
     and not (d ?| array['stdioTrusted','allowPrivateNetwork','defaultOn','allowExternalClients','firstParty','gates'])
     and d->'auth'->>'clientSecretEnv' is null;
$$;

-- 340's body, with the admin demand lifted for exactly the request shape.
create or replace function internal.guard_mcp_definition() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
begin
 -- A request (B13) is admitted to a MEMBER; everything else is still admin-only.
 -- On an UPDATE the admin check never lifts: a member may withdraw a request,
 -- never edit one.
 if TG_OP='INSERT' and internal.mcp_definition_is_request(new.definition) then
   perform internal.require_space_member(new.space_id);
 else
   perform internal.require_space_admin(new.space_id);
 end if;
 if not exists(select 1 from public.entities where id=new.entity_id and space_id=new.space_id) then raise exception 'MCP space mismatch' using errcode='22023'; end if;
 perform internal.validate_mcp_definition(new.definition);
 new.title:=lower(new.definition->>'name');
 if TG_OP='INSERT' or internal.mcp_effective_server_key(new.definition)
                      is distinct from internal.mcp_effective_server_key(OLD.definition) then
   perform internal.assert_mcp_server_key_free(new.space_id,new.entity_id,new.definition);
 end if;
 return new;
end $$;

-- 340's body, plus the withdrawal case. A member may SOFT-DELETE a connector
-- they requested while it is still unapproved, and nothing else: not a reparent,
-- not a restore (an undelete has to pass the admin check, so a withdrawn request
-- cannot be revived by its requester after an admin deleted it for good), and
-- never another member's request.
create or replace function internal.guard_mcp_entity() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare withdrawing boolean;
begin
 withdrawing := old.deleted_at is null and new.deleted_at is not null
   and new.parent_id is not distinct from old.parent_id and new.space_id=old.space_id
   and internal.current_member_id(old.space_id) is not null
   and old.created_by = internal.current_member_id(old.space_id)
   and exists(select 1 from public.mcp_servers m
               where m.entity_id=old.id and (m.definition->>'approved')='false');
 if not withdrawing then
   perform internal.require_space_admin(old.space_id);
 else
   perform internal.require_space_member(old.space_id);
 end if;
 if new.space_id<>old.space_id then raise exception 'MCP servers cannot move between spaces' using errcode='42501'; end if;
 return new;
end $$;

-- -----------------------------------------------------------------------------
-- 2. The request door.
-- -----------------------------------------------------------------------------
-- `p_definition` is whole and server-trusted for a catalog request: the handler
-- looks the entry up in MCP_CATALOG by catalogId and the member never gets to
-- send the URL or auth of a catalog connector. A custom request carries the
-- member's own definition, which the predicate above confines.
create or replace function public.request_mcp_server_entity(
  p_space_id uuid, p_definition jsonb, p_note text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare replay jsonb; actor uuid; target uuid; mine integer; here integer; reason text;
begin
  perform internal.require_human_auth_kind();
  -- Off the human gate's other half: a link session is a human, but not THIS
  -- Space's human (§6.5, B11). It may not put a connector in front of admins.
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'') = 'link' then
    raise exception 'MCP connector requests are unavailable to a linked session' using errcode='42501';
  end if;
  perform internal.require_space_member(p_space_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id,'mcp.servers.request');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay#>>'{entity,space_id}',p_space_id::text,'space'); return replay;
  end if;
  if not internal.mcp_definition_is_request(p_definition) then
    raise exception 'a connector request must be an unapproved https connector with no administrator-only settings' using errcode='22023';
  end if;
  if p_note is not null and char_length(btrim(p_note)) not between 1 and 500 then
    raise exception 'a connector request note must be between 1 and 500 characters' using errcode='22023';
  end if;
  actor := internal.resolve_actor(p_actor_id,p_space_id); perform internal.bind_actor(actor);
  -- Serialise the cap check per Space so two concurrent requests cannot both
  -- read the count below the cap (the pattern 284 uses for personal styles).
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_server_requests:'||p_space_id::text,0));
  select count(*) into here from public.mcp_servers m join public.entities e on e.id=m.entity_id
   where m.space_id=p_space_id and e.deleted_at is null and (m.definition->>'approved')='false';
  select count(*) into mine from public.mcp_servers m join public.entities e on e.id=m.entity_id
   where m.space_id=p_space_id and e.deleted_at is null and (m.definition->>'approved')='false' and e.created_by=actor;
  if mine >= 10 then
    raise exception 'you already have 10 connector requests awaiting approval in this space' using errcode='53400';
  end if;
  if here >= 50 then
    raise exception 'this space already has 50 connector requests awaiting approval' using errcode='53400';
  end if;
  target := internal.create_envelope(p_space_id,'mcp_server',actor,null,null);
  insert into public.mcp_servers(entity_id,space_id,title,definition)
    values(target,p_space_id,p_definition->>'name',p_definition);
  perform internal.record_initial_version(target,actor);
  -- The admins' lever is attention, not a message: an 'approve' request on the
  -- connector itself puts it in the inbox next to everything else awaiting a
  -- decision, and resolving it is the approval.
  reason := 'Connector requested: '||coalesce(p_definition->>'name','connector')
         || case when p_note is null then '' else ' — '||btrim(p_note) end;
  perform public.create_attention_request(target,left(reason,500),null,actor,
    case when p_client_mutation_id is null then null else p_client_mutation_id||':attention' end,
    null,'normal','approve',null);
  return internal.ledger_record(p_client_mutation_id,'mcp.servers.request',internal.command_result(target,null,
    internal.record_activity(p_space_id,target,actor,'created',null,
      jsonb_build_object('kind','mcp_server','change','requested')),array[target]));
end $$;

revoke all on function public.request_mcp_server_entity(uuid,jsonb,text,uuid,text) from public;
grant execute on function public.request_mcp_server_entity(uuid,jsonb,text,uuid,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. A live chat's connectors (G4, §5.3).
-- -----------------------------------------------------------------------------
alter table internal.mcp_launch_selections
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.update_chat_mcp_selections(p_chat uuid, p_selections jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare target_space uuid; picks integer;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'') = 'link' then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  -- The CONFIGURER, exactly as save_chat_mcp_selections has it: connectors ride
  -- the human who owns the thread's configuration, never any member who can
  -- read it.
  select c.space_id into target_space from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat and c.configured_by_identity_id=internal.identity_id() and e.deleted_at is null;
  if target_space is null then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  perform internal.require_space_member(target_space);
  if p_selections is null then
    delete from internal.mcp_launch_selections where session_id=p_chat;
    return jsonb_build_object('chatId',p_chat,'mcpSelections',null);
  end if;
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) > 32 then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  picks := jsonb_array_length(p_selections);
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where jsonb_typeof(s.value) <> 'object'
                or not (s.value ? 'serverId')
                or exists(select 1 from jsonb_object_keys(s.value) k where k not in ('serverId','credentialId'))
                or (s.value->>'serverId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or ((s.value ? 'credentialId')
                    and (s.value->>'credentialId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  if (select count(distinct s.value->>'serverId') from jsonb_array_elements(p_selections) s) <> picks then
    raise exception 'duplicate MCP server selection' using errcode='22023';
  end if;
  -- Structure only (B14): the connector must exist, be live and belong to THIS
  -- chat's Space. Approval, readiness and credential usability are re-checked
  -- by compose and bind on every turn, where a pin that went bad must refuse
  -- loudly rather than be quietly dropped here.
  if exists(select 1 from jsonb_array_elements(p_selections) s
             where not exists(select 1 from public.mcp_servers m join public.entities e on e.id=m.entity_id
                               where m.entity_id=(s.value->>'serverId')::uuid and m.space_id=target_space
                                 and e.kind='mcp_server' and e.deleted_at is null)) then
    raise exception 'MCP connector unavailable' using errcode='42501';
  end if;
  insert into internal.mcp_launch_selections(session_id,selections,launcher_identity_id,launcher_auth_kind,updated_at)
    values(p_chat,p_selections,internal.identity_id(),internal.claim_text('tm8.auth_kind'),now())
  on conflict (session_id) do update
    set selections=excluded.selections, launcher_identity_id=excluded.launcher_identity_id,
        launcher_auth_kind=excluded.launcher_auth_kind, updated_at=now();
  return jsonb_build_object('chatId',p_chat,'mcpSelections',p_selections);
end $$;

revoke all on function public.update_chat_mcp_selections(uuid,jsonb) from public;
grant execute on function public.update_chat_mcp_selections(uuid,jsonb) to tm8_app;

reset role;
