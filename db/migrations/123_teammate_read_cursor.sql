-- 123 — give an acting Teammate its own per-anchor read cursor.
--
-- `read_marks` remains exclusively human Member state. Teammates persist in a
-- separate table so an agent read never clears its owner's unread state. This
-- is the narrow as-of-now fix: it does not add a read-through message binding
-- or change the frozen operation contract.

set role tm8_graph_owner;

create table public.teammate_read_marks (
  team_member_id uuid not null references public.team_members(entity_id) on delete cascade,
  anchor_id uuid not null references public.entities(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (team_member_id, anchor_id)
);

create index teammate_read_marks_anchor_idx
  on public.teammate_read_marks(anchor_id);

create or replace function public.mark_read(
  p_anchor_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  anchor_row public.entities;
  selected_member_id uuid;
  selected_actor_id uuid := internal.actor_id();
  marked_at timestamptz := clock_timestamp();
  persisted_at timestamptz;
  teammate_cursor boolean;
  replay jsonb;
  ledger_identity text;
  ledger_actor uuid;
  result jsonb;
begin
  perform internal.require_identity();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;

  anchor_row := internal.live_entity(p_anchor_id);
  if not internal.entity_readable(p_anchor_id) then
    raise exception 'anchor not found' using errcode = 'P0002';
  end if;
  selected_member_id := internal.current_member_id(anchor_row.space_id);
  if selected_member_id is null then
    raise exception 'anchor not found' using errcode = 'P0002';
  end if;
  teammate_cursor := selected_actor_id is not null
    and selected_actor_id <> selected_member_id;
  if teammate_cursor and not internal.can_act_as(selected_actor_id, anchor_row.space_id) then
    raise exception 'anchor not found' using errcode = 'P0002';
  end if;

  select identity_id, actor_id into ledger_identity, ledger_actor
    from public.command_ledger where client_mutation_id = p_client_mutation_id;
  if found and (ledger_identity is distinct from internal.identity_id()
      or ledger_actor is distinct from selected_actor_id) then
    raise exception 'clientMutationId belongs to another principal' using errcode = '23514';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'readMarks.upsert');
  if replay is not null then
    if replay->>'anchorId' is distinct from p_anchor_id::text then
      raise exception 'clientMutationId belongs to another read anchor' using errcode = '23514';
    end if;
    return replay;
  end if;

  if teammate_cursor then
    insert into public.teammate_read_marks(team_member_id, anchor_id, last_read_at)
    values (selected_actor_id, p_anchor_id, marked_at)
    on conflict (team_member_id, anchor_id) do update
      set last_read_at = greatest(teammate_read_marks.last_read_at, excluded.last_read_at)
    returning last_read_at into persisted_at;
  else
    insert into public.read_marks(member_id, anchor_id, last_read_at)
    values (selected_member_id, p_anchor_id, marked_at)
    on conflict (member_id, anchor_id) do update
      set last_read_at = greatest(read_marks.last_read_at, excluded.last_read_at)
    returning last_read_at into persisted_at;

    update public.notifications notification_row
       set read_at = coalesce(notification_row.read_at, persisted_at)
     where notification_row.recipient_member_id = selected_member_id
       and notification_row.recipient_team_member_id is null
       and notification_row.target_entity_id = p_anchor_id
       and notification_row.read_at is null;
  end if;

  result := jsonb_build_object(
    'anchorId', p_anchor_id,
    'lastReadAt', persisted_at,
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'readMarks.upsert', result);
end
$$;

revoke all on function public.mark_read(uuid, text) from public;
grant execute on function public.mark_read(uuid, text) to tm8_app;

reset role;
