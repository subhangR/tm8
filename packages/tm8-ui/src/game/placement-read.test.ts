import { describe, expect, it, vi } from 'vitest';
import type { GameMapContext, GameMapIdentity, GameMapPlacement } from '@tm8/contract';
import type { GamePort } from './port';
import { readGamePlacements } from './placement-read';

const selection = { type: 'town' as const, scope: { kind: 'space' as const, id: 'space' } };
const map: GameMapIdentity = { ...selection, spaceId: 'space', id: 'durable-map', title: 'Town' };
const row = (props: Partial<GameMapPlacement> = {}): GameMapPlacement => ({ itemId: 'item', kind: 'ref', entityId: 'task',
  x: 20, z: 30, rotation: 0, spec: {}, layer: 'human', byActor: 'member', version: 1, expiresAt: null, ...props });
const context = (rows: GameMapPlacement[], nextCursor: string | null = null): GameMapContext => ({ map, placements: rows, nextCursor, terrain: [], terrainTruncated: false });
const port = () => ({ open: vi.fn(async () => map), context: vi.fn(async () => context([])) } as unknown as GamePort & { context: ReturnType<typeof vi.fn<GamePort['context']>> });

describe('persisted placement reads', () => {
  it('pages durable map refs, excludes ghosts/expired/invalid values and preserves human protection provenance', async () => {
    const adapter = port();
    adapter.context.mockResolvedValueOnce(context([row(), row({ itemId: 'ghost', entityId: 'deleted' }), row({ itemId: 'nan', entityId: 'other', x: NaN })], 'page2'));
    adapter.context.mockResolvedValueOnce(context([row({ itemId: 'agent', layer: 'agent', x: 999, version: 9 }),
      row({ itemId: 'expired', entityId: 'other', expiresAt: '2020-01-01T00:00:00Z' }), row({ itemId: 'decor', kind: 'decor', entityId: null })]));
    expect(await readGamePlacements(adapter, 'space', selection, new Set(['task', 'other']))).toEqual({
      townPlacements: [{ entityId: 'task', x: 20, z: 30, actorId: 'member', layer: 'human' }], warnings: [],
    });
    expect(adapter.context.mock.calls[1]).toEqual(['durable-map', 'page2', undefined]);
  });
  it('never uses persisted ref coordinates for Taskland or overwrites derived graph state', async () => {
    const adapter = port(), taskland = { ...selection, type: 'taskland' as const };
    adapter.open = vi.fn(async () => ({ ...map, ...taskland }));
    adapter.context.mockResolvedValue({ ...context([row()]), map: { ...map, ...taskland } });
    expect((await readGamePlacements(adapter, 'space', taskland, new Set(['task']))).townPlacements).toEqual([]);
  });
  it('falls back with a generic notice on failed/mismatched/repeated-cursor reads', async () => {
    for (const fail of ['error', 'mismatch', 'cursor']) {
      const adapter = port();
      if (fail === 'error') adapter.context.mockRejectedValue(new Error('Private body'));
      if (fail === 'mismatch') adapter.context.mockResolvedValue({ ...context([row()]), map: { ...map, spaceId: 'foreign' } });
      if (fail === 'cursor') adapter.context.mockResolvedValue(context([row()], 'same'));
      expect(await readGamePlacements(adapter, 'space', selection, new Set(['task']))).toEqual({ townPlacements: [],
        warnings: ['Saved placements could not be loaded. Showing the derived layout.'] });
    }
  });
  it('keeps cancellation as cancellation instead of displaying fallback data', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readGamePlacements(port(), 'space', selection, new Set(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
