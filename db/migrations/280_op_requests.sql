-- =============================================================================
-- 280 — op requests: request → human approve for human-only operations
-- (lane L5 of task 01a0fb5b; owner decision D5 on form 01a0fb65; inventory doc
-- 01a0fb64 P5).
--
-- An agent may not add a space link, set a link's spawn switch or register a
-- gate folder, and never will: those doors are human-only (251's
-- internal.require_human_auth_kind, 234's gate admin). It may ASK. A request
-- is an `op_request` entity naming ONE op from the contract's allow-list
-- (OP_REQUESTABLE, packages/contract/src/op-requests.ts), its path params, its
-- body and a justification, raised to attention as an `approve` item.
--
-- A human approves or denies it. On approve the SERVER runs the op in-process
-- as the approver: the approver's request identity, the approver's authority
-- checks, the op's own schema. Nothing here runs the op; this file only
-- stores the request and moves its status, so the agent's claims never reach
-- the op at all.
--
--   pending ──claim (approve)──▶ executing ──settle──▶ succeeded | failed
--   pending ──deny──────────────▶ denied
--
-- WHAT IS HERE
--   1. The `op_request` core kind.
--   2. public.op_requests (RLS: readable when its entity is).
--      2b. internal.entity_content gains the `op_request` arm.
--   3. Helpers: the view JSON, who may decide.
--   4. create_op_request      opRequests.create  (any member; agent or human)
--   5. claim_op_request       opRequests.approve (human-only; step 1 of 2)
--      settle_op_request      opRequests.approve (human-only; step 2 of 2)
--      deny_op_request        opRequests.deny    (human-only)
--   6. get_op_request / list_op_requests
--   7. Grants.
--
-- The allow-list is NOT repeated here: the facade checks it at create and
-- again at approve, before anything is claimed. `op` is only shape-checked.
--
-- ONE SHARED OBJECT is re-created: internal.entity_content, on 261's body
-- verbatim (the last to re-create it) with an `op_request` arm added (§2b).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Kind. APPEND, never a full-array rewrite (052's lesson).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('op_request', 'core', null, 'shield-check')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. op_requests
-- -----------------------------------------------------------------------------
create table public.op_requests (
  entity_id             uuid primary key references public.entities(id) on delete cascade,
  space_id              uuid not null references public.spaces(id) on delete cascade,
  op                    text not null,
  label                 text not null,
  title                 text not null,
  params                jsonb not null default '{}'::jsonb,
  input                 jsonb not null default '{}'::jsonb,
  justification         text not null,
  approver              text not null,
  status                text not null default 'pending',
  -- The actor that filed it: a team_member for an agent, a member for a human.
  requested_by          uuid not null references public.entities(id),
  -- The bearer's identity: for an agent, the human it acts for. `requester`
  -- requests are decided by this identity only.
  requester_identity_id text not null,
  -- The bearer's verified work session; the outcome is messaged to it.
  requesting_session_id uuid references public.entities(id) on delete set null,
  decided_by            uuid references public.entities(id),
  decided_identity_id   text,
  decided_at            timestamptz,
  decision_note         text,
  result                jsonb,
  error                 jsonb,
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint op_requests_op_check
    check (char_length(op) <= 200 and op ~ '^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$'),
  constraint op_requests_label_check check (char_length(btrim(label)) between 1 and 200),
  constraint op_requests_title_check check (char_length(btrim(title)) between 1 and 500),
  constraint op_requests_params_check
    check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 8192),
  -- The approved op's clientMutationId is the server's (one per request), never the requester's.
  constraint op_requests_input_check
    check (jsonb_typeof(input) = 'object' and not (input ? 'clientMutationId')
           and octet_length(input::text) <= 32768),
  constraint op_requests_justification_check check (char_length(btrim(justification)) between 1 and 4000),
  constraint op_requests_approver_check check (approver in ('requester', 'any_member')),
  constraint op_requests_status_check
    check (status in ('pending', 'executing', 'succeeded', 'failed', 'denied')),
  constraint op_requests_note_check check (decision_note is null or char_length(decision_note) <= 1000),
  constraint op_requests_decided_check
    check ((status = 'pending') = (decided_by is null and decided_at is null and decided_identity_id is null)),
  constraint op_requests_outcome_check
    check ((result is null or status = 'succeeded') and (error is null or status = 'failed')),
  constraint op_requests_version_check check (version > 0)
);

create index op_requests_space_idx on public.op_requests(space_id, created_at desc, entity_id);
create index op_requests_pending_idx on public.op_requests(space_id) where status = 'pending';

create trigger op_requests_touch_updated_at
before update on public.op_requests
for each row execute function internal.touch_updated_at();

alter table public.op_requests enable row level security;

-- 250's space_links shape (218 §4): readable when the entity is.
create policy op_requests_select on public.op_requests for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = op_requests.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.op_requests to tm8_app;

comment on table public.op_requests is
  'L5 (280): an op_request entity''s detail row. One allow-listed op a human '
  'may approve (the facade runs it as the approver) or deny. Writes only '
  'through the definer doors below.';

-- -----------------------------------------------------------------------------
-- 2b. Content hydration. SHARED OBJECT: 261's body verbatim (250's credential
--     and space_link arms + 261's server arm); the `op_request` arm is the
--     only addition. Without it the kind fell to the `else` arm and hydrated
--     as '{}' (pg cell entity-content-all-kinds).
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
      -- 280 (L5): the request's op, body, justification and outcome. Never the
      -- two identity ids: op_request_json does not show them either.
      when 'op_request' then select to_jsonb(opr) - 'entity_id' - 'requester_identity_id' - 'decided_identity_id'
                              into content from public.op_requests opr where opr.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Helpers.
-- -----------------------------------------------------------------------------

-- Whether the CURRENT caller may approve or deny this request now: a human
-- session, an active member of its space, and, for `requester` requests, the
-- identity the request was filed for. An `executing` request may be re-claimed
-- only by the identity that claimed it (a retry after a lost response).
create or replace function internal.op_request_can_decide(p_row public.op_requests)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
     and internal.current_member_id(p_row.space_id) is not null
     and (p_row.approver = 'any_member' or p_row.requester_identity_id = internal.identity_id())
     and (p_row.status = 'pending'
          or (p_row.status = 'executing' and p_row.decided_identity_id = internal.identity_id()))
$$;
revoke all on function internal.op_request_can_decide(public.op_requests) from public;

create or replace function internal.op_request_json(p_row public.op_requests)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', p_row.entity_id,
    'spaceId', p_row.space_id,
    'op', p_row.op,
    'label', p_row.label,
    'params', p_row.params,
    'input', p_row.input,
    'justification', p_row.justification,
    'title', p_row.title,
    'status', p_row.status,
    'approver', p_row.approver,
    'requestedBy', p_row.requested_by,
    'requestingSessionId', p_row.requesting_session_id,
    'decidedBy', p_row.decided_by,
    'decidedAt', p_row.decided_at,
    'decisionNote', p_row.decision_note,
    'result', p_row.result,
    'error', p_row.error,
    'canDecide', internal.op_request_can_decide(p_row),
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at,
    'version', p_row.version
  )
