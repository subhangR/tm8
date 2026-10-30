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

/**
 * 322 renames 304's `design` kind to `craft`; current readers left-join
 * `public.crafts` and select `internal.craft_summary(e.id)`. Historical
 * fixtures that stop at 304 mirror only that read shape: the table rename and
 * a NULL summary stub. No craft rows are tested.
 */
export async function addCraftProjectionShape(database: W1ScratchDatabase): Promise<void> {
  await database.query(`set role tm8_graph_owner;
    alter table public.designs rename to crafts;
    create or replace function internal.craft_summary(p_craft_id uuid) returns jsonb
      language sql stable as 'select null::jsonb';
    grant execute on function internal.craft_summary(uuid) to tm8_app;
    reset role;`);
}

/**
 * 329 and 331 add the `prs`/`artifacts`/`drawings`/`sessions` link counters,
 * and current readers (`entity-read.ts`, the projector) select them. Historical
 * fixtures that stop before 329 mirror only those columns, at their defaults;
 * no counter trigger runs and no assertion reads them.
 */
export async function addEntityCounterLinkShape(database: W1ScratchDatabase): Promise<void> {
  await database.query(`set role tm8_graph_owner;
    alter table public.entity_counters
      add column if not exists prs       integer not null default 0,
      add column if not exists artifacts integer not null default 0,
      add column if not exists drawings  integer not null default 0,
      add column if not exists sessions  integer not null default 0;
    reset role;`);
}

/**
 * 395 (Bridges B0a): current readers select `internal.bridge_view(e.id)` for
 * bridge rows. 407 (Bridges B2): the message readers and the projector select
 * `internal.bridge_message_badges(ids)` for every page of messages. Historical
 * fixtures that stop before 395 mirror only those reads' signatures: a NULL
 * view and an empty badge list (no message crossed a bridge). No bridge rows
 * are tested.
 */
export async function addBridgeProjectionShape(database: W1ScratchDatabase): Promise<void> {
  await database.query(`set role tm8_graph_owner;
    create or replace function internal.bridge_view(p_bridge_id uuid) returns jsonb
      language sql stable as 'select null::jsonb';
    grant execute on function internal.bridge_view(uuid) to tm8_app;
    create or replace function internal.bridge_message_badges(p_ids uuid[]) returns jsonb
      language sql stable as 'select ''[]''::jsonb';
    grant execute on function internal.bridge_message_badges(uuid[]) to tm8_app;
    reset role;`);
}

/**
 * 397 adds `entities.labels` and the `label` kind's detail table, and current
 * readers select `e.labels` and left-join `public.labels`. Historical fixtures
 * that stop before 397 mirror only that read shape; no label rows are tested.
 */
export async function addLabelProjectionShape(database: W1ScratchDatabase): Promise<void> {
  await database.query(`set role tm8_graph_owner;
    alter table public.entities add column if not exists labels uuid[] not null default '{}';
    create table if not exists public.labels(entity_id uuid primary key, space_id uuid, name text,
      colour text, description text, archived_at timestamptz);
    grant select on public.labels to tm8_app;
    reset role;`);
}
