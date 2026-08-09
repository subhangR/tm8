-- =============================================================================
-- 082 — per-member agent credentials: the metadata index, the login terminal,
-- and the discriminator that keeps a login terminal from being mistaken for an
-- agent.
--
-- READ 079_account_git_credentials's header FIRST. This file deliberately
-- copies its posture: RLS pinned to the owning account and resolved from the
-- transaction identity, NO node-admin bypass, a COLUMN-LEVEL grant rather than
-- a table grant, no insert/update/delete privilege at all, and every mutation
-- behind a SECURITY DEFINER RPC that derives the account and has no parameter
-- naming one.
--
-- WHY THERE ARE NO SECRET COLUMNS HERE.
--
-- 079 stores a GitHub token because a GitHub token IS a string. The credentials
-- this file indexes are FILE-shaped: `claude setup-token` and the Codex login
-- write a file (`.credentials.json`, mode 0600) into a per-account config
-- directory on the node's filesystem. There is nothing to encrypt into a
-- column, so `account_agent_credentials` is an INDEX and nothing more — it says
-- that account A has a credential for provider P, when it was connected, and
-- what to render on a card. Do not add a secret column here. If a provider ever
-- turns out to be string-shaped, it belongs in 079's table, not this one.
--
-- WHY A CREDENTIAL SESSION IS A `work_sessions` ROW AT ALL.
--
-- The login is interactive: a vendor CLI prints a URL and waits for a pasted
-- code. tm8 already has exactly one thing that streams a live PTY to a browser
-- and takes keystrokes back, and it is the work session. Reusing it is cheaper
-- and far less risky than a second streaming stack. But a login terminal is NOT
-- an agent, and every place that assumed "work_sessions row => agent" is now
-- wrong. `session_kind` is how those places tell the difference, and the three
-- externalities below are the ones that BITE if you skip them:
--
--  D3 — THE SPAWN SLOT. `internal.live_work_session_count` had no predicate
--       narrowing it to agents, so a live credential terminal would consume a
--       node-wide agent spawn slot and a busy node would answer
--       `53400 session concurrency cap reached` to a real spawn. Fixed below by
--       replacing that function's ONLY definition (006_execution_side.sql) with
--       one carrying `and ws.session_kind = 'agent'`. The signature is
--       unchanged, so 043 / 048 / 062's `execution_spawn` and `execution_resume`
--       pick it up with no edit. Credential terminals get their own MIRROR
--       count (`internal.credential_session_count`) and their own cap, so a full
--       agent cap can never starve a login and a login can never starve agents.
--
--  D5 — THE GHOST REAPER. `node_id` is left NULL BY CONSTRUCTION on a
--       credential session: `reconcileNodeGhosts` lists candidates BY
--       `node_id`, finds no local PTY for a row it does not own, and force-exits
--       it. A credential terminal carrying a node_id gets killed at node boot.
--       `start_credential_session` therefore never writes node_id, and the
--       credential-sessions service owns its own expiry sweep instead.
--
--  W1 MAINTENANCE. `internal.w1_backfill_participant` tries to give every work
--       session a `participates_in` edge to a team_member. A credential session
--       has no team_member and never will, so without a guard every maintenance
--       pass would emit a `participant_backfill_unresolved` audit row for it
--       forever. The guard goes in `w1_backfill_participant` itself because
--       that is the single choke point all four callers funnel through
--       (015:1896, 015:1936, 065:271, 065:366), and `repair_w1_foundations`'s
--       loop is narrowed as well so it does not even visit the row.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE.
--
--  * It never writes `work_sessions.status` outside the initial insert.
--    Session lifecycle has ONE writer — the process-side terminate / PTY-exit
--    path. See the comment on `finish_credential_session`.
--  * It adds no operation-catalog row. The catalog and its pin cascade belong
--    to a later change that baselines that cascade first.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 0. `internal.current_account_id()` — copied here for ORDER INDEPENDENCE.
--
-- PROVENANCE: this body is byte-identical to the definition in
-- `078_private_projects.sql` on the deployed staging line
-- (`/opt/tm8/staging/db/migrations/078_private_projects.sql`, also reachable as
-- `origin/deploy/channels-on-staging:db/migrations/078_private_projects.sql`,
-- and renumbered to `080_private_projects.sql` on
-- `origin/feat/per-user-private-workspaces`). It is NOT reachable from
-- `origin/main`, which is the branch this file is written against.
--
-- Why copy rather than depend: coupling this migration's mergeability to
-- another lane's merge schedule would mean neither can land without the other.
-- The bodies being IDENTICAL is what makes `create or replace` safe here —
-- whichever file applies second is a no-op, so merge order stops mattering. Two
-- rules follow, and breaking either reintroduces the hazard 079's own header
-- warned about ("apply order decided which one survived"):
--
--   1. If you edit this function, edit it in BOTH files in the same change.
--   2. If the private-projects definition ever grows an arm this copy lacks,
--      DELETE this block and sequence the migrations instead. `create or
--      replace` against a divergent shared body silently clobbers the other
--      lane's arm and nothing goes red.
--
-- It resolves identity -> account and touches no private-projects table, which
-- is what makes it small enough to duplicate at all.
-- -----------------------------------------------------------------------------
create or replace function internal.current_account_id() returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select a.id from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
$$;

