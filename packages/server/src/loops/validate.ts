/**
 * Write-time validation of what a loop definition REFERS TO (design of record
 * 01a182d4 §2.1, §4.3; PR3, task 01a182d5-e482).
 *
 * The doors (378) keep the loop consistent with itself — action vs runner,
 * same-space teammate and tool. What they cannot judge is whether the things
 * the definition points at are what the firing will need: a project that is
 * not a project, a memory that is not a memory, an interaction profile from
 * another space, a stored tool input that no longer fits the tool's current
 * definition. Left unchecked, each of those surfaces only at fire time as a
 * `last_error` — hours after the human who typed it has gone. This module makes
 * them an `invalid_input` at `loops.create`/`loops.update`, naming the field.
 *
 * Judged on the ROW THE WRITE LEAVES, the same rule as 378's
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

function refused(field: string, message: string, extra: Record<string, unknown> = {}): CollabError {
  return new CollabError('invalid_input', message, { details: { field, ...extra } });
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

interface Reference { id: string; kind: string; field: string; what: string }

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
    if (!UUID_RE.test(ref.id)) throw refused(ref.field, `${ref.what} must be an entity id: ${ref.id}`, { ids: [ref.id] });
  }
  const ids = [...new Set(refs.map((ref) => ref.id))];
  const rows = await q.query<{ id: string; kind: string }>(
    `select e.id::text id, e.kind
       from public.entities e
      where e.id = any($1::uuid[]) and e.space_id = $2 and e.deleted_at is null`,
    [ids, spaceId],
  );
  const kinds = new Map(rows.map((row) => [row.id, row.kind]));
  const byField = new Map<string, { what: string; kind: string; bad: string[] }>();
  for (const ref of refs) {
    if (kinds.get(ref.id) === ref.kind) continue;
    const slot = byField.get(ref.field) ?? { what: ref.what, kind: ref.kind, bad: [] };
    slot.bad.push(ref.id);
    byField.set(ref.field, slot);
  }
  const [first] = byField;
  if (first) {
    const [field, { what, kind, bad }] = first;
    throw refused(field, `${what} must name ${bad.length === 1 ? 'a' : ''} live ${kind.replace('_', ' ')}${bad.length === 1 ? '' : 's'} in this space: ${bad.join(', ')}`, { ids: bad });
  }
}

/**
 * The definition's references, judged against the space. `action` decides
 * which references matter: a tool loop's inputs are checked against the tool's
 * CURRENT definition; a dispatch loop's `config` still has to be well-formed
 * (it is stored, and an edit to `action` later would launch with it).
 */
export async function assertLoopDefinitionReferences(q: Querier, spaceId: string, loop: LoopReferenceFields): Promise<void> {
  const config = strictLoopSpawnConfig(loop.config);
  const refs: Reference[] = [];
  if (loop.teamMemberId) {
    refs.push({ id: loop.teamMemberId, kind: 'team_member', field: 'definition.teamMemberId', what: 'teamMemberId' });
  }
  if (config.projectId) {
    refs.push({ id: config.projectId, kind: 'project', field: 'definition.config.projectId', what: 'config.projectId' });
  }
  if (config.interactionProfileId) {
    refs.push({ id: config.interactionProfileId, kind: 'interaction_profile', field: 'definition.config.interactionProfileId', what: 'config.interactionProfileId' });
  }
  for (const id of config.memoryIds ?? []) {
    refs.push({ id, kind: 'memory', field: 'definition.config.memoryIds', what: 'config.memoryIds' });
  }
  if (loop.toolId) {
    refs.push({ id: loop.toolId, kind: 'tool', field: 'definition.toolId', what: 'toolId' });
  }
  await assertReferencedEntities(q, spaceId, refs);

  if (loop.action === 'tool' && loop.toolId) {
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
export async function assertLoopReferences(q: Querier, loopId: string): Promise<void> {
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
  });
}
