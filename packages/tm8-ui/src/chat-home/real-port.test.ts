import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam } from './real-port';

const ROOT = '019f0000-0000-7000-8000-000000000201' as EntityId;
const ANCHOR = '019f0000-0000-7000-8000-000000000202' as EntityId;
const TEAMMATE = '019f0000-0000-7000-8000-000000000203' as EntityId;

function seamStub() {
  const postMessage = vi.fn(async () => ({
    entity: { id: ROOT, kind: 'message' },
    patches: [],
  }));
  const seam = {
    query: vi.fn(async () => ({
      page: { items: [{ id: TEAMMATE, title: 'Forge' }] },
    })),
    commands: { postMessage },
    onChatTurn: vi.fn(() => () => undefined),
  } as unknown as Seam;
  return { seam, postMessage };
}

describe('real chat-home seam adapter', () => {
  it('keeps the missing L2 reads and config op visibly unavailable', async () => {
    const { seam } = seamStub();
    const port = createChatHomePortFromSeam(seam);
    expect(port.threadListUnavailableReason).toMatch(/chatThreads read/);
    expect(port.startThread.unavailableReason).toMatch(/configuration operation/);
    expect(await port.listThreads('space-1')).toEqual([]);
  });

  it('maps one space-wide read and posts later turns to the cached anchor', async () => {
    const { seam, postMessage } = seamStub();
    const listThreads = vi.fn(async () => [{
      rootMessageId: ROOT,
      anchorId: ANCHOR,
      teammateId: TEAMMATE,
      model: 'claude-sonnet-4-5',
      createdAt: '2026-08-13T08:00:00.000Z',
      lastReplyAt: null,
    }]);
    const port = createChatHomePortFromSeam(seam, { listThreads });

    const rows = await port.listThreads('space-1');
    expect(listThreads).toHaveBeenCalledExactlyOnceWith('space-1');
    expect(rows[0]?.config).toEqual({
      teammateId: TEAMMATE,
      teammateLabel: 'Forge',
      model: 'claude-sonnet-4-5',
      modelLabel: 'claude-sonnet-4-5',
    });

    await port.postTurn({
      threadRootId: ROOT,
      body: 'Continue.',
      clientMutationId: 'turn-1',
    });
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'turn-1',
      anchorIds: [ANCHOR],
      parentMessageId: ROOT,
      body: 'Continue.',
    });
  });

  it('creates the first prompt as an ordinary root before config', async () => {
    const { seam, postMessage } = seamStub();
    const configureThread = vi.fn(async (input) => ({
      threadRootId: input.rootMessageId,
      teammateId: input.teammateId,
      model: input.model,
    }));
    const port = createChatHomePortFromSeam(seam, { configureThread });
    const root = await port.startThread.createRoot({
      spaceId: 'space-1',
      anchorId: ANCHOR,
      body: 'First prompt',
      clientMutationId: 'root-1',
    });

    expect(root).toEqual({ threadRootId: ROOT });
    expect(postMessage).toHaveBeenCalledWith({
      clientMutationId: 'root-1',
      anchorIds: [ANCHOR],
      body: 'First prompt',
    });
  });
});

