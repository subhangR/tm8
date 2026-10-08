import { describe, expect, it, vi } from 'vitest';
import type { EntityDetail, EntitySummary, TaskCancellationObservations } from '@tm8/contract';
import { buildMapModel, type MapEntity, type MapInput, type MapScope } from '../story/game/map-model';
import { loadGameCancellationObservations } from './game-lifecycles';
import { createGameMapLoader } from './game-maps';
import type { Seam } from './seam';

const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const SPACE = id(1), OTHER = id(2), TASK = id(3), EXACT = id(4);
const BOUND = '2026-10-08T12:00:00.000Z';
const TTL = 86_400_000;
const entity = (n: number, extra: Partial<MapEntity> = {}): MapEntity => ({
  id: id(n), kind: 'task', title: 'Legacy cancelled task', status: 'cancelled',
  spaceId: SPACE, version: 8, updatedAt: '1900-01-01T00:00:00.000Z', ...extra,
});
const response = (taskIds: readonly string[], spaceId = SPACE): TaskCancellationObservations => ({
  schemaVersion: 'tm8.task-cancellation-observations.v1', spaceId, complete: true,
  facts: taskIds.map(taskId => ({ taskId, statusChangedNotAfter: BOUND })),
});

describe('cold Taskland cancellation observations', () => {
  for (const scope of [{ kind: 'space', id: SPACE }, { kind: 'story', id: id(20) }] as MapScope[]) {
    it(`${scope.kind} cold loader passes the bounded facts into the model without admitting graph-only rows`, async () => {
      const rows = [3, 4].map(n => ({ id: id(n), kind: 'task', parentId: null, spaceId: SPACE,
        title: 'Cancelled task', state: { kind: 'task', status: 'cancelled',
          statusChangedAt: n === 4 ? '2026-10-08T13:00:00.000Z' : null,
          acceptance: { total: 0, completed: 0 } }, counters: { messages: 0 }, badges: {},
      } as unknown as EntitySummary));
      const cancellationRead = vi.fn(async (_spaceId: string, ids: readonly string[]) => response(ids));
      const story = { id: scope.id, kind: 'story', spaceId: SPACE, title: 'Story',
        content: { kind: 'story', page: { roots: [], nodes: rows, edges: [], sessions: [], team: [], childStories: [] } },
      } as unknown as EntityDetail;
      const port = {
        spaces: async () => [{ id: SPACE, name: 'Space' }],
        query: async () => ({ page: { items: rows, nextCursor: null } }),
        entity: async () => story,
        graph: async () => ({ nodes: [{ ...rows[0], id: id(99) }], edges: [], clusters: [] }),
        liveness: { statusOf: () => 'unknown' },
        taskCancellationObservations: cancellationRead,
      } as unknown as Seam;
      const result = await createGameMapLoader(port, SPACE)(scope, undefined, 'taskland');
      expect(cancellationRead).toHaveBeenCalledExactlyOnceWith(SPACE, [TASK]);
      expect(result.input.entities.map(e => e.id)).toEqual([TASK, EXACT]);
      expect(result.input.entities[0]!.cancelledNotAfter).toBe(BOUND);
      expect(result.input.entities[1]!.cancelledAt).toBe('2026-10-08T13:00:00.000Z');
      const model = buildMapModel(result.input, { type: 'taskland', scope, now: Date.parse(BOUND) + TTL - 1 });
      expect(model.nextLifecycleAt).toBe(Date.parse(BOUND) + TTL);
    });

    it(`${scope.kind} reload gets a conservative removal timer; exact and unknown rows stay distinct`, async () => {
      const input: MapInput = {
        scope, taskHierarchyComplete: true,
        entities: [entity(3), entity(4, { cancelledAt: '2026-10-08T13:00:00.000Z' }), entity(5)],
        edges: [], warnings: ['existing warning'], townPlacements: [{ entityId: TASK, x: 5, z: 8 }],
      };
      const original = structuredClone(input);
      const read = vi.fn(async (_spaceId: string, requested: readonly string[]) => response(requested.filter(taskId => taskId === TASK)));
      const loaded = await loadGameCancellationObservations(input, { taskCancellationObservations: read }, SPACE);
      expect(read).toHaveBeenCalledExactlyOnceWith(SPACE, [TASK, id(5)]);
      expect(input).toEqual(original);
      expect(loaded.edges).toBe(input.edges);
      expect(loaded.warnings).toBe(input.warnings);
      expect(loaded.townPlacements).toBe(input.townPlacements);
      expect(loaded.scope).toBe(input.scope);
      expect(loaded.entities[0]).toMatchObject({ version: 8, cancelledNotAfter: BOUND });
      expect(loaded.entities[1]).toBe(input.entities[1]);
      expect(loaded.entities[2]!.cancelledNotAfter).toBeUndefined();
      const now = Date.parse(BOUND) + TTL - 1;
      const model = buildMapModel(loaded, { type: 'taskland', scope, now });
      const place = model.places.find(p => p.id === TASK)!;
      expect(place.rubbleExpiresAt).toBeNull();
      expect(place.cancelledAt).toBeNull();
      expect(place.rubbleRemovalNotAfter).toBe(now + 1);
      expect(model.nextLifecycleAt).toBe(now + 1);
      expect(place.label).not.toContain('2026');
      expect(model.places.find(p => p.id === EXACT)!.rubbleExpiresAt).toBe(Date.parse('2026-10-08T13:00:00.000Z') + TTL);
      const expired = buildMapModel(loaded, { type: 'taskland', scope, now: now + 1, previous: model });
      expect(expired.places.some(p => p.id === TASK)).toBe(false);
      expect(expired.places.some(p => p.id === id(5))).toBe(true);
    });
  }

  it('requests only admitted cancelled exact-null tasks and ignores unrequested or foreign facts', async () => {
    const input: MapInput = { entities: [entity(3), entity(4, { cancelledAt: BOUND }),
      entity(5, { status: 'open' }), entity(6, { kind: 'doc' }), entity(7, { spaceId: OTHER })], edges: [] };
    const read = vi.fn(async () => response([TASK, EXACT, id(5), id(6), id(7), id(999)]));
    const result = await loadGameCancellationObservations(input, { taskCancellationObservations: read }, SPACE);
    expect(read).toHaveBeenCalledExactlyOnceWith(SPACE, [TASK]);
    expect(result.entities).toHaveLength(input.entities.length);
    expect(result.entities.slice(1)).toEqual(input.entities.slice(1));
    expect(result.entities[0]!.cancelledNotAfter).toBe(BOUND);
  });

  it('batches at 500, deduplicates IDs and keeps failed chunks unknown', async () => {
    const input: MapInput = { entities: Array.from({ length: 1001 }, (_, i) => entity(i + 100)), edges: [] };
    const read = vi.fn(async (_spaceId: string, ids: readonly string[]) => {
      if (ids[0] === id(600)) throw new Error('unavailable');
      return response(ids);
    });
    const result = await loadGameCancellationObservations(input, { taskCancellationObservations: read }, SPACE);
    expect(read.mock.calls.map(call => call[1].length)).toEqual([500, 500, 1]);
    expect(result.entities.filter(e => e.cancelledNotAfter === BOUND)).toHaveLength(501);
    expect(result.entities[500]).toBe(input.entities[500]);
    const duplicate = { entities: [entity(3), entity(3)], edges: [] };
    const dedup = vi.fn(async (_spaceId: string, ids: readonly string[]) => response(ids));
    await loadGameCancellationObservations(duplicate, { taskCancellationObservations: dedup }, SPACE);
    expect(dedup.mock.calls[0]![1]).toEqual([TASK]);
  });

  it('missing, failed, wrong-space, incomplete or malformed responses never produce a bound', async () => {
    const input: MapInput = { entities: [entity(3)], edges: [] };
    expect(await loadGameCancellationObservations(input, {}, SPACE)).toBe(input);
    for (const payload of [response([]), response([TASK], OTHER), { ...response([TASK]), complete: false },
      { ...response([TASK]), facts: [{ taskId: TASK, statusChangedNotAfter: 'invalid' }] }]) {
      const read = async () => payload as TaskCancellationObservations;
      expect(await loadGameCancellationObservations(input, { taskCancellationObservations: read }, SPACE)).toBe(input);
    }
    expect(await loadGameCancellationObservations(input, { taskCancellationObservations: async () => { throw new Error('refused'); } }, SPACE)).toBe(input);
    await expect(loadGameCancellationObservations(input, {
      taskCancellationObservations: async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; },
    }, SPACE)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
