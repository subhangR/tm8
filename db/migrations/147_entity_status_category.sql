-- =============================================================================
-- 147  CATEGORY ON THE ENVELOPE: entities.status_category + entities.status_id.
--
-- Phase 1 of "Kind, Status, Category, Workflow". Phase 0 (the projector's
-- fail-loud narrowing) is merged; this file is what it was gating.
--
-- THESE ARE THE FIRST COLUMNS ADDED TO `public.entities` SINCE 001. That is
-- worth saying out loud: `deleted_at` has been the envelope's only disposition
-- for the whole life of the schema, and every list, tab and rollup in the
-- product has had to reach into a DETAIL table to ask "is this finished?".
-- Only `task` has a detail table that can answer, which is why twenty kinds
-- render a "Done" tab over a field that does not exist, and why the same seven
-- task statuses are bucketed six incompatible ways in six different places.
--
-- ## The model, in four lines
--
--   status     — the entity's position in its workflow. OPEN, user-defined
--                later, lives in `entities.status_id`.
--   category   — one of exactly FOUR, closed forever, denormalized onto the
--                envelope as `entities.status_category`.
--   archived   — `deleted_at`. ORTHOGONAL. Never a status, never a category.
--   invariant  — nothing outside a workflow branches on a status NAME.
--
-- Categories are closed so that renaming `in_review` to "Awaiting Sign-off"
-- breaks nothing, and inventing `Triaging` lands somewhere the product already
-- understands. That bargain is the reason for the CHECK constraint below: the
-- closed set has to be closed somewhere that a future migration cannot widen
-- by accident.
--
-- ## What this file does NOT do (later phases, deliberately)
--
--   * No `workflows` / `workflow_states` / `workflow_transitions` tables — 2.
--     Hence `status_id` has NO foreign key yet: there is nothing to reference.
--   * `create_task` / `execution_spawn` / `complete_task` still write status
--     literals without consulting a workflow — 3.
--   * The twenty non-task kinds still have no status, so their
--     `status_category` stays NULL — 5. That NULL is load-bearing (see below).
--   * `tasks.work_status` is NOT retired and NOT constrained differently.
--     Every existing space keeps all seven statuses as named states and merely
--     GAINS categories. Nobody's board changes shape on migration day.
--
-- ## Why NULL is the right value for a kind with no status
--
-- The server's filter predicate is `status_category = any(...)`, and NULL is
-- never equal to anything — so the mere PRESENCE of a category filter narrows
-- a page to entities that have a status, with no `kind` clause needed and no
-- doc silently filed under "To Do". It is the same kind-narrowing the existing
-- `workStatus` and `priority` filters get from their NULL detail columns, and
-- the read path reports it honestly by OMITTING `EntitySummary.category`
-- rather than defaulting it.
--
-- ## The ruled mapping, and the two judgement calls
--
--   open       -> to_do          pulled     -> to_do
--   working    -> in_progress    in_review  -> in_progress
--   blocked    -> in_progress    done       -> done
--   cancelled  -> cancelled
--
-- `pulled -> to_do` and `blocked -> in_progress` are owner decisions, not
-- derivations: a CLAIMED task has not been started, and a BLOCKED task has
-- been started and is stuck. Both were ruled explicitly (2026-08-18 addendum,
-- §3.1) because they are visible to every user on migration day.
--
-- `cancelled` is its own category rather than a flavour of `done`. Abandoned
-- work and finished work are the same thing only to a progress bar.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- The columns.
-- -----------------------------------------------------------------------------
alter table public.entities
  add column status_id       uuid,
  add column status_category text;

-- The closed four, closed in the schema. A category is not "a string we have
-- not seen yet" the way a status will be — the whole design trades open
-- statuses for closed categories, and a constraint is what makes the second
-- half of that trade real rather than a convention. The server narrows the same
-- four and RAISES on anything else (`facade/status.ts`), so the two halves
-- agree about what impossible means.
alter table public.entities
  add constraint entities_status_category_check
  check (status_category is null
         or status_category in ('to_do', 'in_progress', 'done', 'cancelled'));

-- THE busiest predicate in the product, once the four category tabs ship:
-- every list, every board column, every rollup. Partial on `deleted_at is
-- null` because archived rows are excluded by default on every one of those
-- reads (a tombstone is a graph-shape record, not a list row), so indexing
-- them would pay for tuples no category query ever wants.
create index entities_space_status_category_idx
  on public.entities(space_id, status_category)
  where deleted_at is null;

comment on column public.entities.status_id is
  'The entity''s position in its kind''s workflow — a public.workflow_states row. '
  'NULL for every row until phase 2 creates that table; NO foreign key yet, '
  'because there is nothing to reference. Statuses are OPEN and become '
  'user-defined; nothing outside a workflow may branch on a status name.';

comment on column public.entities.status_category is
  'One of to_do / in_progress / done / cancelled — CLOSED FOREVER, and the only '
  'status concept anything outside a workflow may read. Denormalized from the '
  'status so the tab/filter predicate lives on the envelope. NULL means the '
  'entity has NO status (every non-task kind, in this phase) — it does NOT mean '
  'to_do. ARCHIVED IS NOT HERE: that is deleted_at, an orthogonal axis an entity '
  'keeps across a status.';

