-- =============================================================================
-- 432 — Bridges: an agent session forks its group into a new WhatsApp group.
-- (432: main holds 431; #1481 holds 430.)
--
-- Decision D83 (BRIDGE-ENTITY-DESIGN §8, Subhang 2026-11-01): the session a
-- bridge lands on may make a new group on that bridge's number, bridged to a
-- new session, through `bridges.groups.fork`. It narrows D28's "a human makes
-- groups" for this one door only, behind four guards:
--   1. The number's owner opts in per space: `agent_groups` on the offer
--      (space_credentials), set only by the owner, a human (default off).
--   2. The caller is the agent the source bridge lands on: its target session,
--      or the runtime of its target chat (399's bridge_caller_holder).
--   3. People added come from the source group's roster only (checked by the
--      executor against bridge_participants before anything is made).
--   4. Rate limits: 3 forks per source bridge per hour, 10 per number per day.
-- Every fork is a row here (the audit trail), is announced in the source
-- group, and its new session `follows_up` the forking session (when that is a
-- session; a chat's fork is linked by the new session's bridge provenance).
--
-- WHAT THIS FILE DOES
--   §1  space_credentials.agent_groups, shown on the owner's connection view,
--       and public.set_bridge_offer_agent_groups (the owner, human-only).
--   §2  bridge_group_forks: one row per fork, keyed by (source bridge,
--       client mutation id), so a retry lands on the same fork.
--   §3  The doors: bridge_group_fork_context / _begin (the caller's claims:
--       every guard, then the reservation under the number's lock) and
--       bridge_group_fork_release / _record (the bridges worker). The group
--       and its bridge go through 426's split doors, keyed by the fork's
--       announcement message.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The owner's opt-in.
-- -----------------------------------------------------------------------------
alter table public.space_credentials
  add column agent_groups boolean not null default false,
  add constraint space_credentials_agent_groups_connection_check
    check (shape = 'connection' or not agent_groups);

comment on column public.space_credentials.agent_groups is
  '432 (D83): the connection''s owner lets agent sessions in this space fork '
  'groups into new WhatsApp groups on the number (bridges.groups.fork).';

-- Restated from 421 (its only definition): each offer carries agentGroups.
create or replace function internal.bridge_connection_json(c public.bridge_connections)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', c.id, 'provider', c.provider, 'ownerAccountId', c.owner_account_id, 'label', c.label,
    'externalAccountId', c.external_account_id, 'status', c.status, 'runtimeId', c.runtime_id,
    'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'credentialId', sc.id, 'spaceId', sc.space_id, 'visibility', sc.visibility,
               'status', sc.status, 'createdAt', sc.created_at, 'agentGroups', sc.agent_groups,
               'bridges', (select count(*) from public.bridges b
                            where b.credential_id = sc.id and b.ended_at is null))
             order by sc.created_at, sc.id)
        from public.space_credentials sc
       where sc.bridge_connection_id = c.id and sc.status <> 'revoked'), '[]'::jsonb))
$$;
revoke all on function internal.bridge_connection_json(public.bridge_connections) from public;

