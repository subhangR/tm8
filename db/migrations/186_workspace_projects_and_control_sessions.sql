-- The enrollment principal has no graph reads and cannot assume tm8_app.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='tm8_node_enrollment') then
    create role tm8_node_enrollment nologin;
  end if;
end $$;
grant usage on schema public to tm8_node_enrollment;
set role tm8_graph_owner;

create table public.control_session_links (
  session_id uuid primary key references public.auth_sessions(id) on delete cascade,
  central_session_id uuid not null,
  workspace_id uuid not null references public.user_workspaces(id),
  lease_until timestamptz not null
);
alter table public.control_session_links enable row level security;
create policy control_session_self on public.control_session_links for select to tm8_app
  using(exists(select 1 from public.user_workspaces w where w.id=workspace_id and w.account_id=internal.current_account_id()));
grant select on public.control_session_links to tm8_app;

create function public.configure_enrolled_node(p_machine uuid, p_capacity integer) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'node enrollment principal required' using errcode='42501';
  end if;
  perform 1 from public.workspace_node where singleton for update;
  if p_capacity < (select count(*) from public.user_workspaces) or
     exists(select 1 from public.user_workspaces where machine_id<>p_machine) then
    raise exception 'invalid node configuration' using errcode='23514';
  end if;
  update public.workspace_node set machine_id=p_machine,capacity=p_capacity where singleton;
end $$;

