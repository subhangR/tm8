-- Persist the provider config directory selected for a work session. Transcript
-- and resume readers must consume this launch-time fact rather than re-derive
-- it from today's credential binding.

alter table public.work_sessions
  add column if not exists agent_config_dir text;

comment on column public.work_sessions.agent_config_dir is
  'Resolved CLAUDE_CONFIG_DIR or CODEX_HOME used for the original agent run; null for older/non-provider sessions.';

drop function if exists public.record_session_manifest(uuid, jsonb, text[], text, text);

create or replace function public.record_session_manifest(
  p_session_id uuid, p_manifest jsonb, p_env_var_names text[] default '{}'::text[],
  p_system_prompt text default null, p_task_prompt text default null,
  p_agent_config_dir text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  if p_agent_config_dir is not null and p_agent_config_dir !~ '^/' then
    raise exception using errcode = '22023', message = 'agent config dir must be absolute';
  end if;

  insert into public.session_manifests(
    work_session_id, manifest, env_var_names, system_prompt, task_prompt)
  values (
    p_session_id, p_manifest, coalesce(p_env_var_names, '{}'::text[]),
    nullif(p_system_prompt, ''), nullif(p_task_prompt, ''))
  on conflict (work_session_id) do update
    set manifest      = excluded.manifest,
        env_var_names = excluded.env_var_names,
        system_prompt = coalesce(excluded.system_prompt, session_manifests.system_prompt),
        task_prompt   = coalesce(excluded.task_prompt, session_manifests.task_prompt);

  update public.work_sessions
     set agent_config_dir = coalesce(agent_config_dir, nullif(p_agent_config_dir, ''))
   where entity_id = p_session_id;

  return jsonb_build_object('workSessionId', p_session_id);
end
$$;

revoke all on function
  public.record_session_manifest(uuid, jsonb, text[], text, text, text) from public;
grant execute on function
  public.record_session_manifest(uuid, jsonb, text[], text, text, text) to tm8_app;