revoke all on function internal.current_account_id() from public;
grant execute on function internal.current_account_id() to tm8_app;

-- -----------------------------------------------------------------------------
-- 1. The human-only gate, FAIL CLOSED.
--
-- `credentials.*` refuses a caller whose auth session kind is `agent` — status
-- included, because no agent workflow needs it and it leaks login metadata. The
-- primary enforcement is the facade guard at registration; this is defence in
-- depth so that a future RPC caller cannot forget it.
--
-- The claim it reads, `tm8.auth_kind`, is a FIFTH member of the trusted
-- transaction claim surface (`tm8.identity_id`, `tm8.actor_id`,
-- `tm8.node_admin`, `tm8.request_id`). Widening that surface is legitimate here
-- specifically because an auth session's `kind` is IMMUTABLE for the life of
-- the session: the staleness objection that keeps membership out of the claims
-- does not apply to it.
--
-- ⚠ DEPENDENCY, STATED SO IT CANNOT BE DISCOVERED IN PRODUCTION: nothing binds
-- `tm8.auth_kind` yet. Until `BIND_CLAIMS_SQL` in the server's identity layer
-- binds it, this function refuses EVERY caller and all four RPCs below are
-- closed. That is deliberate — a missing claim must refuse, not admit — but it
-- means the server-side binding has to land with, or before, the first caller.
-- -----------------------------------------------------------------------------
create or replace function internal.require_human_auth_kind() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare kind text;
begin
  kind := internal.claim_text('tm8.auth_kind');
  -- Null, empty and unrecognised all land here. Do not add an `is null` escape:
  -- "we could not tell" must read as "no", or the gate is decorative.
  if kind is null or kind not in ('browser', 'cli') then
    raise exception 'credentials are human-only' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(kind, 'none'))::text;
  end if;
end
$$;

-- Revoked from public and granted to NOBODY. This is 079's control 4 applied to
-- a function: the only callers are the four security-definer RPCs below, which
-- run as the definer and therefore never consult tm8_app's privileges. A grant
-- that no caller needs is a grant that only a future mistake can use.
revoke all on function internal.require_human_auth_kind() from public;

comment on function internal.require_human_auth_kind() is
  'Refuses any caller that is not a browser or cli auth session. Fails closed: '
  'a missing or empty tm8.auth_kind claim refuses. Defence in depth behind the '
  'facade guard, not a replacement for it.';

-- -----------------------------------------------------------------------------
-- 2. The discriminator.
--
-- Additive with zero impact on every existing insert path: a `not null default`
-- on an existing table is a CATALOG-ONLY change on PostgreSQL 11 and later (no
-- table rewrite, no backfill), and every insert that does not mention the
-- column gets 'agent' — which is what every row that exists today is.
--
-- The provider does NOT live here. It lives on `credential_sessions.provider`
-- and ONLY there, so there is exactly one copy carrying the CHECK and the
-- one-live-per-pair index, and no second copy to drift out of step.
--
-- SQL surfaces test `session_kind = 'agent'`. TypeScript surfaces must use the
-- inverse — `sessionKind !== 'credential'` — because a row hydrated from an
-- older cached payload has no such field, and `=== 'agent'` would hide real
-- agent sessions from the user. 057's `to_jsonb(ws)` publishes the column to
-- the read models automatically.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  add column session_kind text not null default 'agent'
    check (session_kind in ('agent', 'credential'));

