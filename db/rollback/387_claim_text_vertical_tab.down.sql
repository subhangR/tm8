-- =============================================================================
-- ROLLBACK for 387_claim_text_vertical_tab.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 387:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/387_claim_text_vertical_tab.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '387_claim_text_vertical_tab.sql'"
--
-- RESTORES THE BUG on purpose: these are the 037, 223 and 085 definitions
-- verbatim, so claim_text, header_text and rename_work_session strip a
-- leading/trailing letter v again and keep a vertical tab. No data changes
-- either way.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.claim_text(claim_name text)
returns text language plpgsql stable as $$
declare v text;
begin
  -- btrim with an EXPLICIT character set: the single-argument form strips only
  -- spaces, which let a tab-only or newline-only claim through as a non-null
  -- identity.
  v := nullif(btrim(coalesce(current_setting(claim_name, true), ''), E' \t\n\r\f\v'), '');
  return v;
exception when others then
  return null;
end
$$;

-- Header text as stored: trimmed of whitespace; blank is NULL.
create or replace function internal.header_text(p_text text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select nullif(btrim(p_text, E' \t\r\n\f\v'), '')
$$;

reset role;

create or replace function public.rename_work_session(
  p_entity_id uuid,
  p_expected_version integer,
  p_actor_id uuid default null,
  p_title text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  clean text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD (038).
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;

  -- A blank rename is refused rather than stored. 049 exists because an empty
  -- title read as "Session" through REST and as nothing through the live
  -- projection — the same title disappearing on reload. The door that could
  -- re-create that state is the one that must close it.
  --
  -- THE CHARACTER SET IS SPELLED OUT ON PURPOSE. One-argument btrim() strips
  -- SPACES ONLY, so a title of a tab and a newline survives it non-empty and is
  -- stored — a title that renders as nothing in every client while the door
  -- reports success. Measured, not assumed: the test for this raised
  -- `stored title is now "\t \n"` against the one-argument form.
  clean := nullif(btrim(p_title, E' \t\r\n\f\v'), '');
  if clean is null then
    raise exception 'work session title must not be empty' using errcode = '22023';
  end if;
  -- Named here so the caller gets an invalid_input naming the limit, rather
  -- than 001's check constraint surfacing as an opaque integrity violation.
  if char_length(clean) > 500 then
    raise exception 'work session title must be at most 500 characters'
      using errcode = '22023';
  end if;

  e := internal.live_entity(p_entity_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  update public.work_sessions set title = clean where entity_id = p_entity_id;

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
               jsonb_build_object('kind', 'work_session', 'action', 'renamed')),
             array[p_entity_id]));
end
$$;
