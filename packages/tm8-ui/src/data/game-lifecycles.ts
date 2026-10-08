import {
  MAX_TASK_CANCELLATION_OBSERVATION_IDS,
  TaskCancellationObservationsSchema,
} from '@tm8/contract';
import type { MapInput } from '../story/game/map-model';
import type { Seam } from './seam';

type LifecycleReadPort = Pick<Seam, 'taskCancellationObservations'>;
type Read = <T>(get: () => Promise<T>) => Promise<T>;

/** Cold-load proven bounds into already admitted legacy cancellations only. */
export async function loadGameCancellationObservations(
  input: MapInput,
  seam: LifecycleReadPort,
  spaceId: string,
  read: Read = (get) => get(),
): Promise<MapInput> {
  if (!seam.taskCancellationObservations) return input;
  const ids = [...new Set(input.entities.filter((entity) =>
    entity.kind === 'task' && entity.status === 'cancelled' && entity.cancelledAt == null &&
    (!entity.spaceId || entity.spaceId === spaceId),
  ).map((entity) => entity.id))];
  const bounds = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += MAX_TASK_CANCELLATION_OBSERVATION_IDS) {
    const chunk = ids.slice(offset, offset + MAX_TASK_CANCELLATION_OBSERVATION_IDS);
    try {
      const response = TaskCancellationObservationsSchema.safeParse(
        await read(() => seam.taskCancellationObservations!(spaceId, chunk)),
      );
      if (!response.success || response.data.spaceId !== spaceId) continue;
      const requested = new Set(chunk);
      for (const fact of response.data.facts) {
        if (requested.has(fact.taskId)) bounds.set(fact.taskId, fact.statusChangedNotAfter);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // No fact was obtained. The model keeps the cancellation instant unknown.
    }
  }
  if (!bounds.size) return input;
  return {
    ...input,
    entities: input.entities.map((entity) => bounds.has(entity.id) && entity.kind === 'task' &&
      entity.status === 'cancelled' && entity.cancelledAt == null && (!entity.spaceId || entity.spaceId === spaceId) ? {
      ...entity,
      cancelledNotAfter: bounds.get(entity.id)!,
    } : entity),
  };
}