$$;
revoke all on function internal.op_request_json(public.op_requests) from public;

-- The live request, locked, for a decision door. Not found = not readable.
create or replace function internal.op_request_for_decision(p_request_id uuid)
returns public.op_requests language plpgsql set search_path = public, internal, pg_temp as $$
declare row public.op_requests;
begin
  select r.* into row
    from public.op_requests r
    join public.entities e on e.id = r.entity_id and e.deleted_at is null
   where r.entity_id = p_request_id
   for update of r;
  if row.entity_id is null or not internal.is_space_member(row.space_id) then
    raise exception 'op request % not found', p_request_id using errcode = 'P0002';
  end if;
  perform internal.require_human_auth_kind();
  if internal.current_member_id(row.space_id) is null then
    raise exception 'only a member of this space can decide its requests' using errcode = '42501';
  end if;
  if row.approver = 'requester' and row.requester_identity_id is distinct from internal.identity_id() then
    raise exception 'only the human this request was filed for can decide it'
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'op_request_requester_only')::text;
  end if;
  return row;
end
$$;
revoke all on function internal.op_request_for_decision(uuid) from public;

-- Resolve the request's open approve item, attributed to the decider. No
-- note delivery (note_deliver_after stays null): the facade posts the outcome.
create or replace function internal.op_request_resolve_attention(p_request_id uuid, p_actor uuid, p_note text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.attention_requests
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution_note = left(p_note, 1000), version = version + 1
   where entity_id = p_request_id and status in ('open', 'acknowledged');
end
$$;
revoke all on function internal.op_request_resolve_attention(uuid, uuid, text) from public;

-- Every status change touches the envelope so the entity re-projects.
create or replace function internal.op_request_touch(p_request_id uuid)
returns void language sql set search_path = public, internal, pg_temp as $$
  update public.entities set activity_at = now(), updated_at = now() where id = p_request_id
$$;
revoke all on function internal.op_request_touch(uuid) from public;

-- -----------------------------------------------------------------------------
-- 4. opRequests.create — any member, agent or human. The facade has already
--    checked the op against the allow-list and the body against the op's own
--    schema, and passes the entry's label and approver.
-- -----------------------------------------------------------------------------
create or replace function public.create_op_request(
  p_space_id uuid, p_op text, p_label text, p_title text,
  p_params jsonb, p_input jsonb, p_justification text, p_approver text,
  p_work_session_id uuid default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  request_id uuid;
  row public.op_requests;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'opRequests.create');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- The bearer's verified session, authorised like message provenance (211).
  if p_work_session_id is not null then
    perform 1 from public.entities e join public.work_sessions ws on ws.entity_id = e.id
     where e.id = p_work_session_id and e.space_id = p_space_id and e.deleted_at is null
       and exists (select 1 from public.edges edge where edge.src_id = actor
                    and edge.dst_id = p_work_session_id and edge.type = 'participates_in');
    if not found then
      raise exception 'the requesting session does not match the resolved author session' using errcode = '42501';
    end if;
  end if;

  request_id := internal.create_envelope(p_space_id, 'op_request', actor, null, null);
  insert into public.op_requests(entity_id, space_id, op, label, title, params, input, justification,
                                 approver, requested_by, requester_identity_id, requesting_session_id)
  values (request_id, p_space_id, p_op, btrim(p_label), btrim(p_title),
          coalesce(p_params, '{}'::jsonb), coalesce(p_input, '{}'::jsonb), btrim(p_justification),
          p_approver, actor, internal.identity_id(), p_work_session_id)
  returning * into row;
  perform internal.record_initial_version(request_id, actor);

  insert into public.attention_requests(space_id, entity_id, reason, points, requested_by,
                                        source_session_id, action_type, level)
  values (p_space_id, request_id, left('Approve: ' || row.title, 500), 70, actor,
          p_work_session_id, 'approve', 'high');

  activity_id := internal.record_activity(p_space_id, request_id, actor, 'created', null,
                   jsonb_build_object('kind', 'op_request', 'op', p_op));
  return internal.ledger_record(p_client_mutation_id, 'opRequests.create',
           internal.command_result(request_id, null, activity_id, array[request_id])
           || jsonb_build_object('request', internal.op_request_json(row)));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Decisions. Human-only, a member of the request's space, and the
--    requester's own human for `requester` requests.
--
--    approve is TWO doors around the facade's in-process run of the op:
--    claim (pending → executing, stamped with the decider) commits BEFORE the
--    op runs, so two approvers can never both run it; settle records the
--    outcome. A request whose response was lost stays `executing`; the same
--    identity may claim it again, and the op replays under the request's own
--    clientMutationId instead of running twice.
-- -----------------------------------------------------------------------------
create or replace function public.claim_op_request(p_request_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.op_requests;
  decider uuid;
begin
  row := internal.op_request_for_decision(p_request_id);
  decider := internal.current_member_id(row.space_id);
  if row.status in ('succeeded', 'failed', 'denied') then
    -- Already decided: the answer, not an error, so a retried approve is safe.
    return internal.op_request_json(row);
  end if;
  if row.status = 'executing' and row.decided_identity_id is distinct from internal.identity_id() then
    raise exception 'another approver is running this request' using errcode = 'TOR01',
      detail = jsonb_build_object('reason', 'op_request_executing')::text;
  end if;
  perform internal.bind_actor(decider);
  if row.status = 'pending' then
    update public.op_requests
       set status = 'executing', decided_by = decider, decided_identity_id = internal.identity_id(),
           decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''),
           version = version + 1
     where entity_id = row.entity_id
    returning * into row;
    perform internal.op_request_touch(row.entity_id);
  end if;
  return internal.op_request_json(row);
end
$$;

create or replace function public.settle_op_request(
  p_request_id uuid, p_succeeded boolean, p_result jsonb default null, p_error jsonb default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.op_requests;
  activity_id uuid;
begin
  row := internal.op_request_for_decision(p_request_id);
  if row.status in ('succeeded', 'failed') then
    return internal.op_request_json(row);
  end if;
  if row.status <> 'executing' or row.decided_identity_id is distinct from internal.identity_id() then
    raise exception 'this request is not being run by you' using errcode = 'TOR01',
      detail = jsonb_build_object('reason', 'op_request_not_claimed')::text;
  end if;
  perform internal.bind_actor(row.decided_by);
  update public.op_requests
     set status = case when p_succeeded then 'succeeded' else 'failed' end,
         result = case when p_succeeded then p_result end,
         error = case when p_succeeded then null
                      else coalesce(p_error, jsonb_build_object('code', 'unknown', 'message', 'the op failed')) end,
         version = version + 1
   where entity_id = row.entity_id
  returning * into row;
  perform internal.op_request_resolve_attention(row.entity_id, row.decided_by,
    case when p_succeeded then 'Approved: ran as the approver' else 'Approved, but the op failed' end);
  perform internal.op_request_touch(row.entity_id);
  activity_id := internal.record_activity(row.space_id, row.entity_id, row.decided_by, 'updated', null,
                   jsonb_build_object('kind', 'op_request', 'op', row.op, 'status', row.status));
  return internal.op_request_json(row);
end
$$;

create or replace function public.deny_op_request(p_request_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.op_requests;
  decider uuid;
  activity_id uuid;
begin
  row := internal.op_request_for_decision(p_request_id);
  if row.status = 'denied' then
    return internal.op_request_json(row);
  end if;
  if row.status <> 'pending' then
    raise exception 'this request is already %', row.status using errcode = 'TOR01',
      detail = jsonb_build_object('reason', 'op_request_decided', 'status', row.status)::text;
  end if;
  decider := internal.current_member_id(row.space_id);
  perform internal.bind_actor(decider);
  update public.op_requests
     set status = 'denied', decided_by = decider, decided_identity_id = internal.identity_id(),
         decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         version = version + 1
   where entity_id = row.entity_id
  returning * into row;
  perform internal.op_request_resolve_attention(row.entity_id, decider, coalesce('Denied: ' || row.decision_note, 'Denied'));
  perform internal.op_request_touch(row.entity_id);
  activity_id := internal.record_activity(row.space_id, row.entity_id, decider, 'updated', null,
                   jsonb_build_object('kind', 'op_request', 'op', row.op, 'status', 'denied'));
  return internal.op_request_json(row);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Reads. Every member of the space (agent or human) sees its requests.
-- -----------------------------------------------------------------------------
create or replace function public.get_op_request(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare row public.op_requests;
begin
  select r.* into row
    from public.op_requests r
    join public.entities e on e.id = r.entity_id and e.deleted_at is null
   where r.entity_id = p_request_id;
  if row.entity_id is null or not internal.is_space_member(row.space_id) then
    raise exception 'op request % not found', p_request_id using errcode = 'P0002';
  end if;
  return internal.op_request_json(row);
end
$$;

create or replace function public.list_op_requests(p_space_id uuid, p_status text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_space_member(p_space_id);
  if p_status is not null and p_status not in ('pending', 'executing', 'succeeded', 'failed', 'denied') then
    raise exception 'unknown op request status %', p_status using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(internal.op_request_json(r) order by r.created_at desc, r.entity_id desc)
      from (select r.*
              from public.op_requests r
              join public.entities e on e.id = r.entity_id and e.deleted_at is null
             where r.space_id = p_space_id
               and (p_status is null or r.status = p_status)
             order by r.created_at desc, r.entity_id desc
             limit greatest(1, least(coalesce(p_limit, 50), 200))) r
  ), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function public.create_op_request(uuid, text, text, text, jsonb, jsonb, text, text, uuid, uuid, text) from public;
grant execute on function public.create_op_request(uuid, text, text, text, jsonb, jsonb, text, text, uuid, uuid, text) to tm8_app;
revoke all on function public.claim_op_request(uuid, text) from public;
grant execute on function public.claim_op_request(uuid, text) to tm8_app;
revoke all on function public.settle_op_request(uuid, boolean, jsonb, jsonb) from public;
grant execute on function public.settle_op_request(uuid, boolean, jsonb, jsonb) to tm8_app;
revoke all on function public.deny_op_request(uuid, text) from public;
grant execute on function public.deny_op_request(uuid, text) to tm8_app;
revoke all on function public.get_op_request(uuid) from public;
grant execute on function public.get_op_request(uuid) to tm8_app;
revoke all on function public.list_op_requests(uuid, text, integer) from public;
grant execute on function public.list_op_requests(uuid, text, integer) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.op_requests;
