/**
 * THE ATTENTION SELECTORS — pure functions over the store's state (Attention
 * v2, chapter 5 "UI: one module"). Every surface reads attention through these
 * four, via `useAttention()`: `chipFor(entity)`, `counts()`, `queue(filter)`,
 * `requestsFor(root)`. None of them fetch; the store feeds them.
 *
 * Definitions they settle ONCE for the whole UI (chapter 1):
 * - PENDING is `open` plus legacy `acknowledged`, read as open. The old inbox
 *   read `open` only and disagreed with the dock; that split ends here.
 * - A request counts against its ROLL-UP ROOT (`rootId`, else its own entity).
 *   An entity's chip covers requests rolled up to it AND requests pinned on it,
 *   the same rule as `attention_badges` (migration 255).
 * - COUNTS are distinct roots. `all` is every root; `mine` is roots with a
 *   request assigned to the viewer. Unassigned is never mine. FYI counts. Seen
 *   never reduces either number.
 * - ORDER is unseen-by-me first, then level (urgent > high > normal > fyi),
 *   then total points desc, then oldest first.
 */
import type {
  AttentionLevel,
  AttentionRequest,
  AttentionRequestStatus,
  EntityAttentionSummary,
  EntityId,
} from '@tm8/contract';

/** The one pending set. Legacy `acknowledged` is open (chapter 1). */
export const PENDING_STATUSES: readonly AttentionRequestStatus[] = ['open', 'acknowledged'];

export function isPending(row: Pick<AttentionRequest, 'status'>): boolean {
  return PENDING_STATUSES.includes(row.status);
}

const LEVEL_RANK: Readonly<Record<AttentionLevel, number>> = { fyi: 0, normal: 1, high: 2, urgent: 3 };

export function levelRank(level: AttentionLevel): number {
  return LEVEL_RANK[level];
}

/** A row with no level is a legacy row, and legacy rows default to `normal` (chapter 1). */
export function levelOf(row: Pick<AttentionRequest, 'level'>): AttentionLevel {
  return row.level ?? 'normal';
}

export function rootOf(row: Pick<AttentionRequest, 'rootId' | 'entityId'>): EntityId {
  return row.rootId ?? row.entityId;
}

/** Whether `row` shows on `entityId`'s chip: rolled up to it, or pinned on it. */
export function countsOn(row: Pick<AttentionRequest, 'rootId' | 'entityId'>, entityId: EntityId): boolean {
  return rootOf(row) === entityId || row.entityId === entityId;
}

/** The chip's inputs (chapter 4 "The chip"). */
export interface AttentionChip {
  level: AttentionLevel;
  /** `i` for FYI, `!` otherwise. */
  icon: 'i' | '!';
  /** grey for FYI, amber (`--pn-wait`) for normal/high, red (`--pn-block`) for urgent. */
  tone: 'fyi' | 'wait' | 'block';
  totalPoints: number;
  pendingCount: number;
  /** Age anchor: the oldest pending request. */
  oldestRequestedAt: string;
  latestReason: string;
}

export function chipLook(level: AttentionLevel): Pick<AttentionChip, 'icon' | 'tone'> {
  if (level === 'fyi') return { icon: 'i', tone: 'fyi' };
  if (level === 'urgent') return { icon: '!', tone: 'block' };
  return { icon: '!', tone: 'wait' };
}

