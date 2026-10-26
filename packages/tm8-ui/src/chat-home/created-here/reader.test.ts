import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { CHAT_TAG_EDGE, createdHereReaderFromSeam } from './reader';

const CHAT = '019f0000-0000-7000-8000-00000000c0c0' as EntityId;
const DOC = '019f0000-0000-7000-8000-000000000002' as EntityId;

function seamWith(overrides: Record<string, unknown>) {
  return { commands: {}, ...overrides } as unknown as Seam;
}

describe('createdHereReaderFromSeam tagging', () => {
  it('tags with one attached_to edge, entity -> chat, and removes by edge id', async () => {
    const createEdge = vi.fn(async () => ({ patches: [], edge: { id: 'edge-1', source: { id: DOC, kind: 'doc' } } }));
    const deleteEdge = vi.fn(async () => ({ patches: [] }));
    const reader = createdHereReaderFromSeam(seamWith({ commands: { createEdge, deleteEdge } }));
    expect(CHAT_TAG_EDGE).toBe('attached_to');
    const tag = await reader.tag!(CHAT, DOC);
    expect(createEdge).toHaveBeenCalledWith(expect.objectContaining({ srcId: DOC, dstId: CHAT, type: 'attached_to' }));
    expect(tag).toEqual({ edgeId: 'edge-1', entity: { id: DOC, kind: 'doc' } });
    await reader.untag!('edge-1');
    expect(deleteEdge).toHaveBeenCalledWith('edge-1', expect.objectContaining({ clientMutationId: expect.any(String) }));
  });

  it('reads tags as incoming attached_to on the chat, and outputs as incoming authored_from without messages', async () => {
    const connections = vi.fn(async (_id: EntityId, opts: { types: string[] }) => ({
      nextCursor: null,
      items: opts.types[0] === 'attached_to'
        ? [{ id: 'edge-1', source: { id: DOC, kind: 'doc' } }]
        : [{ id: 'a', source: { id: DOC, kind: 'doc' } }, { id: 'b', source: { id: 'm', kind: 'message' } }],
    }));
    const reader = createdHereReaderFromSeam(seamWith({ connections }));
    expect(await reader.tags!(CHAT)).toEqual([{ edgeId: 'edge-1', entity: { id: DOC, kind: 'doc' } }]);
    expect(connections).toHaveBeenLastCalledWith(CHAT, expect.objectContaining({ types: ['attached_to'], direction: 'incoming' }));
    expect((await reader.outputs!('s' as EntityId)).map((item) => item.id)).toEqual([DOC]);
    expect(connections).toHaveBeenLastCalledWith('s', expect.objectContaining({ types: ['authored_from'], direction: 'incoming' }));
  });

  it('searches by every word', async () => {
    const query = vi.fn(async () => ({ page: { items: [], nextCursor: null } }));
    const reader = createdHereReaderFromSeam(seamWith({ query }));
    await reader.search!({ spaceId: 'space', text: 'plan doc' });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ filters: { words: 'plan doc' } }));
  });
});
