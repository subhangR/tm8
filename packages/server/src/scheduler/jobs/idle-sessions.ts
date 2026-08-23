/**
 * Reap idle agent sessions, so a paused conversation stops costing a process.
 *
 * THE ASYMMETRY THIS CLOSES. A session's conversation is durable — `session
 * resume` relaunches the agent "with the full prior conversation restored", by
 * the provider-native session id the Server recorded. Its PROCESS is not: it is
 * a `claude` on a PTY, holding its whole context resident, and it holds that
 * whether it is mid-turn or has been waiting for input since yesterday.
 *
 * So an idle session pays the full price of a working one and buys nothing. The
 * only thing that process contributes over an exited row is the ability to
 * attach to scrollback — and resume rebuilds the conversation anyway.
 *
 * Measured on a live node 2026-08-23: fourteen sessions in `idle`, each 408–487
 * MB resident and 1.1–2.3% CPU, none of them doing anything. 6.2 GB — 78% of the
 * box — spent on waiting. The operator's fleet had reached 25 sessions and had to
 * be restarted for memory, which killed all of them at once; the question that
 * produced this job was "most of them are idle, why should that still take
 * memory?" It should not.
 *
 * WHAT IS AND IS NOT REAPED. Only `idle` — the status the node sets when an
 * agent has finished its turn and is waiting. `running` and `spawning` are
 * untouched at any age: a long turn is not an abandoned one, and this job must
 * never be the reason a working agent dies. A session with no live PTY is
 * likewise skipped rather than transitioned; that row is a ghost and belongs to
 * `reconcileNodeGhosts`, which explains itself differently and should not have
 * its reason overwritten by this one.
 *
 * OFF BY DEFAULT. Reaping ends a process the operator may expect to still be
 * attachable, so it is opt-in per node via `TM8_SESSION_IDLE_REAP_MINUTES`. A
 * node that sets nothing behaves exactly as before.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const IDLE_SESSION_REAP_JOB_NAME = 'sessions.reap-idle';

/** The two capabilities this job needs from the execution block. */
export interface IdleReapExecution {
  /** True when this node currently holds a PTY for that session. */
  hasSession(sessionId: string): boolean;
  terminate(claims: DbClaims, sessionId: string, opts: { reason: string }): Promise<unknown>;
}

export interface IdleSessionReapOptions {
  db: Db;
  /** Node-owner claims. The transition door needs a real space member. */
  claims: () => Promise<DbClaims>;
  execution: IdleReapExecution;
  /** How long a session must have been `idle` before it is reaped. */
  idleMinutes: number;
  /** Sessions per tick, so one sweep cannot stall the scheduler. */
  batchSize?: number;
  intervalMs?: number;
}

interface IdleRow {
  readonly entity_id: string;
  readonly idle_minutes: number;
}

/**
 * Resolve the configured idle window.
 *
 * Unset, empty, `0` or `off` mean the feature is off — the same vocabulary
 * `resolveSessionCap` uses for its own opt-out, so an operator learns one
 * convention. An unparseable or negative value is also off rather than being
 * coerced to something small: a typo must never silently start killing sessions
 * sooner than anyone asked.
 */
export function resolveIdleReapMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TM8_SESSION_IDLE_REAP_MINUTES']?.trim();
  if (raw === undefined || raw === '') return 0;
  if (/^(off|none|0)$/i.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  return parsed;
}

export function createIdleSessionReapJob(options: IdleSessionReapOptions): ScheduledJob {
  const batchSize = options.batchSize ?? 25;
  return {
    name: IDLE_SESSION_REAP_JOB_NAME,
    intervalMs: options.intervalMs ?? 5 * 60_000,
    jitterRatio: 0.1,
    run: async (_ctx: JobContext): Promise<JobOutcome> => {
      if (options.idleMinutes < 1) {
        return { skipped: true, reason: 'idle reaping is off (TM8_SESSION_IDLE_REAP_MINUTES unset)' };
      }
      const claims = await options.claims();

      // Candidates are chosen by the row's own clock: `status_changed_at` is
      // when it BECAME idle. Ordered oldest-first so a bounded batch always
      // makes progress on the longest-abandoned sessions rather than churning
      // the same recent ones.
      const rows = await options.db.query<IdleRow>(
        claims,
        `select entity_id,
                extract(epoch from (now() - status_changed_at)) / 60 as idle_minutes
           from public.work_sessions
          where session_kind = 'agent'
            and status = 'idle'
            and status_changed_at < now() - make_interval(mins => $1::int)
          order by status_changed_at asc
          limit $2`,
        [options.idleMinutes, batchSize],
      );
      if (rows.length === 0) {
        return { skipped: true, reason: `no sessions idle beyond ${options.idleMinutes}m` };
      }

      let reaped = 0;
      const ghosts: string[] = [];
      const failures: string[] = [];
      for (const row of rows) {
        // A row with no PTY on this node is a ghost, not an idle session. It is
        // left for `reconcileNodeGhosts`, whose reason names a node restart —
        // the honest explanation for that row, and not the one below.
        if (!options.execution.hasSession(row.entity_id)) {
          ghosts.push(row.entity_id);
          continue;
        }
        const idleFor = Math.round(row.idle_minutes);
        try {
          await options.execution.terminate(claims, row.entity_id, {
            reason:
              `reaped after ${String(idleFor)}m idle: the conversation is kept and \`session resume\` ` +
              'restores it in full, so a waiting agent need not hold a process',
          });
          reaped += 1;
        } catch (error) {
          // Collected, not swallowed. A refusal here is the same class of
          // failure that made ghost reconciliation invisible for weeks: reported
          // only to a logger, "reaped nothing" and "was refused everything" read
          // identically.
          failures.push(
            `${row.entity_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return {
        affected: reaped,
        detail: {
          idleMinutes: options.idleMinutes,
          considered: rows.length,
          ...(ghosts.length > 0 ? { skippedAsGhosts: ghosts.length } : {}),
          ...(failures.length > 0 ? { failures } : {}),
        },
      };
    },
  };
}