-- -----------------------------------------------------------------------------
-- The mapping, as ONE function.
--
-- Mirrored in TypeScript by `WORK_STATUS_CATEGORY` in
-- packages/server/src/facade/status.ts — but THIS is the writer. The server
-- reads the column; it never computes it. One writer is what keeps the
-- backfill below and the trigger below it from being able to disagree.
--
-- No `else` arm on purpose. `tasks.work_status` carries a DDL CHECK naming
-- exactly these seven, so an eighth cannot exist without a migration; if one
-- ever does, this function returns NULL and the entity reports "no status"
-- rather than being quietly filed under a bucket nobody chose. That is the
-- same refusal-to-guess the projector's WorkStatusDriftError makes on the
-- read side.
-- -----------------------------------------------------------------------------
create or replace function internal.work_status_category(status text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select case status
    when 'open'      then 'to_do'
    when 'pulled'    then 'to_do'
    when 'working'   then 'in_progress'
    when 'in_review' then 'in_progress'
    when 'blocked'   then 'in_progress'
    when 'done'      then 'done'
    when 'cancelled' then 'cancelled'
  end
$$;

comment on function internal.work_status_category(text) is
  'The RULED work_status -> status_category mapping (2026-08-18 addendum §3.1). '
  'pulled -> to_do (claimed is not started); blocked -> in_progress (started, '
  'and stuck is not un-started). Returns NULL for an unknown status rather than '
  'guessing a bucket.';

-- -----------------------------------------------------------------------------
-- Keeping the column true.
--
-- A denormalized column that is only ever backfilled is a column that is a lie
-- by the end of the day: every task created after this migration would carry a
-- NULL category, and every status change would leave a stale one. The server's
-- category predicate reads this column, so "backfill and move on" would ship a
-- filter that is wrong about every task touched since deploy.
--
-- So: a maintenance trigger, and it is TRANSITIONAL. Phase 3 makes the three
-- doors (`create_task`, `execution_spawn`, `complete_task`) write `status_id`
-- and `status_category` through a workflow, and this trigger is what they
-- replace. Until then it is the only writer, which is exactly the property
-- that makes it safe to delete later: nothing else has an opinion.
--
-- `is distinct from` in the WHERE is not an optimization, it is the event
-- posture: `open -> pulled` changes the status but NOT the category, and a
-- zero-row UPDATE emits no `entity.upsert`. Only a real category change moves
-- a row between tabs, and only a real category change tells the socket so.
--
-- Firing order is alphabetical among AFTER triggers on `public.tasks`:
-- `tasks_announce_unblocked` < `tasks_category` < `tasks_snapshot_version`.
-- So the category is already written when `snapshot_entity_version` bumps
-- `entities.version` and emits the final event of the change — the last event
-- a client sees for a status edit carries both the new version AND the new
-- category, in that one row.
-- -----------------------------------------------------------------------------
create or replace function internal.sync_entity_status_category() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  category text := internal.work_status_category(new.work_status);
begin
  update public.entities
     set status_category = category
   where id = new.entity_id
     and status_category is distinct from category;
  return new;
end
$$;

create trigger tasks_category
after insert or update of work_status on public.tasks
for each row execute function internal.sync_entity_status_category();

-- -----------------------------------------------------------------------------
-- Backfill.
--
-- WHY NOT `set local session_replication_role = replica`. That is the escape
-- 132's header sanctions, and it is aimed at a DIFFERENT hazard: a bulk
-- `update public.tasks`, which runs 132's per-row workflow-vocabulary check and
-- can abort mid-migration in a space whose workflow the author never heard of.
-- This backfill never writes `public.tasks` at all — it writes the envelope —
-- so that trigger is not in the path. Two further reasons to prefer the
-- precise mechanism here:
--
--   * `session_replication_role` is superuser-only, and 001's bootstrap block
--     explicitly supports a NON-SUPERUSER applier (it grants itself
--     tm8_graph_owner membership rather than assuming superuser). Reaching for
--     it would make this file the one that requires more than the schema owner.
--   * It disables EVERY non-replica trigger on the session. Here that would
--     also silence `entities_project_lifecycle_guard` and the four
--     column-scoped validators — invariants this statement has no business
--     switching off. (It passes all of them as written: the update touches
--     neither space_id, kind, parent_id nor deleted_at, and targets only rows
--     that have a `tasks` detail row, so never a `project`.)
--
-- What DOES need silencing is exactly one trigger: `entities_capture_event`.
-- Left on, this statement emits one `entity.upsert` per task in every space —
-- a synthetic edit attributed to nobody, at an UNCHANGED version, flooding
-- every connected client's poll cursor with history that never happened. The
-- category reaches clients on their next read regardless. Disabling one named
-- trigger needs table ownership, which this file already has, and the table is
-- under ACCESS EXCLUSIVE for the DDL above anyway.
-- -----------------------------------------------------------------------------
alter table public.entities disable trigger entities_capture_event;

update public.entities e
   set status_category = internal.work_status_category(t.work_status)
  from public.tasks t
 where t.entity_id = e.id
   and e.status_category is distinct from internal.work_status_category(t.work_status);

alter table public.entities enable trigger entities_capture_event;

-- Belt and braces, because a disabled trigger is exactly the state in which a
-- mistake goes unnoticed: every task must now have a category, and it must be
-- one of the four. If the backfill missed rows the deploy stops here rather
-- than shipping a filter that silently returns short pages.
do $verify$
declare
  uncategorised bigint;
begin
  select count(*) into uncategorised
    from public.tasks t
    join public.entities e on e.id = t.entity_id
   where e.status_category is null;
  if uncategorised > 0 then
    raise exception
      '147 backfill incomplete: % task rows still have a NULL status_category', uncategorised;
  end if;
end
$verify$;

reset role;
