-- =============================================================================
-- 990 (PLACEHOLDER ORDINAL) — space links, part 3: spaceLinks.invoke's SQL
-- half (plan 01a0d9eb §3 W7; decisions 31, 33, 38).
--
-- The real ordinal and the sweep pin are taken at the merge position; until
-- then this file is 990 on a draft branch only (coordinator, 08:35Z).
--
--   * resolve_space_link_invoke: the caller's OWN token row for a link in the
--     home space, by alias or by link id, WITHOUT the sealed bytes. The row is
--     found through 244's internal.space_link_own_row path (current_member_id
--     on the caller's identity inside the session pin), so an agent resolves
--     its LAUNCHING member's row and nobody else's (T18). Same session-kind
--     allow-list as open_space_link_token: browser, cli, agent.
--   * cross_space_audit: one row per invoke, written in the HOME space for
--     every outcome (ok, refused, error). No token, no input body, no error
--     text from the target: op name, via chain, result, a closed reason and
--     the target-side id.
--   * list_cross_space_audit (spaceLinks.audit): the member's own rows; a
--     home admin sees every member's rows on the link.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The audit table.
-- -----------------------------------------------------------------------------

create table public.cross_space_audit (
  id               uuid primary key default gen_random_uuid(),
  link_id          uuid references public.space_links(entity_id) on delete cascade,
  -- What the caller named when no link resolved (an unknown alias); never a secret.
  link_ref         text not null check (char_length(link_ref) between 1 and 200),
  home_space_id    uuid not null references public.spaces(id) on delete cascade,
  -- No FK: a W8 target lives on another server.
  target_space_id  uuid,
  member_id        uuid not null,
  team_member_id   uuid,
  work_session_id  uuid,
  op               text not null check (char_length(op) between 1 and 200),
  via_chain        uuid[] not null default '{}',
  result           text not null check (result in ('ok', 'refused', 'error')),
  reason           text check (reason is null or reason ~ '^[a-z0-9_.]{1,80}$'),
  remote_id        text check (remote_id is null or char_length(remote_id) <= 200),
  request_id       text,
  created_at       timestamptz not null default now()
);

create index cross_space_audit_link_idx on public.cross_space_audit(link_id, created_at desc, id desc);
create index cross_space_audit_member_idx on public.cross_space_audit(member_id, created_at desc);

-- No tm8_app privilege and no policy: every read and write is an RPC below.
alter table public.cross_space_audit enable row level security;

comment on table public.cross_space_audit is
  'W7 (990): one row per spaceLinks.invoke, in the home space. No token, no input, no remote error text.';

-- -----------------------------------------------------------------------------
-- 2. Resolve the caller's own row (no sealed bytes).
-- -----------------------------------------------------------------------------

create or replace function public.resolve_space_link_invoke(p_home_space_id uuid, p_ref text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  row public.space_link_tokens;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  me := internal.current_member_id(p_home_space_id);
  if me is null or p_ref is null or btrim(p_ref) = '' then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select t.* into row from public.space_link_tokens t
   where t.member_id = me and t.home_space_id = p_home_space_id
     and (t.alias = lower(p_ref)
          or (p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and t.link_id = p_ref::uuid))
   order by (t.alias = lower(p_ref)) desc nulls last
   limit 1;
  if row.id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'linkId', row.link_id,
    'tokenRowId', row.id,
    'memberId', row.member_id,
    'homeSpaceId', row.home_space_id,
    'targetSpaceId', row.target_space_id,
    'status', row.status,
    'allowSpawn', row.allow_spawn,
    'spawnBudget', row.spawn_budget);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Record one invoke. Written by the server under the CALLER's home claims.
-- -----------------------------------------------------------------------------

create or replace function public.record_cross_space_audit(
  p_home_space_id uuid,
  p_link_id uuid,
  p_link_ref text,
  p_target_space_id uuid,
  p_work_session_id uuid,
  p_op text,
  p_via uuid[],
  p_result text,
  p_reason text,
  p_remote_id text
) returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  actor uuid;
  v_id uuid;
begin
  me := internal.current_member_id(p_home_space_id);
  if me is null then
    raise exception 'not a member of the home space' using errcode = '42501';
  end if;
  if p_link_id is not null and not exists (
    select 1 from public.space_links l where l.entity_id = p_link_id and l.home_space_id = p_home_space_id
  ) then
    raise exception 'space link is not in this space' using errcode = '22023';
  end if;
  -- The work session must be the home space's; anything else is dropped, not trusted.
  if p_work_session_id is not null and not exists (
    select 1 from public.entities e
     where e.id = p_work_session_id and e.space_id = p_home_space_id and e.kind = 'work_session'
  ) then
    p_work_session_id := null;
  end if;
  actor := nullif(internal.claim_text('tm8.actor_id'), '')::uuid;
  insert into public.cross_space_audit(
    link_id, link_ref, home_space_id, target_space_id, member_id, team_member_id,
    work_session_id, op, via_chain, result, reason, remote_id, request_id)
  values (
    p_link_id, left(coalesce(p_link_ref, p_link_id::text), 200), p_home_space_id, p_target_space_id,
    me, actor, p_work_session_id, left(p_op, 200), coalesce(p_via, '{}'), p_result, p_reason,
    left(p_remote_id, 200), nullif(current_setting('tm8.request_id', true), ''))
  returning cross_space_audit.id into v_id;
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. spaceLinks.audit: own rows, or every row for a home admin.
-- -----------------------------------------------------------------------------

create or replace function public.list_cross_space_audit(
  p_link_id uuid,
  p_limit integer default 50,
  p_before timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  link public.space_links;
  me uuid;
  admin boolean;
begin
  select * into link from public.space_links where entity_id = p_link_id;
  if link.entity_id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  me := internal.current_member_id(link.home_space_id);
  if me is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  admin := internal.is_space_admin(link.home_space_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'linkId', a.link_id,
      'homeSpaceId', a.home_space_id,
      'targetSpaceId', a.target_space_id,
      'memberId', a.member_id,
      'teamMemberId', a.team_member_id,
      'workSessionId', a.work_session_id,
      'op', a.op,
      'viaChain', to_jsonb(a.via_chain),
      'result', a.result,
      'reason', a.reason,
      'remoteId', a.remote_id,
      'requestId', a.request_id,
      'createdAt', a.created_at) order by a.created_at desc, a.id desc)
    from (
      select * from public.cross_space_audit a
       where a.link_id = p_link_id
         and (admin or a.member_id = me)
         and (p_before is null or a.created_at < p_before)
       order by a.created_at desc, a.id desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) a), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on public.cross_space_audit from public, tm8_app;

revoke all on function public.resolve_space_link_invoke(uuid, text) from public;
grant execute on function public.resolve_space_link_invoke(uuid, text) to tm8_app;
revoke all on function public.record_cross_space_audit(uuid, uuid, text, uuid, uuid, text, uuid[], text, text, text) from public;
grant execute on function public.record_cross_space_audit(uuid, uuid, text, uuid, uuid, text, uuid[], text, text, text) to tm8_app;
revoke all on function public.list_cross_space_audit(uuid, integer, timestamptz) from public;
grant execute on function public.list_cross_space_audit(uuid, integer, timestamptz) to tm8_app;

reset role;

analyze public.cross_space_audit;
