set role tm8_graph_owner;
create table public.workspace_invitations (
  id uuid primary key default internal.new_id(),
  space_id uuid not null references public.spaces(id),
  email text not null,
  role text not null check(role in ('admin','member')),
  created_by text not null references public.user_profiles(identity_id),
  client_mutation_id text not null,
  expires_at timestamptz not null default now()+interval '7 days',
  revoked_at timestamptz,
  accepted_by uuid references public.accounts(id),
  unique(created_by,client_mutation_id)
);
alter table public.workspace_invitations enable row level security;
create policy workspace_invites_read on public.workspace_invitations for select to tm8_app
  using(internal.is_space_admin(space_id));
grant select on public.workspace_invitations to tm8_app;

create function public.prepare_workspace_invitation(p_space uuid,p_email text,p_role text,p_mutation text) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare invitation public.workspace_invitations;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_admin(p_space);
  if p_role not in ('admin','member') or nullif(btrim(p_email),'') is null or nullif(btrim(p_mutation),'') is null then
    raise exception 'invalid invitation' using errcode='22023';
  end if;
  insert into public.workspace_invitations(space_id,email,role,created_by,client_mutation_id)
    values(p_space,lower(p_email),p_role,internal.identity_id(),p_mutation) on conflict do nothing;
  select * into invitation from public.workspace_invitations where created_by=internal.identity_id() and client_mutation_id=p_mutation;
  if invitation.space_id<>p_space or invitation.email<>lower(p_email) or invitation.role<>p_role then
    raise exception 'mutation payload mismatch' using errcode='23514';
  end if;
  if invitation.revoked_at is not null or invitation.expires_at<=now() then raise exception 'invitation unavailable' using errcode='42501'; end if;
  return to_jsonb(invitation);
end $$;
create function public.revoke_workspace_invitation(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare invitation public.workspace_invitations;
begin
  select * into invitation from public.workspace_invitations where id=p_id for update;
  if invitation.id is null then raise exception 'invitation missing' using errcode='P0002'; end if;
  perform internal.require_human_auth_kind();
  perform internal.require_space_admin(invitation.space_id);
  update public.workspace_invitations set revoked_at=coalesce(revoked_at,now()) where id=p_id;
  return jsonb_build_object('id',p_id,'revoked',true);
end $$;
create function public.accept_control_space_invitations(p_account uuid,p_email text,p_invitations uuid[]) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare invitation public.workspace_invitations; identity text;
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'enrollment principal required' using errcode='42501';
  end if;
  select identity_id into identity from public.accounts where id=p_account and status='active';
  if identity is null then raise exception 'account unavailable' using errcode='42501'; end if;
  for invitation in select * from public.workspace_invitations where id=any(p_invitations) for update loop
    if invitation.revoked_at is not null or invitation.accepted_by is not null or invitation.expires_at<=now() then continue; end if;
    if invitation.email<>lower(p_email) then raise exception 'invitation recipient mismatch' using errcode='42501'; end if;
    -- Existing membership retains its role; accepting an invite is not a demotion.
    if not exists(select 1 from public.members m join public.entities e on e.id=m.entity_id where m.space_id=invitation.space_id and m.identity_id=identity and e.deleted_at is null) then
      perform internal.attach_member(invitation.space_id,identity,invitation.role);
    end if;
    update public.workspace_invitations set accepted_by=p_account where id=invitation.id;
  end loop;
end $$;
revoke all on function public.prepare_workspace_invitation(uuid,text,text,text),public.revoke_workspace_invitation(uuid),
  public.accept_control_space_invitations(uuid,text,uuid[]) from public;
grant execute on function public.prepare_workspace_invitation(uuid,text,text,text),public.revoke_workspace_invitation(uuid) to tm8_app;
grant execute on function public.accept_control_space_invitations(uuid,text,uuid[]) to tm8_node_enrollment;
reset role;