comment on column public.work_sessions.session_kind is
  'agent = a real agent session. credential = an interactive vendor-login '
  'terminal (082). Anything that assumed a work_sessions row is an agent must '
  'narrow on this. Read the 082 header before adding a third value.';

-- The target half of `credential_sessions`'s composite foreign key. `entity_id`
-- is already the primary key, so this adds no new uniqueness — it exists purely
-- so a foreign key can reference (entity_id, session_kind) as a pair, which is
-- what makes "a credential_sessions row can only ever point at a credential
-- work_session" a DECLARATIVE guarantee instead of an argument about which
-- grants happen not to exist.
alter table public.work_sessions
  add constraint work_sessions_entity_id_session_kind_key
    unique (entity_id, session_kind);

-- -----------------------------------------------------------------------------
-- 3. D3 — the spawn cap stops counting login terminals.
--
-- This REPLACES the function's only definition (006_execution_side.sql). The
-- body is that definition plus one conjunct; the signature is untouched, so
-- 007 / 043 / 048 / 062 keep calling it with no edit and 047's grant survives
-- `create or replace`.
-- -----------------------------------------------------------------------------
create or replace function internal.live_work_session_count(target_space uuid default null)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.status in ('spawning','running','idle')
     and ws.session_kind = 'agent'
     and e.deleted_at is null
     and (target_space is null or e.space_id = target_space)
$$;

comment on function internal.live_work_session_count(uuid) is
  'Live AGENT sessions, for execution.spawn/resume''s concurrency cap. The '
  'session_kind predicate is load-bearing (082 D3): without it a credential '
  'login terminal consumes a node-wide agent spawn slot.';

-- -----------------------------------------------------------------------------
-- 4. Metadata for FILE-shaped credentials. No secret columns — see the header.
-- -----------------------------------------------------------------------------
create table public.account_agent_credentials (
  id               uuid primary key default internal.new_id(),
  account_id       uuid not null references public.accounts(id) on delete cascade,
  -- ('anthropic','openai') and no more. A provider is admitted by MEASURING its
  -- login flow — a login verb in the fixed command table, a probe, a storage
  -- shape — not by widening this list. `github` is string-shaped and stays in
  -- 079's `account_git_credentials`.
  provider         text not null
    check (provider in ('anthropic', 'openai')),
  -- Display only. NULL FOREVER for anthropic: the login verb tm8 uses
  -- (`claude setup-token`) requests inference scope only, so it can never learn
  -- an email. The UI must branch on presence and render "Connected — inference
  -- access", never "Connected as null". Do not "fix" this by switching to the
  -- wider login verb: that one requests org:create_api_key, which is materially
  -- worse on a node with no cross-user isolation.
  login            text
    check (login is null or char_length(btrim(login)) between 1 and 200),
  auth_method      text
    check (auth_method is null or char_length(btrim(auth_method)) between 1 and 50),
  connected_at     timestamptz not null default now(),
  last_verified_at timestamptz,
  status           text not null default 'active'
    check (status in ('active', 'stale', 'revoked')),
  constraint account_agent_credentials_one_per_provider
    unique (account_id, provider)
);

comment on table public.account_agent_credentials is
  'Per-account FILE-shaped agent credentials — metadata index only. The secret '
  'is a 0600 file in a per-account config directory on the node, never a column '
  'here. Read the 082 header before adding a column, a policy, or a grant.';

alter table public.account_agent_credentials enable row level security;

-- One policy, one direction: own row, select only. Everything else is an RPC.
--
-- THERE IS NO NODE-ADMIN BYPASS AND THAT IS DELIBERATE, exactly as in 079: an
-- operator administering the node has no business reading which member is
-- connected to which vendor identity. Do not add one "for support".
create policy account_agent_credentials_self_select on public.account_agent_credentials
  for select using (account_id = internal.current_account_id());

-- Column-level rather than a table grant. This table happens to have no secret
-- column today, so the enumeration protects nothing yet — it is here so that
-- adding a column does not silently grant it, which is how the omission in 079
-- would otherwise be lost the first time someone extends this one.
grant select (id, account_id, provider, login, auth_method,
              connected_at, last_verified_at, status)
  on public.account_agent_credentials to tm8_app;
-- No insert/update/delete grant. Deliberate. See the RPCs below.