/** The highest level among rows, or null for none. */
export function maxLevelOf(rows: readonly Pick<AttentionRequest, 'level'>[]): AttentionLevel | null {
  let best: AttentionLevel | null = null;
  for (const row of rows) {
    const level = levelOf(row);
    if (best === null || LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  }
  return best;
}

/** A chip from request rows; null when there are none. */
export function chipFromRows(rows: readonly AttentionRequest[]): AttentionChip | null {
  if (rows.length === 0) return null;
  let totalPoints = 0;
  let oldest = rows[0]!;
  let latest = rows[0]!;
  for (const row of rows) {
    totalPoints += row.points;
    if (row.createdAt < oldest.createdAt) oldest = row;
    // Strictly-later wins, so equal timestamps keep a stable reason.
    if (row.createdAt > latest.createdAt) latest = row;
  }
  const level = maxLevelOf(rows) ?? 'normal';
  return {
    level,
    ...chipLook(level),
    totalPoints,
    pendingCount: rows.length,
    oldestRequestedAt: oldest.createdAt,
    latestReason: latest.reason,
  };
}

/**
 * A chip from the server badge. `maxLevel` is read loosely: migration 255's
 * `attention_badges` computes it, but the contract summary does not carry it
 * yet. When absent, the level comes from `rowsLevel` (the store's rows for this
 * entity), else `normal`.
 */
export function chipFromBadge(
  badge: EntityAttentionSummary | null | undefined,
  rowsLevel: AttentionLevel | null,
): AttentionChip | null {
  if (!badge || badge.pendingCount <= 0) return null;
  const loose = (badge as EntityAttentionSummary & { maxLevel?: AttentionLevel | null }).maxLevel;
  const level = rowsLevel ?? loose ?? 'normal';
  return {
    level,
    ...chipLook(level),
    totalPoints: badge.totalPoints,
    pendingCount: badge.pendingCount,
    oldestRequestedAt: badge.oldestRequestedAt,
    latestReason: badge.latestReason,
  };
}

export type AttentionFilter = 'mine' | 'all';

export interface AttentionCounts {
  /** Roots with a pending request assigned to the viewer. */
  mine: number;
  /** Every root with a pending request. */
  all: number;
}

/** One popover / queue row: one roll-up root with its requests combined. */
export interface AttentionQueueRow {
  rootId: EntityId;
  /** Hydrated lazily; null until known. Render the id, styled as an id, meanwhile. */
  title: string | null;
  kind: string | null;
  chip: AttentionChip;
  /** Newest first. */
  requests: readonly AttentionRequest[];
  /** The most recently raised request: its reason, type and source head the row. */
  latest: AttentionRequest;
  /** Every request on the row has been seen by the viewer (the row dims). */
  seen: boolean;
  /** At least one request is assigned to the viewer. */
  mine: boolean;
  /** Requests pinned somewhere other than the root (a session or form), i.e. rolled up. */
  rolledUp: number;
}

export interface EntityName {
  title: string;
  kind: string;
}

function newestFirst(a: AttentionRequest, b: AttentionRequest): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** Group pending rows by roll-up root. Settled roots are excluded by the caller. */
export function groupByRoot(rows: readonly AttentionRequest[]): Map<EntityId, AttentionRequest[]> {
  const byRoot = new Map<EntityId, AttentionRequest[]>();
  for (const row of rows) {
    if (!isPending(row)) continue;
    const root = rootOf(row);
    const list = byRoot.get(root);
    if (list) list.push(row);
    else byRoot.set(root, [row]);
  }
  return byRoot;
}

export function isMine(rows: readonly AttentionRequest[], viewerId: string | null | undefined): boolean {
  if (!viewerId) return false;
  return rows.some((row) => row.assigneeId != null && row.assigneeId === viewerId);
}

export function countsOf(
  byRoot: ReadonlyMap<EntityId, readonly AttentionRequest[]>,
  viewerId: string | null | undefined,
): AttentionCounts {
  let mine = 0;
  for (const rows of byRoot.values()) if (isMine(rows, viewerId)) mine += 1;
  return { mine, all: byRoot.size };
}

/** The queue in chapter 1's order, optionally narrowed to the viewer's own. */
export function buildQueue(
  byRoot: ReadonlyMap<EntityId, readonly AttentionRequest[]>,
  options: {
    filter: AttentionFilter;
    viewerId: string | null | undefined;
    names: ReadonlyMap<EntityId, EntityName>;
  },
): AttentionQueueRow[] {
  const out: AttentionQueueRow[] = [];
  for (const [rootId, group] of byRoot) {
    const chip = chipFromRows(group);
    if (!chip) continue;
    const mine = isMine(group, options.viewerId);
    if (options.filter === 'mine' && !mine) continue;
    const requests = [...group].sort(newestFirst);
    const name = options.names.get(rootId);
    out.push({
      rootId,
      title: name?.title ?? null,
      kind: name?.kind ?? null,
      chip,
      requests,
      latest: requests[0]!,
      seen: requests.every((row) => row.seenByMe === true),
      mine,
      rolledUp: requests.filter((row) => row.entityId !== rootId).length,
    });
  }
  return out.sort((a, b) => Number(a.seen) - Number(b.seen)
    || LEVEL_RANK[b.chip.level] - LEVEL_RANK[a.chip.level]
    || b.chip.totalPoints - a.chip.totalPoints
    || a.chip.oldestRequestedAt.localeCompare(b.chip.oldestRequestedAt)
    || a.rootId.localeCompare(b.rootId));
}

/** Pending requests shown on `entityId` (own and rolled up), newest first. */
export function requestsOn(rows: readonly AttentionRequest[], entityId: EntityId): AttentionRequest[] {
  return rows.filter((row) => isPending(row) && countsOn(row, entityId)).sort(newestFirst);
}

/** Pending requests RAISED by a session or chat, wherever pinned (F1). */
export function requestsRaisedBy(rows: readonly AttentionRequest[], sessionId: EntityId): AttentionRequest[] {
  return rows.filter((row) => isPending(row) && row.sourceWorkSessionId === sessionId).sort(newestFirst);
}

/** Compact age: `45s`, `12m`, `3h`, `2d`. */
export function formatAge(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
