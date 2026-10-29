/**
 * Write-time validation of what a loop definition REFERS TO (design of record
 * 01a182d4 §2.1, §4.3; PR3, task 01a182d5-e482).
 *
 * The doors (384) keep the loop consistent with itself — action vs runner,
 * same-space teammate and tool. What they cannot judge is whether the things
 * the definition points at are what the firing will need: a project that is
 * not a project, a memory that is not a memory, an interaction profile from
 * another space, a stored tool input that no longer fits the tool's current
 * definition. Left unchecked, each of those surfaces only at fire time as a
 * `last_error` — hours after the human who typed it has gone. This module makes
 * them an `invalid_input` at `loops.create`/`loops.update`, naming the field.
 *
 * Judged on the ROW THE WRITE LEAVES, the same rule as 384's
 * `assert_loop_runner`: the handler calls `assertLoopReferences` inside the
 * door's transaction, after the door, and a refusal rolls the write back. So a
 * patch that changes one field at a time cannot strand a loop with a dangling
 * reference, and the create and update paths share one check.
 *
 * Tool inputs are checked with `scheduledInputProblems`, the SAME function the
 * firing uses (`ToolRuntime.runScheduled`), so what passes here is exactly what
 * will pass at fire time against the same definition version.
 */
import { CollabError, LoopSpawnConfigSchema, type LoopSpawnConfig, type ToolJsonValue } from '@tm8/contract';
import type { Querier } from '../db/types.js';
import { scheduledInputProblems } from '../tools/runtime.js';
import { loadTool } from '../tools/views.js';

/** The stored columns the references live in. */
export interface LoopReferenceFields {
  readonly action: string;
  readonly teamMemberId: string | null;
  readonly toolId: string | null;
  readonly toolInputs: Record<string, ToolJsonValue>;
  readonly config: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PR1's write-time convention (loops/write.ts): the field path leads the message and rides `details.path`. */
function refused(path: string, message: string, extra: Record<string, unknown> = {}): CollabError {
  return new CollabError('invalid_input', `${path}: ${message}`, { details: { path, ...extra } });
}

/**
 * The stored `config`, STRICTLY: an unknown key is refused here (a backstop
 * for every writer, including the `entities.*` loop arm), where the firing
 * strips it (`loopSpawnConfig`).
 */
export function strictLoopSpawnConfig(raw: Record<string, unknown> | null | undefined): LoopSpawnConfig {
  const parsed = LoopSpawnConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw refused('definition.config', `loop config is invalid: ${issues}`);
  }
  return parsed.data;
}

interface Reference { id: string; kind: string; path: string; what: string }

/**
 * Every referenced entity must be live, in the loop's space, readable by the
 * writer and of the kind the field means. One read for all of them; the
 * refusal names the field and every offending id, like `execution.spawn` does
 * for `memoryIds`. An id the writer cannot read is indistinguishable from a
 * missing one (RLS answers both), so nothing about other spaces leaks.
 */
async function assertReferencedEntities(q: Querier, spaceId: string, refs: readonly Reference[]): Promise<void> {
  if (refs.length === 0) return;
  for (const ref of refs) {
    if (!UUID_RE.test(ref.id)) throw refused(ref.path, `${ref.what} must be an entity id: ${ref.id}`, { ids: [ref.id] });
  }
  const ids = [...new Set(refs.map((ref) => ref.id))];
  const rows = await q.query<{ id: string; kind: string }>(
    `select e.id::text id, e.kind
       from public.entities e
      where e.id = any($1::uuid[]) and e.space_id = $2 and e.deleted_at is null`,
    [ids, spaceId],
  );
  const kinds = new Map(rows.map((row) => [row.id, row.kind]));
  const byPath = new Map<string, { what: string; kind: string; bad: string[] }>();
  for (const ref of refs) {
    if (kinds.get(ref.id) === ref.kind) continue;
    const slot = byPath.get(ref.path) ?? { what: ref.what, kind: ref.kind, bad: [] };
    slot.bad.push(ref.id);
    byPath.set(ref.path, slot);
  }
  const [first] = byPath;
  if (first) {
    const [path, { what, kind, bad }] = first;
    const noun = kind.replace('_', ' ');
    throw refused(path, `${what} must name ${bad.length === 1 ? `a live ${noun}` : `live ${noun}s`} in this space: ${bad.join(', ')}`, { ids: bad });
  }
}

/**
 * `config.projectId` resolves the way a spawn resolves it (234: members do not
 * read `public.projects`; `resolve_project_ref` answers for the space's project
 * entity or its folder id, zero rows for anything the caller may not launch
 * in). The same resolver at write time means a project the firing could not
 * open is refused when it is typed, with no existence oracle for other spaces.
 */
