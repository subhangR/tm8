-- =============================================================================
-- ROLLBACK for 381_tool_versions_undebounced.sql — NOT a migration
-- (db/migrate.mjs never reads this directory). Run by hand, as the migration
-- owner, only to undo 381:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/381_tool_versions_undebounced.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '381_tool_versions_undebounced.sql'"
--
-- Tool edits fold again: a same-actor edit inside 5 minutes renumbers the
-- previous snapshot, so a run pinned to it loses its source. Rows 381 already
-- wrote stay. Any later trigger created with 'undebounced' is debounced again
-- once this restores 001's body; check pg_trigger for tgnargs > 0 first.
-- =============================================================================

set role tm8_graph_owner;

drop trigger tools_snapshot on public.tools;
create trigger tools_snapshot after update on public.tools
for each row execute function internal.snapshot_entity_version();

-- 001's body, verbatim.
create or replace function internal.snapshot_entity_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid := internal.actor_id();
  next_version integer;
  latest record;
begin
  -- Nothing changed materially → no version, no snapshot.
  if to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return new;
  end if;

  if actor is null then
    select created_by into actor from public.entities where id = new.entity_id;
  end if;

  select version + 1 into next_version from public.entities where id = new.entity_id for update;

  select entity_id, version, changed_by, changed_at into latest
    from public.entity_versions
   where entity_id = new.entity_id
   order by version desc
   limit 1;

  if latest.entity_id is not null
     and latest.changed_by is not distinct from actor
     and latest.changed_at > now() - internal.version_debounce_window() then
    -- Debounced: fold this edit into the open snapshot. `version` still advances
    -- on the envelope so optimistic concurrency stays honest.
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    update public.entity_versions
       set version = next_version,
           snapshot = internal.entity_snapshot(new.entity_id),
           changed_at = now()
     where entity_id = new.entity_id and version = latest.version;
  else
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    insert into public.entity_versions(entity_id, version, snapshot, changed_by)
    values (new.entity_id, next_version, internal.entity_snapshot(new.entity_id), actor);
  end if;
  return new;
end
$$;

reset role;
