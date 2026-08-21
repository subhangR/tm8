-- 166 -- a chat thread names its working directory, the way a work session does.
--
-- THE DEFECT THIS CLOSES. `chat_threads` carried one `cwd` text column and
-- nothing else, so a thread had no idea WHICH project it was working in. The
-- server filled that gap by INFERRING one: "the Space's single linked project,
-- if it is trusted, and if its working_dir happens to be a git root, then clone
-- it." Three conditions, and the third has never once been true on a live
-- installation -- `<dataDir>/chat/checkouts/` does not exist on the production
-- node, not one thread has ever had a checkout, and every chat has silently run
-- in an empty scratch directory with NO filesystem tools at all. The inference
-- was invisible when it failed, which is the only reason it survived this long.
--
-- Work sessions never had this problem. `work_sessions` has carried
-- `project_id` + `workdir_mode` + `workdir_path` since it shipped, the human
-- picks in `NewSessionComposer`, and 312 sessions have run in `project` mode
-- against it. Chat simply never joined that model. This migration is chat
-- joining it -- the same two facts, recorded rather than guessed.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * NO `worktree` mode. `work_sessions` allows it, the `worktrees` table
--     exists, and it has ZERO ROWS on this node -- the lane is built and
--     unexercised. Chat ships `project | scratch` and stays honest about it;
--     widening the check constraint later is a one-line forward migration.
--
--   * NO TRUST GATE (ruled 2026-08-21). Chat is MORE permissive than spawn,
--     on purpose and in writing.
--
--     AN EARLIER VERSION OF THIS PARAGRAPH JUSTIFIED IT CIRCULARLY, and the
--     replacement is here rather than a quiet edit because the bad argument is
--     the kind that gets copied. It said: chat runs headless under
--     `bypassPermissions`, so the CLI trust dialog `workspace-trust.ts` exists
--     to pre-empt is unreachable, so the gate is unnecessary. Both facts are
--     true and the inference is backwards. `workspace-trust.ts:30-34` states
--     the dependency in the other direction: "tm8's own authorization is
--     unchanged and is what makes this legitimate: `execution_spawn` refuses to
--     launch into an untrusted project, so by the time this runs, an operator
--     has explicitly vouched for this working directory. This records a
--     decision a human already made; it does not make one." The dialog was
--     never the control; its legitimacy DERIVED from the tm8 vouch. Removing
--     the vouch and citing the dialog's absence is the same fact used twice, in
--     opposite directions.
--
--     THE ACTUAL JUSTIFICATION, which is checkable and survives the picker
--     landing: `project` mode is reachable only by a Space member, on a project
--     a NODE ADMIN created (021: `require_node_admin` guards `working_dir` and
--     `trust`) and a SPACE ADMIN linked (021: `require_space_admin`). We take
--     that chain as the vouch and accept that chat does not ask again.
--
--     Two corrections to the framing while we are here. "execution_spawn
--     refuses an untrusted project" overstates it — 007_rpc_catalog.sql:2081
--     requires `p_confirm_untrusted`, a caller-supplied boolean, which is a
--     CONSENT MOMENT rather than a refusal. Chat has no consent moment at all,
--     which is the smaller and more honest statement of the gap. And
--     `projects.trust` is about CONTENT trust — whether a human vouched for
--     what an agent will read in that directory, i.e. the prompt-injection
--     surface — which answering a dialog never addressed.
--
--   * NO GIT REQUIREMENT. Nothing in `projects` has ever required a working_dir
--     to be a repository -- `repo_url` is nullable and null on every project on
--     this node. `project` mode runs in working_dir as it stands, exactly like
--     the session mode of the same name. The git-root test was chat's own
--     invention and it is what made chat blind in `/home/tm8/prod-workspace`.
--
-- THE PATH IS RESOLVED HERE, NOT ACCEPTED FROM THE CALLER. For `project` mode
-- the cwd is read from `projects.working_dir` inside this function; `p_cwd` is
-- ignored. Accepting both a project id and a path would let them disagree, and
-- the disagreement would be the caller's to exploit -- a linked project id
-- paired with somebody else's directory. For `scratch` the path IS the
-- caller's, because it is server-owned by construction (the handler builds it
-- under dataDir and no client ever names it).

set role tm8_graph_owner;

alter table public.chat_threads
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists workdir_mode text not null default 'scratch';

-- Existing rows are all scratch and the default backfills them correctly: every
-- thread written before this migration ran in `<dataDir>/chat-threads/<id>`,
-- which is exactly what `scratch` names. Their `cwd` is already bound and this
-- does not move it -- a thread's directory is pinned at start (ruled), so no
-- live thread changes where it works because of this migration.
alter table public.chat_threads
  add constraint chat_threads_workdir_mode_check
  check (workdir_mode in ('project', 'scratch'));

