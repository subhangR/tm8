-- =============================================================================
-- 100 — Phase 0 containment (2026-08-11).
--
-- TWO unrelated-looking changes that are the same change: authority must be
-- resolved from TABLES, and a credential must not outlive the thing it was
-- minted for.
--
-- PART A — node admin resolves from `accounts`, not from a claim.
--
--   001:141-145 states the rule the whole schema is built on: the claims other
--   than `tm8.identity_id` are "a fast path for the server. Authorization NEVER
--   trusts them." Two functions break it:
--
--     internal.is_node_admin()      001:166   reads the tm8.node_admin CLAIM
--     internal.require_node_admin() 002:319   reads the accounts TABLE   ✅
--
--   The claim form is used as authority in FIVE places: one read policy on
--   projects (008:177), one on server_connections (044:34), and — worse —
--   three WRITE gates in 095. Today the server derives that claim from the
--   token-hash-verified session row, so none of this is reachable from a
--   client. But it converts a claim-construction bug in TypeScript from
--   "Postgres refuses" into "privilege escalation", and it is the one place
--   the schema does not enforce its own stated invariant.
--
--   `internal.is_node_admin()` is NOT dropped. It is a claim ACCESSOR, and
--   009 grants it to tm8_app alongside the other accessors; it stays available
--   for diagnostics and for the server's own fast-path checks. What changes is
--   that nothing in the schema uses it to DECIDE anything.
--
-- PART B — a door to revoke agent credentials whose agent is gone.
--
--   `public.revoke_agent_auth_session` (074:107) exists and has ZERO callers in
--   product code — verified by grep across packages/. Nothing has ever revoked
--   an agent bearer on exit. Measured on this node before writing this file:
--   152 live agent tokens, of which 124 belong to work sessions that are no
--   longer running. Each carries the full graph reach of the human who spawned
--   it, for up to its full TTL.
--
--   The obvious fix — restore the liveness clause 072:36-59 had and 074:26-41
--   silently dropped when it redefined `resolve_auth_session` — is NOT safe
--   yet. `work_session_transition` (043:92) is `require_space_member` only, so
--   "mark it exited" would become a one-call revocation of any member's live
--   agent credential. That is a DoS, and it waits for the lifecycle gate.
--
--   So the revocation is keyed on something no database caller can forge:
--   whether THIS NODE still has a PTY for that session. The split mirrors
--   094/095's upload sweep, inverted — there the database names what to delete
--   and the node deletes it; here the node names what is dead and the database
--   revokes it. The database cannot see a process; the node cannot read
--   auth_sessions (008:204-206, RLS with zero policies, on purpose).
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- PART A
-- -----------------------------------------------------------------------------

-- The table-resolved predicate. This is `require_node_admin`'s test, lifted so
-- it has exactly one implementation and a boolean form policies can use — a
-- policy expression must never raise, so it cannot call the require_* form.
create or replace function internal.has_node_admin_account() returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id()
       and a.status = 'active'
       and (a.is_node_admin or a.is_owner)
  )
$$;

comment on function internal.has_node_admin_account() is
  'Table-resolved node admin. The ONLY node-admin predicate any policy or RPC '
  'may decide on; internal.is_node_admin() reads the claim and decides nothing.';

-- One implementation, two shapes. Behaviour is unchanged — same query, same
-- errcode, same message — so every existing caller is unaffected.
create or replace function internal.require_node_admin() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not internal.has_node_admin_account() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
end
$$;

-- RLS policy expressions are evaluated as the QUERYING role, so tm8_app must be
-- able to execute the predicate the policies below name (008:236-248).
grant execute on function internal.has_node_admin_account() to tm8_app;

-- 008:177-181. Drops the "a node admin sees every project on the node" arm's
-- dependence on a claim. The arm itself stays until the capability split
-- narrows it — this migration changes WHERE the answer comes from, not what
-- the answer is.
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to tm8_app
  using (internal.has_node_admin_account()
         or exists (select 1 from public.space_projects sp
                     where sp.project_id = projects.id
                       and internal.is_space_member(sp.space_id)));