create function public.import_control_session(p_account uuid,p_identity text,p_email text,
  p_workspace uuid,p_operation uuid,p_machine uuid,p_central_session uuid,p_session uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare a public.accounts; w public.user_workspaces; node public.workspace_node;
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'node enrollment principal required' using errcode='42501';
  end if;
  select * into node from public.workspace_node where singleton for update;
  if node.machine_id<>p_machine then raise exception 'machine mismatch' using errcode='42501'; end if;
  select * into a from public.accounts where id=p_account;
  if found and (a.identity_id<>p_identity or a.status<>'active') then
    raise exception 'account migration conflict' using errcode='42501';
  end if;
  if a.id is null then
    insert into public.user_profiles(identity_id,email) values(p_identity,p_email);
    insert into public.accounts(id,identity_id,username,email)
      values(p_account,p_identity,'u_'||replace(p_account::text,'-',''),p_email) returning * into a;
  end if;
  select * into w from public.user_workspaces where account_id=p_account;
  if found and (w.id<>p_workspace or w.machine_id<>p_machine or w.state='suspended') then
    raise exception 'workspace assignment conflict' using errcode='42501';
  end if;
  if w.id is null then
    if (select count(*) from public.user_workspaces) >= node.capacity then
      raise exception 'workspace_capacity_exhausted' using errcode='23514';
    end if;
    insert into public.user_workspaces(id,account_id,machine_id,operation_id)
      values(p_workspace,p_account,p_machine,p_operation) returning * into w;
  end if;
  insert into public.auth_sessions(id,account_id,kind,token_hash,label,expires_at)
    values(p_session,p_account,'browser',p_hash,'Central sign-in',now()+interval '12 hours');
  insert into public.control_session_links values(p_session,p_central_session,p_workspace,now()+interval '30 seconds');
  return jsonb_build_object('accountId',a.id,'identityId',a.identity_id,'workspaceId',w.id);
end $$;

create function public.refresh_control_lease(p_session uuid,p_central uuid,p_workspace uuid) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'node enrollment principal required' using errcode='42501';
  end if;
  update public.control_session_links set lease_until=now()+interval '30 seconds'
    where session_id=p_session and central_session_id=p_central and workspace_id=p_workspace;
  if not found then raise exception 'control session missing' using errcode='P0002'; end if;
end $$;

create function public.create_workspace_project(p_space uuid,p_name text,p_source jsonb,p_mutation text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare account uuid; workspace public.user_workspaces; repo public.workspace_repositories; project public.projects; project_id uuid;
begin
  account:=internal.current_account_id();
  perform internal.require_space_member(p_space);
  perform internal.require_human_auth_kind();
  select * into workspace from public.user_workspaces where account_id=account for update;
  if workspace.id is null or workspace.state<>'ready' then raise exception 'workspace_not_ready' using errcode='23514'; end if;
  if nullif(btrim(p_mutation),'') is null then raise exception 'mutation id required' using errcode='22023'; end if;
  select * into repo from public.workspace_repositories where owner_account_id=account and client_mutation_id=p_mutation;
  if found then
    if repo.home_space_id<>p_space or repo.source<>p_source then raise exception 'mutation payload mismatch' using errcode='23514'; end if;
    select * into project from public.projects where id=repo.project_id;
    return jsonb_build_object('project',to_jsonb(project),'repository',to_jsonb(repo));
  end if;
  if p_source->>'kind' not in ('init','clone','import') then raise exception 'invalid source' using errcode='22023'; end if;
  project_id:=internal.new_id();
  -- This is a virtual runner path, never an application-host directory.
  insert into public.projects(id,name,working_dir,repo_url,trust)
    values(project_id,p_name,'/home/user/projects/'||project_id::text,p_source->>'url','untrusted') returning * into project;
  insert into public.space_projects(space_id,project_id,linked_by)
    values(p_space,project_id,internal.current_member_id(p_space));
  insert into public.workspace_repositories(project_id,home_space_id,owner_account_id,source,client_mutation_id)
    values(project_id,p_space,account,p_source,p_mutation) returning * into repo;
  insert into public.workspace_checkouts(workspace_id,project_id,relative_path)
    values(workspace.id,project_id,'projects/'||project_id::text);
  return jsonb_build_object('project',to_jsonb(project),'repository',to_jsonb(repo));
end $$;

create function public.ensure_workspace_checkout(p_project uuid) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare workspace public.user_workspaces; checkout public.workspace_checkouts;
begin
  select * into workspace from public.user_workspaces where account_id=internal.current_account_id();
  if workspace.id is null or workspace.state<>'ready' then raise exception 'workspace_not_ready' using errcode='23514'; end if;
  if not exists(select 1 from public.space_projects where project_id=p_project and internal.is_space_member(space_id)) then
    raise exception 'project not found' using errcode='P0002';
  end if;
  if not exists(select 1 from public.workspace_repositories where project_id=p_project and state='ready') then
    raise exception 'project_requires_workspace_migration' using errcode='23514';
  end if;
  insert into public.workspace_checkouts(workspace_id,project_id,relative_path)
    values(workspace.id,p_project,'projects/'||p_project::text) on conflict do nothing;
  select * into checkout from public.workspace_checkouts where workspace_id=workspace.id and project_id=p_project;
  return to_jsonb(checkout);
end $$;

create function public.finish_workspace_project(p_project uuid,p_ready boolean,p_failure text default null) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not exists(select 1 from public.workspace_repositories where project_id=p_project and owner_account_id=internal.current_account_id()) then
    raise exception 'project owner required' using errcode='42501';
  end if;
  update public.workspace_repositories set state=case when p_ready then 'ready' else 'failed' end,failure_code=p_failure where project_id=p_project;
  update public.workspace_checkouts set state=case when p_ready then 'ready' else 'failed' end
    where project_id=p_project and workspace_id in(select id from public.user_workspaces where account_id=internal.current_account_id());
end $$;

create function public.finish_workspace_checkout(p_project uuid) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not exists(select 1 from public.space_projects where project_id=p_project and internal.is_space_member(space_id)) then
    raise exception 'project not found' using errcode='P0002';
  end if;
  update public.workspace_checkouts set state='ready' where project_id=p_project and
    workspace_id in(select id from public.user_workspaces where account_id=internal.current_account_id() and state='ready');
end $$;

revoke all on function public.configure_enrolled_node(uuid,integer),
  public.import_control_session(uuid,text,text,uuid,uuid,uuid,uuid,uuid,text),public.refresh_control_lease(uuid,uuid,uuid),
  public.create_workspace_project(uuid,text,jsonb,text),public.ensure_workspace_checkout(uuid),
  public.finish_workspace_project(uuid,boolean,text),public.finish_workspace_checkout(uuid) from public;
grant execute on function public.configure_enrolled_node(uuid,integer),
  public.import_control_session(uuid,text,text,uuid,uuid,uuid,uuid,uuid,text),public.refresh_control_lease(uuid,uuid,uuid) to tm8_node_enrollment;
grant execute on function public.create_workspace_project(uuid,text,jsonb,text),public.ensure_workspace_checkout(uuid),
  public.finish_workspace_project(uuid,boolean,text),public.finish_workspace_checkout(uuid) to tm8_app;
reset role;
