-- =============================================================================
-- 235 — space-owned projects, the backfill (plan 01a0d9eb W11).
--
-- ROW-REWRITING. 234 added the columns and fills them for every new row; this
-- file fills them for the rows that existed before 234. It writes ONLY the
-- three new nullable columns and changes nothing else:
--
--   chats.project_entity_id          <- project_links(chat.space_id, chat.project_id)
--   work_sessions.project_entity_id  <- project_links(session entity's space, ws.project_id)
--   worktrees.space_id               <- the worktree entity's space_id
--   worktrees.project_entity_id      <- project_links(that space, wt.project_id)
--
-- project_id (the folder) is NOT repointed: every existing chat and session
-- keeps opening its folder through the same column it always did, and a
-- rollback of the server needs no data change.
--
-- A row whose (space, folder) pair has no project_links row (the folder was
-- never linked into that space, or the projection was skipped for want of an
-- actor) keeps null; nothing reads the new column as required.
--
-- updated_at and the worktree snapshot version are left alone: the triggers
-- that would bump them on a column nobody sees are disabled for this file's
-- updates only (same transaction), so no chat reorders in the list and no
-- worktree emits a spurious version.
--
-- Idempotent: each update only touches rows whose column is still null.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

alter table public.chats disable trigger chats_touch_updated_at;
alter table public.work_sessions disable trigger work_sessions_touch_updated_at;
alter table public.worktrees disable trigger worktrees_touch_updated_at;
alter table public.worktrees disable trigger worktrees_snapshot_version;

update public.chats chat
   set project_entity_id = link.project_entity_id
  from public.project_links link
 where chat.project_entity_id is null
   and chat.project_id is not null
   and link.space_id = chat.space_id
   and link.project_id = chat.project_id;

update public.work_sessions ws
   set project_entity_id = link.project_entity_id
  from public.entities session_entity, public.project_links link
 where ws.project_entity_id is null
   and ws.project_id is not null
   and session_entity.id = ws.entity_id
   and link.space_id = session_entity.space_id
   and link.project_id = ws.project_id;

update public.worktrees wt
   set space_id = worktree_entity.space_id
  from public.entities worktree_entity
 where wt.space_id is null
   and worktree_entity.id = wt.entity_id;

update public.worktrees wt
   set project_entity_id = link.project_entity_id
  from public.project_links link
 where wt.project_entity_id is null
   and link.space_id = wt.space_id
   and link.project_id = wt.project_id;

alter table public.chats enable trigger chats_touch_updated_at;
alter table public.work_sessions enable trigger work_sessions_touch_updated_at;
alter table public.worktrees enable trigger worktrees_touch_updated_at;
alter table public.worktrees enable trigger worktrees_snapshot_version;

reset role;

analyze public.chats;
analyze public.work_sessions;
analyze public.worktrees;