async function assertProjectRef(q: Querier, spaceId: string, projectId: string): Promise<void> {
  const path = 'definition.config.projectId';
  if (!UUID_RE.test(projectId)) throw refused(path, `config.projectId must be a project id: ${projectId}`, { ids: [projectId] });
  const rows = await q.query<{ folder_id: string }>(
    'select folder_id from public.resolve_project_ref($1::uuid, $2::uuid)', [projectId, spaceId],
  );
  if (rows.length === 0) throw refused(path, `config.projectId must name a project of this space: ${projectId}`, { ids: [projectId] });
}

/**
 * The definition's references, judged against the space. `action` decides
 * which references matter: a tool loop's inputs are checked against the tool's
 * CURRENT definition; a dispatch loop's `config` still has to be well-formed
 * (it is stored, and an edit to `action` later would launch with it).
 */
export async function assertLoopDefinitionReferences(
  q: Querier, spaceId: string, loop: LoopReferenceFields, changed: LoopReferenceChange = EVERY_REFERENCE,
): Promise<void> {
  const config: LoopSpawnConfig = changed.config ? strictLoopSpawnConfig(loop.config) : {};
  const refs: Reference[] = [];
  if (changed.runner && loop.teamMemberId) {
    refs.push({ id: loop.teamMemberId, kind: 'team_member', path: 'definition.teamMemberId', what: 'teamMemberId' });
  }
  if (config.projectId) await assertProjectRef(q, spaceId, config.projectId);
  if (config.interactionProfileId) {
    refs.push({ id: config.interactionProfileId, kind: 'interaction_profile', path: 'definition.config.interactionProfileId', what: 'config.interactionProfileId' });
  }
  for (const id of config.memoryIds ?? []) {
    refs.push({ id, kind: 'memory', path: 'definition.config.memoryIds', what: 'config.memoryIds' });
  }
  if (changed.tool && loop.toolId) {
    refs.push({ id: loop.toolId, kind: 'tool', path: 'definition.toolId', what: 'toolId' });
  }
  await assertReferencedEntities(q, spaceId, refs);

  if (changed.tool && loop.action === 'tool' && loop.toolId) {
    const tool = await loadTool(q, loop.toolId);
    const problems = scheduledInputProblems(tool, loop.toolInputs);
    if (problems.length > 0) {
      throw refused(
        'definition.toolInputs',
        `toolInputs do not fit tool ${tool.definition.name} v${tool.version}: ${problems.join('; ')}`,
        { problems },
      );
    }
  }
}

/**
 * The call site for `loops.create`, `loops.update` and the `entities.*` loop
 * arm: inside the door's transaction, right after the door. Reads the row the
 * door left under the caller's claims and judges it; a throw rolls the write
 * back. `not_found` only when the row itself is unreadable, which after a
 * door call that returned means the caller is not who the door thought.
 */
export async function assertLoopReferences(q: Querier, loopId: string, changed: LoopReferenceChange = EVERY_REFERENCE): Promise<void> {
  const [row] = await q.query<{
    spaceId: string; action: string; teamMemberId: string | null; toolId: string | null;
    toolInputs: Record<string, ToolJsonValue> | null; config: Record<string, unknown> | null;
  }>(
    `select e.space_id::text "spaceId", l.action, l.team_member_id::text "teamMemberId",
            l.tool_id::text "toolId", l.tool_inputs "toolInputs", l.config
       from public.loops l join public.entities e on e.id = l.entity_id
      where l.entity_id = $1 and e.deleted_at is null`,
    [loopId],
  );
  if (!row) throw new CollabError('not_found', `loop ${loopId} is unavailable`);
  await assertLoopDefinitionReferences(q, row.spaceId, {
    action: row.action,
    teamMemberId: row.teamMemberId,
    toolId: row.toolId,
    toolInputs: row.toolInputs ?? {},
    config: row.config,
  }, changed);
}

/**
 * Which of a loop's references a write SETS, the only ones it is judged on (loops PR1 review B2: a
 * tool deleted after the loop was configured blocks nothing). A create sets them all, and so does
 * an action change, since what the loop launches then reads them. A reference that went stale
 * under the loop (a deleted tool, an edited tool definition, a deleted memory) never blocks a
 * rename or a schedule edit: the firing records it as the run's error and the loop's `last_error`.
 */
export interface LoopReferenceChange { readonly runner: boolean; readonly config: boolean; readonly tool: boolean }
export const EVERY_REFERENCE: LoopReferenceChange = { runner: true, config: true, tool: true };
