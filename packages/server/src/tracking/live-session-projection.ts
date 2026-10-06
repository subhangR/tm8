import type { TaskLiveSession } from '@tm8/contract';
import type { Querier } from '../db/types.js';

/**
 * `badges.liveSession` for a page of rows — THE loader, called by both
 * assemblers (`facade/entity-read.ts` and `events/projector.ts`), for the same
 * reason `loadLinkedPullRequestBadges` is shared: a chip that renders on load
 * and vanishes on the next live `entity.upsert` reads as the work moving.
 *
 * Task P0g (01a111b2-aaf2). The 6 Oct 2026 audit (doc 01a111b7-3ab4) found 211
 * of 219 working or blocked tasks with no live session on them, and nobody
 * could tell. The owner's policy (form 01a111ba-85b5) is FLAG ONLY: this badge
 * is the flag, and nothing here or anywhere else changes a task's status.
 *
 * Only `working` and `blocked` tasks get the badge: `open` has no one by
 * definition, `in_review` legitimately outlives its session (Spec D1 R3), and
 * done or cancelled work has stopped.
 *
 * A claim is a `working_on` edge into the task with no `props.endedAt` (302).
 * A session claim counts only while its session's outcome is `open`: a
 * completed or stopped session's claims have ended, or are about to.
 */

/** A person's claim with no activity from them for this long is flagged (owner, 6 Oct). */
export const PERSON_IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const LIVE_PROCESS = new Set(['spawning', 'running', 'idle']);

interface ClaimRow {
  task_id: string;
  src_id: string;
  src_kind: string;
  props: Record<string, unknown> | null;
  created_at: Date | string;
  ws_status: string | null;
  ws_outcome: string | null;
  ws_status_changed_at: Date | string | null;
  holder_last_message_at: Date | string | null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function propIso(props: Record<string, unknown> | null, key: string): string | null {
  const v = props?.[key];
  return typeof v === 'string' && v !== '' ? iso(v) : null;
}

function latest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v !== null && (best === null || v > best)) best = v;
  return best;
}

/**
 * The verdict for one task from its claim rows (pure, so tests can pin every
 * branch without a database). `now` is injectable for the 7-day rule.
 */
export function liveSessionOf(claims: readonly ClaimRow[], now: number = Date.now()): TaskLiveSession {
  const active = claims.filter((c) => propIso(c.props, 'endedAt') === null);
  const sessions = active.filter(
    (c) => c.src_kind === 'work_session' && (c.ws_outcome ?? 'open') === 'open',
  );

  const live = sessions.filter((c) => LIVE_PROCESS.has(c.ws_status ?? ''));
  if (live.length > 0) {
    const first = [...live].sort((a, b) =>
      (propIso(a.props, 'startedAt') ?? iso(a.created_at) ?? '').localeCompare(
        propIso(b.props, 'startedAt') ?? iso(b.created_at) ?? ''),
    )[0]!;
    return {
      state: 'live',
      since: propIso(first.props, 'startedAt') ?? iso(first.created_at),
      sessionId: first.src_id,
    };
  }

  if (sessions.length > 0) {
    const down = [...sessions].sort((a, b) =>
      (iso(b.ws_status_changed_at) ?? '').localeCompare(iso(a.ws_status_changed_at) ?? ''),
    )[0]!;
    return { state: 'session_down', since: iso(down.ws_status_changed_at), sessionId: down.src_id };
  }

  const people = active.filter((c) => c.src_kind === 'member');
  if (people.length > 0) {
    const lastActivity = latest(
      people.flatMap((c) => [
        propIso(c.props, 'startedAt'),
        iso(c.created_at),
        iso(c.holder_last_message_at),
      ]),
    );
    const idle = lastActivity === null || now - Date.parse(lastActivity) >= PERSON_IDLE_AFTER_MS;
    return { state: idle ? 'person_idle' : 'person', since: lastActivity, sessionId: null };
  }

  return {
    state: 'no_session',
    since: latest(claims.map((c) => propIso(c.props, 'endedAt'))),
    sessionId: null,
  };
}

export async function loadTaskLiveSessionBadges(
  q: Querier,
  // Structural, not `EntityRow`: the projector assembles from its own row type.
  rows: readonly { id: string; kind: string }[],
  now: number = Date.now(),
): Promise<Map<string, TaskLiveSession>> {
  const out = new Map<string, TaskLiveSession>();
  const taskIds = [...new Set(rows.filter((r) => r.kind === 'task').map((r) => r.id))];
  if (taskIds.length === 0) return out;

  // The status gate is read HERE, not from the caller's row, so both
  // assemblers answer from the same fact. A task with no claim row at all
  // still comes back (left join) — that is the `no_session` case.
  const result = await q.query<ClaimRow & { work_status: string }>(
    `select t.entity_id as task_id, t.work_status,
            g.src_id, s.kind as src_kind, g.props, g.created_at,
            ws.status as ws_status, ws.outcome as ws_outcome,
            ws.status_changed_at as ws_status_changed_at,
            (select max(m.created_at) from public.messages m
              where m.anchor_id = t.entity_id and m.author_id = g.src_id
                and s.kind = 'member') as holder_last_message_at
       from public.tasks t
       left join public.edges g on g.dst_id = t.entity_id and g.type = 'working_on'
       left join public.entities s on s.id = g.src_id and s.deleted_at is null
       left join public.work_sessions ws on ws.entity_id = g.src_id
      where t.entity_id = any($1::uuid[])
        and t.work_status in ('working', 'blocked')`,
    [taskIds],
  );

  const byTask = new Map<string, ClaimRow[]>();
  for (const row of result) {
    // Querier is an external seam and some contract tests use broad fakes
    // that answer every SELECT with their fixture row: validate the shape.
    if (typeof row.task_id !== 'string' || !taskIds.includes(row.task_id)) continue;
    if (row.work_status !== 'working' && row.work_status !== 'blocked') continue;
    const list = byTask.get(row.task_id) ?? [];
    // A source the left join could not resolve (deleted, or no edge) is no claim.
    if (typeof row.src_id === 'string' && typeof row.src_kind === 'string') list.push(row);
    byTask.set(row.task_id, list);
  }
  for (const [taskId, claims] of byTask) out.set(taskId, liveSessionOf(claims, now));
  return out;
}
