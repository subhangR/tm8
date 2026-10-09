import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityStateSchema, type EntitySummary } from '@tm8/contract';

import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { WORKSPACE_EVENT_COLUMNS, WorkspaceEventMapper, type WorkspaceEventRow } from '../../src/events/mapper.js';
import { ChangesFixture } from './changes-fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const fixture = new ChangesFixture();
const projector = new PgEntityProjector();

beforeAll(async () => { await fixture.open('status_projection'); });
afterAll(async () => { await fixture.close(); });

function taskState(entity: EntitySummary | undefined) {
  if (entity?.state.kind !== 'task') throw new Error('expected task state');
  return entity.state;
}

async function state(id: string) {
  return fixture.db.tx(fixture.claims(), async (q) => {
    const read = taskState((await loadEntitySummariesByIds(q, [id], fixture.identityId))[0]);
    const event = taskState((await projector.entitySummaries(q, [id])).get(id));
    expect(EntityStateSchema.parse(read)).toEqual(read);
    expect(EntityStateSchema.parse(event)).toEqual(event);
    expect(event.statusChangedAt).toBe(read.statusChangedAt);
    const raw = (await q.query<{ status_changed_at: Date | null }>(
      'select status_changed_at from public.tasks where entity_id=$1', [id],
    ))[0]!;
    expect(read.statusChangedAt).toBe(raw.status_changed_at?.toISOString() ?? null);
    const captures = await q.query<WorkspaceEventRow>(
      `select ${WORKSPACE_EVENT_COLUMNS} from public.workspace_events
       where space_id=$1 and event_type='entity.upsert' and payload->>'id'=$2
       order by seq desc limit 1`, [fixture.spaceId, id],
    );
    expect(captures).toHaveLength(1);
    const mapped = await new WorkspaceEventMapper(projector).mapRows(q, captures);
    const upsert = mapped.find((e) => e.type === 'entity.upsert');
    expect(upsert?.type).toBe('entity.upsert');
    if (upsert?.type !== 'entity.upsert') throw new Error('expected mapped entity upsert');
    expect(taskState(upsert.entity).statusChangedAt).toBe(read.statusChangedAt);
    return read;
  });
}

describe('task status time through the real transition trigger and both projections', () => {
  it('cancel, redundant cancel, unrelated edit, reopen and recancel preserve the current episode', async () => {
    const beforeCreate = (await fixture.db.asOwner(q => q.query<{ at: Date }>(
      'select clock_timestamp() as at')))[0]!.at;
    const id = await fixture.createTask('Cancellation lifecycle');
    const afterCreate = (await fixture.db.asOwner(q => q.query<{ at: Date }>(
      'select clock_timestamp() as at')))[0]!.at;
    const created = await state(id);
    // 317 tasks_stamp_initial_status stamps INSERT (lines42-57), without inventing
    // a status-transition delta. state() also checks exact DB/read/event equality.
    expect(created.statusChangedAt).not.toBeNull();
    expect(Date.parse(created.statusChangedAt!)).toBeGreaterThanOrEqual(beforeCreate.getTime());
    expect(Date.parse(created.statusChangedAt!)).toBeLessThanOrEqual(afterCreate.getTime());
    const creationDeltas = await fixture.db.asOwner(q => q.query(
      `select seq from public.workspace_events
       where event_type='task.status_changed' and payload->>'id'=$1`, [id]));
    expect(creationDeltas).toEqual([]);

    await fixture.setStatus(id, 'cancelled');
    const cancelled = await state(id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.statusChangedAt).not.toBeNull();
    expect(Date.parse(cancelled.statusChangedAt!)).toBeGreaterThan(Date.parse(created.statusChangedAt!));

    await fixture.setStatus(id, 'cancelled');
    expect((await state(id)).statusChangedAt).toBe(cancelled.statusChangedAt);
    await fixture.rename(id, 'Unrelated title edit');
    expect((await state(id)).statusChangedAt).toBe(cancelled.statusChangedAt);

    await fixture.setStatus(id, 'open');
    const reopened = await state(id);
    expect(reopened.status).toBe('open');
    expect(Date.parse(reopened.statusChangedAt!)).toBeGreaterThan(Date.parse(cancelled.statusChangedAt!));
    await fixture.setStatus(id, 'cancelled');
    const recancelled = await state(id);
    expect(recancelled.status).toBe('cancelled');
    expect(Date.parse(recancelled.statusChangedAt!)).toBeGreaterThan(Date.parse(reopened.statusChangedAt!));
  });

  it('projects a legacy cancellation with no timestamp as unknown', async () => {
    const id = await fixture.createTask('Legacy cancelled');
    await fixture.setStatus(id, 'cancelled');
    // Fixture-only clearing represents a cancellation predating migration316.
    // Its later ordinary edit must preserve unknown history on both paths.
    await fixture.db.asOwner((q) => q.query('update public.tasks set status_changed_at=null where entity_id=$1', [id]));
    await fixture.rename(id, 'Legacy cancellation edited today');
    const legacy = await state(id);
    expect(legacy.status).toBe('cancelled');
    expect(legacy.statusChangedAt).toBeNull();
  });

  it('reads timestamps in one batch under the caller and hides foreign-space tasks', async () => {
    const visible = await Promise.all(Array.from({ length: 4 }, (_, i) => fixture.createTask(`Visible ${i}`)));
    for (const id of visible) await fixture.setStatus(id, 'cancelled');

    const outsider = { identityId: `outsider_${randomUUID()}`, nodeAdmin: false };
    await fixture.db.rpc(outsider, 'public.upsert_user_profile', ['Other owner', null, null]);
    const otherSpace = await fixture.db.rpc<{ space: { id: string } }>(outsider, 'public.create_space', [
      'Private other space', '', 'private', null, null,
    ]);
    const hidden = await fixture.db.rpc<{ entity: { id: string; version: number } }>(outsider, 'public.create_task', [
      otherSpace.space.id, 'Private cancelled task', null, '', '{}', null,
      null, 'medium', '[]', null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ]);
    await fixture.db.rpc(outsider, 'public.update_task_content', [
      hidden.entity.id, hidden.entity.version, null, null, null, null, 'cancelled',
      null, null, null, null, false, null, false,
    ]);

    await fixture.db.tx(fixture.claims(), async (q) => {
      const ids = [...visible, hidden.entity.id];
      const read = await loadEntitySummariesByIds(q, ids, fixture.identityId);
      const events = await projector.entitySummaries(q, ids);
      expect(read.map((s) => s.id)).toEqual(visible);
      expect([...events.keys()].sort()).toEqual([...visible].sort());
      for (const entity of read) {
        expect(taskState(entity).statusChangedAt).not.toBeNull();
        expect(taskState(events.get(entity.id)).statusChangedAt).toBe(taskState(entity).statusChangedAt);
      }
    });
  });
});
