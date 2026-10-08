import { describe, expect, it } from 'vitest';
import { EntityStateSchema, type EntitySummary } from '@tm8/contract';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';

const SPACE = '33333333-3333-4333-8333-333333333333';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const TASK = '11111111-1111-4111-8111-111111111111';
const TIME = '2026-10-08T12:30:45.123Z';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK, space_id: SPACE, kind: 'task', parent_id: null,
    position: 0, visibility: 'space', version: 3, created_by: ACTOR,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-10-08T15:00:00.000Z',
    activity_at: '2026-10-08T15:30:00.000Z', deleted_at: null,
    likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0,
    human_messages: 0, agent_messages: 0, docs: 0, memories: 0,
    task_title: 'Cancelled task', task_description: '', work_status: 'cancelled',
    task_status_changed_at: TIME, priority: 'medium', completion_gate: 'none',
    task_axes: {}, axes: {}, due_date: null, start_date: null,
    acceptance_criteria: [], custom_fields: null,
    ...overrides,
  };
}

function reader(rows: readonly Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const q: Querier = {
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      calls.push({ sql, params });
      const ids = Array.isArray(params[0]) ? params[0] : [];
      return (sql.includes('t.status_changed_at as task_status_changed_at')
        ? rows.filter((r) => ids.includes(r.id)) : []) as R[];
    },
    async rpc() { throw new Error('projection must stay read-only'); },
  };
  return { q, calls };
}

function taskState(entity: EntitySummary | undefined) {
  if (entity?.state.kind !== 'task') throw new Error('expected task state');
  return entity.state;
}

async function both(taskRow: Record<string, unknown>) {
  const { q } = reader([taskRow]);
  const read = taskState((await loadEntitySummariesByIds(q, [TASK], ACTOR))[0]);
  const event = taskState((await new PgEntityProjector().entitySummaries(q, [TASK])).get(TASK));
  expect(EntityStateSchema.parse(read)).toEqual(read);
  expect(EntityStateSchema.parse(event)).toEqual(event);
  expect(event.statusChangedAt).toBe(read.statusChangedAt);
  return read;
}

describe('authoritative task status time on read and event projections', () => {
  it.each([
    ['driver Date', new Date(TIME)],
    ['timestamp text with offset', '2026-10-08T18:00:45.123+05:30'],
  ])('normalizes %s to the same UTC instant', async (_label, timestamp) => {
    expect((await both(row({ task_status_changed_at: timestamp }))).statusChangedAt).toBe(TIME);
  });

  it.each([null, undefined])('keeps legacy %s unknown despite later envelope activity', async (timestamp) => {
    expect((await both(row({ task_status_changed_at: timestamp }))).statusChangedAt).toBeNull();
  });

  it('an unrelated edit changes the envelope but preserves status time', async () => {
    const before = await both(row());
    const after = await both(row({
      task_title: 'Renamed', version: 4,
      updated_at: '2026-10-09T00:00:00.000Z', activity_at: '2026-10-09T01:00:00.000Z',
    }));
    expect(after.statusChangedAt).toBe(before.statusChangedAt);
  });

  it.each(['open', 'working', 'blocked', 'done'])('preserves the current %s transition time', async (status) => {
    const state = await both(row({ work_status: status }));
    expect(state.status).toBe(status);
    expect(state.statusChangedAt).toBe(TIME);
  });

  it('validates nullable timestamps and refuses malformed contract values', async () => {
    const state = await both(row());
    expect(EntityStateSchema.safeParse({ ...state, statusChangedAt: 'yesterday' }).success).toBe(false);
    const { statusChangedAt: _timestamp, ...olderPayload } = state;
    expect(EntityStateSchema.parse(olderPayload)).toEqual(olderPayload);
  });

  it.each(['read', 'event'])('%s hydrates a batch with fixed query count and no event history scan', async (path) => {
    async function hydrate(count: number) {
      const rows = Array.from({ length: count }, (_, i) => row({
        id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`,
      }));
      const ids = rows.map((r) => String(r.id));
      const { q, calls } = reader(rows);
      const summaries = path === 'read'
        ? await loadEntitySummariesByIds(q, ids, ACTOR)
        : [...(await new PgEntityProjector().entitySummaries(q, ids)).values()];
      expect(summaries).toHaveLength(count);
      expect(summaries.every((s) => taskState(s).statusChangedAt === TIME)).toBe(true);
      const hydration = calls.filter((c) => c.sql.includes('t.status_changed_at') &&
        Array.isArray(c.params[0]) && c.params[0].includes(ids[0]));
      expect(hydration).toHaveLength(1);
      expect(hydration[0]?.params[0]).toEqual(ids);
      expect(calls.every((c) => !c.sql.includes('workspace_events'))).toBe(true);
      return calls.length;
    }
    expect(await hydrate(32)).toBe(await hydrate(1));
  });
});
