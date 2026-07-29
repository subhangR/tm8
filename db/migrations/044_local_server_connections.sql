-- 044 — node-local named connections to other tm8 Servers.
--
-- These rows are routing configuration, not graph entities. They deliberately
-- contain no password: Phase 1 has no remote authentication boundary, and a
-- credential that is stored but never used would only create secret exposure.

set role tm8_graph_owner;

create table public.server_connections (
  id uuid primary key default internal.new_id(),
  name text not null,
  base_url text not null,
  username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint server_connections_name_check
    check (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  constraint server_connections_base_url_check
    check (length(base_url) <= 2048 and base_url ~ '^https?://'),
  constraint server_connections_username_check
    check (username is null or (length(username) between 1 and 100))
);

create unique index server_connections_name_unique
  on public.server_connections (lower(name));

create trigger server_connections_touch_updated_at
before update on public.server_connections
for each row execute function internal.touch_updated_at();

alter table public.server_connections enable row level security;

create policy server_connections_node_admin_select on public.server_connections
  for select using (internal.is_node_admin());

grant select on public.server_connections to tm8_app;

create or replace function public.create_server_connection(
  p_name text,
  p_base_url text,
  p_username text default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  connection_row public.server_connections;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'serverConnections.create');
  if replay is not null then
    if replay #>> '{connection,name}' is distinct from lower(p_name) then
      raise exception 'clientMutationId is already bound to another server connection'
        using errcode = '23514';
    end if;
    return replay;
  end if;

  perform internal.require_node_admin();

  insert into public.server_connections(name, base_url, username)
  values (lower(p_name), p_base_url, p_username)
  returning * into connection_row;

  result := jsonb_build_object('connection', jsonb_build_object(
    'id', connection_row.id,
    'name', connection_row.name,
    'baseUrl', connection_row.base_url,
    'username', connection_row.username,
    'createdAt', connection_row.created_at,
    'updatedAt', connection_row.updated_at
  ));

  return internal.ledger_record(
    p_client_mutation_id,
    'serverConnections.create',
    result
  );
end
$$;

create or replace function public.delete_server_connection(
  p_name text,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  connection_row public.server_connections;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'serverConnections.delete');
  if replay is not null then
    if replay #>> '{connection,name}' is distinct from lower(p_name) then
      raise exception 'clientMutationId is already bound to another server connection'
        using errcode = '23514';
    end if;
    return replay;
  end if;

  perform internal.require_node_admin();

  delete from public.server_connections
   where name = lower(p_name)
   returning * into connection_row;

  if connection_row.id is null then
    raise exception 'server connection not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object('connection', jsonb_build_object(
    'id', connection_row.id,
    'name', connection_row.name,
    'baseUrl', connection_row.base_url,
    'username', connection_row.username,
    'createdAt', connection_row.created_at,
    'updatedAt', connection_row.updated_at
  ));

  return internal.ledger_record(
    p_client_mutation_id,
    'serverConnections.delete',
    result
  );
end
$$;

revoke all on function public.create_server_connection(text, text, text, text) from public;
revoke all on function public.delete_server_connection(text, text) from public;
grant execute on function public.create_server_connection(text, text, text, text) to tm8_app;
grant execute on function public.delete_server_connection(text, text) to tm8_app;

reset role;
