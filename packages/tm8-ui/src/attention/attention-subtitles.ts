/**
 * The words the S5b surfaces print about a request — one copy, so the tile
 * subtitle, the detail block, the session banner and the roll-up line can never
 * describe the same request two ways (chapter 4, mock tabs 3-5).
 *
 * Pure functions over the contract row: no store, no seam. The surfaces read the
 * rows from the module's selectors and hand them here.
 */
import type { AttentionRequest, EntityId } from '@tm8/contract';

/** `#a41f`: the last four hex digits. A v7 uuid's head is its timestamp, so
 *  sibling sessions started the same minute share it; the tail does not. */
export function shortSessionId(id: string): string {
  return `#${id.replace(/-/g, '').slice(-4)}`;
}

/** Coarse age, as the mock prints it: `now`, `40m`, `3h`, `2d`, `3w`. */
export function attentionAge(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 2) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * The session/chat tile's subtitle (F1): `waiting on you: <latest reason>`, or
 * `ended · waiting on you: …` once the asker is gone. The marker survives the
 * session ending; only resolve, withdraw or clear removes it.
 */
export function sessionWaitingLine(latestReason: string, ended: boolean): string {
  return `${ended ? 'ended · ' : ''}waiting on you: ${latestReason}`;
}

/**
 * Whether a request was pinned somewhere OTHER than the root it counts on —
 * a session's `working_on` task, a form's `attached_to` task (chapter 1).
 */
export function isRolledUp(request: AttentionRequest, root: EntityId): boolean {
  return request.entityId !== root;
}

/** How a rolled-up request's origin is named: a session by its short id, a
 *  form or other child by the title the host knows, else its short id. */
export function viaLabel(
  request: AttentionRequest,
  titleOf?: (id: string) => string | null | undefined,
): string {
  if (request.sourceWorkSessionId && request.entityId === request.sourceWorkSessionId) {
    return `session ${shortSessionId(request.entityId)}`;
  }
  return titleOf?.(request.entityId) ?? shortSessionId(request.entityId);
}

/**
 * The roll-up root's subtitle (mock tab 5):
 * `3 requests · 2 own, 1 via session #c09e`. Null when nothing is rolled up —
 * a root whose requests are all its own needs no breakdown; its chip says it.
 */
export function rollupLine(
  root: EntityId,
  requests: readonly AttentionRequest[],
  titleOf?: (id: string) => string | null | undefined,
): string | null {
  const via = requests.filter((r) => isRolledUp(r, root));
  if (via.length === 0) return null;
  const own = requests.length - via.length;
  const sources = [...new Set(via.map((r) => viaLabel(r, titleOf)))];
  const from = sources.length === 1 ? sources[0] : `${sources.length} sources`;
  const noun = requests.length === 1 ? 'request' : 'requests';
  return `${requests.length} ${noun} · ${own} own, ${via.length} via ${from}`;
}

/**
 * Where the one note in a block goes (chapter 3): the raising session when there
 * is one, `N sessions` when several asked, otherwise the root's own thread.
 */
export function noteTarget(requests: readonly AttentionRequest[], rootNoun: string): string {
  const sessions = [...new Set(requests.map((r) => r.sourceWorkSessionId).filter((s): s is EntityId => !!s))];
  if (sessions.length === 1) return `sent to session ${shortSessionId(sessions[0]!)}`;
  if (sessions.length > 1) return `sent to ${sessions.length} sessions`;
  return `posted on this ${rootNoun}`;
}

/** The session a request came from, as the block's jump line reads it. */
export function sourceLine(request: AttentionRequest): { id: EntityId | null; text: string } {
  const id = request.sourceWorkSessionId ?? null;
  if (!id) return { id: null, text: 'session unknown' };
  if (request.sourceSessionLive === false) return { id, text: `session ${shortSessionId(id)} ended` };
  return { id, text: `session ${shortSessionId(id)}` };
}
