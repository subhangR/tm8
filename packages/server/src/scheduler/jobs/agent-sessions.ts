/**
 * Orphaned agent-credential sweep.
 *
 * THE HOLE THIS CLOSES. `public.revoke_agent_auth_session` shipped in 074 and,
 * until Phase 0, had zero callers anywhere in product code — nothing had ever
 * revoked an agent bearer when its agent exited. Measured on the prod node
 * before this job existed: 152 live agent tokens, 124 of them belonging to
 * work sessions that had already stopped. Each carries the full graph reach of
 * the human who spawned it.
 *
 * The exit sink now revokes on the ordinary path. This job is for the paths
 * that have no exit sink to run: a `SIGKILL`, a node that crashed with agents
 * live, a PTY whose exit handler never fired. Those are precisely the cases
 * where a credential outlives its agent indefinitely, so a backstop that only
 * ran on clean exits would be a backstop for the case that was already fine.
 *
 * WHY IT IS KEYED ON THE PTY TABLE AND NOT ON `work_sessions.status`.
 * Status looks like the obvious key and is the wrong one. `work_session_transition`
 * (043:92) is gated on `require_space_member` alone, so any member of a space
 * can mark any session in it `exited`. A status-keyed sweep would therefore
 * hand every space member a one-call revocation of any other member's live
 * agent credential — trading a credential-lifetime bug for a denial-of-service.
 * Whether this node holds a live PTY for a session is not writable from SQL and
 * not reachable by any database caller, which is what makes it the safe key.
 *
 * The database cannot see a process and the node cannot read `auth_sessions`
 * (008:204-206 — RLS with zero policies, deliberately). So this is a two-door
 * exchange, the same split 095's upload sweep uses, inverted: there the
 * database names what to delete and the node deletes it; here the node names
 * what is dead and the database revokes it.
 *
 * `runOnStart` is load-bearing. A restarted node owns no PTYs, so every agent
 * credential it minted before the restart belongs to a process that no longer
 * exists — the empty live set is the correct answer, and the first tick after
 * boot is what repairs a crash.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const AGENT_SESSION_SWEEP_JOB_NAME = 'identity.agent-session-sweep';

/**
 * The one PTY capability this job needs. `PtyHostService` satisfies it; a test
 * satisfies it with an array. Deliberately narrow — this job must never be able
 * to do anything TO a session, only ask which ones are alive.
 */
export interface LiveSessionSource {
  /** Session ids this node currently holds a live PTY for. */
  liveSessionIds(): readonly string[];
}

export interface AgentSessionSweepOptions {
  db: Db;
  /** Node-owner claims — both doors are node-admin gated. */
  claims: () => Promise<DbClaims>;
  /** Must match `work_sessions.node_id` for sessions this node owns. */
  nodeId: string;
  pty: LiveSessionSource;
  intervalMs?: number;
  runOnStart?: boolean;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runAgentSessionSweepTick(
  options: AgentSessionSweepOptions,
  _signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const claims = await options.claims();

  const outstanding = asStringArray(
    await options.db.rpc<unknown>(claims, 'public.live_agent_session_work_ids', [options.nodeId]),
  );
  if (outstanding.length === 0) {
    return { skipped: true, reason: 'no live agent credentials on this node' };
  }

  // Read the PTY table ONCE, after the database read. Taking it after means a
  // session that spawned during the round trip is in the live set and is not
  // revoked; taking it before could revoke a session that started in between.
  // Erring toward "leave it alone" is the right direction for a credential the
  // owner may still be using — the next tick catches it if it really is dead.
  const live = new Set(options.pty.liveSessionIds());
  const orphaned = outstanding.filter((id) => !live.has(id));
  if (orphaned.length === 0) {
    return { skipped: true, reason: `${outstanding.length} agent credential(s), all with live PTYs` };
  }

  const result = await options.db.rpc<{ revoked?: unknown; workSessionIds?: unknown }>(
    claims,
    'public.revoke_orphaned_agent_sessions',
    [options.nodeId, [...live]],
  );
  const revoked = typeof result?.revoked === 'number' ? result.revoked : 0;

  if (revoked > 0) {
    // Worth a line in the log: a healthy node revokes a handful per tick, and a
    // sudden large number means agents are dying without their exit sink.
    log?.(
      `identity.agent-session-sweep: revoked ${revoked} agent credential(s) whose PTY is gone `
        + `(${live.size} live, ${outstanding.length} outstanding)`,
    );
  }

  return {
    affected: revoked,
    detail: { outstanding: outstanding.length, live: live.size, revoked },
  };
}

export function createAgentSessionSweepJob(options: AgentSessionSweepOptions): ScheduledJob {
  return {
    name: AGENT_SESSION_SWEEP_JOB_NAME,
    // Five minutes. This bounds how long a credential outlives an unclean agent
    // death, which is the whole point, and the tick is two indexed queries
    // against a table with hundreds of rows — cheap enough to run hot.
    intervalMs: options.intervalMs ?? 5 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runAgentSessionSweepTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}
