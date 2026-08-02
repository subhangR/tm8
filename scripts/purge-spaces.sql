-- Hard-purge two Spaces from a tm8 database.
--
-- tm8 has no `spaces.delete` operation, so this is raw SQL. It works around
-- three substrate obstacles, in this order:
--   1. guard_w1_edge refuses cascade DELETE of recorder-owned edge types
--      (selected_profile, authored_from, ...) unless the transaction claims
--      the `forward_compensation` writer token.
--   2. guard_w1_edge refuses to drop the last participant of a *live* work
--      session, so any stale `running` session is retired first through
--      public.work_session_transition (its status has a single writer).
--   3. capture_workspace_event inserts into space_event_seq, which FKs to
--      spaces — so a plain `delete from spaces` fails 23503 mid-cascade.
--      Every event-capturing and NO-ACTION-referencing child is therefore
--      deleted explicitly while the space row still exists; the space row
--      goes last, when nothing left cascading captures an event.
\set ON_ERROR_STOP on

begin;
set local statement_timeout = '300s';
select set_config('tm8.identity_id', :'identity', true);

-- (2) retire the stale `running` work session
select public.work_session_transition(id::uuid, 'exited', 0, null, null,
                                      'space-purge-' || left(id::text, 8))
  from (select ws.entity_id as id
          from public.work_sessions ws
          join public.entities e on e.id = ws.entity_id
         where e.space_id in (:'space_a', :'space_b')
           and ws.status in ('spawning', 'running', 'idle')) live;

-- spaces.default_channel_id / default_interaction_profile_id RESTRICT the
-- entities they point at, and guard_space_settings owns both columns.
select internal.w1_set_writer('space_settings');
update public.spaces
   set default_channel_id = null, default_interaction_profile_id = null
 where id in (:'space_a', :'space_b')
   and (default_channel_id is not null or default_interaction_profile_id is not null);

-- (1) claim the writer token that exempts recorder-owned edge deletes
select internal.w1_set_writer('forward_compensation');

-- (3) children first, space row last

delete from public.messages m using public.entities e
 where e.id = m.entity_id and e.space_id in (:'space_a', :'space_b');
delete from public.edges              where space_id        in (:'space_a', :'space_b');
delete from public.point_events       where space_id        in (:'space_a', :'space_b');
delete from public.attention_requests where space_id        in (:'space_a', :'space_b');
-- artifact_bundle_revisions is never deleted directly: its append-only trigger
-- fires only at pg_trigger_depth() = 0, so a direct delete is refused while the
-- cascade from entities(artifact_entity_id) is allowed. Dropping the artifact
-- entities in their own statement clears the revisions before the sweep below,
-- whose published_by (NO ACTION) would otherwise still be referenced.
delete from public.entities
 where space_id in (:'space_a', :'space_b') and kind = 'artifact';
delete from public.session_handoffs   where source_space_id in (:'space_a', :'space_b');
delete from public.work_session_interaction_pins p using public.entities e
 where e.id = p.work_session_id and e.space_id in (:'space_a', :'space_b');
delete from public.file_upload_slots  where space_id        in (:'space_a', :'space_b');
delete from public.notifications      where space_id        in (:'space_a', :'space_b');
delete from public.activity           where space_id        in (:'space_a', :'space_b');
delete from public.entities           where space_id        in (:'space_a', :'space_b');
-- space_projects has an AFTER-DELETE audit trigger that writes a workspace
-- event, so it too must go while the space row is still present.
delete from public.project_links      where space_id        in (:'space_a', :'space_b');
delete from public.space_projects     where space_id        in (:'space_a', :'space_b');

delete from public.spaces             where id              in (:'space_a', :'space_b');

select count(*) as spaces_remaining_of_the_two
  from public.spaces where id in (:'space_a', :'space_b');

-- commit is deliberately NOT here: run with `-c 'commit'` appended, or edit.
