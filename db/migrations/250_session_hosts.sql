-- =============================================================================
-- 250 — session_hosts: where this node's detached session hosts live, and the
-- token that proves a server may drive one (task 01a0db31, design doc
-- 01a0db5e §D4/R5).
--
-- WHAT IS HERE
--   1. `internal.session_hosts` — one row per running session host: the node
--      that started it, its build generation, its socket, its controller token
--      and its pid. A server restart reads these rows to find the agents it
--      left running and reattach them.
--   2. Five node-admin RPCs over it: list / insert / set pid / remove for the
--      calling node, and owner_of(socket_path) so a server can tell an
--      orphaned host in its own data dir from one another node registered.
--
-- WHY INTERNAL: the token is a bearer credential for every agent the host
-- holds (write to its terminal, signal it). tm8_app gets no grant on the
-- table; only the security-definer RPCs below reach it, and each requires a
-- node admin — the identity a server runs its boot sweeps as.
--
-- WHY (node_id, generation): the generation is a hash of the host's built
-- files and the node version, so two nodes on one build share it. The socket
-- path lives under the node's data dir and is unique on its own.
-- =============================================================================

set role tm8_graph_owner;

create table internal.session_hosts (
  node_id text not null,
  generation text not null,
  socket_path text not null,
  token text not null,
  pid integer,
  created_at timestamptz not null default now(),
  primary key (node_id, generation),
  constraint session_hosts_node_id_check check (length(node_id) between 1 and 512),
  constraint session_hosts_generation_check check (generation ~ '^[a-z0-9-]{1,64}$'),
  constraint session_hosts_socket_path_check check (length(socket_path) between 1 and 4096 and socket_path like '/%'),
  constraint session_hosts_token_check check (length(token) between 32 and 256),
  constraint session_hosts_pid_check check (pid is null or pid > 0)
);

create unique index session_hosts_socket_path_unique on internal.session_hosts (socket_path);

comment on table internal.session_hosts is
  'Detached session hosts per node (task 01a0db31): socket, controller token, pid. Reached only through node-admin RPCs.';

create function public.session_host_list(p_node_id text)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  return coalesce(
    (select jsonb_agg(jsonb_build_object(
              'generation', h.generation,
              'socketPath', h.socket_path,
              'token', h.token,
              'pid', h.pid) order by h.created_at)
       from internal.session_hosts h
      where h.node_id = p_node_id),
    '[]'::jsonb);
end
$$;

create function public.session_host_insert(
  p_node_id text, p_generation text, p_socket_path text, p_token text, p_pid integer
)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  insert into internal.session_hosts (node_id, generation, socket_path, token, pid)
  values (p_node_id, p_generation, p_socket_path, p_token, p_pid);
end
$$;

create function public.session_host_set_pid(p_node_id text, p_generation text, p_pid integer)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  update internal.session_hosts set pid = p_pid
   where node_id = p_node_id and generation = p_generation;
end
$$;

create function public.session_host_remove(p_node_id text, p_generation text)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  delete from internal.session_hosts where node_id = p_node_id and generation = p_generation;
end
$$;

create function public.session_host_owner_of(p_socket_path text)
returns text
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  return (select h.node_id from internal.session_hosts h where h.socket_path = p_socket_path);
end
$$;

revoke all on table internal.session_hosts from public;
revoke all on function public.session_host_list(text) from public;
revoke all on function public.session_host_insert(text, text, text, text, integer) from public;
revoke all on function public.session_host_set_pid(text, text, integer) from public;
revoke all on function public.session_host_remove(text, text) from public;
revoke all on function public.session_host_owner_of(text) from public;
grant execute on function public.session_host_list(text) to tm8_app;
grant execute on function public.session_host_insert(text, text, text, text, integer) to tm8_app;
grant execute on function public.session_host_set_pid(text, text, integer) to tm8_app;
grant execute on function public.session_host_remove(text, text) to tm8_app;
grant execute on function public.session_host_owner_of(text) to tm8_app;

reset role;

do $verify$
begin
  if to_regclass('internal.session_hosts') is null then
    raise exception 'VERIFY 250: internal.session_hosts was not created';
  end if;
  if has_table_privilege('tm8_app', 'internal.session_hosts', 'select') then
    raise exception 'VERIFY 250: tm8_app must not read session host tokens directly';
  end if;
  if not has_function_privilege('tm8_app', 'public.session_host_list(text)', 'execute') then
    raise exception 'VERIFY 250: tm8_app cannot execute session_host_list';
  end if;
end
$verify$;
