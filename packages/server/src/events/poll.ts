/**
 * `events.poll` — the catch-up fallback for clients that lost the socket
 * (`GET /v2/spaces/:spaceId/events`, catalog line 129, status `v1`).
 *
 * This operation used to be a deliberate `501 not_implemented`: with no durable
 * event log behind it, the only honest answer was a refusal, because a `200 []`
 * would tell a reconnecting client "you have missed nothing" — a data-loss bug
 * wearing a green badge. The log now exists (`public.workspace_events`, captured
 * by the trigger in db/migrations/003), so the honest answer changed and this
 * file implements it. `NotImplementedEventLog` is kept for the case that matters
 * most: a node wired WITHOUT a database must go back to refusing, not to
 * answering `[]`.
 *
 * The `since` cursor is the per-space `seq` from the AM-2 §3 envelope, not a
 * timestamp and not an opaque keyset cursor: the client replays from the last
 * seq it durably applied. Presence/typing are never returned here — they are
 * ephemeral (DEV-4) and there is nothing to catch up on. The capture trigger
 * never writes them to the log, so that exclusion is structural, not a filter
 * this file has to remember to apply.
 */
import { CollabError, type DurableWorkspaceEvent } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { WorkspaceEventMapper, WORKSPACE_EVENT_COLUMNS, type WorkspaceEventRow } from './mapper.js';
import { PgEntityProjector, type EntityProjector } from './projector.js';

/**
 * The durable event log, as `events.poll` needs to see it — a read of
 * `workspace_events` under the caller's identity.
 */
export interface DurableEventLog {
  /**
   * Events for `spaceId` with `seq > sinceSeq`, in ascending seq order,
   * at most `limit` of them.
   */
  since(spaceId: string, sinceSeq: number, limit: number, claims: DbClaims): Promise<DurableEventPage>;
}

/**
 * One page of catch-up.
 *
 * `nextCursor` is the highest seq the client has now durably seen, as a string,
 * and is reusable VERBATIM as the next request's `?since=`. That shape is fixed
 * by the conformance suite, which is normative here:
 * tools/conformance/test/events.test.ts:25 declares
 * `{ items: unknown[]; nextCursor: string | null }` and line 90 feeds
 * `page.nextCursor` straight back in as `since`. It is not a DEV-5 keyset cursor
 * — `since` is the seq itself (AM-2 §3), and wrapping it in an opaque cursor
 * would break a client that legitimately tracks its own last-applied seq.
 */
export interface DurableEventPage {
  items: DurableWorkspaceEvent[];
  nextCursor: string | null;
}

/**
 * Used when the node has no database. It exists so that a misconfigured node
 * refuses in the contract's own error vocabulary instead of returning a
 * plausible empty result that a client would read as "fully caught up".
 */
export class NotImplementedEventLog implements DurableEventLog {
  since(spaceId: string): Promise<DurableEventPage> {
    return Promise.reject(
      new CollabError('not_implemented', `no durable event log: cannot replay events for space ${spaceId}`),
    );
  }
}

/**
 * How many events one poll page may carry.
 *
 * The retained buffer is ~5 minutes / 1000 events per space, so a page cap of
 * 500 means a client that fell two pages behind can still catch up without
 * hitting retention. `limit` from the query string is clamped to this, never
 * trusted.
 */
export const MAX_POLL_LIMIT = 500;
export const DEFAULT_POLL_LIMIT = 200;

/**
 * `DurableEventLog` over `public.workspace_events`.
 *
 * The whole read — the log rows AND the entity hydration the mapper needs — runs
 * inside ONE `Db.tx` with the caller's claims. Two reasons, both load-bearing:
 *
 * - **Authorization.** `workspace_events_select` (008, and the grant fix in 009)
 *   filters rows to spaces the caller belongs to. Hydrating the referenced
 *   entities in a separate privileged read would leak titles the caller cannot
 *   see, and no RLS policy would catch it, because the leak happens after the
 *   policy ran.
 * - **Consistency.** One transaction is one snapshot, so an entity cannot be
 *   deleted between "I selected the event" and "I hydrated its title", which
 *   would otherwise turn a valid event into a skipped one at random.
 */
export class PgDurableEventLog implements DurableEventLog {
  private readonly db: Db;
  private readonly mapper: WorkspaceEventMapper;
  private readonly onSkip: ((message: string) => void) | undefined;

  constructor(db: Db, opts: { projector?: EntityProjector; onSkip?: (message: string) => void } = {}) {
    this.db = db;
    this.mapper = new WorkspaceEventMapper(opts.projector ?? new PgEntityProjector());
    this.onSkip = opts.onSkip;
  }

  async since(spaceId: string, sinceSeq: number, limit: number, claims: DbClaims): Promise<DurableEventPage> {
    const capped = Math.min(Math.max(1, limit), MAX_POLL_LIMIT);

    return this.db.tx(claims, async (q) => {
      const rows = await q.query<WorkspaceEventRow>(
        `select ${WORKSPACE_EVENT_COLUMNS}
           from public.workspace_events
          where space_id = $1 and seq > $2
          order by seq asc
          limit $3`,
        [spaceId, sinceSeq, capped],
      );

      const items = await this.mapper.mapRows(q, rows, (err) => this.onSkip?.(err.message));

      // The cursor advances past SKIPPED rows too — it is the last seq we
      // EXAMINED, not the last one we returned. Advancing only past returned
      // events would wedge a client forever on the first row it cannot see: it
      // would re-request the same page, get the same empty result, and never
      // progress. `rows`, not `items`, is therefore the correct source here.
      //
      // On an empty page the cursor echoes the caller's own position rather than
      // going null. `null` would be the Page<T> convention for "end of list",
      // but this feed has no end — it means "caught up" — and a client that
      // stored a null would lose its place and replay from zero on the next
      // poll. Echoing is always a valid `?since=` and cannot lose a position.
      const lastExamined = rows.at(-1);
      return {
        items,
        nextCursor: String(lastExamined === undefined ? sinceSeq : Number(lastExamined.seq)),
      };
    });
  }
}
