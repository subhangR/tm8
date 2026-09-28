-- 274 (PLACEHOLDER ordinal; the integrator numbers it at composition) — W7b.
--
-- Task 01a0d9fd; F (01a0da94) v4 §3 and decision 38; phases P2 W7b row; plan
-- T23 (explicit-share half) and T33. Stacked on W7 (#884, 258_space_link_invoke):
-- `cross_space_audit` is read below.
--
-- ADDITIVE ONLY. Two new tables, one new core kind, new functions, and
-- redefinitions that copy the latest definer's body and add to it. No existing
-- row is rewritten or deleted.
--
--   1. Kind `remote_ref` (doc 14 §5): an entity in the HOME space A that holds
--      the other side's id AS TEXT, never a real edge. `public.remote_refs` is
--      its detail row, and its entity_content arm allow-lists what it shows.
--   2. `record_remote_ref` — invoke creates one after a create or a spawn in B
--      succeeds, under the caller's own home claims. It needs the caller's own
--      signed-in token row on the link AND the ok `cross_space_audit` row that
--      invoke wrote for that remote id, so a ref cannot be minted for work the
--      member never did through the link. Kind, title and status are read from
--      B's row, never taken from the caller.
--   3. `poll_remote_refs` — the watcher. Node admin (the scheduler's owner
--      claims), no session, no unseal. It reads B's `workspace_events` ONLY for
--      the ids held in `remote_refs`, ONLY where the ref's token row is
--      `signed_in`, through the 205 subject index. It writes with no bound actor
--      (the system actor): `tm8.actor_id` is cleared before every write.
--   4. `internal.is_resolved` gains a `remote_ref` arm: a depends_on on a ref
--      gates on the CACHED `remote_status_category`, like 152's pull_request
--      override, and never on the ref's own envelope status, which a member of A
--      can move by hand. The envelope status is mirrored for display only.
--   5. Spawn in B through a link (decision 38: on by default, per-link switch,
--      budget 3 LIVE spawns per token row). `public.space_link_spawns` holds
--      reservations. `reserve_space_link_spawn` runs under the caller's HOME
--      claims, locks the token row FOR UPDATE and counts live reservations, so
--      concurrent reserves serialize and the 4th is refused. The two spawn-path
--      SQL doors that 256 closed to auth kind `link` — the credential read and
--      the work-session mint — admit a link session ONLY against a reservation
--      of its own token row, and the mint binds the reservation to the new work
--      session atomically. `issue_agent_auth_session` stays closed.
--
-- DEFAULTS (fail-closed, recorded in the PR body):
--   * T33: a spawn may name a folder granted to B and NOT to A. A folder granted
--     to both is refused.
--   * The budget counts invoke spawns (reservations). Descendants of a spawned
--     session are bounded by B's cap and by 256's cascade, not by this budget.
--   * An unbound reservation lives `internal.space_link_spawn_reservation_ttl()`
--     (10 minutes). The mint refuses a work session created before its
--     reservation, so a reservation cannot be spent on a resume.
--   * A deleted remote entity reads as `cancelled`: never `done`, so its gate
--     stays closed.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The kind. APPEND, never a full-array rewrite (052's lesson).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('remote_ref', 'core', null, 'external-link')
on conflict (kind) where space_id is null do nothing;

create table public.remote_refs (
  entity_id               uuid primary key references public.entities(id) on delete cascade,
  home_space_id           uuid not null references public.spaces(id) on delete cascade,
  link_id                 uuid not null references public.space_links(entity_id) on delete cascade,
  token_row_id            uuid not null references public.space_link_tokens(id) on delete cascade,
  -- No FK: a W8 target lives on another server.
  target_space_id         uuid not null,
  -- The other side's id AS TEXT (doc 14 §5): never an edge, never an FK.
  remote_id               text not null check (char_length(remote_id) between 1 and 200),
  remote_kind             text not null check (char_length(remote_kind) between 1 and 80),
  remote_title            text check (remote_title is null or char_length(remote_title) <= 500),
  remote_status_category  text check (remote_status_category is null
    or remote_status_category in ('to_do', 'in_progress', 'done', 'cancelled')),
  -- B's per-space event seq this ref has been read up to.
  last_seen_seq           bigint not null default 0,
  watched_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (token_row_id, remote_id)
);
create index remote_refs_token_row_idx on public.remote_refs(token_row_id, watched_at nulls first);
create index remote_refs_link_idx on public.remote_refs(link_id);

alter table public.remote_refs enable row level security;
-- 218's shape: the entities RLS decides readability once per statement; no
-- per-row membership helper (rls-membership-once-per-statement pins this).
create policy remote_refs_select on public.remote_refs for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = remote_refs.entity_id and readable_entity.deleted_at is null offset 0)));
grant select on public.remote_refs to tm8_app;

