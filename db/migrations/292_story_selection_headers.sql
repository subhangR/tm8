-- Stories carry the same authored selection headers as other reference kinds.
create or replace function internal.header_kind_allowed(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('team_member', 'doc', 'artifact', 'drawing', 'file', 'task', 'collection', 'story')
$$;
