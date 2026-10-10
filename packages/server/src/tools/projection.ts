import { ToolRunSchema, ToolViewSchema, type ActorSummary, type ToolRun, type ToolView } from '@tm8/contract';
import { createHash } from 'node:crypto';

/** Shared by entity reads and event projection, with no credential material. */
export const TOOL_CONTENT_SQL = `case when e.kind='tool' then internal.entity_content(e.id) || jsonb_build_object(
 'secretBindings',coalesce((select jsonb_agg(jsonb_build_object('inputName',b.input_name,'credentialId',b.credential_id,
 'keyHint',c.key_hint,'boundBy',b.bound_by,'boundAt',b.bound_at)) from public.tool_secret_bindings b
 left join public.space_credentials c on c.id=b.credential_id where b.tool_id=e.id),'[]'::jsonb)) end`;

export const TOOL_RUN_SQL = `case when ws.session_kind='tool' then jsonb_build_object(
 'id',e.id,'spaceId',e.space_id,'parentSessionId',e.parent_id,'toolId',ws.tool_id,'toolVersion',ws.tool_version,
 'sourceSha256',ws.tool_source_sha256,'inputs',ws.tool_inputs,'state',ws.tool_state,'keepOpen',ws.tool_keep_open,
 'exitCode',ws.tool_exit_code,'startedAt',ws.tool_started_at,'exitedAt',ws.tool_exited_at,'outputTail',ws.tool_output_tail) end`;

interface RawToolContent {
 definition: ToolView['definition']; execution_version: number; config_revision: number; config: ToolView['config'];
 secretBindings: { inputName: string; credentialId: string; keyHint: string | null; boundBy: string | null; boundAt: string | null }[];
}
export function toolBindingActorIds(raw: unknown): string[] {
 return (raw as RawToolContent | null)?.secretBindings?.flatMap(b => b.boundBy ? [b.boundBy] : []) ?? [];
}
export function projectToolView(row: { id: string; space_id: string; version: number; tool_content?: unknown }, actors: Map<string, ActorSummary>): ToolView {
 const raw = row.tool_content as RawToolContent;
 return ToolViewSchema.parse({ id: row.id, spaceId: row.space_id, version: Number(row.version), definition: raw.definition,
  executionVersion: raw.execution_version, configRevision: raw.config_revision,
  sourceSha256: createHash('sha256').update(raw.definition.source).digest('hex'), config: raw.config,
  secretBindings: raw.secretBindings.map(b => ({ ...b, boundAt: b.boundAt ? new Date(b.boundAt).toISOString() : null,
   boundBy: b.boundBy ? actors.get(b.boundBy) ?? null : null })), sourceChangedSinceViewerLastRun: null });
}
export function projectToolRun(raw: unknown, invoker?: ActorSummary | null): ToolRun {
 const value = raw as ToolRun;
 return ToolRunSchema.parse({ ...value, startedAt: value.startedAt ? new Date(value.startedAt).toISOString() : null,
  exitedAt: value.exitedAt ? new Date(value.exitedAt).toISOString() : null, ...(invoker === undefined ? {} : { invoker }) });
}
export function toolRunView(row: { id: string; space_id: string; parent_id: string | null; tool_id: string; tool_version: number;
 tool_source_sha256: string; tool_inputs: ToolRun['inputs']; tool_state: ToolRun['state']; tool_keep_open: boolean;
 tool_exit_code: number | null; tool_started_at: string | Date | null; tool_exited_at: string | Date | null; tool_output_tail: string }): ToolRun {
 return projectToolRun({ id: row.id, spaceId: row.space_id, toolId: row.tool_id, toolVersion: Number(row.tool_version),
  sourceSha256: row.tool_source_sha256, inputs: row.tool_inputs, state: row.tool_state, keepOpen: row.tool_keep_open,
  exitCode: row.tool_exit_code, startedAt: row.tool_started_at, exitedAt: row.tool_exited_at,
  outputTail: row.tool_output_tail, parentSessionId: row.parent_id });
}