comment on table public.remote_refs is
  'W7b (274): the detail row of a remote_ref entity in the home space. Holds B''s '
  'id as text and the watcher''s cached status; no token, no secret. Written only '
  'by record_remote_ref and poll_remote_refs.';

-- A content change is a version (001's snapshot trigger, 103's shape).
create trigger remote_refs_snapshot after update on public.remote_refs
for each row when (
     new.remote_status_category is distinct from old.remote_status_category
  or new.remote_title is distinct from old.remote_title
  or new.remote_kind is distinct from old.remote_kind
) execute function internal.snapshot_entity_version();

-- A ref reaching `done` unblocks its waiters (003's announcement, the same
-- function the task and pull_request triggers call).
create trigger remote_refs_announce_unblocked after update of remote_status_category on public.remote_refs
for each row when (new.remote_status_category = 'done' and old.remote_status_category is distinct from 'done')
execute function internal.on_resolution_change();

-- SHARED OBJECT: 266's entities_announce_unblocked, re-created verbatim with
-- `remote_ref` added to its exclusion. Like a pull_request (which 266 already
-- excludes), a remote_ref resolves by its own state -- the watcher's cached
-- category (is_resolved's 274 arm) -- not by entities.status_category, so the
-- trigger above is its one announcing path. Without this the status mirror
-- moving the ref's entity to done announced every waiter a second time.
drop trigger entities_announce_unblocked on public.entities;
create trigger entities_announce_unblocked
after update on public.entities
for each row when (new.status_category = 'done' and old.status_category is distinct from 'done'
                   and new.kind not in ('pull_request', 'remote_ref'))
execute function internal.on_status_category_done();

-- -----------------------------------------------------------------------------
-- 2. Content hydration. SHARED OBJECT: body copied from 261 (W8) verbatim; the
--    `remote_ref` arm is the only addition. An allow-list: the token row id is
--    not shown.
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
      -- 274 (W7b): the other side's id as text and the watcher's cached status.
      when 'remote_ref' then select jsonb_build_object(
                                 'link_id', r.link_id, 'target_space_id', r.target_space_id,
                                 'remote_id', r.remote_id, 'remote_kind', r.remote_kind,
                                 'title', r.remote_title,
                                 'remote_status_category', r.remote_status_category,
                                 'watched_at', r.watched_at)
                               into content from public.remote_refs r where r.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. is_resolved — 152's body plus the `remote_ref` arm (a second kind-behaviour
--    override, for 152's reason: the state is synced from outside the product
--    and no workflow transition runs when it moves).
-- -----------------------------------------------------------------------------
create or replace function internal.is_resolved(target uuid) returns boolean
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; resolved boolean;
begin
  select * into e from public.entities where id = target;
  if e.id is null or e.deleted_at is not null then
    return false;
  end if;
  -- THE ONE KIND-BEHAVIOUR OVERRIDE. `pull_requests.state` is synced from the
  -- forge (103) and no workflow transition runs when it moves, so the category
  -- would go stale the moment a PR merged outside the product.
  if e.kind = 'pull_request' then
    select p.state = 'merged' into resolved from public.pull_requests p
     where p.entity_id = target;
    return coalesce(resolved, false);
  end if;
  -- 274 (W7b): a remote_ref gates on the watcher's CACHED category only. Its
  -- envelope status is display, and a member of A can move it by hand.
  if e.kind = 'remote_ref' then
    select r.remote_status_category = 'done' into resolved from public.remote_refs r
     where r.entity_id = target;
    return coalesce(resolved, false);
  end if;
  return coalesce(e.status_category = 'done', false);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Helpers.
-- -----------------------------------------------------------------------------

-- THE reservation lifetime (lead ruling E: one named constant). An unbound
-- reservation older than this is not live and does not count.
create or replace function internal.space_link_spawn_reservation_ttl()
returns interval language sql immutable set search_path = public, internal, pg_temp as $$
  select interval '10 minutes'
$$;

-- B's current category for a remote id on this server: the entity's own
-- category, `cancelled` when it is deleted or gone (never `done`, so a gate on
-- it stays closed). Definer-only callers.
create or replace function internal.remote_ref_snapshot(p_target_space uuid, p_remote_id text,
  out kind text, out title text, out category text, out present boolean)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; c jsonb;
begin
  present := false;
  if p_remote_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return;
  end if;
  select * into e from public.entities where id = p_remote_id::uuid and space_id = p_target_space;
  if e.id is null then
    return;
  end if;
  present := true;
  kind := e.kind;
  c := internal.entity_content(e.id);
  title := left(coalesce(c ->> 'title', c ->> 'name'), 500);
  category := case when e.deleted_at is not null then 'cancelled'
                   else coalesce(e.status_category, 'to_do') end;
end
$$;
revoke all on function internal.remote_ref_snapshot(uuid, text) from public;