-- 044:33-34.
drop policy if exists server_connections_node_admin_select on public.server_connections;
create policy server_connections_node_admin_select on public.server_connections
  for select using (internal.has_node_admin_account());

-- 095's three WRITE gates. Each was `require_identity()` followed by an inline
-- `if not internal.is_node_admin()` raising 42501; `require_node_admin()` does
-- both, against the table. The message changes from the bespoke string to
-- 'node admin required', which is the message every other node-admin refusal in
-- the schema already uses.
create or replace function public.sweep_file_upload_slots(
  p_limit integer default 100
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  expired_count bigint;
  purgeable jsonb;
begin
  perform internal.require_node_admin();

  select internal.expire_file_upload_slots() into expired_count;

  with picked as (
    select id from public.file_upload_slots
     where status in ('expired', 'aborted')
       and storage_purged_at is null
     order by expires_at
     limit greatest(coalesce(p_limit, 100), 1)
       for update skip locked
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'uploadId', s.id,
           'spaceId', s.space_id,
           'storagePath', s.storage_path)), '[]'::jsonb)
    into purgeable
    from public.file_upload_slots s
    join picked on picked.id = s.id;

  return jsonb_build_object(
    'expired', coalesce(expired_count, 0),
    'purgeable', purgeable);
end
$$;

create or replace function public.mark_file_upload_slots_purged(
  p_upload_ids uuid[]
) returns bigint language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare affected bigint;
begin
  perform internal.require_node_admin();

  update public.file_upload_slots
     set storage_purged_at = now()
   where id = any(coalesce(p_upload_ids, '{}'))
     and status in ('expired', 'aborted')
     and storage_purged_at is null;
  get diagnostics affected = row_count;
  return affected;
end
$$;

create or replace function public.purge_deleted_file_blobs(
  p_grace_seconds integer default 2592000,
  p_retry_seconds integer default 86400,
  p_limit integer default 100
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare purgeable jsonb;
begin
  perform internal.require_node_admin();

  with picked as (
    select f0.entity_id from public.files f0
      join public.entities e0 on e0.id = f0.entity_id
     where f0.purged_at is null
       and e0.deleted_at is not null
       and e0.deleted_at < now() - make_interval(secs => greatest(p_grace_seconds, 0))
     order by e0.deleted_at
     limit greatest(coalesce(p_limit, 100), 1)
       for update of f0 skip locked
  ), marked as (
    update public.files f
       set purged_at = now(), checksum_sha256 = null
      from picked
     where f.entity_id = picked.entity_id
     returning f.entity_id, f.storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'entityId', m.entity_id,
           'spaceId', e.space_id,
           'storagePath', m.storage_path)), '[]'::jsonb)
    into purgeable
    from (
      select entity_id, storage_path from marked
      union
      select f.entity_id, f.storage_path from public.files f
       where f.purged_at is not null
         and f.purged_at > now() - make_interval(secs => greatest(p_retry_seconds, 0))
    ) m
    join public.entities e on e.id = m.entity_id;

  return jsonb_build_object('purgeable', purgeable);
end
$$;

-- -----------------------------------------------------------------------------
-- PART B — the orphaned-agent-credential sweep doors.
-- -----------------------------------------------------------------------------

-- READ door. `auth_sessions` has RLS with zero policies and no select grant, so
-- this is the only way the node can learn which agent credentials are live.
-- It returns work session ids and nothing else — never a token hash, never a
-- label, never an account id. A node that leaks this learns which of its own
-- sessions hold credentials, which it already knew.
create or replace function public.live_agent_session_work_ids(p_node_id text)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare ids jsonb;
begin
  perform internal.require_node_admin();
  if p_node_id is null or btrim(p_node_id) = '' then
    raise exception 'node id is required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(distinct s.work_session_id), '[]'::jsonb)
    into ids
    from public.auth_sessions s
    join public.work_sessions ws on ws.entity_id = s.work_session_id
   where s.kind = 'agent'
     and s.revoked_at is null
     and s.expires_at > now()
     and ws.node_id = p_node_id;

  return ids;