-- bridges.connections.offer's agentGroups: the owner (a human) turns agent
-- group forks on or off for one space the number is offered to.
create or replace function public.set_bridge_offer_agent_groups(
  p_connection_id uuid, p_space_id uuid, p_on boolean
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections; cred uuid; was boolean;
begin
  perform internal.require_human_auth_kind();
  conn := internal.bridge_own_connection(p_connection_id);
  if p_on is null then raise exception 'agentGroups is true or false' using errcode = '22023'; end if;
  select id, agent_groups into cred, was from public.space_credentials
   where bridge_connection_id = conn.id and space_id = p_space_id and status <> 'revoked'
   for update;
  if cred is null then
    raise exception 'this connection is not offered to this space' using errcode = 'P0002';
  end if;
  if was is distinct from p_on then
    update public.space_credentials set agent_groups = p_on where id = cred;
    perform internal.record_activity(p_space_id, cred, internal.current_member_id(p_space_id), 'updated', null,
      jsonb_build_object('kind', 'credential', 'op', 'bridges.connections.offer', 'connectionId', conn.id,
                         'agentGroups', p_on));
  end if;
  return jsonb_build_object('credentialId', cred, 'agentGroups', p_on);
end
$$;
revoke all on function public.set_bridge_offer_agent_groups(uuid, uuid, boolean) from public;
grant execute on function public.set_bridge_offer_agent_groups(uuid, uuid, boolean) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. The record (and the audit trail).
-- -----------------------------------------------------------------------------
create table public.bridge_group_forks (
  id                 uuid primary key default gen_random_uuid(),
  from_bridge_id     uuid not null references public.bridges(entity_id) on delete cascade,
  client_mutation_id text not null check (char_length(client_mutation_id) between 1 and 200),
  space_id           uuid not null references public.spaces(id) on delete cascade,
  connection_id      uuid not null references public.bridge_connections(id) on delete cascade,
  -- The forker (a work session, or a chat's runtime) and the member it acts for.
  session_id         uuid not null references public.entities(id) on delete cascade,
  actor_id           uuid references public.entities(id) on delete set null,
  title              text not null check (char_length(btrim(title)) between 1 and 200),
  participants       integer not null check (participants between 1 and 256),
  teammate_id        uuid references public.entities(id) on delete set null,
  -- Filled as the fork goes: its announcement, the group, its bridge and session.
  message_id         uuid references public.messages(entity_id) on delete set null,
  conversation_id    text check (char_length(conversation_id) between 1 and 256),
  bridge_id          uuid references public.bridges(entity_id) on delete set null,
  new_session_id     uuid references public.entities(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (from_bridge_id, client_mutation_id)
);
create index bridge_group_forks_connection_idx on public.bridge_group_forks(connection_id, created_at desc);
create index bridge_group_forks_from_idx on public.bridge_group_forks(from_bridge_id, created_at desc);
-- "Is this bridge a fork, and who forked it": one index probe on the new bridge.
create unique index bridge_group_forks_bridge_idx on public.bridge_group_forks(bridge_id) where bridge_id is not null;
alter table public.bridge_group_forks enable row level security;
-- No policy and no grant: written and read only by the definers below.

comment on table public.bridge_group_forks is
  '432 (D83): every group an agent session forked from a bridged group, who forked it '
  'and what it made; the rate limits count these rows.';

-- -----------------------------------------------------------------------------
-- §3. The doors.
-- -----------------------------------------------------------------------------

-- Every guard but the rate limit, as the caller. Returns the source bridge and
-- the forking session; refuses with nothing written.
create or replace function internal.bridge_group_fork_gate(p_bridge_id uuid, out b public.bridges, out session_id uuid)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; offer public.space_credentials;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  select * into e from public.entities where id = p_bridge_id;
  if b.entity_id is null or e.deleted_at is not null or not internal.entity_readable(p_bridge_id) then
    raise exception 'Bridge is unavailable' using errcode = 'P0002';
  end if;
  -- 399's holder: the caller's work session, else the chat its chat-runtime bearer runs.
  session_id := internal.bridge_caller_holder(b.space_id);
  if session_id is null or session_id <> b.target_id then
    raise exception 'only the session this bridge lands on can fork its group' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_bridge_session')::text;
  end if;
  if b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  if b.paused_at is not null then
    perform internal.bridge_refuse('bridge_paused', 'this bridge is paused: resume it before forking its group');
  end if;
  select * into offer from public.space_credentials where id = b.credential_id;
  if offer.id is null or offer.status <> 'active' or not offer.agent_groups then
    raise exception 'the number''s owner has not let agents make groups in this space (bridge connection offer --agent-groups on)'
      using errcode = '42501', detail = jsonb_build_object('reason', 'agent_groups_off')::text;
  end if;
end
$$;
revoke all on function internal.bridge_group_fork_gate(uuid) from public;

-- What the executor needs before it resolves anyone: the bridge's space and number,
-- the forking session and the member it acts for.
create or replace function public.bridge_group_fork_context(p_bridge_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare g record;
begin
  select * into g from internal.bridge_group_fork_gate(p_bridge_id);
  return jsonb_build_object(
    'bridgeId', (g.b).entity_id, 'spaceId', (g.b).space_id, 'connectionId', (g.b).connection_id,
    'provider', (g.b).provider, 'title', (g.b).conversation ->> 'title',
    'sessionId', g.session_id, 'forkerKind', (g.b).target_kind,
    'memberId', internal.current_member_id((g.b).space_id));
end
$$;
revoke all on function public.bridge_group_fork_context(uuid) from public;
grant execute on function public.bridge_group_fork_context(uuid) to tm8_app;

-- Reserve one fork: the guards again, then the limits under the number's lock.
-- A retry with the same mutation id answers the first row. Over a limit it
-- answers {rateLimited: {retryAfterSeconds}} and writes nothing.
create or replace function public.bridge_group_fork_begin(
  p_bridge_id uuid, p_client_mutation_id text, p_title text, p_participants integer, p_teammate_id uuid
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare g record; f public.bridge_group_forks; oldest timestamptz; retry_at timestamptz;
begin
  select * into g from internal.bridge_group_fork_gate(p_bridge_id);
  select * into f from public.bridge_group_forks
   where from_bridge_id = p_bridge_id and client_mutation_id = p_client_mutation_id;
  if f.id is not null then
    return jsonb_build_object('forkId', f.id, 'messageId', f.message_id, 'replayed', true);
  end if;
  perform 1 from public.bridge_connections where id = (g.b).connection_id for update;
  -- 3 per source bridge per hour.
  select min(created_at) into oldest from (
    select created_at from public.bridge_group_forks
     where from_bridge_id = p_bridge_id and created_at > now() - interval '1 hour'
     order by created_at desc limit 3) r having count(*) >= 3;
  if oldest is not null then retry_at := oldest + interval '1 hour'; end if;
  -- 10 per number per day.
  select min(created_at) into oldest from (
    select created_at from public.bridge_group_forks
     where connection_id = (g.b).connection_id and created_at > now() - interval '1 day'
     order by created_at desc limit 10) r having count(*) >= 10;
  if oldest is not null then retry_at := greatest(retry_at, oldest + interval '1 day'); end if;
  if retry_at is not null then
    return jsonb_build_object('rateLimited', jsonb_build_object(
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from retry_at - now())))::int));
  end if;
  insert into public.bridge_group_forks(from_bridge_id, client_mutation_id, space_id, connection_id,
                                        session_id, actor_id, title, participants, teammate_id)
  values (p_bridge_id, p_client_mutation_id, (g.b).space_id, (g.b).connection_id,
          g.session_id, internal.current_member_id((g.b).space_id), left(btrim(p_title), 200), p_participants, p_teammate_id)
  returning * into f;
  return jsonb_build_object('forkId', f.id, 'messageId', null, 'replayed', false);
end
$$;
revoke all on function public.bridge_group_fork_begin(uuid, text, text, integer, uuid) from public;
grant execute on function public.bridge_group_fork_begin(uuid, text, text, integer, uuid) to tm8_app;

-- WhatsApp made no group: the reservation does not count against the limits.
create or replace function public.bridge_group_fork_release(p_fork_id uuid) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  delete from public.bridge_group_forks where id = p_fork_id and conversation_id is null;
end
$$;
revoke all on function public.bridge_group_fork_release(uuid) from public;
grant execute on function public.bridge_group_fork_release(uuid) to tm8_app;

-- What the fork made so far; null arguments keep what is there.
create or replace function public.bridge_group_fork_record(
  p_fork_id uuid, p_message_id uuid, p_conversation_id text, p_bridge_id uuid, p_new_session_id uuid
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  update public.bridge_group_forks
     set message_id = coalesce(p_message_id, message_id),
         conversation_id = coalesce(p_conversation_id, conversation_id),
         bridge_id = coalesce(p_bridge_id, bridge_id),
         new_session_id = coalesce(p_new_session_id, new_session_id)
   where id = p_fork_id;
end
$$;
revoke all on function public.bridge_group_fork_record(uuid, uuid, text, uuid, uuid) from public;
grant execute on function public.bridge_group_fork_record(uuid, uuid, text, uuid, uuid) to tm8_app;

reset role;

analyze public.bridge_group_forks;
