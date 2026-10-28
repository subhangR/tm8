/**
 * A loop's spawn configuration becomes a `SpawnRequest` (design of record
 * 01a182d4 §3.4 "spawn"; PR3, task 01a182d5-e482).
 *
 * `loops.config` holds exactly what is PASSED THROUGH to `execution.spawn`
 * (§2.1: anything the executor branches on is a column instead), validated by
 * `LoopSpawnConfigSchema` on every write. Here it is mapped 1:1 onto the
 * request the public `execution.spawn` handler would build from the same
 * fields — one field per field, no defaulting of its own, so a loop launches
 * exactly what a human would have launched by hand with those settings.
 *
 * Before this module only `model`, `agentTool` and `accessMode` travelled and
 * `projectId` was forced to null, so a loop could never run in a project
 * checkout, never pick a reasoning effort, never hand over memories.
 */
import { CollabError, LoopSpawnConfigSchema, type LoopSpawnConfig } from '@tm8/contract';
import type { SpawnRequest } from '@tm8/execution';

/** The loop columns a spawn firing reads, after the action branch chose `spawn`. */
export interface SpawnLoopFields {
  readonly spaceId: string;
  /** Non-null by the door's invariant: a spawn loop names its runner. */
  readonly teamMemberId: string;
  readonly title: string;
  readonly prompt: string;
  readonly config: Record<string, unknown> | null;
}

/**
 * The stored `config` as the schema reads it at fire time.
 *
 * Unknown keys are STRIPPED here, not refused: the write path (`loops.create`,
 * `loops.update`, `assertLoopReferences`) is where an unknown key is an error a
 * human can fix; at fire time the only rows that can carry one predate the
 * schema, and refusing to fire them would retire a schedule over a key nobody
 * reads. A known key with an invalid value IS refused — the firing records it
 * as `last_error` rather than launching something other than what was asked.
 */
export function loopSpawnConfig(raw: Record<string, unknown> | null | undefined): LoopSpawnConfig {
  const parsed = LoopSpawnConfigSchema.strip().safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new CollabError('invalid_input', `loop config is invalid: ${issues}`, {
      details: { field: 'definition.config' },
    });
  }
  return parsed.data;
}

/**
 * Every `LoopSpawnConfig` field travels; nothing else is invented.
 *
 * Optional request fields are SPREAD rather than set to `undefined`, matching
 * the public handler: `SpawnRequest` is written under
 * `exactOptionalPropertyTypes`, and an explicit `undefined` is not an absence.
 * The provenance root (`triggeredByLoopId`) is deliberately NOT here — it is
 * a server fact that travels in `spawn`'s second argument (348), never on the
 * request a client could have built.
 */
export function spawnRequestForLoop(loop: SpawnLoopFields, taskId: string, firingKey: string): SpawnRequest {
  const config = loopSpawnConfig(loop.config);
  return {
    spaceId: loop.spaceId,
    teamMemberId: loop.teamMemberId,
    parentSessionId: null,
    taskIds: [taskId],
    projectId: config.projectId ?? null,
    ...(config.workdir
      ? {
          workdir: {
            mode: config.workdir.mode,
            ...(config.workdir.baseRef !== undefined ? { baseRef: config.workdir.baseRef } : {}),
          },
        }
      : {}),
    ...(config.interactionProfileId ? { interactionProfileId: config.interactionProfileId } : {}),
    mode: config.mode ?? null,
    model: config.model ?? null,
    agentTool: config.agentTool ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    // Defaults to the persona's own posture when null, never silently fullAccess (§7).
    accessMode: config.accessMode ?? null,
    credentialSource: config.credentialSource ?? null,
    ...(config.memoryIds && config.memoryIds.length > 0 ? { memoryIds: [...config.memoryIds] } : {}),
    title: loop.title,
    // The loop's instruction is launch-manifest context, not a runtime
    // prompt — the same channel `--context` uses.
    promptExtra: loop.prompt === '' ? null : loop.prompt,
    clientMutationId: `loop-fire:${firingKey}`,
  };
}
