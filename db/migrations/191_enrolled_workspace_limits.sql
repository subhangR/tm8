set role tm8_graph_owner;
create function public.configure_enrolled_workspace_limits(p_machine uuid,p_capacity integer,p_limits jsonb) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if not pg_has_role(session_user,'tm8_node_enrollment','MEMBER') then
    raise exception 'enrollment principal required' using errcode='42501';
  end if;
  if p_capacity not between 1 and 10000 or jsonb_typeof(p_limits)<>'object' or
    (p_limits->>'cpus')::numeric not between 0.01 and 64 or
    (p_limits->>'memoryMiB')::integer not between 256 and 262144 or
    (p_limits->>'pids')::integer not between 32 and 4096 or
    not p_limits ?& array['cpus','memoryMiB','pids'] then
    raise exception 'invalid workspace limits' using errcode='22023';
  end if;
  perform public.configure_enrolled_node(p_machine,p_capacity);
  update public.workspace_node set limits=p_limits where singleton;
end $$;
revoke all on function public.configure_enrolled_workspace_limits(uuid,integer,jsonb) from public;
grant execute on function public.configure_enrolled_workspace_limits(uuid,integer,jsonb) to tm8_node_enrollment;
reset role;
