import type { W1ScratchDatabase } from './w1-pg.js';

/** Current readers on historical migration fixtures: no tool rows or RPCs. */
export async function addToolProjectionShape(database: W1ScratchDatabase): Promise<void> {
  await database.query(`set role tm8_graph_owner;
    alter table public.chats add column if not exists credential_selection jsonb;
    create table public.tools(entity_id uuid primary key, definition jsonb, execution_version integer, config_revision bigint);
    create table public.tool_config(tool_id uuid, input_name text, value jsonb);
    create table public.tool_secret_bindings(tool_id uuid, input_name text, credential_id uuid, bound_by uuid, bound_at timestamptz);
    alter table public.work_sessions
      add column if not exists session_kind text default 'agent',
      add column tool_id uuid, add column tool_version integer, add column tool_source_sha256 text,
      add column tool_inputs jsonb, add column tool_keep_open boolean, add column tool_state text,
      add column tool_exit_code integer, add column tool_started_at timestamptz,
      add column tool_exited_at timestamptz, add column tool_output_tail text;
    do $$ begin
      if to_regprocedure('public.read_space_credential(uuid)') is null then
        execute 'create function public.read_space_credential(uuid) returns jsonb language sql as ''select null::jsonb''';
      end if;
    end $$;
    grant select on public.tools,public.tool_config,public.tool_secret_bindings,public.work_sessions,public.chats to tm8_app;
    grant execute on function public.read_space_credential(uuid) to tm8_app;
    reset role;`);
}