-- -----------------------------------------------------------------------------
-- 5. The live login terminal. Rows are short-lived by construction.
-- -----------------------------------------------------------------------------
create table public.credential_sessions (
  work_session_id  uuid primary key references public.work_sessions(entity_id) on delete cascade,
  -- Redundant by design, and pinned to a single value: it exists only to give
  -- the composite foreign key below something to match on. See the constraint.
  work_session_kind text not null default 'credential'
    check (work_session_kind = 'credential'),
  account_id       uuid not null references public.accounts(id) on delete cascade,
  -- Three values, not two: a Tier B terminal can also run the `gh` login, even
  -- though the credential that login produces lands in 079's string-shaped
  -- table rather than in `account_agent_credentials`.
  provider         text not null
    check (provider in ('anthropic', 'openai', 'github')),
  expires_at       timestamptz not null,
  finished_at      timestamptz,
  -- The declarative half of the invariant "a credential_sessions row's work
  -- session is a credential work session". Without it the guarantee rests on
  -- tm8_app having no insert grant — true today, but an absence, and an absence
  -- is not a constraint. With it, the row is unproducible even by a superuser
  -- who forgot, and `session_kind` cannot be flipped out from under it either.
  constraint credential_sessions_work_session_is_credential
    foreign key (work_session_id, work_session_kind)
    references public.work_sessions(entity_id, session_kind) on delete cascade
);

-- ONE live login per (account, provider). A second attempt is a mistake or a
-- double-click, never a legitimate second terminal — the vendor CLIs write to
-- one config directory and two concurrent logins race each other's files.
create unique index credential_sessions_one_live_per_account_provider
  on public.credential_sessions(account_id, provider) where finished_at is null;

-- The expiry sweep's driving index: rows still open, oldest deadline first.
create index credential_sessions_open_expiry_idx
  on public.credential_sessions(expires_at) where finished_at is null;

-- The MIRROR CAP's count. It lives HERE, after the table, and not beside
-- `live_work_session_count` in section 3 where its twin is, for a reason that
-- is not stylistic: `check_function_bodies` is on by default, so a `language
-- sql` body naming `public.credential_sessions` cannot be created before that
-- table exists. Defining it above would abort the migration.
-- The mirror. A credential terminal is metered, just not against the agent cap:
-- the two counts are disjoint by construction, so a full agent cap can never
-- block a login and a stuck login can never block a spawn.
--
-- IT COUNTS FROM `credential_sessions`'s OWN LIFECYCLE COLUMNS, NOT FROM
-- `work_sessions.status`, AND THAT IS THE WHOLE POINT (architect ruling R10).
--
-- The obvious predicate — `ws.status in ('spawning','running','idle')`, mirror
-- of the agent count above — is a permanent denial of service after one crash,
-- and the chain is short enough to state in full:
--
--   * the only writer of a credential session's `status` is the process-side
--     PTY-exit path (see `finish_credential_session`, which stamps `finished_at`
--     and nothing else);
--   * that path dies WITH the node, so a node that crashes leaves its credential
--     rows at 'running';
--   * the ghost reaper cannot clean them: it lists candidates by `node_id`, and
--     `node_id` is NULL on a credential session BY CONSTRUCTION (D5 above);
--   * so nothing, ever, moves that row off 'running'.
--
-- Two crash-orphans against a default cap of 2 and NO MEMBER ON THE NODE CAN
-- EVER OPEN A LOGIN AGAIN, with no error that names the cause. Counting from
-- `finished_at`/`expires_at` instead makes an orphan age out of the cap in at
-- most the TTL ceiling (1800s, clamped in `start_credential_session`) with no
-- writer involved at all.
--
-- The trade, stated so it is not rediscovered as a bug: a terminal that is
-- still LIVE past its expiry is undercounted until the credential-sessions
-- service's interval sweep terminates it. That is bounded by the sweep
-- interval and self-correcting; the status-based version's failure was
-- unbounded and self-reinforcing.
create or replace function internal.credential_session_count(target_space uuid default null)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.credential_sessions cs
    join public.entities e on e.id = cs.work_session_id
   where cs.finished_at is null
     and cs.expires_at > now()
     and e.deleted_at is null
     and (target_space is null or e.space_id = target_space)
$$;

revoke all on function internal.credential_session_count(uuid) from public;
grant execute on function internal.credential_session_count(uuid) to tm8_app;

comment on table public.credential_sessions is
  'One row per interactive vendor-login terminal (082). The work session it '
  'points at always has session_kind = ''credential'' and node_id NULL. '
  'Lifecycle is owned by the credential-sessions service, not by SpawnService''s '
  'ghost reconciliation.';