-- The envelope status follows the cache, for display. A transition the ref's
-- workflow refuses (23514) leaves the envelope where it is; the gate reads the
-- cache (§3), so nothing depends on this succeeding.
create or replace function internal.mirror_remote_ref_status(p_ref uuid, p_category text)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; state uuid;
begin
  select * into e from public.entities where id = p_ref;
  if e.id is null or p_category is null then return; end if;
  state := internal.find_workflow_state_for_category(
             internal.workflow_for_entity(e.space_id, 'remote_ref', null), p_category);
  if state is null or state is not distinct from e.status_id then return; end if;
  begin
    update public.entities set status_id = state, updated_at = now() where id = p_ref;
  exception when check_violation then
    null;
  end;
end
$$;
revoke all on function internal.mirror_remote_ref_status(uuid, text) from public;

-- The caller's own token row on `p_link_id` in `p_home_space_id`, locked.
-- Human and agent kinds only; a link session or anything minted under one is
-- refused (the loop guard, lead ruling B).
create or replace function internal.own_space_link_row(p_home_space_id uuid, p_link_id uuid)
returns public.space_link_tokens language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare me uuid; row public.space_link_tokens;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent')
     or internal.link_bound() then
    raise exception 'this session kind cannot use a space link' using errcode = '42501';
  end if;
  me := internal.current_member_id(p_home_space_id);
  if me is null or p_link_id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select t.* into row from public.space_link_tokens t
    join public.entities le on le.id = t.link_id and le.deleted_at is null
   where t.link_id = p_link_id and t.member_id = me and t.home_space_id = p_home_space_id
   for update of t;
  if row.id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  return row;
