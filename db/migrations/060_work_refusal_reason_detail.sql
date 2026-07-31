-- 060 — the `status=done` refusal carries its machine-readable reason.
--
-- `set_work_state` has always refused `done` with errcode 23514 ("completion
-- goes through complete_task"), and the server's translateDbError spreads a
-- JSON RAISE ... DETAIL into `details`. But the raise never carried one, so
-- clients saw only `details.sqlstate: '23514'` — while the CLI grammar, the
-- CLI renderer and the public G02 pin all promise
-- `details.reason = 'use_complete_command'`. This closes that gap at the
-- designed seam: the DB names the reason, the server merely relays it.
--
-- The function body is otherwise byte-identical to the live definition
-- (037's absent-means-merge version, dumped via pg_get_functiondef).

set role tm8_graph_owner;

create or replace function public.set_work_state(p_task_id uuid, p_status text, p_actor_id uuid default null::uuid, p_started_at timestamp with time zone default null::timestamp with time zone, p_note text default null::text, p_client_mutation_id text default null::text, p_clear_note boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'internal', 'pg_temp'
as $function$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.work');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_status not in ('open','pulled','working','in_review','blocked','cancelled') then
    if p_status = 'done' then
      raise exception 'completion goes through complete_task'
        using errcode = '23514', detail = '{"reason":"use_complete_command"}';
    end if;
    raise exception 'invalid work status: %', p_status using errcode = '22023';
  end if;

  if p_status in ('open','cancelled') then
    delete from public.edges
     where src_id = actor and dst_id = p_task_id and type = 'working_on';
  else
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (e.space_id, actor, p_task_id, 'working_on',
            jsonb_build_object(
              'status', p_status,
              'startedAt', coalesce(p_started_at, now()),
              'note', case when p_clear_note then null else p_note end),
            actor)
    on conflict (src_id, dst_id, type) do update
      -- The merge. `note` is the only field a caller cannot express, so it is
      -- the only one that falls back to the stored value; `edges.props` is the
      -- PRE-UPDATE row. An explicit p_clear_note wins over both.
      set props = jsonb_build_object(
            'status', p_status,
            'startedAt', coalesce(p_started_at, now()),
            'note', case
                      when p_clear_note then null
                      else coalesce(p_note, edges.props->>'note')
                    end),
          updated_at = now()
    returning id into edge_id;
  end if;

  update public.tasks set work_status = p_status, updated_at = now() where entity_id = p_task_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.work',
           internal.command_result(p_task_id, edge_id,
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', edge_id,
               jsonb_build_object('status', p_status)), array[p_task_id]));
end
$function$;

reset role;
