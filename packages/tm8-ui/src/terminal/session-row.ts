import type { ActorSummary, EntitySummary, WorkSessionStatus } from '@tm8/contract';

/**
 * SessionRow — the narrow view-model the live-session bar and the roster
 * render. Deliberately not `EntitySummary`.
 *
 * TWO REASONS, both structural:
 *
 * 1. B7 / §15.2 — the shell may not contain a kind literal. If these
 *    components took `EntitySummary` they would have to reach into
 *    `state.kind === 'work_session'` to find the session fields, which is
 *    exactly the build failure the rule names. Projecting once, at the wiring
 *    edge, keeps every rendering module literal-free.
 *
 * 2. It makes the forbidden inference impossible to write by accident. There
 *    is no `activityAt` on this shape, so no component downstream can quietly
 *    derive liveness from recency (D6). Liveness arrives only as a verdict,
 *    passed in beside the row.
 */
export interface SessionRow {
  id: string;
  /** Actor attributed by the server; real projections always supply it. */
  actor?: ActorSummary;
  /** Persona name — "forge", "scout". */
  name: string;
  /** Avatar initial; defaults to the first character of `name`. */
  initial?: string;
  /** Model/tool, e.g. "claude-fable-5". The first thing dropped when narrow. */
  provider?: string | null;
  /** Mono meta line: "task T-109", "coordinator", "12m ago". */
  meta?: string;
  /**
   * The RECORD's own status. Not a liveness claim — it distinguishes exited
   * from failed from spawning among sessions the seam says are not running.
   */
  recordedStatus?: WorkSessionStatus | null;
  /**
   * When the process started and when it ended, as the RECORD holds them. Null
   * on either side is a real state, not a gap to fill: a row whose node died
   * before it could close out never gets an `exitedAt`, and the exited canvas
   * says "no end recorded" rather than substituting `now`.
   *
   * These are timestamps, not the `activityAt` reason 2 above refuses. An
   * exit time is a recorded fact about a process that is over; recency is a
   * guess about one that might not be, and no consumer can derive liveness
   * from a field that only exists once liveness is settled.
   */
  startedAt?: string | null;
  exitedAt?: string | null;
  /** Coordinator → worker nesting; the roster draws one guide level. */
  parentSessionId?: string | null;
}

/**
 * Project a work_session summary into a row.
 *
 * Reads `state` STRUCTURALLY (`'status' in state`) rather than by comparing
 * `kind`, so this stays inside the no-branching law even though it lives
 * outside `domain/`: it asks what the state HAS, never what the entity IS. A
 * summary without those members simply yields a row with the optional fields
 * absent, which every consumer already handles.
 */
export function toSessionRow(summary: EntitySummary, meta?: string): SessionRow {
  const state: Record<string, unknown> = summary.state as unknown as Record<string, unknown>;
  const status = typeof state.status === 'string' ? (state.status as WorkSessionStatus) : null;
  const model = typeof state.model === 'string' ? state.model : null;
  const tool = typeof state.agentTool === 'string' ? state.agentTool : null;
  const startedAt = typeof state.startedAt === 'string' ? state.startedAt : null;
  const exitedAt = typeof state.exitedAt === 'string' ? state.exitedAt : null;

  return {
    id: summary.id,
    actor: summary.createdBy,
    // Fixture personas read "forge · tm8-ui kit"; the persona is the head.
    name: summary.title.split('·')[0]?.trim() || summary.title,
    provider: model ?? tool,
    meta,
    recordedStatus: status,
    startedAt,
    exitedAt,
    parentSessionId: summary.parentId,
  };
}
