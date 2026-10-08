-- Seen is permanent, personal, and recorded only by a list activation.
-- Existing entities start seen at rollout; a new membership starts from its
-- join time. Neither opening a detail nor advancing a message cursor writes
-- this state. A baseline avoids one marker per historical entity/member pair.
set role tm8_graph_owner;

alter table public.members
  add column entities_seen_since timestamptz not null default now();

create table public.entity_seen (
  member_id uuid not null references public.members(entity_id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  seen_at timestamptz not null default clock_timestamp(),
  primary key (member_id, entity_id)
);
alter table public.entity_seen enable row level security;
create policy entity_seen_select on public.entity_seen for select to tm8_app
  using (member_id in (
    select m.entity_id from public.members m
     where m.identity_id = internal.identity_id()
       and m.status = 'active' and internal.is_space_member(m.space_id)
  ));
grant select on public.entity_seen to tm8_app;

create or replace function public.mark_entity_seen(p_entity_id uuid, p_client_mutation_id text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  entity_row public.entities;
  selected_member_id uuid;
  selected_actor_id uuid := internal.actor_id();
  stamped_at timestamptz;
  replay jsonb;
  result jsonb;
  ledger_identity text;
  ledger_actor uuid;
begin
  perform internal.require_human_auth_kind();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  entity_row := internal.live_entity(p_entity_id);
  if not internal.entity_readable(p_entity_id) then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  selected_member_id := internal.current_member_id(entity_row.space_id);
  if selected_member_id is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  if selected_actor_id is not null and selected_actor_id <> selected_member_id then
    raise exception 'seen state belongs to the signed-in member' using errcode = '42501';
  end if;
  select l.identity_id, l.actor_id into ledger_identity, ledger_actor
    from public.command_ledger l where l.client_mutation_id = p_client_mutation_id;
  if found and (ledger_identity is distinct from internal.identity_id()
    or ledger_actor is distinct from selected_actor_id) then
    raise exception 'clientMutationId belongs to another principal' using errcode = '23514';
  end if;
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.markSeen');
  if replay is not null then
    if replay->>'entityId' is distinct from p_entity_id::text then
      raise exception 'clientMutationId belongs to another entity' using errcode = '23514';
    end if;
    return replay;
  end if;

  insert into public.entity_seen as s (member_id, entity_id)
  values (selected_member_id, p_entity_id)
  on conflict on constraint entity_seen_pkey do nothing
  returning s.seen_at into stamped_at;
  if stamped_at is not null then
    -- Private event: other browsers for this member refresh their counts.
    -- No entity update, activity bump, notification, or message-read effect.
    insert into public.workspace_events
      (space_id, seq, event_type, payload, client_mutation_id, recipient_member_id)
    values (entity_row.space_id, internal.next_event_seq(entity_row.space_id), 'entity.seen',
      jsonb_build_object('type', 'entity.seen', 'entityId', p_entity_id,
        'seenAt', to_char(stamped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'clientMutationId', p_client_mutation_id),
      p_client_mutation_id, selected_member_id);
  else
    select s.seen_at into stamped_at from public.entity_seen s
     where s.member_id = selected_member_id and s.entity_id = p_entity_id;
  end if;
  result := jsonb_build_object('entityId', p_entity_id, 'seenAt', to_char(stamped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  return internal.ledger_record(p_client_mutation_id, 'entities.markSeen', result);
end
$$;
revoke all on function public.mark_entity_seen(uuid, text) from public;
grant execute on function public.mark_entity_seen(uuid, text) to tm8_app;

-- Use the caller's RLS visibility, including private sessions. Count the full
-- space (children included), independently of list filters and pagination.
create or replace function public.space_kind_counts(p_space_id uuid)
returns table(kind text, total integer, unseen integer)
language sql stable security invoker set search_path = public, internal, pg_temp as $$
  with me as (
    select m.entity_id, m.entities_seen_since from public.members m
     where m.space_id = p_space_id and m.identity_id = internal.identity_id()
       and m.status = 'active' and internal.is_space_member(p_space_id)
  )
  select e.kind, count(*)::integer,
    count(*) filter (where e.created_at > me.entities_seen_since and s.entity_id is null)::integer
  from public.entities e
  cross join me
  left join public.entity_seen s on s.member_id = me.entity_id and s.entity_id = e.id
  where e.space_id = p_space_id and e.deleted_at is null
    and not exists (select 1 from public.work_sessions ws
                    where ws.entity_id = e.id and ws.session_kind = 'credential')
  group by e.kind
$$;
revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;

-- This function is owned by the migration role (208/302).
reset role;

create or replace function internal.event_subject_ids(p_event_type text, p_payload jsonb)
returns uuid[] language sql immutable parallel safe
set search_path = pg_catalog, pg_temp as $$
  select array(
    select distinct candidate::uuid
      from unnest(case
        when p_event_type in ('entity.upsert', 'entity.deleted', 'entity.activity_touched',
                              'session.outcome_changed', 'session.process_changed')
          then array[p_payload ->> 'id']
        when p_event_type in ('edge.upsert', 'edge.deleted', 'edge.ended')
          then array[p_payload ->> 'src_id', p_payload ->> 'dst_id']
        when p_event_type in ('message.created', 'message.updated', 'message.deleted')
          then array[p_payload ->> 'entity_id', p_payload ->> 'anchor_id']
        when p_event_type = 'entity.seen'
          then array[p_payload ->> 'entityId']
        when p_event_type = 'counter.changed'
          then array[p_payload ->> 'entity_id']
        when p_event_type = 'activity.created'
          then array[p_payload ->> 'entity_id']
        when p_event_type in ('notification.created', 'notification.read')
          then array[p_payload ->> 'target_entity_id']
        when p_event_type = 'git.commit_recorded'
          then array[p_payload ->> 'commitEntityId']
        when p_event_type = 'git.pr_state_changed'
          then array[p_payload ->> 'prEntityId']
        when p_event_type = 'git.worktree_status_changed'
          then array[p_payload ->> 'worktreeEntityId']
        else array[]::text[]
      end) as candidate
     where candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1)
$$;

reset role;
