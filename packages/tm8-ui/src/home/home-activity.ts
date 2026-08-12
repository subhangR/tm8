/**
 * HOME ACTIVITY — the right column, projected from the DURABLE EVENT STREAM.
 *
 * THE SOURCE, and why it is this one. T5-1 annotation 6 says the activity
 * stream is "the event vocabulary rendered as rows: actor · verb · entity chip
 * · recency", which is literally `seam.onEvent`. There is no space-scoped
 * activity READ to page: `seam.activity(id)` is ENTITY-scoped, and the fixture
 * implementation calls `requireSummary(id)`, which THROWS for a space id — so a
 * "space activity" backfill does not exist behind this seam in either
 * implementation. What DOES exist, in both, is the stream.
 *
 * The consequence is stated on the screen rather than papered over: the column
 * shows what has happened SINCE HOME OPENED, its header says so, and
 * "↓ load earlier" renders DISABLED-WITH-REASON carrying D7.1's measured
 * reason (`homeActivityLoadEarlierReason`) — the ruling that reserved this
 * exact control, and the reason GateApp has been parking with the comment
 * "consumed by HomeView at fan-out". Filling the column from a fixture array
 * would look better and would be a lie on a screen whose whole job is triage.
 *
 * EVERY ROW SAYS ONLY WHAT ITS EVENT SAYS. An `entity.upsert` carries
 * `createdBy` — the entity's CREATOR, not whoever performed this change — so an
 * update row renders with NO actor rather than crediting the wrong one. That
 * restraint is the difference between a feed and a fabrication.
 */
import type { DurableWorkspaceEvent } from '@tm8/contract';
import { elapsed, weekdayDate } from '../kit/time';

export interface ActivityRow {
  /** Stable within a space: the envelope's monotonic seq (LLD §6 guarantee). */
  id: string;
  seq: number;
  /** Display name, or null when the event does not name one. Never guessed. */
  actor: string | null;
  /** Stable identity key for the shared Avatar; absent only on actorless events. */
  actorId?: string | null;
  actorAvatar?: string | null;
  isAgent: boolean;
  verb: string;
  /**
   * KIND + title of the thing the verb acted on, when the event carries it.
   *
   * The kind itself, not a mark for it: the row's icon is drawn from registry
   * artwork at render time (`KindIcon`), so this module stays a pure
   * projection and the screen owns the picture. It used to carry a text glyph
   * through an injected `glyphOf`, which is one indirection for a lookup the
   * view can do itself with the kind in hand.
   */
  objectKind: string | null;
  objectTitle: string | null;
  /** C1 target — null when the event names no entity, and then the row is inert. */
  objectId: string | null;
  at: string;
  tone: 'run' | 'wait' | 'block' | 'info' | 'idle' | 'brand';
}

/**
 * Project one durable event into a row, or `null` when the event has no
 * activity meaning on this screen.
 *
 * `notification.*` is deliberately dropped HERE: notifications are the MENTIONS
 * section's fact, and rendering them in both columns would double-count the
 * same event on one screen — the "1 live above a row saying not running"
 * failure shape, in a quieter register.
 */
export function activityRowOf(event: DurableWorkspaceEvent): ActivityRow | null {
  const seq = event.seq;
  const at = event.occurredAt;
  const base = { seq, at, id: `${event.spaceId}#${seq}` };

  switch (event.type) {
    case 'activity.created': {
      const item = event.activity;
      return {
        ...base,
        actor: item.actor?.displayName ?? null,
        actorId: item.actor?.id ?? null,
        actorAvatar: item.actor?.avatar ?? null,
        isAgent: item.actor?.isAgent === true,
        verb: item.verb.replace(/_/g, ' '),
        objectKind: null,
        objectTitle: titleFromSummary(item.summary),
        objectId: item.entityId ?? null,
        at: item.createdAt || at,
        tone: 'info',
      };
    }
    case 'entity.upsert': {
      const entity = event.entity;
      // The ONE case where `createdBy` is honestly the actor: an entity whose
      // createdAt and updatedAt still agree has only ever been created.
      const isCreate = entity.createdAt === entity.updatedAt;
      return {
        ...base,
        actor: isCreate ? entity.createdBy.displayName : null,
        actorId: isCreate ? entity.createdBy.id : null,
        actorAvatar: isCreate ? entity.createdBy.avatar ?? null : null,
        isAgent: isCreate ? entity.createdBy.isAgent : false,
        verb: isCreate ? 'created' : 'updated',
        objectKind: entity.kind,
        objectTitle: entity.title,
        objectId: entity.id,
        tone: isCreate ? 'run' : 'info',
      };
    }
    case 'entity.deleted': {
      const entity = event.entity;
      return {
        ...base,
        actor: null,
        actorId: null,
        actorAvatar: null,
        isAgent: false,
        verb: 'deleted',
        objectKind: entity.kind,
        objectTitle: entity.title,
        objectId: null,
        tone: 'block',
      };
    }
    case 'message.created': {
      const author = event.message.state.author;
      return {
        ...base,
        actor: author.displayName,
        actorId: author.id,
        actorAvatar: author.avatar ?? null,
        isAgent: author.isAgent,
        verb: 'posted',
        objectKind: null,
        objectTitle: excerptOf(event.message.title),
        objectId: event.anchorId,
        tone: 'brand',
      };
    }
    case 'notification.created':
    case 'notification.read':
      return null;
    default:
      return null;
  }
}

/**
 * The rolling window. Newest first, capped — an unbounded array on a screen
 * that may stay open for a day is a leak, and a silent truncation is worse
 * than a stated one, so `ACTIVITY_WINDOW` is exported and the screen says it.
 */
export const ACTIVITY_WINDOW = 60;

export function appendActivity(
  current: readonly ActivityRow[],
  next: ActivityRow,
): ActivityRow[] {
  // The seq spine is the dedupe key (AM-2 §3), so a replayed catch-up frame
  // cannot double a row even though the stream already guarantees it won't.
  if (current.some((row) => row.id === next.id)) return current as ActivityRow[];
  return [next, ...current].slice(0, ACTIVITY_WINDOW);
}

/**
 * The day markers the oracle draws (TODAY / YESTERDAY / an explicit date).
 * Computed against a passed-in `now` so it is testable and never reads the
 * clock behind the caller's back.
 */
export function dayBucketOf(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'UNDATED';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(then)) / 86_400_000);
  if (days <= 0) return 'TODAY';
  if (days === 1) return 'YESTERDAY';
  return weekdayDate(then).toUpperCase();
}

/** Group into the oracle's day-marked runs, order preserved. */
export function bucketActivity(
  rows: readonly ActivityRow[],
  now: Date,
): { label: string; rows: ActivityRow[] }[] {
  const out: { label: string; rows: ActivityRow[] }[] = [];
  for (const row of rows) {
    const label = dayBucketOf(row.at, now);
    const tail = out[out.length - 1];
    if (tail && tail.label === label) tail.rows.push(row);
    else out.push({ label, rows: [row] });
  }
  return out;
}

/** Relative recency in the canvas's mono voice: 12m · 1h · 3h · 1d. */
export function recencyOf(iso: string, now: Date): string {
  return elapsed(iso, now.getTime()) || '—';
}

function titleFromSummary(summary: Record<string, unknown>): string | null {
  const title = summary?.['title'];
  return typeof title === 'string' ? title : null;
}

function excerptOf(text: string): string {
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}
