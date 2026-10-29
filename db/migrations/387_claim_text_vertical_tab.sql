-- =============================================================================
-- 387 — E'\v' IS NOT A POSTGRESQL ESCAPE: three trims stripped the letter v.
--
-- PostgreSQL's E'' strings know \b \f \n \r \t, octal, \x, \u and \U. Any other
-- backslash pair is the character itself, so E'\v' is the letter v
-- (`select E'\v' = 'v'` is true). Three functions spelled the ASCII whitespace
-- set as E' \t\n\r\f\v', so btrim stripped a leading or trailing 'v' and never
-- a real vertical tab:
--
--   internal.claim_text         037  every session claim, tm8.identity_id
--                                     among them
--   public.rename_work_session  085  a title 'v2 rev' was stored as '2 re'
--   internal.header_text        223  selection-header text lost edge v's
--
-- What that broke: an identity whose id begins or ends with 'v' is a member of
-- no space (is_space_member compares members.identity_id with the trimmed
-- claim), and one whose trimmed form is another identity's id reads as that
-- identity. Ids minted by the server ('id_' + base64url of 16 bytes) can start
-- or end with neither, so it surfaced through a test fixture: Tools PR-F's
-- 'versions-owner' arrived as 'ersions-owner'. The tab-only title 085 refuses
-- was refused for \t but stored for a lone vertical tab.
--
-- THE FIX IS THE LITERAL AND NOTHING ELSE. \x0B is the vertical tab. Each body
-- below is the live definition on origin/main (the latest definer of each is
-- still 037, 085 and 223; pg_get_functiondef at ebd3fe23c) with only that
-- literal replaced. CREATE OR REPLACE keeps the owner, the grants and the
-- comment; each statement restates the rest verbatim, under the role its
-- author used (037 and 223 as tm8_graph_owner, 085 as the migration user).
--
-- Rollback (by hand, restores the bug): db/rollback/387_claim_text_vertical_tab.down.sql
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.claim_text(claim_name text)
returns text language plpgsql stable as $$
declare v text;
begin
  -- btrim with an EXPLICIT character set: the single-argument form strips only
  -- spaces, which let a tab-only or newline-only claim through as a non-null
  -- identity.
  v := nullif(btrim(coalesce(current_setting(claim_name, true), ''), E' \t\n\r\f\x0B'), '');
  return v;
exception when others then
  return null;
end
$$;

-- Header text as stored: trimmed of whitespace; blank is NULL.
create or replace function internal.header_text(p_text text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select nullif(btrim(p_text, E' \t\r\n\f\x0B'), '')
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
  clean := nullif(btrim(p_title, E' \t\r\n\f\x0B'), '');
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

set role tm8_graph_owner;

-- VERIFY at apply time: the letter survives, a real vertical tab does not, and
-- no function in public or internal still trims with the letter v.
do $verify$
declare
  leftover text;
begin
  perform set_config('migration_387.probe', ' vov ', true);
  if internal.claim_text('migration_387.probe') is distinct from 'vov' then
    raise exception '387: internal.claim_text still strips the letter v (got %)',
      quote_nullable(internal.claim_text('migration_387.probe'));
  end if;
  perform set_config('migration_387.probe', E'\x0B\t\x0B', true);
  if internal.claim_text('migration_387.probe') is not null then
    raise exception '387: internal.claim_text kept a claim of only vertical tabs';
  end if;
  if internal.header_text(E'\x0Bvov\x0B') is distinct from 'vov' then
    raise exception '387: internal.header_text mistrims (got %)',
      quote_nullable(internal.header_text(E'\x0Bvov\x0B'));
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into leftover
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'internal')
     and strpos(p.prosrc, E'\\f\\v') > 0;
  if leftover is not null then
    raise exception '387: still trimming with the letter v: %', leftover;
  end if;
end
$verify$;

reset role;
