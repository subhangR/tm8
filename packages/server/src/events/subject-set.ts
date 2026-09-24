/**
 * The canonical subject set — which entity ids a `workspace_events` row is
 * ABOUT, by event type (migration 208, spec doc 01a0cf35 §4 Storage).
 *
 * The database derives `workspace_events.subject_ids` with
 * `internal.event_subject_ids`; this is the same table written down in
 * TypeScript so the server can reason about it without a round trip, and so a
 * test can hold the two to each other. test/events/subject-set.pg.test.ts pins
 * BOTH directions: every type the mapper projects is classified here (as a
 * subject type or as subjectless), and the SQL function agrees with
 * `subjectIdsOf` on every one of them. Adding an event type without deciding
 * its subjects fails that test, which is the point — the two change-feed steps
 * once disagreed silently about `counter.changed` and `git.*`.
 *
 * `git.*` is IN: a git fact names only its PR/commit/worktree entity, and the
 * change feed's `pr`/`commit` classes find those rows through this set.
 * `counter.changed` is IN: it names its `entity_id`; the change feed drops it
 * from the digest (§3.2), but "what is this row about" is not "what does one
 * consumer render".
 */

/** Event type → the payload keys holding its subject entity ids. */
export const EVENT_SUBJECT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'entity.upsert': ['id'],
  'entity.deleted': ['id'],
  'entity.activity_touched': ['id'],
  'edge.upsert': ['src_id', 'dst_id'],
  'edge.deleted': ['src_id', 'dst_id'],
  'message.created': ['entity_id', 'anchor_id'],
  'message.updated': ['entity_id', 'anchor_id'],
  'message.deleted': ['entity_id', 'anchor_id'],
  'counter.changed': ['entity_id'],
  'activity.created': ['entity_id'],
  'notification.created': ['target_entity_id'],
  'notification.read': ['target_entity_id'],
  'git.commit_recorded': ['commitEntityId'],
  'git.pr_state_changed': ['prEntityId'],
  'git.worktree_status_changed': ['worktreeEntityId'],
});

/** Projected types that are about no entity: they index as `'{}'`, never NULL. */
export const SUBJECTLESS_EVENT_TYPES: readonly string[] = Object.freeze([
  'menu.updated',
  'space.default_channel.updated',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The TypeScript twin of `internal.event_subject_ids`: distinct, sorted, uuid-shaped only. */
export function subjectIdsOf(eventType: string, payload: Record<string, unknown>): string[] {
  const keys = EVENT_SUBJECT_KEYS[eventType] ?? [];
  const ids = keys
    .map((k) => payload[k])
    .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
    .map((v) => v.toLowerCase());
  return [...new Set(ids)].sort();
}
