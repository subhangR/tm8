/**
 * `entities.commands.tick` — bug 01a0d2f1.
 *
 * Live agents told to "tick your acceptance criteria and complete" found no
 * write for it and fell back to a 29.5 KB `entity get` to learn the stored
 * member name. This pins the one write path end to end, through the
 * production registry over a real PostgreSQL scratch database:
 *
 *   - the v2 context's `acceptanceWrite.writeOp` runs VERBATIM and ticks,
 *   - the merge is by id: criteria not named keep their stored state,
 *   - an unknown id and a stale version are refused, never dropped,
 *   - after the tick, `task complete`'s criteria gate passes.
 *
 * Writes mutate the shared fixture task, so this lives apart from the
 * read-only context-v2 acceptance suite.
 */
import type { OperationName } from '@tm8/contract';
import { getOperation, WorkspaceEventSchema, type DurableWorkspaceEvent } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'tick-owner',
  isNodeAdmin: false,
  isOwner: true,
};

interface Criterion { id: string; done: boolean; text: string; doneBy?: string; doneAt?: string }
interface V2 { version: number; acceptance: Criterion[]; acceptanceWrite?: { write: string; writeOp: { operation: string; params: Record<string, unknown> } } }
interface Result { entity: { version: number; content: { acceptanceCriteria: Criterion[] }; state: { status: string } } }

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let mutation = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('tick');
  const chain = migrationFiles();
  database.apply(chain.filter((file) => file !== '316_task_game_events.sql'));
  await seedContextV2Fixtures(database);
  // Apply to existing tasks: the migration must not invent their status time.
  database.apply(['316_task_game_events.sql']);
  // The older context fixture stores skills as [], predating EffectiveSkills.
  // Polling its claim edge must use a contract-shaped session summary.
  await database.query(`update public.work_sessions set skills =
    '{"native":[],"indexed":[],"skipped":[],"scannedAt":null}'::jsonb
    where entity_id in ($1,$2)`, [F.WS, F.CS]);
  pgDb = createDb(database.url);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db: pgDb,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => OWNER,
  });
}, 300_000);

afterAll(async () => {
  await pgDb?.end();
  await database?.destroy();
});