end
$$;
revoke all on function internal.own_space_link_row(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- 5. record_remote_ref — invoke's create/spawn follow-up, under home claims.
-- -----------------------------------------------------------------------------
create or replace function public.record_remote_ref(
  p_home_space_id uuid,
  p_link_id uuid,
  p_remote_id text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  me uuid;
  snap record;
  ref public.remote_refs;
  v_id uuid;
  v_seq bigint;
begin
  row := internal.own_space_link_row(p_home_space_id, p_link_id);
  me := row.member_id;
  perform internal.bind_actor(me);
  if row.status <> 'signed_in' then
    raise exception 'the space link is not signed in' using errcode = '42501',
      detail = jsonb_build_object('reason', 'link_not_signed_in')::text;
  end if;

  select * into ref from public.remote_refs where token_row_id = row.id and remote_id = p_remote_id;
  if ref.entity_id is not null then
    return jsonb_build_object('id', ref.entity_id, 'remoteId', ref.remote_id, 'created', false);
  end if;

  -- The work was done through this link, by this member, and it created something.
  if not exists (
    select 1 from public.cross_space_audit a
     where a.link_id = p_link_id and a.member_id = me and a.home_space_id = p_home_space_id
       and a.result = 'ok' and a.remote_id = p_remote_id
       and (a.op = 'execution.spawn' or a.op ~ '^[a-z0-9_.]+\.create$')
  ) then
    raise exception 'no create or spawn through this link produced that id' using errcode = '42501',
      detail = jsonb_build_object('reason', 'remote_ref_unaudited')::text;
  end if;

  -- Same server only (W8 is the follow-up): B's row is the truth for kind, title and status.
  select * into snap from internal.remote_ref_snapshot(row.target_space_id, p_remote_id);
  if not snap.present then
    raise exception 'remote entity not found' using errcode = 'P0002';
  end if;
  select coalesce(q.last_seq, 0) into v_seq from public.space_event_seq q where q.space_id = row.target_space_id;

  v_id := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (v_id, p_home_space_id, 'remote_ref', null, null, me, 'space');
  insert into public.remote_refs(entity_id, home_space_id, link_id, token_row_id, target_space_id,
                                 remote_id, remote_kind, remote_title, remote_status_category,
                                 last_seen_seq, watched_at)
  values (v_id, p_home_space_id, p_link_id, row.id, row.target_space_id,
          p_remote_id, snap.kind, snap.title, snap.category, coalesce(v_seq, 0), now());
  perform internal.record_initial_version(v_id, me);
  perform internal.record_activity(p_home_space_id, v_id, me, 'created', null,
            jsonb_build_object('kind', 'remote_ref'));
  perform internal.mirror_remote_ref_status(v_id, snap.category);
  return jsonb_build_object('id', v_id, 'remoteId', p_remote_id, 'created', true);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. poll_remote_refs — the watcher. Node admin; no bound actor.
-- -----------------------------------------------------------------------------
create or replace function public.poll_remote_refs(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  r public.remote_refs;
  hit bigint;
  snap record;
  polled integer := 0;
  changed integer := 0;
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  -- The system actor: nothing below is attributed to whoever holds the claims.
  perform internal.bind_actor(null);

  for r in
    select rr.* from public.remote_refs rr
      join public.space_link_tokens t on t.id = rr.token_row_id
      join public.entities le on le.id = rr.link_id and le.deleted_at is null
      join public.entities re on re.id = rr.entity_id and re.deleted_at is null
     where t.status = 'signed_in'
     order by rr.watched_at nulls first, rr.entity_id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update of rr skip locked
  loop
    polled := polled + 1;
    hit := null;
    -- ONLY this ref's id, ONLY in its target space, ONLY after its cursor.
    if r.remote_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select max(ev.seq) into hit from public.workspace_events ev
       where ev.space_id = r.target_space_id
         and ev.seq > r.last_seen_seq
         and ev.subject_ids && array[r.remote_id::uuid];
    end if;
    if hit is null then
      update public.remote_refs set watched_at = now() where entity_id = r.entity_id;
      continue;
    end if;
    select * into snap from internal.remote_ref_snapshot(r.target_space_id, r.remote_id);
    update public.remote_refs
       set remote_status_category = case when snap.present then snap.category else 'cancelled' end,
           remote_title = case when snap.present then snap.title else remote_title end,
           last_seen_seq = hit,
           watched_at = now(),
           updated_at = now()
     where entity_id = r.entity_id;
    if (case when snap.present then snap.category else 'cancelled' end) is distinct from r.remote_status_category then
      changed := changed + 1;
      perform internal.mirror_remote_ref_status(r.entity_id,
                case when snap.present then snap.category else 'cancelled' end);
    end if;
  end loop;
  return jsonb_build_object('polled', polled, 'changed', changed);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Spawn reservations.
-- -----------------------------------------------------------------------------
create table public.space_link_spawns (
  id               uuid primary key default internal.new_id(),
  token_row_id     uuid not null references public.space_link_tokens(id) on delete cascade,
  target_space_id  uuid not null,
  project_id       uuid,
  -- No FK: the session is in B and may be deleted; a missing row is not live.
  work_session_id  uuid,
  reserved_at      timestamptz not null default now(),
  bound_at         timestamptz,
  released_at      timestamptz,
  constraint space_link_spawns_bound_shape check ((work_session_id is null) = (bound_at is null))
);
create index space_link_spawns_token_row_idx on public.space_link_spawns(token_row_id)
  where released_at is null;
create unique index space_link_spawns_one_per_session on public.space_link_spawns(work_session_id)
  where work_session_id is not null;

-- Definer-only: no policy, no grant.
alter table public.space_link_spawns enable row level security;

comment on table public.space_link_spawns is
  'W7b (274): one row per spawn through a space link. Live = unreleased and '
  'either unbound within internal.space_link_spawn_reservation_ttl() or bound '
  'to a spawning/running/idle work session. The budget is space_link_tokens.spawn_budget.';

create or replace function internal.space_link_spawn_is_live(s public.space_link_spawns)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  select s.released_at is null and (
    (s.bound_at is null and s.reserved_at > now() - internal.space_link_spawn_reservation_ttl())
    or (s.bound_at is not null and exists (
          select 1 from public.work_sessions ws
            join public.entities e on e.id = ws.entity_id and e.deleted_at is null
           where ws.entity_id = s.work_session_id
             and ws.status in ('spawning', 'running', 'idle'))))
$$;
revoke all on function internal.space_link_spawn_is_live(public.space_link_spawns) from public;

-- Under the caller's HOME claims, before invoke runs the spawn in B.
create or replace function public.reserve_space_link_spawn(
  p_home_space_id uuid,
  p_link_id uuid,
  p_project_id uuid default null,
  p_parent_session_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  live integer;
  v_id uuid;
begin
  -- FOR UPDATE on the token row: concurrent reserves on one row serialize here,
  -- so the count below cannot be read stale by a racing reserve.
  row := internal.own_space_link_row(p_home_space_id, p_link_id);
  if row.status <> 'signed_in' then
    raise exception 'the space link is not signed in' using errcode = '42501',
      detail = jsonb_build_object('reason', 'link_not_signed_in')::text;
  end if;
  if not row.allow_spawn then
    raise exception 'spawning through this space link is switched off' using errcode = '42501',
      detail = jsonb_build_object('reason', 'spawn_off')::text;
  end if;
  -- T33: only B's folders. A folder also granted to the home space is refused
  -- (DEFAULT: fail-closed on a shared folder).
  if p_project_id is not null and (
       not exists (select 1 from public.space_projects sp
                    where sp.space_id = row.target_space_id and sp.project_id = p_project_id)
       or exists (select 1 from public.space_projects sp
                   where sp.space_id = p_home_space_id and sp.project_id = p_project_id)) then
    raise exception 'a spawn through a space link may name only the target space''s projects'
      using errcode = '42501', detail = jsonb_build_object('reason', 'project_not_in_target')::text;
  end if;
  if p_parent_session_id is not null and not exists (
       select 1 from public.entities e
        where e.id = p_parent_session_id and e.kind = 'work_session'
          and e.space_id = row.target_space_id and e.deleted_at is null) then
    raise exception 'a spawn through a space link may name only a parent session in the target space'
      using errcode = '42501', detail = jsonb_build_object('reason', 'parent_not_in_target')::text;
  end if;

  select count(*) into live from public.space_link_spawns s
   where s.token_row_id = row.id and internal.space_link_spawn_is_live(s);
  if live >= row.spawn_budget then
    raise exception 'this space link has % live spawns of its budget of %', live, row.spawn_budget
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'spawn_budget', 'live', live, 'budget', row.spawn_budget)::text;
  end if;

  insert into public.space_link_spawns(token_row_id, target_space_id, project_id)
  values (row.id, row.target_space_id, p_project_id)
  returning id into v_id;
  return jsonb_build_object('reservationId', v_id, 'live', live + 1, 'budget', row.spawn_budget,
                            'targetSpaceId', row.target_space_id);
end
$$;

-- Under the caller's HOME claims: a spawn that failed before its mint gives
-- its reservation back. A bound reservation is released by its session ending.
create or replace function public.release_space_link_spawn(p_home_space_id uuid, p_link_id uuid, p_reservation_id uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare row public.space_link_tokens; n integer;
begin
  row := internal.own_space_link_row(p_home_space_id, p_link_id);
  update public.space_link_spawns set released_at = now()
   where id = p_reservation_id and token_row_id = row.id
     and bound_at is null and released_at is null;
  get diagnostics n = row_count;
  return n > 0;
end
$$;

-- The link session's own token row (256's shape: via_link claim + identity),
-- locked, signed in with spawning allowed, targeting `p_space`. EQUIVALENT to
-- W7p's link-bound admission predicate (256/271 read_space_credential_for_spawn,
-- lead ruling B): the same joins and the same six conditions (t.link_id = own
-- via_link claim, m.identity_id = identity_id(), m.status active, link entity
-- not deleted, target = p_space, signed_in, allow_spawn); it differs only in
-- returning the row under FOR UPDATE (the budget's serialisation point) and
-- raising 42501 where W7p's EXISTS is false. Every caller adds a live
-- reservation on top, so each door is ruling B AND a reservation.
create or replace function internal.link_spawn_row(p_space uuid)
returns public.space_link_tokens language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare row public.space_link_tokens;
begin
  select t.* into row
    from public.space_link_tokens t
    join public.members m on m.entity_id = t.member_id
    join public.entities e on e.id = t.link_id
   where t.link_id = internal.claim_text('tm8.via_link')::uuid
     and m.identity_id = internal.identity_id()
     and m.status = 'active'
     and e.deleted_at is null
   for update of t;
  if row.id is null or row.status <> 'signed_in' or not row.allow_spawn
     or row.target_space_id is distinct from p_space then
    raise exception 'a space link session spawns only in its target, while the link is signed in with spawning allowed'
      using errcode = '42501';
  end if;
  return row;
end
$$;
revoke all on function internal.link_spawn_row(uuid) from public;

-- execution.spawn's first statement under a `link` identity (TS layer (iii),
-- replacing 256's flat refusal): the spawn runs only against a live, unbound
-- reservation of this token row, and T33 is re-checked here, at the point of
-- use, whatever invoke was told. Nothing is written; the mint binds.
create or replace function public.admit_space_link_spawn(
  p_space_id uuid,
  p_project_id uuid default null,
  p_parent_session_id uuid default null
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare row public.space_link_tokens;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link' then
    raise exception 'only a space link session is admitted here' using errcode = '42501';
  end if;
  row := internal.link_spawn_row(p_space_id);
  if not exists (
    select 1 from public.space_link_spawns s
     where s.token_row_id = row.id and s.target_space_id = p_space_id
       and s.bound_at is null and s.released_at is null
       and s.reserved_at > now() - internal.space_link_spawn_reservation_ttl()
  ) then
    raise exception 'a space link spawn runs only against a reservation made by spaceLinks.invoke'
      using errcode = '42501', detail = jsonb_build_object('reason', 'spawn_unreserved')::text;
  end if;
  if p_project_id is not null and (
       not exists (select 1 from public.space_projects sp
                    where sp.space_id = p_space_id and sp.project_id = p_project_id)
       or exists (select 1 from public.space_projects sp
                   where sp.space_id = row.home_space_id and sp.project_id = p_project_id)) then
    raise exception 'a spawn through a space link may name only the target space''s projects'
      using errcode = '42501', detail = jsonb_build_object('reason', 'project_not_in_target')::text;
  end if;
  if p_parent_session_id is not null and not exists (
       select 1 from public.entities e
        where e.id = p_parent_session_id and e.kind = 'work_session'
          and e.space_id = p_space_id and e.deleted_at is null) then
    raise exception 'a spawn through a space link may name only a parent session in the target space'
      using errcode = '42501', detail = jsonb_build_object('reason', 'parent_not_in_target')::text;
  end if;
end
$$;

-- The one definition of "this caller holds a live link-spawn reservation for
-- p_space": its OWN token row (W7p's own-row predicate: its own via_link
-- claim, its own active home-space member, the link not deleted) has a
-- reservation into p_space that is unreleased and either unbound within the
-- TTL or bound to a session still spawning. A boolean, stable and lock-free,
-- so a reader can ask it; `internal.link_spawn_row` (locking, raising) stays
-- the budget's door. `p_bound_live` (default false) also admits a reservation
-- bound to a session that is still live (spawning, running or idle: the
-- budget's own `space_link_spawn_is_live`), for a reader the spawn reaches
-- after the PTY exists (the post-spawn usable-ids recheck); the credential
-- read keeps the default. Callers: read_space_credential_for_spawn below, and the
-- W6 a2 readers stacked on this migration (task 01a0e767) — keep the name and
-- signature stable.
create or replace function internal.link_spawn_reservation_live(p_space uuid, p_bound_live boolean default false)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select exists (
    select 1
      from public.space_link_spawns s
      join public.space_link_tokens t on t.id = s.token_row_id
      join public.members m on m.entity_id = t.member_id
      join public.entities e on e.id = t.link_id
      left join public.work_sessions ws on ws.entity_id = s.work_session_id
     where t.link_id = internal.claim_text('tm8.via_link')::uuid
       and m.identity_id = internal.identity_id()
       and m.status = 'active'
       and e.deleted_at is null
       and s.target_space_id = p_space
       and s.released_at is null
       and case when p_bound_live then internal.space_link_spawn_is_live(s)
                else (s.bound_at is null and s.reserved_at > now() - internal.space_link_spawn_reservation_ttl())
                     or ws.status = 'spawning' end
  )
$$;
revoke all on function internal.link_spawn_reservation_live(uuid, boolean) from public;

-- -----------------------------------------------------------------------------
-- 8. read_space_credential_for_spawn — 271's body (the latest definer; gate 8's
--    server-only refusal stays the first statement, for every caller). The
--    link session's flat refusal now admits it only against a live
--    reservation of its own row for this space (unbound within the TTL, or
--    bound to a session still spawning), found by W7p's own-row predicate.
--    W7p's link-bound arm (lead ruling B) then applies unchanged: the default
--    credential only, signed in, spawning allowed. Net: ruling B AND a live
--    reservation. Lead ruling A: never a private credential, restated.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_launcher uuid;
begin
  -- gate 8: a server-only provider is never handed to a launch, for any
  -- caller, pinned or default. Refused before anything is read.
  if internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is a server-only credential and never reaches a session', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'server_only', 'provider', p_provider)::text;
  end if;

  -- W7p (ruling A') as narrowed by W7b: a link session's own claims read a
  -- spawn credential only while a live spawn reservation exists on its OWN
  -- token row for this space (unbound within the TTL, or bound to a session
  -- still spawning). The row is found by exactly W7p's predicate below
  -- (own via_link claim, own active home-space member, link not deleted);
  -- W7p's link-bound arm then still applies unchanged (default credential
  -- only, signed in, spawning allowed). So this can only narrow lead ruling
  -- B: ruling B AND a live reservation.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    if not internal.link_spawn_reservation_live(p_launch_space_id) then
      raise exception 'a space link session cannot read a spawn credential' using errcode = '42501';
    end if;
  end if;
  perform internal.require_space_member(p_launch_space_id);
  v_launcher := internal.current_account_id();

  -- W7p: a link-bound caller gets the target's DEFAULT credential only, and
  -- only while its own row for this link and target is signed in with
  -- spawning allowed. A pinned id, a missing row or a switched-off link: 42501.
  if internal.link_bound() then
    if p_credential_id is not null or not exists (
      select 1
        from public.space_link_tokens t
        join public.members m on m.entity_id = t.member_id
        join public.entities e on e.id = t.link_id
       where t.link_id = internal.claim_text('tm8.via_link')::uuid
         and m.identity_id = internal.identity_id()
         and m.status = 'active'
         and e.deleted_at is null
         and t.target_space_id = p_launch_space_id
         and t.status = 'signed_in'
         and t.allow_spawn
    ) then
      raise exception 'a space link spawn uses only this space''s default credential, while the link is signed in with spawning allowed'
        using errcode = '42501';
    end if;
  end if;

  if p_credential_id is null then
    select * into stored from public.space_credentials
     where space_id = p_launch_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then
      raise exception 'this space has no default % credential', p_provider using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'no_default', 'provider', p_provider)::text;
    end if;
  else
    select * into stored from public.space_credentials
     where id = p_credential_id and space_id = p_launch_space_id;
    if stored.id is null or stored.provider is distinct from p_provider then
      raise exception 'space credential not found in this space' using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'not_found', 'provider', p_provider)::text;
    end if;
    if stored.status <> 'active' then
      raise exception 'space credential "%" is %', stored.label, stored.status using errcode = '23514',
        detail = jsonb_build_object('reason', stored.status, 'provider', p_provider)::text;
    end if;
  end if;

  -- The space default is public by constraint, so this only ever refuses a
  -- pinned id; it is checked for both anyway.
  if not (stored.visibility = 'public' or stored.owner_account_id is null
          or stored.owner_account_id = v_launcher) then
    raise exception 'space credential "%" is private to its owner', stored.label using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;
  -- W7b (lead ruling A): through a link, public or space-owned only — never
  -- the member's own private credential (W10 §3h).
  if internal.link_bound() and not (stored.visibility = 'public' or stored.owner_account_id is null) then
    raise exception 'a space link spawn never uses a private credential' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', stored.display_login,
    'secretCiphertext', case when stored.shape = 'login' then null else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case when stored.shape = 'login' then null else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
revoke all on function public.record_remote_ref(uuid, uuid, text) from public;
grant execute on function public.record_remote_ref(uuid, uuid, text) to tm8_app;
revoke all on function public.poll_remote_refs(integer) from public;
grant execute on function public.poll_remote_refs(integer) to tm8_app;
revoke all on function public.reserve_space_link_spawn(uuid, uuid, uuid, uuid) from public;
grant execute on function public.reserve_space_link_spawn(uuid, uuid, uuid, uuid) to tm8_app;
revoke all on function public.release_space_link_spawn(uuid, uuid, uuid) from public;
grant execute on function public.release_space_link_spawn(uuid, uuid, uuid) to tm8_app;
revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;
revoke all on function public.admit_space_link_spawn(uuid, uuid, uuid) from public;
grant execute on function public.admit_space_link_spawn(uuid, uuid, uuid) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- 8b. W9 R-2: a link-bound AGENT (the reserved spawn, and every descendant —
--     link_provenance_for stamps via_link_id on each one, so the claim carries
--     it) starts nothing: no agent session, no terminal. The one launch under
--     a link is the link session binding its own reservation, so the budget
--     counts every process the link starts; a grandchild is refused rather
--     than budgeted (lead ruling on R-2 (2)).
-- -----------------------------------------------------------------------------
create or replace function internal.refuse_link_bound_agent_launch()
returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link'
     and internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session started through a space link cannot start another session'
      using errcode = '42501', detail = jsonb_build_object('reason', 'link_bound_launch')::text;
  end if;
end
$$;

-- Default (PUBLIC) execute, like internal.link_bound: it reads only claims and
-- holds no privilege, and the definers that call it keep their original owners
-- through `create or replace` (tm8_graph_owner for 256's mints).


-- -----------------------------------------------------------------------------
-- 9. issue_work_session_agent_session — 256's body; the first-statement link
--    refusal now admits a link session that binds a live reservation of its
--    own row to this work session (or re-mints for the session it is bound
--    to). Replaced after `reset role`, like 226 and 256: owned by the
--    migrating role.
-- -----------------------------------------------------------------------------
create or replace function public.issue_work_session_agent_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  account_row public.accounts;
  session_row public.auth_sessions;
  session_space uuid;
  prov record;
  link_row public.space_link_tokens;
  reservation uuid;
begin
  -- W7p mint backstop (deny-by-default ruling): a `link` session mints only
  -- through W7b's reservation, bound below once the session is known.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    select e.space_id into session_space from public.entities e where e.id = p_work_session_id;
    link_row := internal.link_spawn_row(session_space);
  end if;
  perform internal.refuse_link_bound_agent_launch();
  perform internal.require_identity();
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    raise exception 'invalid work-session credential' using errcode = '22023';
  end if;

  select a.* into account_row
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if account_row.id is null then
    raise exception 'active account not found' using errcode = 'P0002';
  end if;

  session_space := null;
  select e.space_id into session_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
    join public.edges relation on relation.src_id = e.id
      and relation.dst_id = p_team_member_id and relation.type = 'relates_to'
   where e.id = p_work_session_id
     and e.deleted_at is null
     and ws.status in ('spawning','running','idle')
   for update of ws;
  if session_space is null then
    raise exception 'live work session/persona relationship not found' using errcode = 'P0002';
  end if;
  if not internal.can_act_as(p_team_member_id, session_space) then
    raise exception 'cannot issue a credential for this session persona' using errcode = '42501';
  end if;

  -- W7b: bind the reservation (or find the one already bound to this session).
  if link_row.id is not null then
    select s.id into reservation from public.space_link_spawns s
     where s.token_row_id = link_row.id and s.work_session_id = p_work_session_id
       and s.released_at is null;
    if reservation is null then
      select s.id into reservation from public.space_link_spawns s
        join public.entities wse on wse.id = p_work_session_id
       where s.token_row_id = link_row.id
         and s.target_space_id = session_space
         and s.bound_at is null and s.released_at is null
         and s.reserved_at > now() - internal.space_link_spawn_reservation_ttl()
         -- A reservation is spent on a NEW session, never on a resume.
         and wse.created_at >= s.reserved_at
       order by s.reserved_at, s.id
       limit 1
       for update of s skip locked;
      if reservation is null then
        raise exception 'a space link session cannot mint an agent session' using errcode = '42501';
      end if;
      update public.space_link_spawns
         set work_session_id = p_work_session_id, bound_at = now()
       where id = reservation;
    end if;
  end if;

  -- W7p: the link this session descends from, before the revoke below.
  select * into prov from internal.link_provenance_for(p_work_session_id);

  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id,
    via_link_id, parent_session_id
  ) values (
    account_row.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, least(p_expires_at, prov.parent_expires_at), session_space,
    prov.via_link_id, prov.parent_session_id
  ) returning * into session_row;

  return to_jsonb(session_row) - 'token_hash';
end
$$;

revoke all on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 10. issue_agent_auth_session — 256's body plus the R-2 refusal of a
--     link-bound agent caller.
-- -----------------------------------------------------------------------------
create or replace function public.issue_agent_auth_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  target_space uuid;
  account public.accounts;
  issued public.auth_sessions;
  prov record;
begin
  -- W7p mint backstop (deny-by-default ruling, Q4): this mint refuses a `link`
  -- session as its first statement, like issue_work_session_agent_session.
  -- 226 resolved the identity in the declare block, which runs before any
  -- statement; it moves below the refusal. #884 admits its invoke by its
  -- marker, and nothing else.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot mint an agent session' using errcode = '42501';
  end if;
  perform internal.refuse_link_bound_agent_launch();
  identity := internal.require_identity();
  if p_expires_at <= now() then
    raise exception 'agent auth session expiry must be in the future' using errcode = '22023';
  end if;

  select e.space_id into target_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null
   for update of ws;
  if target_space is null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;

  if not internal.can_act_as(p_team_member_id, target_space)
     or not exists (
       select 1 from public.edges edge
        where edge.src_id = p_team_member_id
          and edge.dst_id = p_work_session_id
          and edge.type = 'participates_in'
     ) then
    raise exception 'agent credential persona does not participate in this work session'
      using errcode = '42501';
  end if;

  select * into account
    from public.accounts a
   where a.identity_id = identity and a.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  -- W7p: the link this session descends from, before the revoke below.
  select * into prov from internal.link_provenance_for(p_work_session_id);

  -- Serialize on the work_session above, then retire every earlier run token
  -- before inserting the replacement. Plaintext is never persisted here.
  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id
     and kind = 'agent'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id,
    via_link_id, parent_session_id
  ) values (
    account.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, least(p_expires_at, prov.parent_expires_at), target_space,
    prov.via_link_id, prov.parent_session_id
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

revoke all on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 11. start_shell_session — 101's body plus the R-2 link refusal.
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
  -- W9 R-2: a link session and everything started under it open no shell. A
  -- terminal is an unbudgeted process under B's membership; first statement,
  -- ahead of the replay (no link-bound caller can own a replayable row).
  if internal.link_bound() then
    raise exception 'a space link session cannot start a terminal'
      using errcode = '42501', detail = jsonb_build_object('reason', 'link_bound_launch')::text;
  end if;
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
-- 12. A remote_ref's lifecycle is command-owned, like space_link's (251 §10b).
--     A generic delete/restore/move would detach the ref from the link it was
--     recorded under, or (a delete) make the gate read 'cancelled' by hand. The
--     TS gate (RESTRICTED_LIFECYCLE_KINDS) refuses first; this is the SQL lock.
--     A NEW trigger reusing 251's function: 251's WHEN list stays W8's to edit.
--     Adds-only; creating it touches no row. The FK cascade from the link is a
--     DELETE, which this BEFORE UPDATE trigger does not see.
-- -----------------------------------------------------------------------------
create trigger entities_remote_ref_lifecycle_command_owned
before update of deleted_at, parent_id, position, space_id on public.entities
for each row
when (old.kind = 'remote_ref'
      and (new.deleted_at is distinct from old.deleted_at
           or new.parent_id is distinct from old.parent_id
           or new.position is distinct from old.position
           or new.space_id is distinct from old.space_id))
execute function internal.refuse_generic_link_lifecycle();

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.remote_refs;
analyze public.space_link_spawns;