alter table public.credential_sessions enable row level security;

-- Same posture as above: own rows, select only, no node-admin bypass. Watching
-- someone else's login terminal is exactly the thing this must not allow.
create policy credential_sessions_self_select on public.credential_sessions
  for select using (account_id = internal.current_account_id());

grant select (work_session_id, account_id, provider, expires_at, finished_at)
  on public.credential_sessions to tm8_app;
-- No insert/update/delete grant.

-- -----------------------------------------------------------------------------
-- 6. W1 maintenance stops treating a login terminal as an agent.
--
-- The guard lives inside `w1_backfill_participant` because that is the single
-- choke point every caller funnels through — the 015 install pass, 065's
-- derived-edge trigger, 065's sweep, and `repair_w1_foundations`. Guarding only
-- at the call sites would leave whichever caller is added next unguarded.
--
-- Both bodies below are 015's, unchanged except for the marked lines.
-- -----------------------------------------------------------------------------
create or replace function internal.w1_backfill_participant(target_session uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare session_space uuid; candidate uuid; candidate_count integer; actor uuid;
begin
  -- ADDED IN 082. A credential session has no team_member and never will, so
  -- there is no participant to backfill. Returning 0 rather than falling
  -- through matters: the fall-through path ends at a
  -- `participant_backfill_unresolved` audit row, which every maintenance pass
  -- would then re-emit for the same login terminal forever.
  if exists (select 1 from public.work_sessions ws
              where ws.entity_id = target_session and ws.session_kind <> 'agent') then
    return 0;
  end if;
  select space_id, created_by into session_space, actor
    from public.entities where id = target_session and kind = 'work_session';
  if session_space is null then return 0; end if;
  if exists (select 1 from public.edges
              where type = 'participates_in' and dst_id = target_session) then
    return 0;
  end if;
  select count(*), (array_agg(candidate_id order by candidate_id))[1]
    into candidate_count, candidate from (
    select distinct case when src.kind = 'team_member' then edge.src_id else edge.dst_id end candidate_id
      from public.edges edge
      join public.entities src on src.id = edge.src_id
      join public.entities dst on dst.id = edge.dst_id
     where edge.type = 'relates_to'
       and ((src.kind = 'team_member' and dst.id = target_session)
         or (dst.kind = 'team_member' and src.id = target_session))
       and src.space_id = session_space and dst.space_id = session_space
       and src.deleted_at is null and dst.deleted_at is null
  ) candidates;
  if candidate_count = 1 then
    perform 1 from public.work_sessions where entity_id = target_session for update;
    perform internal.w1_set_writer('backfill');
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (session_space, candidate, target_session, 'participates_in', '{}'::jsonb,
            coalesce(actor, candidate))
    on conflict (src_id, dst_id, type) do nothing;
    perform internal.w1_set_writer(null);
    return 1;
  end if;
  perform internal.w1_audit(session_space, 'participant_backfill_unresolved',
    jsonb_build_object('workSessionId', target_session, 'candidateCount', candidate_count));
  return 0;
end
$$;

create or replace function public.repair_w1_foundations(
  p_space_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; project_row record; session_id uuid; repaired integer := 0; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'maintenance.w1.repair');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  -- Lock all ProjectResources before the affected Space, then visit projections.
  perform 1 from public.projects p join public.space_projects sp on sp.project_id = p.id
   where sp.space_id = p_space_id order by p.id for update of p;
  perform 1 from public.spaces where id = p_space_id for update;
  for project_row in
    select project_id from public.space_projects where space_id = p_space_id order by project_id
  loop
    perform internal.materialize_project_projection(p_space_id, project_row.project_id, true);
    repaired := repaired + 1;
  end loop;
  insert into public.space_menu_configs(space_id, schema_version, revision, payload)
  values (p_space_id, 1, 1, internal.w1_default_menu_payload())
  on conflict (space_id) do nothing;
  for session_id in
    select ws.entity_id from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
    -- ADDED IN 082: `and ws.session_kind = 'agent'`. A login terminal is not an
    -- agent session and maintenance has nothing to repair on it. This is
    -- belt-and-braces over the guard inside w1_backfill_participant; it also
    -- keeps `ensure_core_interaction_pin` off the row.
    where e.space_id = p_space_id and ws.session_kind = 'agent' order by ws.entity_id
  loop
    perform internal.ensure_core_interaction_pin(session_id);
    repaired := repaired + internal.w1_backfill_participant(session_id);
  end loop;
  update public.projects p set
    active_link_count = counts.link_count,
    link_frozen = counts.link_count > 16
  from (select project_id, count(*)::integer link_count from public.space_projects
        group by project_id) counts
  where p.id = counts.project_id;
  perform internal.w1_audit(p_space_id, 'repair_completed',
    jsonb_build_object('mutationCount', repaired));
  result := jsonb_build_object('spaceId', p_space_id, 'mutationCount', repaired,
                               'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'maintenance.w1.repair', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. RPCs. All SECURITY DEFINER, all derive the account from
--    `internal.current_account_id()`, and NONE takes an account parameter.
--
--    That last clause is the whole security property, not a style preference:
--    an account parameter would make every one of these a confused deputy, and
--    no amount of checking inside the body recovers what a missing parameter
--    guarantees for free.
-- -----------------------------------------------------------------------------

-- Open a login terminal.
--
-- `node_id` is NOT written and must never be — see D5 in the header. The row
-- gets `share_mode = 'none'` because the terminal streams a device code and the
-- member's own keystrokes, and nobody else in the space has any business
-- watching that.
create or replace function public.start_credential_session(
  p_space_id uuid,
  p_provider text,
  p_ttl_seconds integer default 900,
  p_session_cap integer default 2
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  v_actor uuid;
  v_ttl integer;
  v_session_id uuid;
  v_expires_at timestamptz;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);

  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai', 'github') then
    raise exception 'unsupported credential provider' using errcode = '22023';
  end if;

  -- Clamp rather than reject: a login that is allowed to sit open for an hour
  -- is a terminal nobody is watching, and the floor keeps a caller from
  -- creating a session that has already expired.
  v_ttl := least(greatest(coalesce(p_ttl_seconds, 900), 60), 1800);

  -- The MIRROR cap. Disjoint from the agent cap on purpose: see section 3.
  if internal.credential_session_count(null) >= greatest(coalesce(p_session_cap, 2), 1) then
    raise exception 'credential session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.credential_session_count(null))::text;
  end if;

  -- The actor is the caller's own membership in this space, never
  -- `internal.resolve_actor`: resolve_actor exists so a caller can act AS a
  -- teammate, and a credential session is the one thing that must never be
  -- opened on someone else's behalf. `require_space_member` above guarantees
  -- this is non-null.
  v_actor := internal.current_member_id(p_space_id);

  v_expires_at := now() + make_interval(secs => v_ttl);

  v_session_id := internal.create_envelope(p_space_id, 'work_session', v_actor, null, null);
  insert into public.work_sessions(entity_id, title, status, share_mode, session_kind)
  values (v_session_id, 'Connect ' || p_provider, 'spawning', 'none', 'credential');

  -- Same transaction as the work_sessions insert, and tm8_app has no insert
  -- grant on either table, so there is no path that produces one without the
  -- other.
  insert into public.credential_sessions(work_session_id, account_id, provider, expires_at)
  values (v_session_id, v_account_id, p_provider, v_expires_at);

  return jsonb_build_object(
    'workSessionId', v_session_id,
    'spaceId', p_space_id,
    'provider', p_provider,
    'expiresAt', v_expires_at
  );
end
$$;

-- Close a login terminal's ledger row.
--
-- IT STAMPS `finished_at` AND NOTHING ELSE. It deliberately does not write
-- `work_sessions.status`, because session lifecycle has exactly ONE writer: the
-- process-side terminate / PTY-exit path. An RPC that flipped the row to
-- 'exited' while the PTY may still be live would be telling precisely the
-- false-'exited' lie that SpawnService.terminate refuses to tell when a kill
-- fails with EPERM. The calling service orchestrates the true order: terminate
-- the PTY, let normal exit reconciliation write the status, THEN call this.
--
-- Idempotent: finishing an already-finished session is a fact, not an error,
-- and answering 404 would leak whether a session existed.
create or replace function public.finish_credential_session(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.credential_sessions;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  update public.credential_sessions
     set finished_at = now()
   where work_session_id = p_work_session_id
     and account_id = v_account_id
     and finished_at is null
  returning * into stored;

  if stored.work_session_id is null then
    -- Either already finished, or not this account's. Both answer the same way
    -- on purpose: distinguishing them tells a caller whether someone else's
    -- session exists.
    return jsonb_build_object('workSessionId', p_work_session_id, 'finished', false);
  end if;

  return jsonb_build_object(
    'workSessionId', stored.work_session_id,
    'provider', stored.provider,
    'finished', true,
    'finishedAt', stored.finished_at
  );
end
$$;

-- Upsert the metadata row after a login succeeds. The secret is already on
-- disk by the time this is called; this only records that it is there.
create or replace function public.set_account_agent_credential(
  p_provider text,
  p_login text,
  p_auth_method text,
  p_status text default 'active'
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_agent_credentials;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'unsupported agent credential provider' using errcode = '22023';
  end if;
  if coalesce(p_status, 'active') not in ('active', 'stale', 'revoked') then
    raise exception 'unsupported credential status' using errcode = '22023';
  end if;

  insert into public.account_agent_credentials(
    account_id, provider, login, auth_method, status, last_verified_at
  ) values (
    v_account_id, p_provider, nullif(btrim(p_login), ''), nullif(btrim(p_auth_method), ''),
    coalesce(p_status, 'active'), now()
  )
  on conflict (account_id, provider) do update
     set login            = excluded.login,
         auth_method      = excluded.auth_method,
         status           = excluded.status,
         last_verified_at = excluded.last_verified_at
  returning * into stored;

  return jsonb_build_object(
    'connected', stored.status = 'active',
    'provider', stored.provider,
    'login', stored.login,
    'authMethod', stored.auth_method,
    'status', stored.status,
    'connectedAt', stored.connected_at,
    'lastVerifiedAt', stored.last_verified_at
  );
end
$$;

-- Forget a credential. Idempotent for the same reason 079's delete is.
--
-- THIS REMOVES THE INDEX ROW ONLY. Deleting the on-disk credential file, and
-- terminating the sessions that already hold the secret in memory, are the
-- caller's job and must happen in that order — revoke first, so no new spawn
-- can pick it up while the rest of the operation runs. Termination is
-- containment, not revocation: a process that already read the credential keeps
-- it, and only rotating at the vendor actually invalidates it.
create or replace function public.delete_account_agent_credential(p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  removed integer;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  delete from public.account_agent_credentials
   where account_id = v_account_id
     and provider = p_provider;
  get diagnostics removed = row_count;

  return jsonb_build_object(
    'connected', false,
    'provider', p_provider,
    'deleted', removed > 0
  );
end
$$;

-- -----------------------------------------------------------------------------
-- 8. D4 — the rail counters stop counting login terminals.
--
-- A credential session is a `work_session` entity, so without this it appears
-- in the rail's `work_session` count and, worse, in the UNSEEN count: a member
-- would see a bold "1" for a terminal they opened themselves seconds ago.
--
-- THE BODY BELOW IS 068_counters_watermark.sql's, NOT 063_space_kind_counts's.
-- 063 defines the same function and 068 replaced it; 063's body is dead code
-- that `create or replace` silently superseded with nothing going red. Starting
-- from 063 would resurrect the superseded version. Everything here is 068's
-- verbatim except the marked conjunct.
--
-- The predicate is spelled `<> 'agent'` rather than `= 'credential'` on
-- purpose: it fails toward counting, so a future third session kind is excluded
-- until someone decides otherwise, instead of quietly appearing in the rail.
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
         -- Unseen = changed since the LATER of "when I last opened it" and
         -- "when my counters start". The watermark is the floor: without it a
         -- never-opened row is unseen forever, which is how 93% of a workspace
         -- ended up bold.
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
     -- ADDED IN 082. See the block comment above.
     and not exists (select 1 from public.work_sessions ws
                      where ws.entity_id = e.id and ws.session_kind <> 'agent')
   group by e.kind
$$;

revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;

revoke all on function public.start_credential_session(uuid, text, integer, integer) from public;
revoke all on function public.finish_credential_session(uuid) from public;
revoke all on function public.set_account_agent_credential(text, text, text, text) from public;
revoke all on function public.delete_account_agent_credential(text) from public;
grant execute on function public.start_credential_session(uuid, text, integer, integer) to tm8_app;
grant execute on function public.finish_credential_session(uuid) to tm8_app;
grant execute on function public.set_account_agent_credential(text, text, text, text) to tm8_app;
grant execute on function public.delete_account_agent_credential(text) to tm8_app;

reset role;
