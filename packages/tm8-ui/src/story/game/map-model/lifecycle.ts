import { isCancelledTask, isDoneTask } from './progress';
import type { MapEntity, MapPlace } from './types';

export const RUBBLE_TTL_MS = 24 * 60 * 60 * 1000;
export const isCompletedSession = (n: MapEntity): boolean => n.kind === 'work_session' &&
  (n.outcome === 'completed' || (!n.outcome && n.endedKind === 'completed') ||
    (!n.outcome && !n.endedKind && (n.status === 'completed' || n.processState === 'completed')));
export const isActiveMapEdge = (edge: { endedAt?: string | null; status?: string | null }): boolean =>
  !edge.endedAt && !['ended', 'cancelled', 'inactive', 'removed'].includes(edge.status ?? '');

/** Unknown evidence has no expiry, rather than a fabricated reload-time TTL. */
export function rubbleLifetime(entity: MapEntity, now: number, previous?: MapPlace) {
  if (!isCancelledTask(entity)) return { cancelledAt: null, expiresAt: null, removalNotAfter: null, expired: false };
  const cancelledAt = entity.cancelledAt ?? (previous?.constructionStage === 'rubble' ? previous.cancelledAt : null) ?? null;
  const at = cancelledAt && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(cancelledAt) ? Date.parse(cancelledAt) : NaN;
  const expiresAt = Number.isFinite(at) ? at + RUBBLE_TTL_MS : null;
  const bound = entity.cancelledNotAfter && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(entity.cancelledNotAfter) ? Date.parse(entity.cancelledNotAfter) : NaN;
  const removalNotAfter = expiresAt === null && Number.isFinite(bound) ? bound + RUBBLE_TTL_MS : null;
  const deadline = expiresAt ?? removalNotAfter;
  return { cancelledAt: expiresAt === null ? null : cancelledAt, expiresAt, removalNotAfter,
    expired: deadline !== null && now >= deadline };
}

/** Foundation anchors stay while an unshipped yard (including rubble) remains. */
export function shippingAncestors(entities: readonly MapEntity[], retained: ReadonlySet<string>): Set<string> {
  const byId = new Map(entities.filter(n => n.kind === 'task').map(n => [n.id, n]));
  const ancestors = new Set<string>();
  for (const id of retained) {
    let parent = byId.get(id)?.parentId;
    const seen = new Set([id]);
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      if (isDoneTask(byId.get(parent)!)) ancestors.add(parent);
      parent = byId.get(parent)!.parentId;
    }
  }
  return ancestors;
}
