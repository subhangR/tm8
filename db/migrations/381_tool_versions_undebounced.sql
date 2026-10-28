-- =============================================================================
-- 381 — Every change to a tool is its own stored version: the `tools` snapshot
-- trigger opts out of the 5-minute debounce (Tools v2 PR-F, task 01a183cd).
--
-- Number 381 is RESERVED by the Tools v2 coordinator (378 Loops PR1, 379 Tools
-- PR-C, 380 Tools PR-E, 381 this file, 382/383 Loops PR2/PR3). Nothing here
-- depends on 378-380.
--
-- The hole. A tool run pins `work_sessions.tool_version` (= entities.version at
-- launch, 318 start_tool_session) and `tool_source_sha256`, and the audit
-- promise is that the pinned version resolves to the source that ran
-- (entity_versions.snapshot -> content.definition.source). But 318's
-- `tools_snapshot` ran 001's debounce: a same-actor edit inside
-- `version_debounce_window()` RENUMBERS the latest row to the new version and
-- overwrites its snapshot. Create + two quick edits left one row (v3); runs
-- pinned to v1 and v2 kept a sha256 with no source behind it. Config and secret
-- writes fire the same trigger (they bump `tools.config_revision`), so a config
-- set right after an edit renumbered the definition row a run had just pinned.
--
-- Why the trigger and not the RPC. 055 §12 (artifacts.publish) writes its row
-- from the RPC because `artifacts` has no snapshot trigger. `tools` has one, and
-- every tools.* writer goes through it: update_tool_entity (definition),
-- set_tool_config, create_tool_credential and bind_tool_secret
-- (config_revision). A direct write in update_tool_entity alone would leave the
-- config writers folding into, and renumbering, the definition row. So the
-- generic function takes ONE optional trigger argument, 'undebounced', and
-- `tools_snapshot` is recreated with it: every material change to a tools row
-- bumps entities.version and appends its own entity_versions row in the same
-- statement, which is the `else` branch of 001's function. Still one writer per
-- change (001 §12); no RPC body is copied and no signature changes.
-- tools.create already writes v1 directly (record_initial_version); what lost
-- it was the next edit's fold.
--
-- Config and secret writes are unchanged in kind: they bumped entities.version
-- and wrote a snapshot before (events and optimistic concurrency need the bump)
-- and still do. Their snapshot carries the unchanged definition, so they are
-- not definition versions, and a run launched after one resolves to that row
-- with the right source. They are just no longer folded. execution_version and
-- the 40001 stale check are untouched. Versions written before this migration
-- may already have been folded; their source cannot be recovered.
--
-- SHARED-OBJECT NOTICE: internal.snapshot_entity_version is copied VERBATIM
-- from 001 (its only definition until now; every versioned kind's trigger runs
-- it), plus the argument check and one condition on the debounce branch. A
-- trigger created with no argument behaves exactly as before. Whoever replaces
-- this function next must copy THIS body, or `tools` silently folds again.
-- Rollback: db/rollback/381_tool_versions_undebounced.down.sql.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.snapshot_entity_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid := internal.actor_id();
  next_version integer;
  latest record;
  undebounced boolean;
begin
  -- 381: `execute function internal.snapshot_entity_version('undebounced')`
  -- never folds. Any other argument is a typo that would silently keep the
  -- debounce, so it fails loudly instead.
  undebounced := TG_NARGS = 1 and TG_ARGV[0] = 'undebounced';
  if TG_NARGS > 0 and not undebounced then
    raise exception 'snapshot_entity_version: unknown trigger arguments % on %', TG_ARGV, TG_TABLE_NAME
      using errcode = '22023';
  end if;

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

  if not undebounced
     and latest.entity_id is not null
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

-- Same name, so trigger firing order on public.tools is unchanged.
drop trigger tools_snapshot on public.tools;
create trigger tools_snapshot after update on public.tools
for each row execute function internal.snapshot_entity_version('undebounced');

reset role;
