-- =============================================================================
-- 373: who owns a per-session directory that is not a work session's.
--
-- The node's reclaim job (`execution.session-artifact-reclaim`, formerly
-- `execution.codex-home-reclaim`) now also removes the space-key homes under
-- `<dataDir>/credentials/sessions/<id>/`. That directory is keyed by a work
-- session id OR BY A CHAT ID: a chat on a space API key materializes its home
-- at the same path (packages/server/src/chat/credentials.ts). 372 answers for
-- work sessions only, so a chat's id is missing from its answer, and the job
-- would read it as "no such session" and remove a live chat's transcripts.
--
-- So before it removes a space-key home whose id 372 did not answer for, the
-- job asks this door whether the id is any entity at all. An id with an
-- entity row (a chat, deleted or not) keeps its home: chat retention is not
-- this job's question. Only an id with no entity row is an orphan.
--
-- NODE ADMIN, and deliberately NOT filtered by space membership, for 372's
-- reason: an id missing from the answer is treated as an orphan and its
-- directory removed, and the node owner is not a member of every space.
-- Returns kind and deletion only, never content.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.session_home_owner_facts(p_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 1000 then
    raise exception 'at most 1000 ids per call' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id,
           'kind', e.kind,
           'deleted', e.deleted_at is not null)), '[]'::jsonb)
    into rows
    from public.entities e
   where e.id = any(coalesce(p_ids, '{}'::uuid[]));
  return rows;
end
$$;

revoke all on function public.session_home_owner_facts(uuid[]) from public;
grant execute on function public.session_home_owner_facts(uuid[]) to tm8_app;

reset role;
