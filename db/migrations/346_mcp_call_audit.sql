-- =============================================================================
-- 346: the per-call MCP audit, extended. Plan §5.6, gap G10, §9.3(6).
--
-- `mcp_call_audit` (297) said that SOME call ran on a session, a server and a
-- credential, and whether it worked. Nobody could answer "which session sent
-- that email?": no tool name, no human it acted for, no chain, no latency, and
-- a refused call left no row at all, because `authorize` throws before the
-- `started` row was written. Admins alone could read it. This migration:
--
-- * ADDS COLUMNS to the existing table (never a second one): tool, root member,
--   chain, via, chat, credential scope, deny reason, latency, request/response
--   SIZES. Outcome widens to started|succeeded|failed|denied|refreshed.
-- * STORES NO ARGUMENTS OR RESULTS. Only the tool name and the byte sizes; an
--   opt-in per-connector "log arguments" is later work.
-- * PROVENANCE IS READ, NEVER RE-DERIVED. The root and chain are what `bind`
--   recorded on the binding (343). The server passes what
--   `read_mcp_session_binding` handed it (grant.rootMemberId / grant.chain);
--   for a call refused BEFORE a grant existed — the root left a Space in the
--   chain, the connector was unselected — the writer falls back to the very
--   same stored binding columns. There is no walk here.
-- * ONE WRITER, AUTHENTICATED BY THE SESSION'S OWN BEARER. 297's
--   `record_mcp_call` ran under the root's claims and needed only Space
--   membership, so any member could write any row, and a denial caused by the
--   root losing membership could not be written at all. The new writer accepts
--   only an agent/agent_runtime bearer whose auth session IS the audited
--   session, takes the Space from the session entity, and checks every value it
--   did not derive against the binding. 297's writer is dropped.
-- * READ POLICY: Space admins read the whole Space; a member reads the rows
--   where they are the root (§5.6, §10.8; connections act as the root, §6).
--   Human callers only: link and agent bearers read nothing.
-- * RETENTION: `prune_mcp_call_audit` (node admin) deletes rows past the
--   retention window in bounded batches. The server runs it from the scheduler,
--   90 days by default, `TM8_MCP_AUDIT_RETENTION_DAYS` per node.
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns.
-- -----------------------------------------------------------------------------
alter table public.mcp_call_audit
  add column tool text check (tool is null or (char_length(tool) between 1 and 200 and tool !~ '[[:cntrl:]]')),
  add column root_member_id uuid,
  add column chain uuid[],
  -- Only what is written today; t-mcp-tokens-server widens this when external
  -- token callers exist (plan §5.6 lists 'external_token' and 'test').
  add column via text check (via is null or via in ('session', 'chat')),
  add column chat_id uuid,
  add column credential_scope text check (credential_scope is null or credential_scope in ('member', 'space')),
  add column deny_reason text check (deny_reason is null or deny_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  add column latency_ms integer check (latency_ms is null or latency_ms >= 0),
  add column request_bytes integer check (request_bytes is null or request_bytes >= 0),
  add column response_bytes integer check (response_bytes is null or response_bytes >= 0);

alter table public.mcp_call_audit drop constraint mcp_call_audit_outcome_check;
alter table public.mcp_call_audit add constraint mcp_call_audit_outcome_check
  check (outcome in ('started', 'succeeded', 'failed', 'denied', 'refreshed'));
-- A denial always says why, and only a denial carries a reason.
alter table public.mcp_call_audit add constraint mcp_call_audit_denied_has_reason
  check ((outcome = 'denied') = (deny_reason is not null));

-- The list reads newest-first within a Space; retention scans by time.
create index mcp_call_audit_space_recent on public.mcp_call_audit(space_id, id desc);
-- The per-connector filter (§10.8 "connector"), newest first.
create index mcp_call_audit_space_server on public.mcp_call_audit(space_id, server_id, id desc);
create index mcp_call_audit_session on public.mcp_call_audit(session_id, id desc);
create index mcp_call_audit_root on public.mcp_call_audit(root_member_id, id desc) where root_member_id is not null;
create index mcp_call_audit_occurred on public.mcp_call_audit(occurred_at);

-- -----------------------------------------------------------------------------
-- 2. Read policy: admins the whole Space, members their own (root) rows.
-- -----------------------------------------------------------------------------
create function internal.mcp_audit_visible(p_space uuid, p_root uuid)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  -- A human oversight surface (lead ruling on #1321): an agent bearer carries
  -- its owner's identity, so without the kind check an admin's agent would read
  -- the whole Space. The member branch honours the session pin exactly as
  -- is_space_admin does for the admin branch.
  select coalesce(internal.claim_text('tm8.via_link'), '') = ''
     and coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
     and (internal.is_space_admin(p_space)
          or (p_root is not null
              and (internal.session_space_id() is null or internal.session_space_id() = p_space)
              and exists(select 1 from public.members m
                where m.entity_id = p_root and m.space_id = p_space
                  and m.identity_id = internal.identity_id() and m.status = 'active')))
$$;
revoke all on function internal.mcp_audit_visible(uuid, uuid) from public;
grant execute on function internal.mcp_audit_visible(uuid, uuid) to tm8_app;

drop policy mcp_call_audit_read on public.mcp_call_audit;
create policy mcp_call_audit_read on public.mcp_call_audit for select to tm8_app
  using (internal.mcp_audit_visible(space_id, root_member_id));

-- -----------------------------------------------------------------------------
-- 3. The writer.
--
-- p_root / p_chain are what `read_mcp_session_binding` returned for this call,
-- or null when it refused. Either way the row is checked against the stored
-- binding: a supplied chain must BE the recorded chain, and a supplied root
-- must be a member row of the recorded root identity in this Space.
-- -----------------------------------------------------------------------------
drop function public.record_mcp_call(uuid, uuid, uuid, uuid, text, text);

create function public.record_mcp_call_audit(
  p_session uuid, p_server uuid, p_credential uuid, p_method text, p_tool text, p_outcome text,
  p_root_member uuid, p_chain uuid[], p_deny_reason text,
  p_latency_ms integer, p_request_bytes integer, p_response_bytes integer)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_auth uuid := nullif(internal.claim_text('tm8.auth_session_id'), '')::uuid;
  v_kind text := coalesce(internal.claim_text('tm8.auth_kind'), '');
  v_chat boolean;
  v_space uuid;
  b internal.mcp_session_bindings;
  v_root uuid;
  v_root_identity text;
  v_chain uuid[];
  v_scope text;
begin
  -- Only the audited session's own runtime bearer writes its rows.
  if v_kind not in ('agent', 'agent_runtime') or v_auth is null
     or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP audit writer unavailable' using errcode = '42501';
  end if;
  select coalesce(s.runtime_chat_id = p_session, false) into v_chat from public.auth_sessions s
   where s.id = v_auth and s.via_link_id is null
     and (s.work_session_id = p_session or s.runtime_chat_id = p_session);
  if not found then
    raise exception 'MCP audit writer unavailable' using errcode = '42501';
  end if;
  select e.space_id into v_space from public.entities e where e.id = p_session;
  if v_space is null then
    raise exception 'MCP audit session unavailable' using errcode = '42501';
  end if;

  select * into b from internal.mcp_session_bindings where session_id = p_session;
  if b.session_id is not null and b.space_id <> v_space then
    raise exception 'MCP audit binding mismatch' using errcode = '42501';
  end if;
  v_chain := coalesce(p_chain, b.chain);
  if p_chain is not null and p_chain is distinct from b.chain then
    raise exception 'MCP audit chain is not the recorded chain' using errcode = '22023';
  end if;
  -- The recorded root, or for a binding written before 343 the launcher, as
  -- their member row in this Space (whatever its status: a removed root is
  -- exactly the denial worth naming).
  -- B50 (advisor review): the connector must be one of THIS Space's, so a row
  -- can never name another Space's connector. A call that reached the provider
  -- (any outcome but 'denied') must also be on a connector the binding selected;
  -- a refusal is exactly the case where it may not be, and the Space check
  -- above still binds it.
  if not exists(select 1 from public.entities e
      where e.id = p_server and e.space_id = v_space and e.kind = 'mcp_server') then
    raise exception 'MCP audit connector is not one of this space''s' using errcode = '22023';
  end if;
  if b.session_id is not null and p_outcome <> 'denied' and not exists(
      select 1 from jsonb_array_elements(b.selections) sel where sel->>'serverId' = p_server::text) then
    raise exception 'MCP audit connector is not selected on this session' using errcode = '22023';
  end if;

  -- The root as RECORDED. A supplied root must be the recorded root's member
  -- row here (whatever its status: a removed root is exactly the denial worth
  -- naming). Absent one, the binding's own root. The launcher stands in ONLY
  -- for a binding written before 343 by a HUMAN launcher; a rootless binding
  -- (loop executor, no human provenance) records NULL, which means "no human
  -- provenance" — never the node owner the executor ran as (B50).
  if b.session_id is not null then
    v_root_identity := case
      when b.root_identity_id is not null then b.root_identity_id
      when b.launcher_auth_kind in ('browser', 'cli') then b.launcher_identity_id
    end;
  end if;
  if p_root_member is not null then
    if v_root_identity is null or not exists(select 1 from public.members m
        where m.entity_id = p_root_member and m.space_id = v_space and m.identity_id = v_root_identity) then
      raise exception 'MCP audit root is not the recorded root' using errcode = '22023';
    end if;
    v_root := p_root_member;
  elsif v_root_identity is not null then
    v_root := coalesce(case when b.root_identity_id is not null then b.root_member_id end,
      (select m.entity_id from public.members m where m.space_id = v_space and m.identity_id = v_root_identity));
  end if;

  -- B50: a credential, when named, must be an MCP credential of this Space.
  if p_credential is not null then
    select case when c.owner_account_id is null then 'space' else 'member' end into v_scope
      from public.space_credentials c
     where c.id = p_credential and c.space_id = v_space and c.provider = 'mcp';
    if v_scope is null then
      raise exception 'MCP audit credential is not one of this space''s MCP connections' using errcode = '22023';
    end if;
  end if;

  insert into public.mcp_call_audit(space_id, session_id, server_id, credential_id, method, outcome,
    tool, root_member_id, chain, via, chat_id, credential_scope, deny_reason,
    latency_ms, request_bytes, response_bytes)
  values (v_space, p_session, p_server, p_credential, p_method, p_outcome,
    left(nullif(btrim(p_tool), ''), 200), v_root, v_chain,
    case when v_chat then 'chat' else 'session' end, case when v_chat then p_session end,
    v_scope, p_deny_reason, p_latency_ms, p_request_bytes, p_response_bytes);
end
$$;
revoke all on function public.record_mcp_call_audit(uuid, uuid, uuid, text, text, text, uuid, uuid[], text, integer, integer, integer) from public;
grant execute on function public.record_mcp_call_audit(uuid, uuid, uuid, text, text, text, uuid, uuid[], text, integer, integer, integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. mcp.audit.list — newest first, keyset-paged by id.
--
-- Human callers only. A non-member is refused; a member who is not an admin sees only rows where
-- they are the root, so a member filter naming someone else returns nothing.
-- -----------------------------------------------------------------------------
create function public.list_mcp_call_audit(
  p_space uuid, p_session uuid, p_chat uuid, p_server uuid, p_member uuid, p_outcome text,
  p_before bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_admin boolean; v_self uuid; v_items jsonb;
begin
  -- Human only (browser/cli; refuses link and agent bearers), fail-closed, and
  -- a link claim refuses whatever kind rides beside it.
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP audit is unavailable to a space link' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_space);
  v_admin := internal.is_space_admin(p_space);
  select m.entity_id into v_self from public.members m
   where m.space_id = p_space and m.identity_id = internal.identity_id() and m.status = 'active'
     and (internal.session_space_id() is null or internal.session_space_id() = p_space);
  select coalesce(jsonb_agg(row_json order by id desc), '[]'::jsonb) into v_items from (
    select a.id, jsonb_build_object(
      'id', a.id::text, 'spaceId', a.space_id, 'sessionId', a.session_id, 'chatId', a.chat_id,
      'serverId', a.server_id, 'credentialId', a.credential_id, 'credentialScope', a.credential_scope,
      'method', a.method, 'tool', a.tool, 'outcome', a.outcome, 'denyReason', a.deny_reason,
      'rootMemberId', a.root_member_id, 'chain', to_jsonb(coalesce(a.chain, '{}'::uuid[])), 'via', a.via,
      'latencyMs', a.latency_ms, 'requestBytes', a.request_bytes, 'responseBytes', a.response_bytes,
      'occurredAt', a.occurred_at) as row_json
      from public.mcp_call_audit a
     where a.space_id = p_space
       and (v_admin or (v_self is not null and a.root_member_id = v_self))
       and (p_session is null or a.session_id = p_session)
       and (p_chat is null or a.chat_id = p_chat)
       and (p_server is null or a.server_id = p_server)
       and (p_member is null or a.root_member_id = p_member)
       and (p_outcome is null or a.outcome = p_outcome)
       and (p_before is null or a.id < p_before)
     order by a.id desc
     limit greatest(1, least(coalesce(p_limit, 50), 201))) page;
  return jsonb_build_object('items', v_items, 'scope', case when v_admin then 'space' else 'own' end);
end
$$;
revoke all on function public.list_mcp_call_audit(uuid, uuid, uuid, uuid, uuid, text, bigint, integer) from public;
grant execute on function public.list_mcp_call_audit(uuid, uuid, uuid, uuid, uuid, text, bigint, integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. Retention. Node admin; bounded batch so a first run on a large table never
-- holds a long lock. The job calls it until a batch comes back short.
-- -----------------------------------------------------------------------------
create function public.prune_mcp_call_audit(p_retain interval default interval '90 days', p_batch integer default 5000)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  perform internal.require_node_admin();
  if p_retain < interval '1 day' then
    raise exception 'MCP audit retention must be at least one day' using errcode = '22023';
  end if;
  delete from public.mcp_call_audit where id in (
    select id from public.mcp_call_audit where occurred_at < now() - p_retain
     order by occurred_at limit greatest(1, least(coalesce(p_batch, 5000), 50000)));
  get diagnostics removed = row_count;
  return removed;
end
$$;
revoke all on function public.prune_mcp_call_audit(interval, integer) from public;
grant execute on function public.prune_mcp_call_audit(interval, integer) to tm8_app;

analyze public.mcp_call_audit;

reset role;