async function call<T>(
  opName: OperationName,
  params: Record<string, string>,
  opts: { query?: URLSearchParams; body?: Record<string, unknown> } = {},
): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op,
    opName,
    params,
    query: opts.query ?? new URLSearchParams(),
    body: opts.body === undefined ? undefined : { clientMutationId: `tick-${++mutation}`, ...opts.body },
    requestId: `tick-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
  return (await handler(ctx)) as T;
}

const context = (): Promise<V2> => call<V2>('entities.context', { id: F.T }, { query: new URLSearchParams({ schema: 'v2' }) });

const tick = (body: Record<string, unknown>): Promise<Result> =>
  call<Result>('entities.commands.tick', { id: F.T }, { body });

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

// Read each captured row through the production poll/projector under tm8_app.
// limit=1 proves task subject filtering and hydration work on isolated events.
const cursor = async (): Promise<number> => Number((await database.query<{ seq: string }>(
  'select coalesce(max(seq), 0)::text seq from public.workspace_events where space_id=$1', [F.space],
))[0]!.seq);
async function taskEvents(since: number, taskId = F.T): Promise<DurableWorkspaceEvent[]> {
  const log = new PgDurableEventLog(pgDb);
  const events: DurableWorkspaceEvent[] = [];
  for (;;) {
    const page = await log.since(F.space, since, 1,
      { identityId: IDENTITY, nodeAdmin: false, requestId: 'game-events' }, { entityId: taskId });
    for (const event of page.items) {
      expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
      events.push(event);
    }
    if (!page.hasMore) return events;
    since = page.examinedThrough;
  }
}

async function gameEvents(since: number, taskId = F.T): Promise<DurableWorkspaceEvent[]> {
  return (await taskEvents(since, taskId)).filter((e) =>
    e.type === 'task.criterion_changed' || e.type === 'task.status_changed');
}

describe('entities.commands.tick (bug 01a0d2f1) and Game P0c events', () => {
  it('refuses an unknown criterion id BY NAME, listing the ids the task carries, and writes nothing', async () => {
    const before = await context();
    const since = await cursor();
    const err = await refusal(() => tick({ expectedVersion: before.version, criterionIds: ['a1', 'nope'] }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('nope');
    expect(err.details).toMatchObject({ reason: 'unknown_criterion', unknown: ['nope'], known: ['a1', 'a2', 'a3', 'a4'] });
    expect((await context()).version).toBe(before.version);
    expect(await gameEvents(since)).toEqual([]);
  });

  it('refuses a stale version as version_conflict with the current detail', async () => {
    const before = await context();
    const since = await cursor();
    const err = await refusal(() => tick({ expectedVersion: before.version - 1, criterionIds: ['a1'] }));
    expect(err.code).toBe('version_conflict');
    expect((await context()).version).toBe(before.version);
    expect(await gameEvents(since)).toEqual([]);
  });

  it('merges by id: one tick changes one criterion, stamps it, and leaves the rest as stored', async () => {
    const before = await context();
    const since = await cursor();
    const body = { expectedVersion: before.version, criterionIds: ['a1', 'a1', 'a2'], clientMutationId: 'game-first-tick' };
    const r = await tick(body);
    expect(r.entity.version).toBe(before.version + 1);
    const byId = new Map(r.entity.content.acceptanceCriteria.map((c) => [c.id, c]));
    expect(byId.get('a1')).toMatchObject({ done: true });
    expect(byId.get('a1')?.doneAt).toEqual(expect.any(String));
    expect(byId.get('a2')?.done).toBe(true);
    expect(byId.get('a3')?.done).toBe(false);
    expect(byId.get('a4')?.done).toBe(false);
    // Texts and order are untouched — the caller never restated them.
    expect(r.entity.content.acceptanceCriteria.map((c) => [c.id, c.text]))
      .toEqual(before.acceptance.map((c) => [c.id, c.text]));
    expect(await gameEvents(since)).toEqual([expect.objectContaining({
      type: 'task.criterion_changed', taskId: F.T, criterionId: 'a1',
      criterionText: byId.get('a1')!.text, isDone: true, done: 2, total: 4,
    })]);
    const replaySince = await cursor();
    expect((await tick(body)).entity.version).toBe(r.entity.version);
    expect((await context()).version).toBe(r.entity.version);
    expect(await gameEvents(replaySince)).toEqual([]);
  });

  it('a repeated tick keeps its stamp and emits nothing; replay emits nothing even with the old version', async () => {
    const before = await context();
    const since = await cursor();
    const stamped = (await database.query<{ acceptance_criteria: Criterion[] }>(
      'select acceptance_criteria from public.tasks where entity_id=$1', [F.T],
    ))[0]!.acceptance_criteria.find((c) => c.id === 'a1');
    const body = { expectedVersion: before.version, criterionIds: ['a1'], clientMutationId: 'game-repeat-tick' };
    const once = await tick(body);
    expect(once.entity.content.acceptanceCriteria.find((c) => c.id === 'a1'))
      .toEqual(stamped);
    const replay = await tick(body);
    expect(replay.entity.version).toBe(once.entity.version);
    expect((await context()).version).toBe(once.entity.version);
    expect(await gameEvents(since)).toEqual([]);
  });

  it('a text edit and criterion reorder produce no done-state events', async () => {
    const before = await context();
    const since = await cursor();
    await call('entities.patch', { id: F.T }, { body: {
      expectedVersion: before.version,
      content: { acceptanceCriteria: [...before.acceptance].reverse().map((c) => ({ ...c, text: `${c.text} (edited)` })) },
    } });
    expect(await gameEvents(since)).toEqual([]);
  });

  it('criterion additions/removals carry new counts in entity.upsert without inventing a tick', async () => {
    const before = await context();
    const since = await cursor();
    const added = await call<Result>('entities.patch', { id: F.T }, { body: {
      expectedVersion: before.version,
      content: { acceptanceCriteria: [...before.acceptance, { id: 'extra', text: 'New work', done: false }] },
    } });
    const addEvents = await taskEvents(since);
    expect(addEvents.filter((e) => e.type === 'task.criterion_changed')).toEqual([]);
    expect(addEvents).toContainEqual(expect.objectContaining({ type: 'entity.upsert', entity: expect.objectContaining({
      id: F.T, state: expect.objectContaining({ acceptance: { completed: 2, total: 5 } }),
    }) }));
    const removedSince = await cursor();
    await call('entities.patch', { id: F.T }, { body: {
      expectedVersion: added.entity.version, content: { acceptanceCriteria: before.acceptance },
    } });
    const removedEvents = await taskEvents(removedSince);
    expect(removedEvents.filter((e) => e.type === 'task.criterion_changed')).toEqual([]);
    expect(removedEvents).toContainEqual(expect.objectContaining({ type: 'entity.upsert', entity: expect.objectContaining({
      id: F.T, state: expect.objectContaining({ acceptance: { completed: 2, total: 4 } }),
    }) }));
  });

  it('done:false unticks, and the context hint follows the open set', async () => {
    const before = await context();
    const since = await cursor();
    await tick({ expectedVersion: before.version, criterionIds: ['a1'], done: false });
    const after = await context();
    expect(after.acceptance.find((c) => c.id === 'a1')?.done).toBe(false);
    expect(after.acceptanceWrite?.write).toBe(`tm8 task tick ${F.T} a4 a3 a1 --expect-version ${after.version}`);
    expect(await gameEvents(since)).toEqual([expect.objectContaining({
      type: 'task.criterion_changed', criterionId: 'a1', isDone: false, done: 1, total: 4,
    })]);
    const repeatedSince = await cursor();
    await tick({ expectedVersion: after.version, criterionIds: ['a1'], done: false });
    expect(await gameEvents(repeatedSince)).toEqual([]);
  });

  it('the context writeOp runs verbatim, the hint disappears, and task complete then passes the criteria gate', async () => {
    const view = await context();
    const since = await cursor();
    const op = view.acceptanceWrite!.writeOp;
    expect(op.operation).toBe('entities.commands.tick');
    const { id, ...body } = op.params;
    const ticked = await call<Result>(op.operation as OperationName, { id: String(id) }, { body });
    expect(ticked.entity.content.acceptanceCriteria.every((c) => c.done)).toBe(true);

    const after = await context();
    expect(after.acceptanceWrite).toBeUndefined();
    const changed = await gameEvents(since);
    expect(changed.map((e) => e.type === 'task.criterion_changed' ? e.criterionId : '')).toEqual(['a4', 'a3', 'a1']);
    expect(changed).toEqual(['a4', 'a3', 'a1'].map((criterionId) => expect.objectContaining({
      type: 'task.criterion_changed', criterionId, isDone: true, done: 4, total: 4,
    })));
    const statusSince = await cursor();

    const done = await call<Result>('entities.commands.complete', { id: F.T }, {
      body: { expectedVersion: after.version, completerIds: [F.member] },
    });
    expect(done.entity.state.status).toBe('done');
    expect(await gameEvents(statusSince)).toEqual([expect.objectContaining({
      type: 'task.status_changed', taskId: F.T, from: 'working', to: 'done',
    })]);
    const repeatSince = await cursor();
    const repeated = await refusal(() => call('entities.commands.complete', { id: F.T }, { body: {
      expectedVersion: done.entity.version, completerIds: [F.member],
    } }));
    expect(repeated.code).toBe('invariant_violation');
    expect(await gameEvents(repeatSince)).toEqual([]);
  });
});

describe('task status Game event facts', () => {
  it('captures each transaction old value; unchanged writes and command replay emit nothing', async () => {
    const since = await cursor();
    const beforeTime = (await database.query<{ status_changed_at: Date | null }>(
      'select status_changed_at from public.tasks where entity_id=$1', [F.B],
    ))[0]!.status_changed_at;
    expect(beforeTime).toBeNull();
    const body = { status: 'working', clientMutationId: 'game-status-working' };
    await call('entities.commands.work', { id: F.B }, { body });
    const workingTime = (await database.query<{ status_changed_at: Date }>(
      'select status_changed_at from public.tasks where entity_id=$1', [F.B],
    ))[0]!.status_changed_at.toISOString();
    await call('entities.commands.work', { id: F.B }, { body });
    await call('entities.commands.work', { id: F.B }, { body: { status: 'working' } });
    expect((await database.query<{ status_changed_at: Date }>(
      'select status_changed_at from public.tasks where entity_id=$1', [F.B],
    ))[0]!.status_changed_at.toISOString()).toBe(workingTime);
    await call('entities.commands.work', { id: F.B }, { body: { status: 'blocked' } });
    const blockedTime = (await database.query<{ status_changed_at: Date }>(
      'select status_changed_at from public.tasks where entity_id=$1', [F.B],
    ))[0]!.status_changed_at.toISOString();
    // The latest summary is blocked; the earlier event must still say working.
    expect(await gameEvents(since, F.B)).toEqual([
      expect.objectContaining({ type: 'task.status_changed', taskId: F.B, from: 'open', to: 'working', occurredAt: workingTime }),
      expect.objectContaining({ type: 'task.status_changed', taskId: F.B, from: 'working', to: 'blocked', occurredAt: blockedTime }),
    ]);
  });

  it('patch changes share the event path, and a stale patch writes no event', async () => {
    const before = await call<V2>('entities.context', { id: F.B }, { query: new URLSearchParams({ schema: 'v2' }) });
    const since = await cursor();
    const patched = await call<Result>('entities.patch', { id: F.B }, { body: { expectedVersion: before.version, content: { status: 'in_review' } } });
    expect(await gameEvents(since, F.B)).toEqual([expect.objectContaining({
      type: 'task.status_changed', from: 'blocked', to: 'in_review',
    })]);
    const failedSince = await cursor();
    const err = await refusal(() => call('entities.patch', { id: F.B }, {
      body: { expectedVersion: before.version, content: { status: 'open' } },
    }));
    expect(err.code).toBe('version_conflict');
    expect(await gameEvents(failedSince, F.B)).toEqual([]);
    const cancellationSince = await cursor();
    await call('entities.patch', { id: F.B }, { body: {
      expectedVersion: patched.entity.version, content: { status: 'cancelled' },
    } });
    const cancelledTime = (await database.query<{ status_changed_at: Date }>(
      'select status_changed_at from public.tasks where entity_id=$1', [F.B],
    ))[0]!.status_changed_at.toISOString();
    expect(await gameEvents(cancellationSince, F.B)).toEqual([expect.objectContaining({
      type: 'task.status_changed', from: 'in_review', to: 'cancelled', occurredAt: cancelledTime,
    })]);
  });
});

describe('task status transition time', () => {
  it('cancel/reopen/recancel captures the current episode and cannot regress with older transaction starts', async () => {
    // The preceding patch cancelled B. Start a transaction before a newer
    // recancellation, then perform its write after that transaction commits.
    await call('entities.commands.work', { id: F.B }, { body: { status: 'open' } });
    const older = await database.pool.connect();
    let committed = false;
    try {
      await older.query('begin');
      await older.query('set local role tm8_graph_owner');
      const started = (await older.query<{ at: Date }>('select now() at')).rows[0]!.at;
      const since = await cursor();
      await call('entities.commands.work', { id: F.B }, { body: { status: 'cancelled' } });
      const cancelled = (await database.query<{ status_changed_at: Date }>(
        'select status_changed_at from public.tasks where entity_id=$1', [F.B],
      ))[0]!.status_changed_at;
      expect(cancelled.getTime()).toBeGreaterThan(started.getTime());
      await older.query(`select set_config('tm8.identity_id',$1,true)`, [IDENTITY]);
      const reopened = (await older.query<{ status_changed_at: Date }>(
        `update public.tasks set work_status='open' where entity_id=$1 returning status_changed_at`, [F.B],
      )).rows[0]!.status_changed_at;
      await older.query('commit');
      committed = true;
      expect(reopened.getTime()).toBeGreaterThanOrEqual(cancelled.getTime());
      expect(await gameEvents(since, F.B)).toEqual([
        expect.objectContaining({ type: 'task.status_changed', from: 'open', to: 'cancelled', occurredAt: cancelled.toISOString() }),
        expect.objectContaining({ type: 'task.status_changed', from: 'cancelled', to: 'open', occurredAt: reopened.toISOString() }),
      ]);
      await call('entities.commands.work', { id: F.B }, { body: { status: 'cancelled' } });
      const recancelled = (await database.query<{ status_changed_at: Date }>(
        'select status_changed_at from public.tasks where entity_id=$1', [F.B],
      ))[0]!.status_changed_at;
      expect(recancelled.getTime()).toBeGreaterThanOrEqual(reopened.getTime());
      const before = await call<V2>('entities.context', { id: F.B }, { query: new URLSearchParams({ schema: 'v2' }) });
      await call('entities.patch', { id: F.B }, { body: { expectedVersion: before.version,
        content: { acceptanceCriteria: [{ id: 'preserve-time', text: 'Criterion-only edit', done: false }] },
      } });
      expect((await database.query<{ status_changed_at: Date }>(
        'select status_changed_at from public.tasks where entity_id=$1', [F.B],
      ))[0]!.status_changed_at.toISOString()).toBe(recancelled.toISOString());
    } finally {
      if (!committed) await older.query('rollback');
      older.release();
    }
  });
});

describe('task Game event RLS', () => {
  it('never serves captured criterion text from an unreadable task, while readable events still pass', async () => {
    const since = await cursor();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.tasks set acceptance_criteria =
        '[{"id":"secret","text":"Private criterion text","done":true}]'::jsonb
        where entity_id=$1`, [F.H]);
    });
    const captured = await database.query<{ n: number }>(`select count(*)::int n from public.workspace_events
      where seq > $1 and event_type='task.criterion_changed' and payload->>'id'=$2`, [since, F.H]);
    expect(captured[0]!.n).toBe(1);
    expect(await taskEvents(since, F.H)).toEqual([]);
    const visible = await call<V2>('entities.context', { id: F.B }, { query: new URLSearchParams({ schema: 'v2' }) });
    await call('entities.patch', { id: F.B }, { body: { expectedVersion: visible.version,
      content: { acceptanceCriteria: [{ id: 'public', text: 'Public criterion', done: true }] },
    } });
    const readable = await gameEvents(since, F.B);
    expect(readable).toEqual([expect.objectContaining({ type: 'task.criterion_changed', criterionText: 'Public criterion', done: 1, total: 1 })]);
  });
});
