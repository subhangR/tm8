export { toolRunView } from './projection.js';
import { toolRunView } from './projection.js';
import { createHash } from 'node:crypto';
import { CollabError, ToolDefinitionSchema, type ToolRun, type ToolView } from '@tm8/contract';
import { loadActors, actorOf } from '../facade/entity-read.js';
import type { Querier } from '../db/types.js';

export async function loadTool(q: Querier, toolId: string): Promise<ToolView> {
  const [row] = await q.query<{ id: string; space_id: string; version: number; definition: unknown; execution_version: number; config_revision: number }>(
    `select e.id,e.space_id,e.version,t.definition,t.execution_version,t.config_revision from public.entities e join public.tools t on t.entity_id=e.id
     where e.id=$1 and e.deleted_at is null and internal.entity_readable(e.id)`, [toolId]);
  if (!row) throw new CollabError('not_found', 'Tool is unavailable');
  const definition = ToolDefinitionSchema.parse(row.definition);
  const config = await q.query<{ input_name: string; value: ToolView['config'][string] }>(
    'select input_name,value from public.tool_config where tool_id=$1', [toolId]);
  const bindings = await q.query<{ input_name: string; credential_id: string; key_hint: string | null; bound_by: string | null; bound_at: Date | string | null }>(
    `select b.input_name,b.credential_id,public.read_space_credential(b.credential_id)->>'keyHint' as key_hint,b.bound_by,b.bound_at from public.tool_secret_bindings b
     where b.tool_id=$1`, [toolId]);
  const actors = await loadActors(q, bindings.flatMap(value => value.bound_by ? [value.bound_by] : []));
  const [last] = await q.query<{ tool_source_sha256: string }>(`select w.tool_source_sha256 from public.work_sessions w
    join public.entities e on e.id=w.entity_id where w.tool_id=$1 and e.deleted_at is null
    and e.created_by=coalesce(internal.actor_id(),internal.current_member_id($2::uuid)) order by e.id desc limit 1`, [toolId, row.space_id]);
  const sha = createHash('sha256').update(definition.source).digest('hex');
  let sourceChangedSinceViewerLastRun: ToolView['sourceChangedSinceViewerLastRun'] = null;
  if (last && last.tool_source_sha256 !== sha) {
    const [edit] = await q.query<{ changed_by: string | null; changed_at: Date | string }>(`select v.changed_by,v.changed_at
      from public.entity_versions v where v.entity_id=$1 and v.snapshot#>>'{content,definition,source}'=$2
      and v.version>coalesce((select max(prior.version) from public.entity_versions prior where prior.entity_id=$1
        and prior.snapshot#>>'{content,definition,source}' is distinct from $2),0)
      order by v.version limit 1`, [toolId, definition.source]);
    if (edit) {
      const editor = edit.changed_by ? actorOf(await loadActors(q, [edit.changed_by]), edit.changed_by) : null;
      sourceChangedSinceViewerLastRun = { byActor: editor, at: new Date(edit.changed_at).toISOString(), fromSha: last.tool_source_sha256, toSha: sha };
    }
  }
  return { id: row.id, spaceId: row.space_id, version: Number(row.version), executionVersion: Number(row.execution_version), configRevision: Number(row.config_revision), definition,
    sourceSha256: sha, sourceChangedSinceViewerLastRun,
    config: Object.fromEntries(config.map(value => [value.input_name, value.value])),
    secretBindings: bindings.map(value => ({ inputName: value.input_name, credentialId: value.credential_id, keyHint: value.key_hint, boundAt: value.bound_at ? new Date(value.bound_at).toISOString() : null, boundBy: value.bound_by ? actorOf(actors, value.bound_by) : null })) };
}

export const RUN_SELECT = `select e.id,e.space_id,e.parent_id,e.created_by,w.tool_id,w.tool_version,w.tool_source_sha256,
 w.tool_inputs,w.tool_state,w.tool_keep_open,w.tool_exit_code,w.tool_started_at,w.tool_exited_at,w.tool_output_tail
 from public.entities e join public.work_sessions w on w.entity_id=e.id
 where w.session_kind='tool' and e.deleted_at is null and internal.entity_readable(e.id)`;
export interface ToolRunRow {
  id: string; created_by: string; space_id: string; parent_id: string | null; tool_id: string; tool_version: number; tool_source_sha256: string;
  tool_inputs: ToolRun['inputs']; tool_state: ToolRun['state']; tool_keep_open: boolean; tool_exit_code: number | null;
  tool_started_at: string | Date | null; tool_exited_at: string | Date | null; tool_output_tail: string;
}
const iso = (value: string | Date | null) => value === null ? null : new Date(value).toISOString();
export async function loadToolRun(q: Querier, sessionId: string): Promise<ToolRun> {
  const [row] = await q.query<ToolRunRow>(`${RUN_SELECT} and e.id=$1`, [sessionId]);
  if (!row) throw new CollabError('not_found', 'Tool run is unavailable');
  return { ...toolRunView(row), invoker: actorOf(await loadActors(q, [row.created_by]), row.created_by) };
}
