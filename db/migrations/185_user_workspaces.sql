-- Private execution state is separate from the shared Space graph. Existing
-- project paths and accounts remain untouched until an explicit migration.
set role tm8_graph_owner;

create table public.workspace_node (
  singleton boolean primary key default true check (singleton),
  machine_id uuid not null default internal.new_id(),
  capacity integer not null default 10 check (capacity between 1 and 10000)
);
insert into public.workspace_node(singleton) values (true);

create table public.user_workspaces (
  id uuid primary key default internal.new_id(),
  account_id uuid not null unique references public.accounts(id),
  machine_id uuid not null,
  state text not null default 'pending' check (state in ('pending','provisioning','ready','failed','suspended')),
  operation_id uuid not null default internal.new_id(),
  limits jsonb not null default '{"cpus":2,"memoryMiB":4096,"pids":256}',
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.workspace_repositories (
  project_id uuid primary key references public.projects(id),
  home_space_id uuid not null references public.spaces(id),
  owner_account_id uuid not null references public.accounts(id),
  state text not null default 'pending' check (state in ('pending','ready','failed')),
  source jsonb not null,
  operation_id uuid not null default internal.new_id(),
  failure_code text,
  client_mutation_id text not null,
  created_at timestamptz not null default now(),
  unique(owner_account_id, client_mutation_id)
);
create table public.workspace_checkouts (
  workspace_id uuid not null references public.user_workspaces(id),
  project_id uuid not null references public.workspace_repositories(project_id),
  relative_path text not null check (relative_path !~ '(^/|(^|/)\.\.(/|$))'),
  state text not null default 'pending' check (state in ('pending','ready','failed')),
  operation_id uuid not null default internal.new_id(),
  primary key(workspace_id, project_id)
);

alter table public.user_workspaces enable row level security;
alter table public.workspace_repositories enable row level security;
alter table public.workspace_checkouts enable row level security;
create policy workspace_self_read on public.user_workspaces for select to tm8_app
  using (account_id = internal.current_account_id());
create policy repository_member_read on public.workspace_repositories for select to tm8_app
  using (exists(select 1 from public.space_projects sp where sp.project_id = workspace_repositories.project_id
    and internal.is_space_member(sp.space_id)));
create policy checkout_self_read on public.workspace_checkouts for select to tm8_app
  using (exists(select 1 from public.user_workspaces w where w.id = workspace_id
    and w.account_id = internal.current_account_id()));
grant select on public.user_workspaces, public.workspace_repositories, public.workspace_checkouts to tm8_app;

create function public.ensure_user_workspace() returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare account uuid; result public.user_workspaces; node public.workspace_node;
begin
  account := internal.current_account_id();
  if account is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into result from public.user_workspaces where account_id = account;
  if found then return to_jsonb(result); end if;
  -- The row lock serializes reservations, including concurrent first logins.
  select * into node from public.workspace_node where singleton for update;
  select * into result from public.user_workspaces where account_id = account;
  if found then return to_jsonb(result); end if;
  if (select count(*) from public.user_workspaces) >= node.capacity then
    raise exception 'workspace_capacity_exhausted' using errcode = '23514';
  end if;
  insert into public.user_workspaces(account_id, machine_id)
    values(account, node.machine_id) returning * into result;
  return to_jsonb(result);
end $$;

create function public.transition_user_workspace(p_operation uuid, p_state text, p_failure text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result public.user_workspaces;
begin
  select * into result from public.user_workspaces
    where account_id = internal.current_account_id() and operation_id = p_operation for update;
  if not found then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if result.state = 'suspended' then raise exception 'workspace suspended' using errcode = '42501'; end if;
  if not ((result.state in ('pending','failed') and p_state = 'provisioning') or
          (result.state = 'provisioning' and p_state in ('ready','failed')) or result.state = p_state) then
    raise exception 'invalid workspace transition' using errcode = '23514';
  end if;
  update public.user_workspaces set state = p_state, failure_code = p_failure, updated_at = now()
    where id = result.id returning * into result;
  return to_jsonb(result);
end $$;

create function public.configure_workspace_node(p_machine uuid, p_capacity integer) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  perform 1 from public.workspace_node where singleton for update;
  if p_capacity < (select count(*) from public.user_workspaces) then
    raise exception 'capacity below assigned workspace count' using errcode = '23514';
  end if;
  if exists(select 1 from public.user_workspaces where machine_id <> p_machine) then
    raise exception 'machine identity is immutable after allocation' using errcode = '23514';
  end if;
  update public.workspace_node set machine_id = p_machine, capacity = p_capacity where singleton;
end $$;

revoke all on function public.ensure_user_workspace(),
  public.transition_user_workspace(uuid,text,text), public.configure_workspace_node(uuid,integer) from public;
grant execute on function public.ensure_user_workspace(),
  public.transition_user_workspace(uuid,text,text), public.configure_workspace_node(uuid,integer) to tm8_app;
reset role;