end
$$;

-- WRITE door.
--
-- The caller passes the sessions it has PROVEN are still running here, and the
-- function revokes every other live agent credential belonging to THIS node.
--
-- Two deliberate bounds:
--
--   * `ws.node_id = p_node_id` — a node may only revoke its own sessions. A
--     multi-node deployment cannot have one node sweep another's agents.
--   * keyed on PTY liveness, NOT on `work_sessions.status`. Status is writable
--     by any space member through `work_session_transition` (043:92), so a
--     status-keyed sweep would hand every member a one-call revocation of
--     anyone's live agent. Whether a PTY exists is not expressible in SQL and
--     not reachable by any database caller — which is exactly why it is the
--     right key, and why this has to be a door rather than a trigger.
--
-- Passing an EMPTY live set is meaningful and correct: a node that has just
-- started owns no PTYs, so every agent credential it minted before the restart
-- belongs to a process that no longer exists. That is the boot repair.
create or replace function public.revoke_orphaned_agent_sessions(
  p_node_id text,
  p_live_work_session_ids uuid[] default '{}'
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  revoked_ids uuid[];
begin
  perform internal.require_node_admin();
  if p_node_id is null or btrim(p_node_id) = '' then
    raise exception 'node id is required' using errcode = '22023';
  end if;

  with victims as (
    select s.id
      from public.auth_sessions s
      join public.work_sessions ws on ws.entity_id = s.work_session_id
     where s.kind = 'agent'
       and s.revoked_at is null
       and ws.node_id = p_node_id
       and not (s.work_session_id = any (coalesce(p_live_work_session_ids, '{}')))
       for update of s
  ), done as (
    update public.auth_sessions s
       set revoked_at = now()
      from victims
     where s.id = victims.id
     returning s.work_session_id
  )
  select coalesce(array_agg(distinct work_session_id), '{}') into revoked_ids from done;

  return jsonb_build_object(
    'revoked', coalesce(array_length(revoked_ids, 1), 0),
    'workSessionIds', to_jsonb(revoked_ids));
end
$$;

revoke all on function public.live_agent_session_work_ids(text) from public;
revoke all on function public.revoke_orphaned_agent_sessions(text, uuid[]) from public;
grant execute on function public.live_agent_session_work_ids(text) to tm8_app;
grant execute on function public.revoke_orphaned_agent_sessions(text, uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- PART C — the account count, for the boot invariant.
--
-- `identity-resolver.ts:79-88` resolves an unauthenticated loopback request as
-- THE NODE OWNER, and `config.ts:347` defaults `TM8_DISABLE_AUTO_OWNER` to
-- false — so auto-owner is ON unless an operator turned it off. On a
-- single-account laptop that is the intended degenerate case. On a node with
-- eight accounts it means anyone who reaches loopback is the owner, and the
-- entire multi-user posture rests on one env var defaulting the unsafe way.
--
-- The server refuses to start in that combination (bootstrap/auto-owner-invariant.ts),
-- and to decide it, it has to count accounts before anybody has authenticated.
--
-- CLAIM-FREE, deliberately, and this is the whole justification: the caller has
-- no identity yet — working out whether identities are even required is the
-- question being asked. It returns one integer and nothing else: no username,
-- no identity id, no status, nothing that names a person. That is strictly less
-- than either claim-free hole 007 already ships (`resolve_auth_session` returns
-- a whole session, `resolve_account_credential` a whole credential row), and
-- reaching it at all requires a tm8_app connection — i.e. already having the
-- database.
create or replace function public.node_account_count() returns integer
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select count(*)::integer from public.accounts
$$;

revoke all on function public.node_account_count() from public;
grant execute on function public.node_account_count() to tm8_app;

reset role;