-- The two facts must agree. A `project` thread without a project id could not
-- name its directory, and a `scratch` thread WITH one would claim a binding it
-- does not have -- and would survive `on delete set null` as a silent
-- downgrade to a mode it never asked for.
alter table public.chat_threads
  add constraint chat_threads_project_binding_check
  check (
    (workdir_mode = 'project' and project_id is not null)
    or (workdir_mode = 'scratch' and project_id is null)
  );

comment on column public.chat_threads.project_id is
  'The linked project this thread works in; null exactly when workdir_mode is scratch.';
comment on column public.chat_threads.workdir_mode is
  'project = the project working_dir as it stands; scratch = a server-owned empty per-thread directory.';

-- The 136 definition, plus the two new arguments. Arity changes, so the old
-- 9-argument function is DROPPED rather than left as an overload: a stale
-- signature that silently writes no project binding is exactly the kind of
-- trap that outlives the person who left it.
drop function if exists public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text);

create or replace function public.start_chat_thread(
  p_root_message_id uuid,
  p_teammate_id uuid,
  p_model text,
  p_provider text,
  p_agent_tool text,
  p_chat_mode text,
  p_native_session_id uuid,
  p_cwd text,
  p_client_mutation_id text,
  p_project_id uuid,
  p_workdir_mode text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  root public.messages;
  root_entity public.entities;
  member_id uuid;
  request_hash text;
  legacy_request_hash text;
  stored_hash text;
  last_reply timestamptz;
  configured_at timestamptz;
  resolved_cwd text;
  result jsonb;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = ''
     or p_provider is null or btrim(p_provider) = ''
     or p_agent_tool is null or btrim(p_agent_tool) = '' then
    raise exception 'model, provider, and agent tool are required' using errcode = '22023';
  end if;
  if p_chat_mode not in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft') then
    raise exception 'invalid chat mode' using errcode = '22023';
  end if;
  if p_workdir_mode is null or p_workdir_mode not in ('project', 'scratch') then
    raise exception 'workdir mode must be project or scratch' using errcode = '22023';
  end if;
  if p_native_session_id is null then
    raise exception 'native session id is required' using errcode = '22023';
  end if;

  request_hash := internal.w2_sha256(jsonb_build_object(
    'identityId', internal.identity_id(),
    'rootMessageId', p_root_message_id,
    'teammateId', p_teammate_id,
    'model', p_model,
    'provider', p_provider,
    'agentTool', p_agent_tool,
    'mode', p_chat_mode,
    -- The binding is part of the request's identity. Without these two, a
    -- replay of the same clientMutationId carrying a DIFFERENT project would
    -- match the stored hash and return the original thread, which reads to the
    -- caller as "your project choice was accepted" when it was discarded.
    'projectId', p_project_id,
    'workdirMode', p_workdir_mode
  ));
  -- The 9-argument hash: the same object WITHOUT the two new keys. Computed
  -- unconditionally so the deploy-window fallback below has it.
  legacy_request_hash := internal.w2_sha256(jsonb_build_object(
    'identityId', internal.identity_id(),
    'rootMessageId', p_root_message_id,
    'teammateId', p_teammate_id,
    'model', p_model,
    'provider', p_provider,
    'agentTool', p_agent_tool,
    'mode', p_chat_mode
  ));

  replay := internal.ledger_replay(p_client_mutation_id, 'chat.threads.start');
  if replay is not null then
    stored_hash := replay ->> '_requestHash';
    -- DEPLOY-WINDOW FALLBACK (review finding F6 on #479). Every ledger row
    -- written by the 9-argument function holds a hash computed without
    -- `projectId`/`workdirMode`. A client retrying that same
    -- clientMutationId across the deploy recomputes with the new keys and
    -- mismatches — for a request that is byte-for-byte the one it sent.
    --
    -- There is no way back for that caller: the thread was already inserted
    -- and configuration is write-once, so retrying under a fresh mutation id
    -- raises 23505 instead. It would never learn its own thread's start
    -- result. Accepting the legacy hash closes a window that is narrow but
    -- has no recovery inside it.
    --
    -- This is NOT a general weakening. It admits exactly one shape — a
    -- pre-166 row whose other seven fields match — and a post-166 row can
    -- never match it, because every row written from here on stores the
    -- 9-key form only if it predates this function. DELETE THIS BRANCH one
    -- release after 166 ships; by then no 9-argument row can still be
    -- in-flight.
    if stored_hash is distinct from request_hash
       and stored_hash is distinct from legacy_request_hash then
      raise exception 'chat thread start replay does not match the original request'
        using errcode = '23514', detail = 'chat_thread_start_identity_mismatch';
    end if;
    return replay;
  end if;

  select * into root from public.messages
   where entity_id = p_root_message_id for update;
  if root.entity_id is not null then
    select * into root_entity from public.entities
     where id = root.entity_id for update;
  end if;
  if root.entity_id is null or root_entity.deleted_at is not null
     or not internal.entity_readable(root.entity_id)
     or not internal.entity_readable(root.anchor_id) then
    raise exception 'chat root message not found' using errcode = 'P0002';
  end if;
  if root_entity.parent_id is not null or root.root_message_id is not null then
    raise exception 'chat must be configured on a root message' using errcode = '22023';
  end if;
  perform internal.require_space_member(root_entity.space_id);
  member_id := internal.current_member_id(root_entity.space_id);
  if member_id is null or root.author_id <> member_id then
    raise exception 'only the human root author may configure this chat thread'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_members tm
    join public.entities teammate on teammate.id = tm.entity_id
    where tm.entity_id = p_teammate_id
      and teammate.space_id = root_entity.space_id
      and teammate.deleted_at is null
  ) then
    raise exception 'chat teammate not found in the root space' using errcode = 'P0002';
  end if;

  -- Resolve the directory. This function is SECURITY DEFINER, so the Space
  -- link is checked EXPLICITLY: RLS on `space_projects` is not evaluated here,
  -- and a project linked to some other Space must not become reachable by
  -- naming its id. Trust is deliberately not consulted (see the header).
  if p_workdir_mode = 'project' then
    if p_project_id is null then
      raise exception 'project mode requires a project id' using errcode = '22023';
    end if;
    select p.working_dir into resolved_cwd
      from public.projects p
      join public.space_projects sp on sp.project_id = p.id
     where p.id = p_project_id
       and sp.space_id = root_entity.space_id;
    if resolved_cwd is null then
      raise exception 'project is not linked to this space' using errcode = 'P0002';
    end if;
  else
    if p_project_id is not null then
      raise exception 'scratch mode does not take a project id' using errcode = '22023';
    end if;
    if p_cwd is null or left(p_cwd, 1) <> '/' then
      raise exception 'scratch mode requires an absolute cwd' using errcode = '22023';
    end if;
    resolved_cwd := p_cwd;
  end if;

  if exists (select 1 from public.chat_threads where root_message_id = p_root_message_id) then
    raise exception 'chat thread configuration is write-once' using errcode = '23505';
  end if;

  insert into public.chat_threads(
    root_message_id, space_id, anchor_id,
    configured_by_identity_id, configured_by_member_id, teammate_id,
    model, provider, agent_tool, chat_mode, native_session_id, cwd,
    client_mutation_id, requester_auth_kind, project_id, workdir_mode
  ) values (
    p_root_message_id, root_entity.space_id, root.anchor_id,
    internal.identity_id(), member_id, p_teammate_id,
    p_model, p_provider, p_agent_tool, p_chat_mode, p_native_session_id, resolved_cwd,
    p_client_mutation_id, internal.claim_text('tm8.auth_kind'), p_project_id, p_workdir_mode
  ) returning created_at into configured_at;

  insert into public.chat_turns(
    root_message_id, user_message_id, requested_by_member_id, requested_by_auth_kind,
    pricing_provider, pricing_model, queued_at
  ) values (
    p_root_message_id, p_root_message_id, member_id, internal.claim_text('tm8.auth_kind'),
    p_provider, p_model, root.created_at
  );

  select max(created_at) into last_reply from public.messages
   where root_message_id = p_root_message_id;
  result := jsonb_build_object(
    'thread', jsonb_build_object(
      'rootMessageId', p_root_message_id,
      'anchorId', root.anchor_id,
      'teammateId', p_teammate_id,
      'model', p_model,
      'mode', p_chat_mode,
      'createdAt', internal.w2_iso(configured_at),
      'lastReplyAt', internal.w2_iso(last_reply),
      -- The binding goes back to the caller so the composer can show what it
      -- actually got rather than what it asked for. The resolved PATH stays
      -- server-side: the UI already holds `projects.working_dir` for every
      -- project it can see, so an id is all it needs to render the directory,
      -- and a scratch path is a server internal with no name worth showing.
      'projectId', p_project_id,
      'workdirMode', p_workdir_mode
    ),
    '_requestHash', request_hash
  );
  return internal.ledger_record(p_client_mutation_id, 'chat.threads.start', result);
end
$$;

revoke all on function public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text,uuid,text) from public;
grant execute on function public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text,uuid,text) to tm8_app;

reset role;
