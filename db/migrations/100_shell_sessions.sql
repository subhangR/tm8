-- 100 — VANILLA TERMINALS: `work_sessions.session_kind = 'shell'`.
--
-- A shell session is a real PTY running the node's login shell and nothing
-- else: no persona, no manifest, no agent token, no interaction pin,
-- `agent_tool` NULL. It is the terminal you get without `claude-code` or
-- `codex` in front of it.
--
-- 083's column comment says "Read the 083 header before adding a third value."
-- This is that read, and its five externalities are answered here one by one.
-- Two of them needed a change; three were already correct and are recorded so
-- the next person does not have to re-derive that.
--
-- ---------------------------------------------------------------------------
-- THE AUDIT — every SQL surface that branches on `session_kind`
--
-- SQL ONLY, AND THE SCOPE IS THE POINT. The TypeScript filters were checked
-- too (they are deny-lists, as `contract.ts` requires, and a shell session
-- survives all of them), but they are NOT enumerated here — a list is a
-- promise to be complete, and this one is complete about SQL. Item 4b below is
-- the exception that proves the boundary: SQL living inside a .ts file, which
-- a grep of this directory cannot see.
-- ---------------------------------------------------------------------------
--
--  1. `internal.live_work_session_count` (083 §3) — `= 'agent'`.
--     UNCHANGED, AND THAT IS THE DECISION, not an omission. A vanilla terminal
--     must not burn an agent spawn slot: a member with two terminals open would
--     otherwise find real spawns answering `53400 session concurrency cap
--     reached`, which reads as a broken node rather than as a full one. Shells
--     get their own disjoint count below, exactly as credentials did, so a wall
--     of terminals can never starve agents and a full agent cap can never
--     refuse a terminal.
--
--  2. `internal.w1_backfill_participant` (083 §5) — `<> 'agent'` ⇒ return 0.
--     UNCHANGED AND CORRECT FOR SHELL BY THE SAME REASONING that made it
--     correct for credential: a shell session has no team_member and never will,
--     so there is no participant to backfill, and falling through would emit a
--     `participant_backfill_unresolved` audit row on every maintenance pass
--     forever. The deny-list spelling is what made it right for a kind that did
--     not exist when it was written.
--
--  3. `internal.repair_w1_foundations`'s session loop (083 §5) — `= 'agent'`.
--     UNCHANGED AND CORRECT. The loop's two jobs are
--     `ensure_core_interaction_pin` and the participant backfill. A shell
--     session has no interaction profile to pin (nothing composes a prompt for
--     it) and no participant, so visiting it would do nothing twice.
--
--  4. `public.space_kind_counts` (083 §8) — `<> 'agent'` ⇒ excluded.
--     ***CHANGED HERE***, to `= 'credential'`. This is the allow-list trap the
--     contract's `sessionKind` comment predicts, wearing SQL clothing: written
--     as "not agent", it silently drops vanilla terminals from the rail count
--     while the session LIST still shows them, so the rail reads "3" over four
--     rows and nothing anywhere goes red. 083 chose that spelling deliberately
--     ("a future third session kind is excluded until someone decides
--     otherwise") and named the decision as future work. This is the decision:
--     a shell session is a thing a member deliberately started and expects to
--     find, so it COUNTS. Only the private login terminal is hidden, and now
--     the predicate says exactly that and nothing more.
--
--  4b. `credential-catalog.ts:521` — `where ws.session_kind = 'agent'`, inside
--     `terminateAgentSessions`. SQL, but embedded in TypeScript, which is why
--     a `db/migrations` grep does not find it and why it is called out
--     separately. UNCHANGED AND CORRECT for shell: disconnecting a vendor
--     credential must not kill a member's vanilla terminals, which hold no
--     vendor credential to be invalidated. Named here because an allow-list
--     that happens to be right is still an allow-list, and the next person
--     widening this column needs to re-decide it rather than not see it.
--
--  5. `public.execution_spawn` (048) — no `session_kind` predicate; it inserts
--     rows that default to 'agent'. UNTOUCHED ON PURPOSE. It is a shared body
--     on the critical launch path and the 052/056/057 `create or replace`
--     hazard applies; `start_shell_session` below is a NEW function beside it,
--     so nothing that spawns an agent today changes behaviour by one line.
--
-- Two SQL surfaces reach work_sessions with NO kind predicate and are correct
-- unchanged, which is worth stating because both look like candidates:
-- `public.work_session_transition` (043) — a shell's status transitions are
-- ordinary and go through R29's single writer like everyone else's — and
-- `listNodeActiveSessions`'s ghost-reconciliation read (execution-handlers.ts),
-- which is scoped by `node_id`. Unlike a credential session (083 D5, node_id
-- NULL by construction), a shell session DOES carry `node_id`: its PTY lives in
-- that node's process and dies with it, so a row left `running` after a restart
-- is a genuine ghost and reaping it at boot is the honest outcome. Reattach on
-- reconnect is a different thing entirely and happens inside one live process.

-- -----------------------------------------------------------------------------
-- 1. The third value.
--
-- `drop constraint` + `add constraint` rather than a bare `add`: the CHECK is
-- named by 083's inline form (`work_sessions_session_kind_check`) and Postgres
-- has no "replace check".
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  drop constraint if exists work_sessions_session_kind_check;
alter table public.work_sessions
  add constraint work_sessions_session_kind_check
    check (session_kind in ('agent', 'credential', 'shell'));

comment on column public.work_sessions.session_kind is
  'agent = a real agent session. credential = an interactive vendor-login '
  'terminal (083). shell = a vanilla terminal, a PTY on the login shell with '
  'no agent attached (100). Anything that assumed a work_sessions row is an '
  'agent must narrow on this. Read the 083 and 100 headers before adding a '
  'fourth value, and redo 100''s audit rather than assuming it covered you.';

-- -----------------------------------------------------------------------------
-- 2. The shell cap — a third disjoint count, mirroring 083 §3.
--
-- Disjoint from BOTH existing counts on purpose. See externality 1 above.
-- -----------------------------------------------------------------------------
create or replace function internal.shell_session_count(target_space uuid default null)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.status in ('spawning','running','idle')
     and ws.session_kind = 'shell'
     and e.deleted_at is null
     and (target_space is null or e.space_id = target_space)
$$;

comment on function internal.shell_session_count(uuid) is
  'Live VANILLA TERMINAL sessions, for start_shell_session''s own cap. '
  'Disjoint from internal.live_work_session_count and from '
  'internal.credential_session_count so no one kind can starve another.';

-- -----------------------------------------------------------------------------
-- 3. `public.start_shell_session` — mint the row.
--
-- The body is `execution_spawn`'s (048) MINUS everything about a persona, and
-- the subtraction is the point rather than an economy:
--
--   * no `p_team_member_id`, no `live_entity(…, 'team_member')`, no
--     `can_act_as` — there is no persona to authorize through, and inventing
--     one so the shape matches would be a lie in the graph about who is
--     running this;
--   * no `relates_to` edge to a teammate and no `working_on` edges — a vanilla
--     terminal is not working on anything; a human is;
--   * no `p_agent_tool`, `p_model` or `p_mode` parameter AT ALL, so the row's
--     `agent_tool` is NULL by construction and not by a caller remembering to
--     pass null;
--   * no `workdir_mode`/`base_ref` parameters: the mode is DERIVED from whether
--     a project was named, not accepted from the caller. 'project' when there
--     is one, 'scratch' when there is not — the same two values
--     `resolveWorkdir` (manifest.ts) derives for a spawn, so the two paths
--     describe a projectless session identically. An earlier version of this
--     wrote 'project' unconditionally and called it "the only legal value";
--     that was wrong on both counts — the column's CHECK admits
--     ('project','worktree','scratch'), and
--     `bootstrap-manifest.ts` REFUSES the row it produced
--     ("launchProjectId may be null only when workdirMode is scratch").
--     'worktree' is the one this function will never write: a worktree exists
--     so concurrent agents do not collide on one checkout; a human who names a
--     project means that directory.
--     `p_workdir_path` IS accepted, because the caller has already resolved and
--     re-validated the project's recorded `working_dir`; the column's own CHECK
--     (absolute, no `..`) is the backstop.
--
-- What it KEEPS from 048, because none of it is agent-specific: the ledger
-- replay guard, `require_space_member`, `resolve_actor`/`bind_actor`, the
-- project link + trust gate, the concurrency cap (its own), `create_envelope`,
-- and the `command_result` + `record_activity` return shape.
--
-- The actor is `resolve_actor`, matching spawn and NOT the credential path's
-- `current_member_id`. 083 used the narrower one because a login terminal must
-- never be opened on someone else's behalf — it is about to hold that person's
-- vendor password. A shell holds no secret of that kind, and a coordinator
-- opening a terminal as a teammate it may legitimately act as is ordinary use.
-- -----------------------------------------------------------------------------
create or replace function public.start_shell_session(
  p_space_id uuid, p_project_id uuid default null, p_title text default null,
  p_node_id text default null, p_workdir_path text default null,
  p_confirm_untrusted boolean default false,
  p_session_cap integer default 4, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  project public.projects;
  session_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.terminal.start');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if internal.shell_session_count(null) >= greatest(coalesce(p_session_cap, 4), 1) then
    raise exception 'terminal concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.shell_session_count(null))::text;
  end if;

  -- The same three project gates spawn applies, in the same order. A terminal
  -- is a shell prompt in that directory: if the project is not trusted, the
  -- consent it needs is the same consent, not a lesser one.
  if p_project_id is not null then
    select * into project from public.projects where id = p_project_id;
    if project.id is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.space_projects
                    where space_id = p_space_id and project_id = p_project_id) then
      raise exception 'project is not linked to this space' using errcode = '42501';
    end if;
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'opening a terminal in an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
  end if;

  -- A ROOT, ALWAYS. `execution_spawn` takes `p_parent_session_id` so an agent
  -- can record the session it spawned; a vanilla terminal is started by a human
  -- from the UI and has no spawning session to descend from.
  session_id := internal.create_envelope(p_space_id, 'work_session', actor, null, null);
  -- `workdir_path` IS RECORDED, and NULL when it genuinely cannot be. A
  -- projectless terminal's directory is named for the session id, which does
  -- not exist until the line above runs — the same chicken-and-egg
  -- `execution_spawn` has, and it resolves it by writing the scratch ROOT with
  -- a literal `pending` on the end. A row saying `.../pending` is a path no
  -- process ever had; NULL says "not recorded", which is true and which a
  -- reader can act on. The project case has a real answer and gets it.
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, status, session_kind)
  values (session_id, coalesce(nullif(btrim(p_title), ''), 'Terminal'), p_node_id,
          p_project_id,
          -- DERIVED, never 'project' unconditionally. A projectless terminal
          -- that claimed `workdir_mode = 'project'` with a NULL project_id and
          -- a NULL workdir_path renders in the UI as a project working
          -- directory with no directory, and is the exact combination
          -- `bootstrap-manifest.ts` rejects.
          case when p_project_id is null then 'scratch' else 'project' end,
          p_workdir_path, 'spawning', 'shell');

  return internal.ledger_record(p_client_mutation_id, 'execution.terminal.start',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object(
                 'kind', 'work_session',
                 'sessionKind', 'shell'
               )),
             array[session_id])) || jsonb_build_object('__tm8_replayed', false);
