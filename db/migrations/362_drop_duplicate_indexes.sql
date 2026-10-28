-- =============================================================================
-- 362: drop four indexes that duplicate a unique constraint's own index.
--
-- Each of these was created next to a UNIQUE constraint on the same columns, so
-- every insert and update paid for two identical btrees, and the planner could
-- only ever use one of them. The unique index stays; the plain copy goes:
--
--   accounts                   accounts_identity_idx            (002)
--     duplicates accounts_identity_id_key                (identity_id)
--   workspace_events           workspace_events_space_seq_idx   (003)
--     duplicates workspace_events_space_id_seq_key       (space_id, seq)
--   artifact_bundle_revisions  artifact_bundle_revisions_artifact_idx (055)
--     duplicates artifact_bundle_revisions_artifact_entity_id_revision_numbe_key
--                                                         (artifact_entity_id, revision_number)
--   task_workflows             task_workflows_space_idx         (132)
--     duplicates task_workflows_space_id_type_value_key  (space_id, type_value)
--
-- The artifact copy is `revision_number DESC`. That buys nothing: a btree is
-- read backward as cheaply as forward, so "latest revision of artifact X"
-- (artifact_entity_id = $1 order by revision_number desc limit 1) is an index
-- scan backward on the unique index.
--
-- Found by grouping pg_index on (indrelid, indkey, indclass, indcollation,
-- expressions, predicate) after a full `migrate up`; these four are the only
-- groups with more than one member. No code or test names any of them.
--
-- Plain DROP INDEX, not CONCURRENTLY: the runner wraps each file in a
-- transaction. The drop takes a brief ACCESS EXCLUSIVE lock on each table;
-- lock_timeout makes it fail fast rather than queue behind a long reader.
-- `if exists` so a hand-tidied database still applies.
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

drop index if exists public.accounts_identity_idx;
drop index if exists public.workspace_events_space_seq_idx;
drop index if exists public.artifact_bundle_revisions_artifact_idx;
drop index if exists public.task_workflows_space_idx;

reset role;
