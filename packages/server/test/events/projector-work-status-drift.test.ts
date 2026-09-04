/**
 * An unrecognised `tasks.work_status` must RAISE on the event path, not coerce.
 *
 * Until `WorkStatusDriftError` existed, `projector.ts` narrowed the column with
 * `oneOf(r.work_status, WORK_STATUSES, 'open')` — so a status the contract does
 * not name arrived at every subscribed client as `open`. Nothing logged, nothing
 * failed: a task in some other state simply rendered as untouched over the live
 * feed while the database and the read path both said otherwise. This test is
 * the tripwire for that, and it matters more with every step toward
 * user-defined statuses, where "a status this file has never heard of" stops
 * being a migration bug and becomes an ordinary Tuesday.
 *
 * The projector is driven through its PUBLIC method against a fake `Querier`,
 * not by calling the private narrowing function: the coercion lived at a call
 * site, so a test that only exercised the helper would go green against a
 * `stateOf` that still called `oneOf`.
 */
import { describe, expect, it } from 'vitest';
import { PgEntityProjector, WorkStatusDriftError } from '../../src/events/projector.js';
import type { Querier } from '../../src/db/types.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '33333333-3333-4333-8333-333333333333';

/** The one marker unique to the wide hydration join in projector.ts. */
const SUMMARY_MARKER = 't.work_status, t.priority';

/**
 * A task row as the hydration join returns it. Cast rather than spelled out in
 * full: `SummaryRow` is ~120 nullable columns and is not exported, and every
 * field this projection reads for a task is present below.
 */
function taskRow(status: string | null): Record<string, unknown> {
  return {
    id: TASK_ID,
    space_id: SPACE_ID,
    kind: 'task',
    parent_id: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activity_at: '2026-08-18T00:00:00.000Z',
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    deleted_at: null,
    created_by: ACTOR_ID,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    human_messages: 0,
    agent_messages: 0,
    docs: 0,
    memories: 0,
    task_title: 'A task',
    task_description: null,
    work_status: status,
    priority: 'medium',
    completion_gate: 'none',
    axes: null,
    due_date: null,
    acceptance_criteria: [],
    custom_fields: null,
  };
}

/** Answers the hydration join with `rows`; every other query with nothing. */
function querierFor(rows: readonly Record<string, unknown>[]): Querier {
  return {
    query: async (sql: string) => (sql.includes(SUMMARY_MARKER) ? [...rows] : []),
    rpc: async () => {
      throw new Error('the projector must not write');
    },
  } as unknown as Querier;
}

describe('projector work_status drift', () => {
  it('RAISES on a status the contract does not name, instead of coercing to open', async () => {
    const projector = new PgEntityProjector();
    await expect(projector.entitySummaries(querierFor([taskRow('archived')]), [TASK_ID])).rejects
      .toThrow(WorkStatusDriftError);
  });

  it('names the offending value and the entity, so the row is findable', async () => {
    const projector = new PgEntityProjector();
    const err = await projector
      .entitySummaries(querierFor([taskRow('needs_triage')]), [TASK_ID])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('needs_triage');
    expect((err as Error).message).toContain(TASK_ID);
  });

  it('still projects every status the contract DOES name', async () => {
    const projector = new PgEntityProjector();
    for (const status of ['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled']) {
      const summaries = await projector.entitySummaries(querierFor([taskRow(status)]), [TASK_ID]);
      const state = summaries.get(TASK_ID)?.state;
      expect(state?.kind).toBe('task');
      expect((state as { status?: string }).status).toBe(status);
    }
  });

  it('keeps NULL meaning open — that is a missing join, not a drifted value', async () => {
    const projector = new PgEntityProjector();
    const summaries = await projector.entitySummaries(querierFor([taskRow(null)]), [TASK_ID]);
    const state = summaries.get(TASK_ID)?.state;
    expect((state as { status?: string }).status).toBe('open');
  });
});
