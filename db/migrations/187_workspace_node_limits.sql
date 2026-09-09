set role tm8_graph_owner;
alter table public.workspace_node add column limits jsonb not null default '{"cpus":2,"memoryMiB":4096,"pids":256}';

create function public.configure_workspace_limits(p_machine uuid,p_capacity integer,p_limits jsonb) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_node_admin();
  if (p_limits->>'cpus')::numeric not between 0.01 and 64 or
     (p_limits->>'memoryMiB')::integer not between 256 and 262144 or
     (p_limits->>'pids')::integer not between 32 and 4096 then
    raise exception 'invalid workspace limits' using errcode='22023';
  end if;
  perform public.configure_workspace_node(p_machine,p_capacity);
  update public.workspace_node set limits=p_limits where singleton;
end $$;

create or replace function public.ensure_user_workspace() returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare account uuid; result public.user_workspaces; node public.workspace_node;
begin
  account:=internal.current_account_id();
  if account is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into result from public.user_workspaces where account_id=account;
  if found then return to_jsonb(result); end if;
  select * into node from public.workspace_node where singleton for update;
  select * into result from public.user_workspaces where account_id=account;
  if found then return to_jsonb(result); end if;
  if (select count(*) from public.user_workspaces) >= node.capacity then
    raise exception 'workspace_capacity_exhausted' using errcode='23514';
  end if;
  insert into public.user_workspaces(account_id,machine_id,limits) values(account,node.machine_id,node.limits) returning * into result;
  return to_jsonb(result);
end $$;
revoke all on function public.configure_workspace_limits(uuid,integer,jsonb) from public;
grant execute on function public.configure_workspace_limits(uuid,integer,jsonb) to tm8_app;
reset role;