end
$$;

revoke all on function public.start_shell_session(
  uuid, uuid, text, text, text, boolean, integer, uuid, text
) from public;
grant execute on function public.start_shell_session(
  uuid, uuid, text, text, text, boolean, integer, uuid, text
) to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. Externality 4 — the rail counters stop being an allow-list.
--
-- THE BODY BELOW IS 083 §8's, WHICH IS 068_counters_watermark.sql's. 063
-- defines the same function and 068 replaced it; 063's body is dead code that
-- `create or replace` silently superseded. Everything here is that body
-- verbatim except the one marked conjunct.
-- -----------------------------------------------------------------------------
create or replace function public.space_kind_counts(p_space_id uuid)
returns table(kind text, total integer, unseen integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (
    select m.entity_id as member_id, m.counters_since
      from public.members m
     where m.space_id = p_space_id
       and m.identity_id = internal.identity_id()
     limit 1
  )
  select e.kind,
         count(*)::integer as total,
         count(*) filter (
           where e.activity_at > greatest(
             coalesce(mark_row.last_read_at, '-infinity'::timestamptz),
             coalesce((select counters_since from me), '-infinity'::timestamptz)
           )
         )::integer as unseen
    from public.entities e
    left join public.read_marks mark_row
      on mark_row.anchor_id = e.id
     and mark_row.member_id = (select member_id from me)
   where e.space_id = p_space_id
     and e.deleted_at is null
     and internal.is_space_member(p_space_id)
     and internal.entity_readable(e.id)
     -- CHANGED IN 100: was `ws.session_kind <> 'agent'`. Spelled as the exact
     -- kind being hidden, so the third kind (and any fourth) is COUNTED unless
     -- someone writes it in here. 083 excluded a login terminal because a
     -- member would see a bold unseen "1" for a terminal they opened seconds
     -- ago in a settings dialog; a vanilla terminal is a session they started
     -- from the session list and will look at, so hiding it would make the
     -- rail disagree with the list it labels.
     and not exists (select 1 from public.work_sessions ws
                      where ws.entity_id = e.id and ws.session_kind = 'credential')
   group by e.kind
$$;

revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;
