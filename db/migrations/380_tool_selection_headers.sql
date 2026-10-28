-- Tools carry the same authored selection headers as other reference kinds
-- (Tools v2 PR-E, task 01a182cd-c865). `tm8 tool create --when-to-use` and the
-- UI create form write one through entities.header.set after tools.create;
-- before this file set_entity_header answered `header_not_stored` for a tool
-- and kept nothing. The launch context index's `tools` group routes by it.
--
-- 'loop' is listed too, by the coordinator's UNION RULE for this function:
-- the Tools and Loops lanes both add a kind here, and a create-or-replace
-- keeps only the highest-numbered body, so every redefinition lists the full
-- union. Loops PR1's 378 redefines it with this identical list, so either
-- merge order converges. Union rule: any later redefinition must keep every
-- kind listed here.
-- (The reader side of a loop header — SELECTION_HEADER_KINDS and its arm in
-- packages/server/src/headers/resolve.ts — is the Loops lane's.)
create or replace function internal.header_kind_allowed(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('team_member', 'doc', 'artifact', 'drawing', 'file', 'task', 'collection', 'story', 'tool', 'loop')
$$;
